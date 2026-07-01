import { tryCompileDSL, parse, serialize } from './dsl.js';
import { setupFileImport } from './file-import.js';
import { setupFreesoundModal } from './freesound-modal.js';

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const playBtn       = document.getElementById('playBtn');
const paletteSelect = document.getElementById('paletteSelect');
const statusText    = document.getElementById('statusText');
const dropZone      = document.getElementById('dropZone');
const fileInput     = document.getElementById('fileInput');
const trackLanes    = document.getElementById('trackLanes');
const masterCanvas  = document.getElementById('masterCanvas');
const masterStack   = document.getElementById('masterStack');
const trackNavigator= document.getElementById('trackNavigator');
const navCount      = document.getElementById('navCount');
const bpmInput      = document.getElementById('bpmInput');
const beatsInput    = document.getElementById('beatsInput');

// ─── Constants ─────────────────────────────────────────────────────────────────
const UI_BANDS      = 256;
const TRACK_SPEC_W  = 560;
const TRACK_SPEC_H  = 160;
const TRACK_WAVE_W  = 260;
const TRACK_WAVE_H  = 46;

// ─── Global audio state ────────────────────────────────────────────────────────
let audioCtx      = null;
let masterGain    = null;
let masterAnalyser= null;
let playing       = false;
let rafRunning    = false;
let bpm           = 120;
let beatsPerCycle = 4;

// Master spectrogram
let masterW = 900;
let masterH = 220;
let masterFreqData = null;
let masterImgData  = null;
let masterPixels32 = null;
let masterVisHead  = 0;
let masterVisData  = null;  // circular buffer
let masterVizMax   = 1;

// ─── Track registry ────────────────────────────────────────────────────────────
const tracks = new Map();
let masterTrackId = null;

// ─── Palette LUTs ──────────────────────────────────────────────────────────────
const STOPS = {
    matrix:  [[0,[0,0,0]],[0.4,[0,70,0]],[0.75,[0,190,30]],[1,[130,255,100]]],
    ocean:   [[0,[0,0,0]],[0.28,[8,0,115]],[0.62,[0,155,195]],[1,[170,255,255]]],
    plasma:  [[0,[0,0,0]],[0.28,[75,0,155]],[0.58,[215,0,175]],[0.82,[255,175,0]],[1,[255,255,50]]],
    inferno: [[0,[0,0,0]],[0.33,[148,0,12]],[0.64,[255,115,0]],[1,[255,252,165]]],
};

const LUTS = {};
for (const [name, stops] of Object.entries(STOPS)) {
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let si = 1;
        while (si < stops.length - 1 && t > stops[si][0]) si++;
        const span = stops[si][0] - stops[si - 1][0] || 1;
        const u    = Math.max(0, Math.min(1, (t - stops[si - 1][0]) / span));
        const [r1, g1, b1] = stops[si - 1][1];
        const [r2, g2, b2] = stops[si][1];
        lut[i * 3]     = Math.round(r1 + (r2 - r1) * u);
        lut[i * 3 + 1] = Math.round(g1 + (g2 - g1) * u);
        lut[i * 3 + 2] = Math.round(b1 + (b2 - b1) * u);
    }
    LUTS[name] = lut;
}

// ─── Ensure AudioContext ───────────────────────────────────────────────────────
async function ensureAudioCtx() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    masterGain = audioCtx.createGain();
    masterAnalyser = audioCtx.createAnalyser();
    masterAnalyser.fftSize = 2048;
    masterAnalyser.smoothingTimeConstant = 0.3;
    masterGain.connect(masterAnalyser);
    masterAnalyser.connect(audioCtx.destination);

    masterFreqData = new Float32Array(masterAnalyser.frequencyBinCount);

    await audioCtx.audioWorklet.addModule('/spectral-worklet.js');
}

// ─── Master spectrogram setup ──────────────────────────────────────────────────
function initMasterCanvas() {
    const rect = masterStack.getBoundingClientRect();
    masterW = Math.floor(rect.width) || Math.max(900, window.innerWidth - 80);
    masterH = Math.floor(rect.height) || 220;
    masterCanvas.width  = masterW;
    masterCanvas.height = masterH;

    const ctx = masterCanvas.getContext('2d');
    masterImgData  = ctx.createImageData(masterW, masterH);
    masterPixels32 = new Uint32Array(masterImgData.data.buffer);

    masterVisData = Array.from({ length: masterW }, () => new Float32Array(UI_BANDS));
    masterVisHead = 0;
    masterBandRows = null;
}

let resizeRaf = null;

function handleViewportResize() {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        initMasterCanvas();
        for (const track of tracks.values()) {
            drawTrackWaveform(track);
        }
    });
}

// ─── Send buffer to worklet ────────────────────────────────────────────────────

function sendBufferToWorklet(track) {
    const rawData = track.audioBuffer.getChannelData(0);
    const copy = new Float32Array(rawData);
    track.workletNode.port.postMessage(
        {
            type: 'setBuffer',
            buffer: copy.buffer,
            loopStart: Math.floor(track.loopStartRatio * rawData.length),
            loopEnd:   Math.floor(track.loopEndRatio   * rawData.length),
        },
        [copy.buffer]
    );
}

// ─── Track creation ────────────────────────────────────────────────────────────

