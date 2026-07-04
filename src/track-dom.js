import { TRACK_SPEC_W, TRACK_SPEC_H, TRACK_WAVE_W, TRACK_WAVE_H } from './constants.js';
import { trackLanes, trackNavigator } from './dom.js';
import { state } from './state.js';
import { tryCompileDSL, parse } from './dsl.js';
import { setupWaveformDrag } from './waveform.js';
import { renderTrackOverlay } from './overlay.js';
import { updateNavigator, toggleCollapse } from './navigator.js';
import { updateMuteSolo, startAllTracks, startSingleTrack } from './playback.js';
// Note: setMasterTrack / duplicateTrack / removeTrack are imported from tracks.js.
// That creates a circular reference (tracks.js also imports from here), which is safe
// in ES modules because all usages are inside function bodies — never at module init time.
import { setMasterTrack, duplicateTrack, removeTrack } from './tracks.js';

// ─── Track DOM builder ─────────────────────────────────────────────────────────

export function buildTrackDOM(track) {
    const lane = document.createElement('div');
    lane.className = 'track-lane';
    lane.dataset.trackId = track.id;

    // ── Controls column ──────────────────────────────────────────────────────
    const controls = document.createElement('div');
    controls.className = 'track-controls';

    const header = document.createElement('div');
    header.className = 'track-header';

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'btn-action btn-collapse';
    collapseBtn.title = 'Collapse/expand track';
    collapseBtn.innerHTML = '<span class="btn-collapse-icon">▾</span>';
    collapseBtn.addEventListener('click', () => toggleCollapse(track));

    const masterBtn = document.createElement('button');
    masterBtn.className = `btn-master ${track.id === state.masterTrackId ? 'is-master' : ''}`;
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

    const waveCanvas = document.createElement('canvas');
    waveCanvas.className = 'track-waveform';
    waveCanvas.width  = TRACK_WAVE_W;
    waveCanvas.height = TRACK_WAVE_H;
    track.waveCanvas = waveCanvas;
    track.waveCtx    = waveCanvas.getContext('2d');
    setupWaveformDrag(track);

    controls.append(header, btnsRow, waveCanvas);

    // ── Spectrogram column ───────────────────────────────────────────────────
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

    track.preImgData   = track.preCtx.createImageData(TRACK_SPEC_W, TRACK_SPEC_H);
    track.prePixels32  = new Uint32Array(track.preImgData.data.buffer);
    track.postImgData  = track.postCtx.createImageData(TRACK_SPEC_W, TRACK_SPEC_H);
    track.postPixels32 = new Uint32Array(track.postImgData.data.buffer);

    for (let i = 3; i < track.preImgData.data.length; i += 4) track.preImgData.data[i] = 255;

    specStack.append(preCanvas, postCanvas, overlaySvg);

    // ── Code column ──────────────────────────────────────────────────────────
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
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end   = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 2;
            return;
        }
        if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            state.selectedTrackId = track.id;
            state.tracks.forEach(t => {
                if (t.el) t.el.classList.toggle('active-lane', t.id === track.id);
            });
            trackNavigator.querySelectorAll('.nav-pill').forEach(p => {
                p.classList.toggle('active', p.dataset.trackId === track.id);
            });
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
        { label: 'band blur',  code: 'band(200, 4000).blur(0.3, 0.6)' },
        { label: 'low shelf',  code: 'low(500).blur(0.1, 0.4)' },
        { label: 'high shelf', code: 'high(4000).blur(0.2, 0.3)' },
        { label: 'notch',      code: 'notch(800, 2000)' },
        { label: 'animated',   code: 'band(200 + Math.sin(time * 0.5) * 100, 3000).blur(0.2, 0.5)' },
        { label: 'granular',   code: 'band(100, 8000).granulate(2, 0.6, 60, 0.8)' },
        { label: 'slow + blur',code: 'band(300, 6000).slow(2).blur(0.4, 0.7)' },
        { label: 'reverse',    code: 'band(200, 4000).rev()' },
    ];
    const chipsRow = document.createElement('div');
    chipsRow.className = 'snippet-chips';
    for (const { label, code } of snippets) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'snippet-chip';
        chip.textContent = label;
        chip.title = code;
        chip.addEventListener('click', () => { textarea.value = code; textarea.focus(); });
        chipsRow.appendChild(chip);
    }

    codeWrap.append(chipsRow, textarea, errorSpan, hint);

    // ── Assemble lane ────────────────────────────────────────────────────────
    lane.append(controls, specStack, codeWrap);
    trackLanes.appendChild(lane);
    track.el = lane;
}

// ─── Apply DSL code to a track ─────────────────────────────────────────────────

export function applyTrackCode(track) {
    if (!state.playing) {
        startAllTracks();
    } else if (!track.isPlaying) {
        startSingleTrack(track);
    }

    const src = track.codeTextarea.value.trim();
    const { code, blur, clockMod, granulate, error } = src
        ? tryCompileDSL(src)
        : { code: 'mag', blur: null, clockMod: null, granulate: null, error: null };

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
    track.workletNode?.port.postMessage({ type: 'updateGranulate', params: granulate ?? null });

    try {
        const ast = src ? parse(src) : null;
        renderTrackOverlay(track, ast?.type === 'Blur' ? null : ast);
    } catch {
        renderTrackOverlay(track, null);
    }
}
