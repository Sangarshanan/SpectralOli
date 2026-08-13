import { TRACK_SPEC_W, TRACK_SPEC_H, TRACK_WAVE_W, TRACK_WAVE_H } from './constants.js';
import { trackLanes, trackNavigator } from './dom.js';
import { state } from './state.js';
import { tryCompileDSL, parse, hasSeqStatement, normalizeDSL } from './dsl.js';
import { setupWaveformDrag, drawTrackWaveform, sendSlicesToWorklet } from './waveform.js';
import { detectSlices } from './slicer.js';
import { updateSliceEditor } from './slice-editor.js';
import { renderTrackOverlay } from './overlay.js';
import { updateNavigator, toggleCollapse } from './navigator.js';
import { updateMuteSolo, startAllTracks, startSingleTrack, sendCompiledDSLToWorklet } from './playback.js';
import { setMasterTrack, duplicateTrack, removeTrack } from './tracks.js';
import { isMac } from './shortcuts.js';
import { drawFreqAxis } from './spectrogram.js';
import { createTrackCodeEditor, getTrackCode, setTrackCode, setEditorError } from './code-editor.js';
import { scheduleSaveCode } from './persistence.js';

// Lanes scrolled out of the viewport are skipped by the draw loop.
const laneVisibilityObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
        const id = entry.target.dataset.trackId;
        const track = state.tracks.get(id);
        if (track) track.visible = entry.isIntersecting;
    }
}, { rootMargin: '200px 0px' });

// Track DOM builder

// Transform-pipeline method names — used to detect whether the current last
// line is already a pipeline statement (dot-chain continues) or something
// else (a fresh pipeline statement must start on its own line).
const TRANSFORM_METHOD_NAMES = ['blur', 'sgranulate', 'scale', 'rotate', 'skew', 'transpose'];

export const SUGGESTION_GROUPS = {
    entries: [
        [
            { label: 'slicep()', insert: 'slicep 512\nseq("0:")', tooltip: 'slicep n - Percussive slicing', domain: 'global' },
            { label: 'slicem()', insert: 'slicem 2048\nseq("0:")', tooltip: 'slicem n - Melodic slicing', domain: 'global' },
            { label: 'slicee()', insert: 'slicee 16\nseq("0:")', tooltip: 'slicee n - Equal-time slicing', domain: 'global' }
        ],
        [
            { label: 'band()', insert: 'band(200, 4000)', tooltip: 'band(lowHz, highHz) - Filter freq band', domain: 'mask' },
            { label: 'harmonic()', insert: 'harmonic(110, 6, 45)', tooltip: 'harmonic(baseHz, count, [width]) - Harmonic series filter', domain: 'mask' },
            { label: 'low()', insert: 'low(1000)', tooltip: 'low(hz) - Low-pass filter', domain: 'mask' },
            { label: 'high()', insert: 'high(2000)', tooltip: 'high(hz) - High-pass filter', domain: 'mask' }
        ],
        [
            { label: 'fft', insert: 'fft 1024', tooltip: 'fft n - Set the STFT frame size', domain: 'global' },
            { label: 'clock', insert: 'clock 0.5', tooltip: 'clock multiplier - Global speed multiplier', domain: 'global' },
            { label: 'gain', insert: 'gain 1.5', tooltip: 'gain expr - Output gain (dynamic expression allowed)', domain: 'global' }
        ]
    ],
    chain_pattern: [
        [
            { label: '.at()', insert: '.at("0", , 0.5)', tooltip: '.at(spec, op, [prob]) - Apply operation to steps at these positions', offset: -6, domain: 'time' },
            { label: '.every()', insert: '.every(4, )', tooltip: '.every(n, op) - Run operation every n-th cycle', domain: 'time' },
            { label: '.fast()', insert: '.fast(2)', tooltip: '.fast(multiplier) - Speed up sequence loop or steps', domain: 'time' },
            { label: '.slow()', insert: '.slow(2)', tooltip: '.slow(multiplier) - Slow down sequence loop or steps', domain: 'time' }
        ]
    ],
    chain_spectrum: [
        [
            { label: '.blur()', insert: '.blur(0.3, 0.5)', tooltip: '.blur(timeAmt, freqAmt) - Spectral blur', domain: 'transform' },
            { label: '.sgranulate()', insert: '.sgranulate(0.5, 0.8)', tooltip: '.sgranulate(scatter, mix) - Spectral granulation', domain: 'transform' },
            { label: '.scale()', insert: '.scale(1.5, 1.0)', tooltip: '.scale(time, freq, [mix]) - Scale time & frequency', domain: 'transform' },
            { label: '.rotate()', insert: '.rotate(45)', tooltip: '.rotate(degrees, [mix]) - Rotate spectrum', domain: 'transform' },
            { label: '.skew()', insert: '.skew(0.5, 0.0)', tooltip: '.skew(x_skew, y_skew, [mix]) - Skew freq across time', domain: 'transform' }
        ],
        [
            { label: '.transpose()', insert: '.transpose(12)', tooltip: '.transpose(semitones, [mix]) - Pitch shift', domain: 'transform' },
            { label: '+ region', insert: ' + high(4000)', tooltip: '+ region - Add to the frequency mask (saturating union)', domain: 'mask', sameLine: true },
            { label: '- region', insert: ' - band(800, 1200)', tooltip: '- region - Subtract from the frequency mask (clamped)', domain: 'mask', sameLine: true },
            { label: '! negate', insert: '', tooltip: '! - Wrap the mask in a complement (1 - x)', domain: 'mask', wrapNegate: true }
        ]
    ],
    modifiers: [
        [
            { label: 'stutter()', insert: 'stutter(2)', tooltip: 'stutter(n) - Repeat step n times', isModifier: true, domain: 'time' },
            { label: 'silence()', insert: 'silence()', tooltip: 'silence() - Mute targeted steps', isModifier: true, domain: 'time' },
            { label: 'reverse()', insert: 'reverse()', tooltip: 'reverse() - Reverse step audio', isModifier: true, domain: 'time' },
            { label: 'every()', insert: 'every(2, )', tooltip: 'every(n, op) - Run every n-th cycle', isModifier: true, domain: 'time' },
            { label: 'euclid()', insert: 'euclid(k, n, offset)', tooltip: 'euclid(k, n, [offset]) - Euclidean rhythm generator; offset rotates the pattern', isModifier: true, domain: 'time' }
        ],
        [
            { label: 'shuffle()', insert: 'shuffle()', tooltip: 'shuffle([rng]) - Randomize step order', isModifier: true, domain: 'time' },
            { label: 'repeat()', insert: 'repeat(2)', tooltip: 'repeat(n) - Loop targeted block', isModifier: true, domain: 'time' },
            { label: 'mirror()', insert: 'mirror()', tooltip: 'mirror() - Append mirrored copy', isModifier: true, domain: 'time' }
        ]
    ]
};