function createTrackId() {
    return crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createTrack(audioBuffer, name) {
    await ensureAudioCtx();

    const id = createTrackId();

    // Audio nodes
    const workletNode = new AudioWorkletNode(audioCtx, 'spectral-coder-processor', {
        outputChannelCount: [1],
    });
    const gainNode = audioCtx.createGain();
    workletNode.connect(gainNode);
    gainNode.connect(masterGain);

    // Visualization buffers
    const timeCols = TRACK_SPEC_W;
    const visPreData  = Array.from({ length: timeCols }, () => new Float32Array(UI_BANDS));
    const visPostData = Array.from({ length: timeCols }, () => new Float32Array(UI_BANDS));

    // Worklet → vis data
    workletNode.port.onmessage = ({ data }) => {
        if (data.type === 'render') {
            const track = tracks.get(id);
            if (!track) return;
            track.visPreData[track.visHead].set(data.preArray);
            track.visPostData[track.visHead].set(data.postArray);
            track.visHead = (track.visHead + 1) % timeCols;
        }
    };

    const track = {
        id,
        name: name || 'untitled',
        audioBuffer,
        workletNode,
        gainNode,
        volume: 1,
        muted: false,
        solo: false,
        loopStartRatio: 0,
        loopEndRatio: 1,
        code: '',
        visHead: 0,
        visPreData,
        visPostData,
        vizMaxPre: 1,
        vizMax: 1,
        el: null,
        // Canvas/ctx references (set by buildTrackDOM)
        waveCanvas: null, waveCtx: null,
        preCanvas: null,  preCtx: null,
        postCanvas: null, postCtx: null,
        overlaySvg: null,
        preImgData: null, prePixels32: null,
        postImgData: null, postPixels32: null,
        codeTextarea: null,
        nameInput: null,
        errorSpan: null,
        // Waveform drag state
        dragging: null,
        // SVG overlay state
        currentAst: null,
        svgDrag: null,
        // Collapse state
        collapsed: false,
        // Clock state
        clockMod: null,
        isPlaying: false,
    };

    tracks.set(id, track);

    // Send audio buffer and initial clock settings to worklet
    sendBufferToWorklet(track);
    track.workletNode.port.postMessage({ type: 'updateClock', bpm, beatsPerCycle });
    buildTrackDOM(track);
    drawTrackWaveform(track);
    updatePlayButton();
    
    if (tracks.size === 1) {
        setMasterTrack(track.id);
    } else {
        updateNavigator();
    }

    return track;
}

function removeTrack(id) {
    const track = tracks.get(id);
    if (!track) return;

    // Stop and disconnect audio
    track.workletNode.port.postMessage({ type: 'stop' });
    track.workletNode.disconnect();
    track.gainNode.disconnect();

    // Remove DOM
    if (track.el && track.el.parentNode) {
        track.el.parentNode.removeChild(track.el);
    }

    tracks.delete(id);
    
    if (masterTrackId === id) {
        masterTrackId = tracks.size > 0 ? tracks.keys().next().value : null;
        if (masterTrackId) setMasterTrack(masterTrackId);
    }

    updateMuteSolo();
    updatePlayButton();
    updateNavigator();
}

// ─── Master Track ──────────────────────────────────────────────────────────────

function setMasterTrack(id) {
    masterTrackId = id;
    
    // Update UI
    tracks.forEach(t => {
        const isMaster = t.id === masterTrackId;
        if (t.el) {
            const btn = t.el.querySelector('.btn-master');
            if (btn) btn.classList.toggle('is-master', isMaster);
        }
    });
    
    updateNavigator();
}

// ─── Duplicate track ───────────────────────────────────────────────────────────

async function duplicateTrack(sourceTrackId) {
    const src = tracks.get(sourceTrackId);
    if (!src) return;

    // Determine copy name: add " (N)" suffix
    const baseName = src.name.replace(/\s*\(\d+\)$/, '');
    let copyNum = 2;
    for (const t of tracks.values()) {
        const m = t.name.match(new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*\\((\\d+)\\))?$`));
        if (m) copyNum = Math.max(copyNum, (parseInt(m[1]) || 1) + 1);
    }

    const newTrack = await createTrack(src.audioBuffer, `${baseName} (${copyNum})`);
    if (!newTrack) return;

    // Copy loop points (different section selection is the main use case)
    newTrack.loopStartRatio = src.loopStartRatio;
    newTrack.loopEndRatio   = src.loopEndRatio;
    drawTrackWaveform(newTrack);

    // Update worklet with corrected loop points
    newTrack.workletNode.port.postMessage({
        type: 'updateLoopPoints',
        loopStart: Math.floor(newTrack.loopStartRatio * newTrack.audioBuffer.length),
        loopEnd:   Math.floor(newTrack.loopEndRatio   * newTrack.audioBuffer.length),
    });

    // Copy code
    if (src.code) {
        newTrack.codeTextarea.value = src.code;
        newTrack.code = src.code;
        const { clockMod, granulate } = tryCompileDSL(src.code);
        newTrack.clockMod = clockMod;
        if (clockMod) newTrack.workletNode.port.postMessage({ type: 'updateClockMod', clockMod });
        newTrack.workletNode.port.postMessage({ type: 'updateGranulate', params: granulate ?? null });
    }

    // Scroll to the new track
    scrollToTrack(newTrack.id);
}

// ─── Track DOM builder ─────────────────────────────────────────────────────────

function buildTrackDOM(track) {
    const lane = document.createElement('div');
    lane.className = 'track-lane';
    lane.dataset.trackId = track.id;

    // ── Controls column ──
    const controls = document.createElement('div');
    controls.className = 'track-controls';

    // Header: collapse + name + master + duplicate + remove
    const header = document.createElement('div');
    header.className = 'track-header';

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'btn-action btn-collapse';
    collapseBtn.title = 'Collapse/expand track';
    collapseBtn.innerHTML = '<span class="btn-collapse-icon">▾</span>';
    collapseBtn.addEventListener('click', () => toggleCollapse(track));

    const masterBtn = document.createElement('button');
    masterBtn.className = `btn-master ${track.id === masterTrackId ? 'is-master' : ''}`;
    masterBtn.title = 'Set as Master Loop';
    masterBtn.textContent = '👑';
    masterBtn.addEventListener('click', () => setMasterTrack(track.id));

    const nameInput = document.createElement('input');
    nameInput.className = 'track-name';
    nameInput.type = 'text';
    nameInput.value = track.name;
    nameInput.spellcheck = false;
    nameInput.addEventListener('change', () => {
        track.name = nameInput.value;
        updateNavigator();
    });
    track.nameInput = nameInput;

    const dupBtn = document.createElement('button');
    dupBtn.className = 'btn-action btn-duplicate';
    dupBtn.title = 'Duplicate track';
    dupBtn.textContent = '⎘';
    dupBtn.addEventListener('click', () => duplicateTrack(track.id));

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-action btn-remove';
    removeBtn.title = 'Remove track';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => removeTrack(track.id));

    header.append(collapseBtn, nameInput, masterBtn, dupBtn, removeBtn);

    // Buttons row: mute, solo, volume
    const btnsRow = document.createElement('div');
    btnsRow.className = 'track-buttons';

    const muteBtn = document.createElement('button');
    muteBtn.className = 'btn-mute';
    muteBtn.textContent = 'M';
    muteBtn.addEventListener('click', () => {
        track.muted = !track.muted;
        muteBtn.classList.toggle('active', track.muted);
        updateMuteSolo();
    });

    const soloBtn = document.createElement('button');
    soloBtn.className = 'btn-solo';
    soloBtn.textContent = 'S';
    soloBtn.addEventListener('click', () => {
        track.solo = !track.solo;
        soloBtn.classList.toggle('active', track.solo);
        updateMuteSolo();
    });

    const volSlider = document.createElement('input');
    volSlider.className = 'track-volume';
    volSlider.type = 'range';
    volSlider.min = '0';
    volSlider.max = '1';
    volSlider.step = '0.01';
    volSlider.value = '1';
    volSlider.addEventListener('input', () => {
        track.volume = parseFloat(volSlider.value);
        updateMuteSolo();
    });

    btnsRow.append(muteBtn, soloBtn, volSlider);

    // Waveform canvas
    const waveCanvas = document.createElement('canvas');
    waveCanvas.className = 'track-waveform';
    waveCanvas.width  = TRACK_WAVE_W;
    waveCanvas.height = TRACK_WAVE_H;
    track.waveCanvas = waveCanvas;
    track.waveCtx    = waveCanvas.getContext('2d');
    setupWaveformDrag(track);

    controls.append(header, btnsRow, waveCanvas);

    // ── Spectrogram column ──
    const specStack = document.createElement('div');
    specStack.className = 'track-spectrogram-stack';

    const preCanvas = document.createElement('canvas');
    preCanvas.className = 'track-spec-pre';
    preCanvas.width  = TRACK_SPEC_W;
    preCanvas.height = TRACK_SPEC_H;
    track.preCanvas = preCanvas;
    track.preCtx    = preCanvas.getContext('2d');

    const postCanvas = document.createElement('canvas');
    postCanvas.className = 'track-spec-post';
    postCanvas.width  = TRACK_SPEC_W;
    postCanvas.height = TRACK_SPEC_H;
    track.postCanvas = postCanvas;
    track.postCtx    = postCanvas.getContext('2d');

    const overlaySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlaySvg.classList.add('track-overlay');
    overlaySvg.setAttribute('width', TRACK_SPEC_W);
    overlaySvg.setAttribute('height', TRACK_SPEC_H);
    track.overlaySvg = overlaySvg;

    // Pre-allocate ImageData
    track.preImgData   = track.preCtx.createImageData(TRACK_SPEC_W, TRACK_SPEC_H);
    track.prePixels32  = new Uint32Array(track.preImgData.data.buffer);
    track.postImgData  = track.postCtx.createImageData(TRACK_SPEC_W, TRACK_SPEC_H);
    track.postPixels32 = new Uint32Array(track.postImgData.data.buffer);

    // Pre-fill alpha for pre canvas
    for (let i = 3; i < track.preImgData.data.length; i += 4) track.preImgData.data[i] = 255;

    specStack.append(preCanvas, postCanvas, overlaySvg);

    // ── Code column ──
    const codeWrap = document.createElement('div');
    codeWrap.className = 'track-code-wrap';

    const textarea = document.createElement('textarea');
    textarea.className = 'track-code';
    textarea.rows = 6;
    textarea.spellcheck = false;
    textarea.autocomplete = 'off';
    textarea.placeholder = 'band(200,4000).blur(0.3,0.6)';
    track.codeTextarea = textarea;

    textarea.addEventListener('keydown', e => {
        // Tab inserts spaces instead of changing focus
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 2;
            return;
        }
        if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            // Set this track as selected
            selectedTrackId = track.id;
            tracks.forEach(t => {
                if (t.el) t.el.classList.toggle('active-lane', t.id === track.id);
            });
            trackNavigator.querySelectorAll('.nav-pill').forEach(p => {
                p.classList.toggle('active', p.dataset.trackId === track.id);
            });

            // Apply code (do not toggle mute if we are actively editing code)
            applyTrackCode(track);
        }
    });

    const hint = document.createElement('span');
    hint.className = 'code-hint';
    hint.textContent = 'ctrl+enter to apply · dsl or raw js';

    const errorSpan = document.createElement('span');
    errorSpan.className = 'code-error';
    track.errorSpan = errorSpan;

    const snippets = [
        { label: 'band blur',    code: 'band(200, 4000).blur(0.3, 0.6)' },
        { label: 'low shelf',    code: 'low(500).blur(0.1, 0.4)' },
        { label: 'high shelf',   code: 'high(4000).blur(0.2, 0.3)' },
        { label: 'notch',        code: 'notch(800, 2000)' },
        { label: 'animated',     code: 'band(200 + Math.sin(time * 0.5) * 100, 3000).blur(0.2, 0.5)' },
        { label: 'granular',     code: 'band(100, 8000).granulate(2, 0.6, 60, 0.8)' },
        { label: 'slow + blur',  code: 'band(300, 6000).slow(2).blur(0.4, 0.7)' },
        { label: 'reverse',      code: 'band(200, 4000).rev()' },
    ];
    const chipsRow = document.createElement('div');
    chipsRow.className = 'snippet-chips';
    for (const { label, code } of snippets) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'snippet-chip';
        chip.textContent = label;
        chip.title = code;
        chip.addEventListener('click', () => {
            textarea.value = code;
            textarea.focus();
        });
        chipsRow.appendChild(chip);
    }

    codeWrap.append(chipsRow, textarea, errorSpan, hint);

    // ── Assemble lane ──
    lane.append(controls, specStack, codeWrap);
    trackLanes.appendChild(lane);
    track.el = lane;
}

// ─── Apply code to track ───────────────────────────────────────────────────────
function applyTrackCode(track) {
    if (!playing) {
        startAllTracks();
    } else if (!track.isPlaying) {
        // Track was added after playback started — start it individually
        startSingleTrack(track);
    }
    const src = track.codeTextarea.value.trim();
    const { code, blur, clockMod, granulate, error } = src ? tryCompileDSL(src) : { code: 'mag', blur: null, clockMod: null, granulate: null, error: null };

    // Show or clear parse error — on error, keep previous audio running
    if (track.errorSpan) {
        if (error) {
            track.errorSpan.textContent = error;
            track.errorSpan.classList.add('visible');
            track.codeTextarea.style.borderColor = '#ff4466';
            return;
        } else {
            track.errorSpan.textContent = '';
            track.errorSpan.classList.remove('visible');
            track.codeTextarea.style.borderColor = '';
        }
    }

    track.code = src;

    // Store and send clock modifications
    track.clockMod = clockMod;
    track.workletNode?.port.postMessage({
        type: 'updateClockMod',
        clockMod: clockMod || { fitCycles: 1, speedMultiplier: 1.0, isReversed: false },
    });

    track.workletNode?.port.postMessage({ type: 'updateCode', code });
    track.workletNode?.port.postMessage({
        type: 'updateBlur',
        freqAmt: blur?.freqAmt ?? 0,
        timeAmt: blur?.timeAmt ?? 0,
    });
    track.workletNode?.port.postMessage({
        type: 'updateGranulate',
        params: granulate ?? null,
    });

    // Update SVG overlay
    try {
        const ast = src ? parse(src) : null;
        renderTrackOverlay(track, ast?.type === 'Blur' ? null : ast);
    } catch {
        renderTrackOverlay(track, null);
    }
}

// ─── Waveform drawing ──────────────────────────────────────────────────────────

function drawTrackWaveform(track) {
    const { waveCtx, waveCanvas, audioBuffer, loopStartRatio, loopEndRatio } = track;
    const W = waveCanvas.width;
    const H = waveCanvas.height;

    waveCtx.fillStyle = '#090909';
    waveCtx.fillRect(0, 0, W, H);

    if (!audioBuffer) return;

    const data        = audioBuffer.getChannelData(0);
    const samplesPerPx = data.length / W;

    // Loop region shade
    const sx = Math.round(loopStartRatio * W);
    const ex = Math.round(loopEndRatio * W);
    waveCtx.fillStyle = 'rgba(255,255,255,0.055)';
    waveCtx.fillRect(sx, 0, ex - sx, H);

    // Centre line
    waveCtx.strokeStyle = '#1c1c1c';
    waveCtx.lineWidth = 1;
    waveCtx.beginPath();
    waveCtx.moveTo(0, H / 2);
    waveCtx.lineTo(W, H / 2);
    waveCtx.stroke();

    // Min-max waveform
    waveCtx.strokeStyle = '#383838';
    waveCtx.lineWidth = 1;
    waveCtx.beginPath();
    for (let x = 0; x < W; x++) {
        const i0 = Math.floor(x * samplesPerPx);
        const i1 = Math.min(Math.floor((x + 1) * samplesPerPx), data.length - 1);
        let lo = 1, hi = -1;
        for (let s = i0; s <= i1; s++) {
            if (data[s] < lo) lo = data[s];
            if (data[s] > hi) hi = data[s];
        }
        const yTop = (1 - hi) / 2 * H;
        const yBot = (1 - lo) / 2 * H;
        waveCtx.moveTo(x + 0.5, yTop);
        waveCtx.lineTo(x + 0.5, yBot);
    }
    waveCtx.stroke();

    // Loop handles
    [[sx, '#00cc55', 'S'], [ex, '#ff8800', 'E']].forEach(([hx, col, lbl]) => {
        waveCtx.fillStyle = col;
        waveCtx.fillRect(hx - 1, 0, 2, H);
        waveCtx.fillRect(hx - 5, 0, 10, 12);
        waveCtx.fillStyle = '#000';
        waveCtx.font = 'bold 7px monospace';
        waveCtx.textAlign = 'center';
        waveCtx.textBaseline = 'top';
        waveCtx.fillText(lbl, hx, 2);
    });
}

// ─── Waveform drag ─────────────────────────────────────────────────────────────

function setupWaveformDrag(track) {
    const canvas = track.waveCanvas;
    const W = canvas.width;

    function pointerRatio(e) {
        const r = canvas.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    }

    canvas.addEventListener('mousedown', e => {
        const r  = pointerRatio(e);
        const ds = Math.abs(r - track.loopStartRatio) * W;
        const de = Math.abs(r - track.loopEndRatio)   * W;
        track.dragging = ds < de ? 'start' : 'end';
        activeWaveDrag = track;
        e.preventDefault();
    });

    canvas.addEventListener('mousemove', e => {
        if (track.dragging) return;
        const r  = pointerRatio(e);
        const ds = Math.abs(r - track.loopStartRatio) * W;
        const de = Math.abs(r - track.loopEndRatio)   * W;
        canvas.style.cursor = (ds < 10 || de < 10) ? 'col-resize' : 'default';
    });
}

let activeWaveDrag = null;
let activeSvgDrag  = null;

async function addTrackFromArrayBuffer(rawArrayBuffer, trackName) {
    await ensureAudioCtx();
    const buffer = await audioCtx.decodeAudioData(rawArrayBuffer);
    const track = await createTrack(buffer, trackName);
    if (!playing) startAllTracks();
    else startSingleTrack(track);
    scrollToTrack(track.id);
    return track;
}

window.addEventListener('mousemove', e => {
    if (activeWaveDrag) {
        const track = activeWaveDrag;
        const r = (() => {
            const rect = track.waveCanvas.getBoundingClientRect();
            return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        })();
        if (track.dragging === 'start') track.loopStartRatio = Math.min(r, track.loopEndRatio - 0.005);
        else                             track.loopEndRatio   = Math.max(r, track.loopStartRatio + 0.005);
        if (track.audioBuffer) {
            track.workletNode.port.postMessage({
                type: 'updateLoopPoints',
                loopStart: Math.floor(track.loopStartRatio * track.audioBuffer.length),
                loopEnd:   Math.floor(track.loopEndRatio   * track.audioBuffer.length),
            });
        }
        drawTrackWaveform(track);
    } else if (activeSvgDrag) {
        handleSvgDragMove(e);
    }
});

window.addEventListener('mouseup', () => {
    if (activeWaveDrag) {
        activeWaveDrag.dragging = null;
        activeWaveDrag = null;
    }
    if (activeSvgDrag) {
        handleSvgDragEnd();
    }
});

// ─── Spectrogram drawing ───────────────────────────────────────────────────────

// Pre-compute pixel row bounds per frequency band (for track spectrograms)
const trackRowH     = TRACK_SPEC_H / UI_BANDS;
const trackBandRows = new Int32Array(UI_BANDS * 2);
for (let b = 0; b < UI_BANDS; b++) {
    trackBandRows[b * 2]     = Math.floor((UI_BANDS - 1 - b) * trackRowH);
    trackBandRows[b * 2 + 1] = Math.floor((UI_BANDS     - b) * trackRowH);
}

function drawTrackSpectrogram(track) {
    const lut = LUTS[paletteSelect.value] || LUTS.matrix;
    const SW = TRACK_SPEC_W;
    const SH = TRACK_SPEC_H;
    const timeCols = SW;

    // Auto-scale
    let preMax = 0, postMax = 0;
    for (let x = 0; x < timeCols; x++) {
        const pre = track.visPreData[x], post = track.visPostData[x];
        for (let b = 0; b < UI_BANDS; b++) {
            if (pre[b]  > preMax)  preMax  = pre[b];
            if (post[b] > postMax) postMax = post[b];
        }
    }
    track.vizMaxPre += (Math.max(preMax,  0.01) - track.vizMaxPre) * 0.05;
    track.vizMax    += (Math.max(postMax, 0.01) - track.vizMax)    * 0.05;

    // Layer 0: pre-FX grayscale
    track.prePixels32.fill(0xFF000000);
    for (let x = 0; x < timeCols; x++) {
        const frame = track.visPreData[(track.visHead + x) % timeCols];
        for (let b = 0; b < UI_BANDS; b++) {
            const mag = frame[b];
            if (mag < 0.0001) continue;
            const g     = Math.min(255, Math.floor(256 * Math.pow(mag / track.vizMaxPre, 0.4)));
            const color = 0xFF000000 | (g << 16) | (g << 8) | g;
            const yTop  = trackBandRows[b * 2];
            const yBot  = trackBandRows[b * 2 + 1];
            for (let row = yTop; row < yBot; row++) {
                if (row >= 0 && row < SH) track.prePixels32[row * SW + x] = color;
            }
        }
    }
    track.preCtx.putImageData(track.preImgData, 0, 0);

    // Layer 1: post-FX colored
    track.postPixels32.fill(0);
    for (let x = 0; x < timeCols; x++) {
        const frame = track.visPostData[(track.visHead + x) % timeCols];
        for (let b = 0; b < UI_BANDS; b++) {
            const mag = frame[b];
            if (mag < 0.0001) continue;
            const ti    = Math.min(255, Math.floor(256 * Math.pow(mag / track.vizMax, 0.4)));
            const color = 0xFF000000 | (lut[ti * 3 + 2] << 16) | (lut[ti * 3 + 1] << 8) | lut[ti * 3];
            const yTop  = trackBandRows[b * 2];
            const yBot  = trackBandRows[b * 2 + 1];
            for (let row = yTop; row < yBot; row++) {
                if (row >= 0 && row < SH) track.postPixels32[row * SW + x] = color;
            }
        }
    }
    track.postCtx.putImageData(track.postImgData, 0, 0);

    // Freq axis labels
    drawFreqAxis(track.postCtx, SW, SH);
}

function drawFreqAxis(ctx, w, h) {
    const nyq   = audioCtx ? audioCtx.sampleRate / 2 : 22050;
    const ticks = [100, 500, 1000, 2000, 5000, 10000, 20000];
    ctx.save();
    ctx.font = '7px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const hz of ticks) {
        if (hz > nyq) continue;
        const y = h * (1 - hz / nyq);
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 6]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, w - 3, y);
    }
    ctx.restore();
}

// ─── Master spectrogram ────────────────────────────────────────────────────────

// Band rows for master (computed once after init)
let masterBandRows = null;

function ensureMasterBandRows() {
    if (masterBandRows) return;
    const rowH = masterH / UI_BANDS;
    masterBandRows = new Int32Array(UI_BANDS * 2);
    for (let b = 0; b < UI_BANDS; b++) {
        masterBandRows[b * 2]     = Math.floor((UI_BANDS - 1 - b) * rowH);
        masterBandRows[b * 2 + 1] = Math.floor((UI_BANDS     - b) * rowH);
    }
}

function drawMasterSpectrogram() {
    if (!masterAnalyser || !masterImgData) return;

    const lut = LUTS[paletteSelect.value] || LUTS.matrix;
    ensureMasterBandRows();

    // Grab frequency data from analyser
    masterAnalyser.getFloatFrequencyData(masterFreqData);

    // Convert dB to linear and bin into UI_BANDS
    const col = masterVisData[masterVisHead];
    col.fill(0);
    const binSize = masterFreqData.length / UI_BANDS;
    for (let b = 0; b < UI_BANDS; b++) {
        let maxVal = -Infinity;
        const start = Math.floor(b * binSize);
        const end   = Math.min(Math.floor((b + 1) * binSize), masterFreqData.length);
        for (let k = start; k < end; k++) {
            if (masterFreqData[k] > maxVal) maxVal = masterFreqData[k];
        }
        // Convert dB (typically -100 to 0) to linear 0–1
        col[b] = Math.pow(10, Math.max(maxVal, -100) / 20);
    }
    masterVisHead = (masterVisHead + 1) % masterW;

    // Auto-scale
    let maxMag = 0;
    for (let x = 0; x < masterW; x++) {
        const frame = masterVisData[x];
        for (let b = 0; b < UI_BANDS; b++) {
            if (frame[b] > maxMag) maxMag = frame[b];
        }
    }
    masterVizMax += (Math.max(maxMag, 0.001) - masterVizMax) * 0.05;

    // Render
    masterPixels32.fill(0xFF000000);
    for (let x = 0; x < masterW; x++) {
        const frame = masterVisData[(masterVisHead + x) % masterW];
        for (let b = 0; b < UI_BANDS; b++) {
            const mag = frame[b];
            if (mag < 0.0001) continue;
            const ti    = Math.min(255, Math.floor(256 * Math.pow(mag / masterVizMax, 0.4)));
            const color = 0xFF000000 | (lut[ti * 3 + 2] << 16) | (lut[ti * 3 + 1] << 8) | lut[ti * 3];
            const yTop  = masterBandRows[b * 2];
            const yBot  = masterBandRows[b * 2 + 1];
            for (let row = yTop; row < yBot; row++) {
                if (row >= 0 && row < masterH) masterPixels32[row * masterW + x] = color;
            }
        }
    }

    const ctx = masterCanvas.getContext('2d');
    ctx.putImageData(masterImgData, 0, 0);

    // Freq axis on master
    drawFreqAxis(ctx, masterW, masterH);
}

// ─── Clock UI ───────────────────────────────────────────────────────────────────

function updateClockUI() {
    if (!audioCtx) return;
    const cyclesPerSecond = (bpm / 60) / beatsPerCycle;
    const masterPhase = (audioCtx.currentTime * cyclesPerSecond) % 1.0;
    const fill = document.getElementById('global-clock-fill');
    if (fill) fill.style.width = `${masterPhase * 100}%`;
}

// ─── Animation loop ────────────────────────────────────────────────────────────

function drawLoop() {
    updateClockUI();
    for (const track of tracks.values()) {
        // Skip spectrogram rendering for collapsed tracks (perf optimization)
        if (!track.collapsed) {
            drawTrackSpectrogram(track);
        }
    }
    drawMasterSpectrogram();
    requestAnimationFrame(drawLoop);
}

// ─── SVG overlay (per-track) ───────────────────────────────────────────────────

const OVERLAY_COLORS = ['#ff3c6e', '#00e5ff', '#aaff00', '#ff9500'];

function freqToY(hz, h) {
    const nyq = audioCtx ? audioCtx.sampleRate / 2 : 22050;
    return h * (1 - Math.max(0, Math.min(hz / nyq, 1)));
}
function yToFreq(y, h) {
    const nyq = audioCtx ? audioCtx.sampleRate / 2 : 22050;
    return Math.max(0, Math.round((1 - y / h) * nyq));
}

function regionGeom(node, h) {
    switch (node.name) {
        case 'band':  return { yTop: freqToY(node.args[1], h), yBot: freqToY(node.args[0], h) };
        case 'low':   return { yTop: freqToY(node.args[0], h), yBot: h };
        case 'high':  return { yTop: 0,                        yBot: freqToY(node.args[0], h) };
        case 'notch': return { yTop: freqToY(node.args[1], h), yBot: freqToY(node.args[0], h) };
        default:      return { yTop: 0, yBot: h };
    }
}

function getHandleDefs(node) {
    switch (node.name) {
        case 'band':  return [{ argIdx: 1, edge: 'top' }, { argIdx: 0, edge: 'bot' }];
        case 'low':   return [{ argIdx: 0, edge: 'top' }];
        case 'high':  return [{ argIdx: 0, edge: 'bot' }];
        case 'notch': return [{ argIdx: 1, edge: 'top' }, { argIdx: 0, edge: 'bot' }];
        default:      return [];
    }
}

function renderTrackOverlay(track, ast) {
    const svg = track.overlaySvg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    track.currentAst = ast;
    if (!ast) return;

    const SW = TRACK_SPEC_W;
    const SH = TRACK_SPEC_H;

    const regions = [{ node: ast.base, chainPos: 'base' }];
    for (let i = 0; i < ast.chain.length; i++) {
        if (ast.chain[i].method === 'add') regions.push({ node: ast.chain[i].args[0], chainPos: i });
    }

    regions.forEach(({ node, chainPos }, ci) => {
        if (node.args.some(a => typeof a !== 'number')) return;

        const color = OVERLAY_COLORS[ci % OVERLAY_COLORS.length];
        const cpStr = String(chainPos);
        const { yTop, yBot } = regionGeom(node, SH);

        // Filled region rect
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', 0);
        rect.setAttribute('y', yTop);
        rect.setAttribute('width', SW);
        rect.setAttribute('height', Math.max(0, yBot - yTop));
        rect.setAttribute('fill', color);
        rect.setAttribute('fill-opacity', node.name === 'notch' ? '0.15' : '0.08');
        rect.setAttribute('stroke', 'none');
        rect.dataset.chainPos = cpStr;
        svg.appendChild(rect);

        // Draggable edge handles
        for (const { argIdx, edge } of getHandleDefs(node)) {
            const y = edge === 'top' ? yTop : yBot;

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', 0); line.setAttribute('x2', SW);
            line.setAttribute('y1', y); line.setAttribute('y2', y);
            line.setAttribute('stroke', color);
            line.setAttribute('stroke-width', '1.5');
            line.setAttribute('stroke-dasharray', '4 3');
            line.style.pointerEvents = 'none';
            line.dataset.chainPos = cpStr;
            svg.appendChild(line);

            const hit = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            hit.setAttribute('x1', 0); hit.setAttribute('x2', SW);
            hit.setAttribute('y1', y); hit.setAttribute('y2', y);
            hit.setAttribute('stroke', 'transparent');
            hit.setAttribute('stroke-width', '16');
            hit.style.cursor = 'ns-resize';
            hit.dataset.chainPos = cpStr;
            hit.dataset.argIdx   = argIdx;
            hit.addEventListener('mousedown', e => {
                e.preventDefault();
                activeSvgDrag = {
                    track,
                    line,
                    hit,
                    chainPos,
                    argIdx,
                    ast: JSON.parse(JSON.stringify(track.currentAst)),
                };
            });
            svg.appendChild(hit);
        }
    });
}

function handleSvgDragMove(e) {
    const d = activeSvgDrag;
    const bounds = d.track.overlaySvg.getBoundingClientRect();
    const y  = Math.max(0, Math.min(TRACK_SPEC_H, (e.clientY - bounds.top) / bounds.height * TRACK_SPEC_H));
    const hz = yToFreq(y, TRACK_SPEC_H);

    const target = d.chainPos === 'base'
        ? d.ast.base
        : d.ast.chain[d.chainPos].args[0];
    target.args[d.argIdx] = hz;

    d.track.codeTextarea.value = serialize(d.ast);

    d.line.setAttribute('y1', y);
    d.line.setAttribute('y2', y);
    d.hit.setAttribute('y1', y);
    d.hit.setAttribute('y2', y);

    const { yTop, yBot } = regionGeom(target, TRACK_SPEC_H);
    const rect = d.track.overlaySvg.querySelector(`rect[data-chain-pos="${d.chainPos}"]`);
    if (rect) {
        rect.setAttribute('y', yTop);
        rect.setAttribute('height', Math.max(0, yBot - yTop));
    }
}

function handleSvgDragEnd() {
    const d = activeSvgDrag;
    d.track.currentAst = d.ast;
    renderTrackOverlay(d.track, d.track.currentAst);
    const { code, blur } = tryCompileDSL(d.track.codeTextarea.value);
    d.track.workletNode?.port.postMessage({ type: 'updateCode', code });
    d.track.workletNode?.port.postMessage({
        type: 'updateBlur',
        freqAmt: blur?.freqAmt ?? 0,
        timeAmt: blur?.timeAmt ?? 0,
    });
    activeSvgDrag = null;
}

// ─── Playback ──────────────────────────────────────────────────────────────────

// Start a single track that was added while playback is already active
function startSingleTrack(track) {
    if (audioCtx.state === 'suspended') audioCtx.resume();

    track.workletNode.port.postMessage({ type: 'updateClock', bpm, beatsPerCycle });
    track.workletNode.port.postMessage({
        type: 'updateClockMod',
        clockMod: track.clockMod || { fitCycles: 1, speedMultiplier: 1.0, isReversed: false },
    });
    track.workletNode.port.postMessage({ type: 'play' });
    track.isPlaying = true;
}

function startAllTracks() {
    if (audioCtx.state === 'suspended') audioCtx.resume();

    for (const track of tracks.values()) {
        track.workletNode.port.postMessage({ type: 'updateClock', bpm, beatsPerCycle });
        track.workletNode.port.postMessage({
            type: 'updateClockMod',
            clockMod: track.clockMod || { fitCycles: 1, speedMultiplier: 1.0, isReversed: false },
        });
        track.workletNode.port.postMessage({ type: 'play' });
        track.isPlaying = true;
    }

    playing = true;
    playBtn.textContent = '■ Stop All';
    playBtn.classList.add('active');

    if (!rafRunning) {
        rafRunning = true;
        requestAnimationFrame(drawLoop);
    }
}

function stopAllTracks() {
    for (const track of tracks.values()) {
        track.workletNode.port.postMessage({ type: 'stop' });
        track.isPlaying = false;
    }

    playing = false;
    playBtn.textContent = '▶ Play All';
    playBtn.classList.remove('active');
}

playBtn.addEventListener('click', () => {
    if (playing) stopAllTracks();
    else         startAllTracks();
});

// ─── BPM & Beats Per Cycle ────────────────────────────────────────────────────

bpmInput?.addEventListener('change', () => {
    bpm = Math.max(1, parseInt(bpmInput.value) || 120);
    for (const track of tracks.values()) {
        track.workletNode.port.postMessage({ type: 'updateClock', bpm, beatsPerCycle });
    }
});
bpmInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        bpm = Math.max(1, parseInt(bpmInput.value) || 120);
        for (const track of tracks.values()) {
            track.workletNode.port.postMessage({ type: 'updateClock', bpm, beatsPerCycle });
        }
    }
});

beatsInput?.addEventListener('input', () => {
    beatsPerCycle = Math.max(1, parseInt(beatsInput.value) || 4);
    for (const track of tracks.values()) {
        track.workletNode.port.postMessage({ type: 'updateClock', bpm, beatsPerCycle });
    }
});

// ─── Mute / Solo ───────────────────────────────────────────────────────────────

function updateMuteSolo() {
    const anySolo = [...tracks.values()].some(t => t.solo);
    for (const t of tracks.values()) {
        const audible = anySolo ? t.solo && !t.muted : !t.muted;
        t.gainNode.gain.value = audible ? t.volume : 0;
    }
    // Update navigator pill opacity for muted tracks
    trackNavigator.querySelectorAll('.nav-pill').forEach(pill => {
        const t = tracks.get(pill.dataset.trackId);
        if (t) pill.classList.toggle('muted', t.muted || (anySolo && !t.solo));
    });
}

// ─── File upload / drop and Freesound modal ──────────────────────────────────

setupFileImport({
    dropZone,
    fileInput,
    addTrackFromArrayBuffer,
    setStatus: text => { statusText.textContent = text; },
});

setupFreesoundModal({
    addTrackFromArrayBuffer,
});

function updatePlayButton() {
    playBtn.disabled = tracks.size === 0;
}

// ─── Track Navigator ───────────────────────────────────────────────────────────

function updateNavigator() {
    // Remove old pills (keep the label and count spans)
    const oldPills = trackNavigator.querySelectorAll('.nav-pill');
    oldPills.forEach(p => p.remove());

    const countEl = navCount;
    const n = tracks.size;
    countEl.textContent = n > 0 ? `${n} total` : '';

    // Insert pills before the count span
    for (const track of tracks.values()) {
        const pill = document.createElement('button');
        pill.className = 'nav-pill';
        pill.dataset.trackId = track.id;
        pill.textContent = track.name;
        if (track.muted) pill.classList.add('muted');
        if (track.id === masterTrackId) pill.classList.add('master');

        pill.addEventListener('click', () => {
            scrollToTrack(track.id);
        });

        trackNavigator.insertBefore(pill, countEl);
    }
}

let selectedTrackId = null;

function scrollToTrack(id) {
    const track = tracks.get(id);
    if (!track || !track.el) return;

    // If collapsed, expand it
    if (track.collapsed) toggleCollapse(track);

    // Scroll into view
    track.el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Update selected track ID
    selectedTrackId = id;

    // Highlight active track lane
    tracks.forEach(t => {
        if (t.el) t.el.classList.toggle('active-lane', t.id === id);
    });

    // Update active pill
    trackNavigator.querySelectorAll('.nav-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.trackId === id);
    });
}

// Global Ctrl+Enter handler
window.addEventListener('keydown', e => {
    // If we're inside a textarea, that textarea's keydown handler will fire.
    // If not, we handle it here for the selected track.
    if (e.key === 'Enter' && e.ctrlKey) {
        if (e.target.tagName !== 'TEXTAREA') {
            e.preventDefault();
            if (selectedTrackId) {
                const track = tracks.get(selectedTrackId);
                if (track) {
                    // Toggle mute state (play/pause) only if it's already playing
                    if (playing && track.isPlaying) {
                        track.muted = !track.muted;
                    } else {
                        track.muted = false;
                    }
                    // Update UI button state
                    const muteBtn = track.el.querySelector('.btn-mute');
                    if (muteBtn) muteBtn.classList.toggle('active', track.muted);
                    updateMuteSolo();
                    // Apply code
                    applyTrackCode(track);
                }
            }
        }
    }
});

// ─── Collapse / Expand ─────────────────────────────────────────────────────────

function toggleCollapse(track) {
    track.collapsed = !track.collapsed;
    track.el.classList.toggle('collapsed', track.collapsed);
}

// ─── Initial load ──────────────────────────────────────────────────────────────

async function init() {
    initMasterCanvas();
    window.addEventListener('resize', handleViewportResize);

    try {
        const resp = await fetch('/media/break.wav');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const raw = await resp.arrayBuffer();
        await ensureAudioCtx();
        const buffer = await audioCtx.decodeAudioData(raw);
        await createTrack(buffer, 'amen_break');
    } catch (err) {
        updatePlayButton();
    }
}

init();