export function buildTrackDOM(track) {
    const lane = document.createElement('div');
    lane.className = 'track-lane';
    lane.dataset.trackId = track.id;

// Controls column
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
    volSlider.value = String(track.volume ?? 1);
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

    // Slice button + inline panel
    const sliceBtn = document.createElement('button');
    sliceBtn.className = 'btn-action btn-slice';
    sliceBtn.title = 'Detect slices';
    sliceBtn.textContent = '✂ Slice';

    const slicePanel = document.createElement('div');
    slicePanel.className = 'slice-panel';
    slicePanel.style.display = 'none';
    slicePanel.innerHTML = `
        <label class="slice-label">FFT
            <select class="slice-fft">
                <option value="512">512</option>
                <option value="1024" selected>1024</option>
                <option value="2048">2048</option>
                <option value="4096">4096</option>
            </select>
        </label>
        <label class="slice-label">
            <input type="radio" name="slice-type-${track.id}" value="percussion" checked> Perc
        </label>
        <label class="slice-label">
            <input type="radio" name="slice-type-${track.id}" value="melodic"> Mel
        </label>
        <button class="btn-detect">Detect</button>
        <button class="btn-clear-slices">✕</button>
    `;

    sliceBtn.addEventListener('click', () => {
        const isHidden = slicePanel.style.display === 'none';
        slicePanel.style.display = isHidden ? 'flex' : 'none';
        
        if (track.slices) {
            state.activeTrack = track;
            const editor = document.getElementById('sliceEditor');
            if (editor) {
                if (isHidden) {
                    updateSliceEditor(); // Opens it because activeTrack has slices
                } else {
                    editor.style.display = 'none'; // Explicitly hide it
                }
            }
        }
    });

    slicePanel.querySelector('.btn-detect').addEventListener('click', () => {
        if (!track.audioBuffer) return;
        const fftSize = parseInt(slicePanel.querySelector('.slice-fft').value, 10);
        const type    = slicePanel.querySelector(`input[name="slice-type-${track.id}"]:checked`).value;
        track.slices  = detectSlices(track.audioBuffer, fftSize, type);
        sliceBtn.classList.add('active');
        slicePanel.style.display = 'none';
        drawTrackWaveform(track);
        sendSlicesToWorklet(track);
        state.activeTrack = track;
        updateSliceEditor();
    });

    slicePanel.querySelector('.btn-clear-slices').addEventListener('click', () => {
        track.slices = null;
        sliceBtn.classList.remove('active');
        slicePanel.style.display = 'none';
        drawTrackWaveform(track);
        sendSlicesToWorklet(track);
        if (state.activeTrack === track) {
            updateSliceEditor();
        }
    });

    controls.append(header, btnsRow, waveCanvas, sliceBtn, slicePanel);

// Spectrogram column
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
    // The sibling canvases are TRACK_SPEC_W x TRACK_SPEC_H bitmaps that CSS
    // stretches to fill the stack. Without a viewBox the SVG would render its
    // contents 1:1 in CSS pixels instead of stretching with them, leaving the
    // region handles misaligned from the frequencies they mark. Aspect ratio is
    // unconstrained so the overlay tracks the canvases' non-uniform stretch.
    overlaySvg.setAttribute('viewBox', `0 0 ${TRACK_SPEC_W} ${TRACK_SPEC_H}`);
    overlaySvg.setAttribute('preserveAspectRatio', 'none');
    track.overlaySvg = overlaySvg;

    track.preImgData   = track.preCtx.createImageData(TRACK_SPEC_W, TRACK_SPEC_H);
    track.prePixels32  = new Uint32Array(track.preImgData.data.buffer);
    track.postImgData  = track.postCtx.createImageData(TRACK_SPEC_W, TRACK_SPEC_H);
    track.postPixels32 = new Uint32Array(track.postImgData.data.buffer);

    for (let i = 3; i < track.preImgData.data.length; i += 4) track.preImgData.data[i] = 255;

// Frequency axis is static content — drawn once here instead of every frame.
    const axisCanvas = document.createElement('canvas');
    axisCanvas.className = 'track-spec-axis';
    axisCanvas.width  = TRACK_SPEC_W;
    axisCanvas.height = TRACK_SPEC_H;
    axisCanvas.style.pointerEvents = 'none';
    drawFreqAxis(axisCanvas.getContext('2d'), TRACK_SPEC_W, TRACK_SPEC_H);

    specStack.append(preCanvas, postCanvas, axisCanvas, overlaySvg);

// Code column
    const codeWrap = document.createElement('div');
    codeWrap.className = 'track-code-wrap';

    const editorHost = document.createElement('div');
    editorHost.className = 'track-code';

    function selectLane() {
        state.selectedTrackId = track.id;
        state.tracks.forEach(t => {
            if (t.el) t.el.classList.toggle('active-lane', t.id === track.id);
        });
        trackNavigator.querySelectorAll('.nav-pill').forEach(p => {
            p.classList.toggle('active', p.dataset.trackId === track.id);
        });
    }

    // Reassigned once the suggestion-chip UI below is set up; forward-declared
    // here so it can be wired into the editor's cursor-activity callback.
    let handleKeyup = () => {};

    const codeView = createTrackCodeEditor(editorHost, {
        onApply: () => { selectLane(); applyTrackCode(track); },
        onChange: code => {
            track.code = code;
            scheduleSaveCode(track.name, code);
        },
        onCursorActivity: () => handleKeyup(),
    });
    track.codeView = codeView;

    let activeGroup = 'entries';
    let currentPage = 0;

    const chipsRow = document.createElement('div');
    chipsRow.className = 'snippet-chips';

    function getRandomSpec(method, totalSlices) {
        const grid = Math.min(totalSlices || 16, 32);
        const probs = [0.5, 0.6, 0.7, 0.8, 0.9, 1];
        const prob = probs[Math.floor(Math.random() * probs.length)];

        let spec = "0";
        if (method === '.at()') {
            const r = Math.random();
            if (r < 0.35) {
                spec = `${Math.floor(Math.random() * grid)}`;
            } else if (r < 0.60) {
                const count = Math.random() < 0.5 ? 2 : 3;
                const steps = new Set();
                while (steps.size < count) {
                    steps.add(Math.floor(Math.random() * grid));
                }
                spec = Array.from(steps).sort((a, b) => a - b).join(", ");
            } else if (r < 0.80) {
                const neg = Math.floor(Math.random() * Math.min(grid, 8)) + 1;
                spec = `-${neg}`;
            } else {
                const step = Math.min(grid, 16);
                const q = Math.max(2, Math.floor(step / 4));
                spec = `0:${q}, ${q * 2}:${Math.min(grid, q * 3)}`;
            }
        } else {
            const r = Math.random();
            const step = Math.min(grid, 16);
            const half = Math.floor(step / 2) || 4;
            const quarter = Math.floor(step / 4) || 2;
            if (r < 0.40) {
                const choices = [`:${quarter}`, `:${half}`, `${half}:`, `${step - quarter}:`];
                spec = choices[Math.floor(Math.random() * choices.length)];
            } else if (r < 0.75) {
                const starts = [0, quarter, half, step - quarter];
                const s = starts[Math.floor(Math.random() * starts.length)];
                const e = Math.min(grid, s + quarter * (Math.random() < 0.5 ? 1 : 2));
                spec = `${s}:${e}`;
            } else {
                spec = `:${quarter}, ${half}:${half + quarter}`;
            }
        }
        return { spec, prob };
    }

    function getRandomEvery(totalSlices, isChain) {
        const grid = Math.min(totalSlices || 16, 32);
        const cycleChoices = [2, 3, 4, 6, 8].filter(c => c <= Math.max(4, grid / 2));
        const cycles = cycleChoices[Math.floor(Math.random() * cycleChoices.length)] || 4;
        return isChain ? `.every(${cycles}, )` : `every(${cycles}, )`;
    }

    function insertSuggestion(item) {
        const val = getTrackCode(codeView);
        let textToInsert = item.insert;

        if (item.label === '.at()') {
            const totalSlices = state?.activeTrack?.slices?.length || 16;
            const { spec, prob } = getRandomSpec(item.label, totalSlices);
            textToInsert = `${item.label.slice(0, 3)}("${spec}", , ${prob})`;
        } else if (item.label === '.every()' || item.label === 'every()') {
            const totalSlices = state?.activeTrack?.slices?.length || 16;
            textToInsert = getRandomEvery(totalSlices, item.label.startsWith('.'));
        } else if (textToInsert.includes('\nseq("0:")') && hasSeqStatement(val)) {
            // Slice chips bundle a starter seq("0:"); drop it if one already exists.
            textToInsert = textToInsert.replace('\nseq("0:")', '');
        }

        if (item.isModifier) {
            const sel = codeView.state.selection.main;
            const start = sel.from;
            const end = sel.to;
            const newVal = val.slice(0, start) + textToInsert + val.slice(end);
            let newCursor;
            const emptyArg = textToInsert.indexOf(", )");
            if (emptyArg !== -1) {
                newCursor = start + emptyArg + 2;
            } else {
                const nextParen = newVal.indexOf(')', start + textToInsert.length);
                newCursor = nextParen !== -1 ? nextParen + 1 : start + textToInsert.length;
            }
            codeView.dispatch({
                changes: { from: start, to: end, insert: textToInsert },
                selection: { anchor: Math.max(0, Math.min(newCursor, newVal.length)) },
            });
        } else if (item.wrapNegate) {
            // Wraps the last non-empty line (the mask statement) in a complement.
            const lines = val.split('\n');
            let idx = lines.length - 1;
            while (idx >= 0 && !lines[idx].trim()) idx--;
            if (idx < 0) return;
            lines[idx] = `!(${lines[idx].trim()})`;
            const newVal = lines.join('\n');
            codeView.dispatch({
                changes: { from: 0, to: val.length, insert: newVal },
                selection: { anchor: newVal.length },
            });
        } else if (item.sameLine) {
            // Appends directly onto the end of the current (mask) line — no
            // leading dot, no new line, e.g. ` + high(4000)`.
            const trimmed = val.trimEnd();
            const newVal = trimmed + textToInsert;
            codeView.dispatch({
                changes: { from: 0, to: val.length, insert: newVal },
                selection: { anchor: newVal.length },
            });
        } else {
            let insertPos;
            let newVal;
            if (!val.trim()) {
                if (textToInsert.startsWith('.')) textToInsert = textToInsert.slice(1);
                newVal = textToInsert;
                insertPos = 0;
            } else if (textToInsert.startsWith('.')) {
                let trimmed = val.trimEnd();
                if (trimmed.endsWith(';')) trimmed = trimmed.slice(0, -1);
                const lines = trimmed.split('\n');
                const lastLine = lines[lines.length - 1] || '';
                if (item.domain === 'transform') {
                    const lastLineIsPipeline = TRANSFORM_METHOD_NAMES.some(name =>
                        new RegExp(`\\b${name}\\s*\\(`).test(lastLine));
                    if (lastLineIsPipeline) {
                        if (trimmed.endsWith('.')) textToInsert = textToInsert.slice(1);
                        insertPos = trimmed.length;
                        newVal = trimmed + textToInsert;
                    } else {
                        // Last line is a mask (or something else) — a transform
                        // pipeline must start on its own line, without the dot.
                        textToInsert = textToInsert.slice(1);
                        insertPos = trimmed.length + 1;
                        newVal = trimmed + '\n' + textToInsert;
                    }
                } else {
                    // Time domain operators (.on, .at) should chain directly
                    if (trimmed.endsWith('.')) textToInsert = textToInsert.slice(1);
                    insertPos = trimmed.length;
                    newVal = trimmed + textToInsert;
                }
            } else {
                let trimmed = val.trimEnd();
                insertPos = trimmed.length + 1;
                newVal = trimmed + '\n' + textToInsert;
            }
            let newCursor;
            const commaGap = textToInsert.indexOf(", , ");
            const emptyArg = textToInsert.indexOf(", )");
            if (commaGap !== -1) {
                newCursor = insertPos + commaGap + 2;
            } else if (emptyArg !== -1) {
                newCursor = insertPos + emptyArg + 2;
            } else {
                newCursor = insertPos + textToInsert.length + (item.offset || 0);
            }
            codeView.dispatch({
                changes: { from: 0, to: val.length, insert: newVal },
                selection: { anchor: Math.max(0, Math.min(newCursor, newVal.length)) },
            });
        }

        codeView.focus();
        handleKeyup();
    }

    function renderSuggestions() {
        chipsRow.innerHTML = '';
        const pages = SUGGESTION_GROUPS[activeGroup] || SUGGESTION_GROUPS.entries;
        const totalPages = pages.length;
        if (currentPage >= totalPages) currentPage = 0;

        const pageItems = pages[currentPage] || [];

        for (const item of pageItems) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `snippet-chip chip-${item.domain || 'rhythm'}`;
            chip.textContent = item.label;
            if (item.tooltip) chip.setAttribute('data-tooltip', item.tooltip);
            chip.addEventListener('click', () => insertSuggestion(item));
            chipsRow.appendChild(chip);
        }

        if (totalPages > 1) {
            const pageChip = document.createElement('button');
            pageChip.type = 'button';
            pageChip.className = 'snippet-chip chip-page';
            pageChip.textContent = `› (${currentPage + 1}/${totalPages})`;
            pageChip.setAttribute('data-tooltip', `Next page (${(currentPage + 1) % totalPages + 1}/${totalPages})`);
            pageChip.addEventListener('click', () => {
                currentPage = (currentPage + 1) % totalPages;
                renderSuggestions();
            });
            chipsRow.appendChild(pageChip);
        }
    }

    function switchGroup(group) {
        if (activeGroup !== group) {
            activeGroup = group;
            currentPage = 0;
            renderSuggestions();
        }
    }

    handleKeyup = function() {
        const textBefore = getTrackCode(codeView).slice(0, codeView.state.selection.main.head);
        if (/(?:\.(?:at|every)|every)\([^\)]*$/.test(textBefore)) {
            switchGroup('modifiers');
        } else if (/(?:seq|slicep|slicem|slicee|at|fast|slow)\b[^\n]*$/.test(textBefore)) {
            switchGroup('chain_pattern');
        } else if (/(?:band|harmonic|low|high|blur|sgranulate|scale|rotate|skew|transpose)\b[^\n]*$/.test(textBefore)) {
            switchGroup('chain_spectrum');
        } else if (!textBefore.trim()) {
            switchGroup('entries');
        }
    };

    renderSuggestions();
    const hint = document.createElement('span');
    hint.className = 'code-hint';
    hint.textContent = `${isMac ? 'cmd' : 'ctrl'}+enter to apply · dsl or raw js`;

    const errorSpan = document.createElement('span');
    errorSpan.className = 'code-error';
    track.errorSpan = errorSpan;

    codeWrap.append(chipsRow, editorHost, errorSpan, hint);

// Assemble lane
    lane.append(controls, specStack, codeWrap);
    trackLanes.appendChild(lane);
    track.el = lane;
    track.visible = true;
    laneVisibilityObserver.observe(lane);
}

export function unobserveTrackLane(track) {
    if (track.el) laneVisibilityObserver.unobserve(track.el);
}

// Apply DSL code to a track

export function applyTrackCode(track) {
    if (!state.playing) {
        startAllTracks();
    } else if (!track.isPlaying) {
        startSingleTrack(track);
    }

    state.activeTrack = track;

    const raw = getTrackCode(track.codeView).trim();
    // Reorder statements into canonical form and reflect back into the editor.
    const src = raw ? normalizeDSL(raw) : raw;
    if (src !== raw) setTrackCode(track.codeView, src);
    let { code, blur, clockMod, granulate, scale, rotate, skew, transpose, requiresCanvasPool, eval2D, seqIndices, fftSize, pendingSlice, error } = src
        ? tryCompileDSL(src)
        : { code: 'mag', blur: null, clockMod: null, granulate: null, scale: null, rotate: null, skew: null, transpose: null, requiresCanvasPool: false, eval2D: false, seqIndices: null, fftSize: null, pendingSlice: null, error: null };

    if (track.errorSpan) {
        if (error) {
            track.errorSpan.textContent = error;
            track.errorSpan.classList.add('visible');
            setEditorError(track.codeView, true);
            return;
        } else {
            track.errorSpan.textContent = '';
            track.errorSpan.classList.remove('visible');
            setEditorError(track.codeView, false);
        }
    }

    track.code = src;

    // Apply pendingSlice — permanently updates track slices and the visual slice editor only when first applied or changed
    if (pendingSlice && track.audioBuffer) {
        const sliceKey = `${pendingSlice.kind}-${pendingSlice.fftSize || pendingSlice.n}`;
        if (track.lastAppliedSliceKey !== sliceKey) {
            let newSlices = null;
            if (pendingSlice.kind === 'percussion' || pendingSlice.kind === 'melodic') {
                newSlices = detectSlices(track.audioBuffer, pendingSlice.fftSize, pendingSlice.kind);
            } else if (pendingSlice.kind === 'equal') {
                const total = track.audioBuffer.length;
                const n = Math.max(1, pendingSlice.n);
                const chunkSize = Math.floor(total / n);
                newSlices = [];
                for (let i = 0; i < n; i++) {
                    newSlices.push({
                        start: i * chunkSize,
                        end: i === n - 1 ? total : (i + 1) * chunkSize,
                    });
                }
            }
            if (newSlices) {
                track.slices = newSlices;
                track.lastAppliedSliceKey = sliceKey;
                const sliceBtn = track.el?.querySelector('.btn-slice');
                if (sliceBtn) sliceBtn.classList.add('active');
                drawTrackWaveform(track);
                sendSlicesToWorklet(track);
                state.activeTrack = track;
                updateSliceEditor();

                // Re-compile DSL now that track.slices is populated so seq() uses the true slice count
                const recompiled = tryCompileDSL(src);
                if (!recompiled.error) {
                    code = recompiled.code;
                    seqIndices = recompiled.seqIndices;
                    clockMod = recompiled.clockMod;
                    granulate = recompiled.granulate;
                    scale = recompiled.scale;
                    rotate = recompiled.rotate;
                    skew = recompiled.skew;
                    transpose = recompiled.transpose;
                    requiresCanvasPool = recompiled.requiresCanvasPool;
                    eval2D = recompiled.eval2D;
                }
            }
        }
    } else {
        track.lastAppliedSliceKey = null;
    }

    track.clockMod = clockMod;
    sendCompiledDSLToWorklet(track, {
        code, blur, clockMod, granulate, scale, rotate, skew, transpose,
        requiresCanvasPool, eval2D, seqIndices, fftSize,
    });

    try {
        const ast = src ? parse(src) : null;
        renderTrackOverlay(track, ast);
    } catch {
        renderTrackOverlay(track, null);
    }

    if (seqIndices && Array.isArray(seqIndices)) {
        const active = new Set();
        for (const s of seqIndices) {
            if (!s.muted && typeof s.sliceIndex === 'number') {
                active.add(s.sliceIndex);
            }
        }
        track.activeSliceIndices = active;
    } else {
        track.activeSliceIndices = null;
    }
    drawTrackWaveform(track);
    if (state.activeTrack === track) updateSliceEditor();
}
