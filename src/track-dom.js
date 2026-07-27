import { TRACK_SPEC_W, TRACK_SPEC_H, TRACK_WAVE_W, TRACK_WAVE_H } from './constants.js';
import { trackLanes, trackNavigator } from './dom.js';
import { state } from './state.js';
import { tryCompileDSL, parse } from './dsl.js';
import { setupWaveformDrag, drawTrackWaveform, sendSlicesToWorklet } from './waveform.js';
import { detectSlices } from './slicer.js';
import { updateSliceEditor } from './slice-editor.js';
import { renderTrackOverlay } from './overlay.js';
import { updateNavigator, toggleCollapse } from './navigator.js';
import { updateMuteSolo, startAllTracks, startSingleTrack } from './playback.js';
import { setMasterTrack, duplicateTrack, removeTrack } from './tracks.js';
import { isMac, isApplyShortcut } from './shortcuts.js';

// Track DOM builder

const SUGGESTION_GROUPS = {
    entries: [
        [
            { label: 'slicep()', insert: 'slicep(512)\nseq("0:")', tooltip: 'Percussive slicing (512 fft)', domain: 'rhythm' },
            { label: 'slicem()', insert: 'slicem(2048)\nseq("0:")', tooltip: 'Melodic slicing (2048 fft)', domain: 'rhythm' },
            { label: 'slicee()', insert: 'slicee(16)\nseq("0:")', tooltip: 'Equal-time slicing (16 slices)', domain: 'rhythm' }
        ],
        [
            { label: 'band()', insert: 'band(200, 4000)', tooltip: 'Filter freq band (Hz)', domain: 'spectrum' },
            { label: 'harmonic()', insert: 'harmonic(110, 6)', tooltip: 'Harmonic series filter', domain: 'spectrum' },
            { label: 'low()', insert: 'low(1000)', tooltip: 'Low-pass filter (< Hz)', domain: 'spectrum' },
            { label: 'high()', insert: 'high(2000)', tooltip: 'High-pass filter (> Hz)', domain: 'spectrum' }
        ]
    ],
    chain: [
        [
            { label: '.on()', insert: '.on("0:4", , 0.5)', tooltip: 'Modify matching step range', offset: -6, domain: 'rhythm' },
            { label: '.at()', insert: '.at("0", , 0.5)', tooltip: 'Modify step indices', offset: -6, domain: 'rhythm' },
            { label: '.every()', insert: '.every(4, )', tooltip: 'Run every n-th cycle', domain: 'rhythm' },
            { label: '.fast()', insert: '.fast(2)', tooltip: 'Speed up sequence loop', domain: 'rhythm' },
            { label: '.slow()', insert: '.slow(2)', tooltip: 'Slow down sequence loop', domain: 'rhythm' }
        ],
        [
            { label: '.blur()', insert: '.blur(0.3, 0.5)', tooltip: 'Spectral time/freq blur', domain: 'spectrum' },
            { label: '.sgranulate()', insert: '.sgranulate(0.5, 0.8)', tooltip: 'Spectral granulation', domain: 'spectrum' },
            { label: '.scale()', insert: '.scale(1.5, 1.0)', tooltip: 'Scale freq & amplitude', domain: 'spectrum' },
            { label: '.rotate()', insert: '.rotate(45)', tooltip: 'Rotate spectrum (deg, mix)', domain: 'spectrum' },
            { label: '.skew()', insert: '.skew(0.5, 0.0)', tooltip: 'Skew freq across time', domain: 'spectrum' }
        ],
        [
            { label: '.transpose()', insert: '.transpose(12)', tooltip: 'Pitch shift (semitones)', domain: 'spectrum' },
            { label: '.add()', insert: '.add(high(4000))', tooltip: 'Add filter spectrum', domain: 'spectrum' },
            { label: '.sub()', insert: '.sub(band(800, 1200))', tooltip: 'Subtract filter spectrum', domain: 'spectrum' },
            { label: '.invert()', insert: '.invert()', tooltip: 'Invert spectral magnitudes', domain: 'spectrum' }
        ]
    ],
    modifiers: [
        [
            { label: 'stutter()', insert: 'stutter(2)', tooltip: 'Repeat step n times', isModifier: true, domain: 'rhythm' },
            { label: 'silence()', insert: 'silence()', tooltip: 'Mute targeted steps', isModifier: true, domain: 'rhythm' },
            { label: 'reverse()', insert: 'reverse()', tooltip: 'Reverse step audio', isModifier: true, domain: 'rhythm' },
            { label: 'every()', insert: 'every(2, )', tooltip: 'Run every n-th cycle', isModifier: true, domain: 'rhythm' },
            { label: 'euclid()', insert: 'euclid(3, 8)', tooltip: 'Euclidean rhythm generator', isModifier: true, domain: 'rhythm' }
        ],
        [
            { label: 'shuffle()', insert: 'shuffle()', tooltip: 'Randomize step order', isModifier: true, domain: 'rhythm' },
            { label: 'repeat()', insert: 'repeat(2)', tooltip: 'Loop targeted block', isModifier: true, domain: 'rhythm' },
            { label: 'mirror()', insert: 'mirror()', tooltip: 'Append mirrored copy', isModifier: true, domain: 'rhythm' }
        ]
    ]
};

function highlightCode(code) {
    let text = code;
    if (text.endsWith('\n')) text += ' ';
    let escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tokenRegex = /(\b(?:seq|slicep|slicem|slicee|on|at|stutter|euclid|every|mirror|reverse|shuffle|silence|repeat|fast|slow|rev|within)\b)|(\b(?:band|low|high|harmonic|blur|sgranulate|add|sub|invert|gain|scale|rotate|skew|transpose|mag)\b)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b(?:Math|sin|cos|abs|round|time|freq)\b)|(\/\/.*$)/gm;

    return escaped.replace(tokenRegex, (match, rhythm, spectrum, str, num, math, comment) => {
        if (rhythm) return `<span class="hl-rhythm">${rhythm}</span>`;
        if (spectrum) return `<span class="hl-spectrum">${spectrum}</span>`;
        if (str) return `<span class="hl-string">${str}</span>`;
        if (num) return `<span class="hl-number">${num}</span>`;
        if (math) return `<span class="hl-math">${math}</span>`;
        if (comment) return `<span class="hl-comment">${comment}</span>`;
        return match;
    });
}

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
    track.overlaySvg = overlaySvg;

    track.preImgData   = track.preCtx.createImageData(TRACK_SPEC_W, TRACK_SPEC_H);
    track.prePixels32  = new Uint32Array(track.preImgData.data.buffer);
    track.postImgData  = track.postCtx.createImageData(TRACK_SPEC_W, TRACK_SPEC_H);
    track.postPixels32 = new Uint32Array(track.postImgData.data.buffer);

    for (let i = 3; i < track.preImgData.data.length; i += 4) track.preImgData.data[i] = 255;

    specStack.append(preCanvas, postCanvas, overlaySvg);

// Code column
    const codeWrap = document.createElement('div');
    codeWrap.className = 'track-code-wrap';

    function createEditor(placeholder, rows = 3) {
        const wrap = document.createElement('div');
        wrap.className = 'code-editor-wrapper';

        const backdrop = document.createElement('pre');
        backdrop.className = 'syntax-backdrop';
        const backdropCode = document.createElement('code');
        backdropCode.className = 'syntax-code';
        backdrop.appendChild(backdropCode);

        const textarea = document.createElement('textarea');
        textarea.className = 'track-code';
        textarea.rows = rows;
        textarea.spellcheck = false;
        textarea.autocomplete = 'off';
        textarea.placeholder = placeholder;

        function updateHighlight() {
            if (!textarea.value) {
                backdropCode.innerHTML = `<span style="color: #2a3a2e">${textarea.placeholder}</span>`;
            } else {
                backdropCode.innerHTML = highlightCode(textarea.value);
            }
        }

        textarea.addEventListener('input', updateHighlight);
        textarea.addEventListener('scroll', () => {
            backdrop.scrollTop = textarea.scrollTop;
            backdrop.scrollLeft = textarea.scrollLeft;
        });

        const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        Object.defineProperty(textarea, 'value', {
            get() { return desc.get.call(this); },
            set(val) {
                desc.set.call(this, val);
                updateHighlight();
            }
        });

        updateHighlight();
        wrap.append(backdrop, textarea);
        return { wrap, textarea, updateHighlight };
    }

    const codeBox = createEditor('slicep(512); seq(":16").fast(2)\nband(200, 4000).blur(0.5)', 4);
    const textarea = codeBox.textarea;
    track.codeTextarea = textarea;

    const handleKeydown = (textarea, e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end   = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 2;
            return;
        }
        if (isApplyShortcut(e)) {
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
    };

    textarea.addEventListener('keydown', e => handleKeydown(textarea, e));

    const hint = document.createElement('span');
    hint.className = 'code-hint';
    hint.textContent = `${isMac ? 'cmd' : 'ctrl'}+enter to apply · dsl or raw js`;

    const errorSpan = document.createElement('span');
    errorSpan.className = 'code-error';
    track.errorSpan = errorSpan;

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
        let val = textarea.value;
        let textToInsert = item.insert;

        if (item.label === '.on()' || item.label === '.at()') {
            const totalSlices = state?.activeTrack?.slices?.length || 16;
            const { spec, prob } = getRandomSpec(item.label, totalSlices);
            textToInsert = `${item.label.slice(0, 3)}("${spec}", , ${prob})`;
        } else if (item.label === '.every()' || item.label === 'every()') {
            const totalSlices = state?.activeTrack?.slices?.length || 16;
            textToInsert = getRandomEvery(totalSlices, item.label.startsWith('.'));
        }

        if (item.isModifier) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = val.slice(0, start) + textToInsert + val.slice(end);
            const emptyArg = textToInsert.indexOf(", )");
            if (emptyArg !== -1) {
                const newCursor = start + emptyArg + 2;
                textarea.selectionStart = textarea.selectionEnd = newCursor;
            } else {
                const nextParen = textarea.value.indexOf(')', start + textToInsert.length);
                const newCursor = nextParen !== -1 ? nextParen + 1 : start + textToInsert.length;
                textarea.selectionStart = textarea.selectionEnd = newCursor;
            }
        } else {
            let insertPos;
            if (!val.trim()) {
                if (textToInsert.startsWith('.')) textToInsert = textToInsert.slice(1);
                textarea.value = textToInsert;
                insertPos = 0;
            } else if (textToInsert.startsWith('.')) {
                let trimmed = val.trimEnd();
                if (trimmed.endsWith(';')) trimmed = trimmed.slice(0, -1);
                if (trimmed.endsWith('.')) textToInsert = textToInsert.slice(1);
                insertPos = trimmed.length;
                textarea.value = trimmed + textToInsert;
            } else {
                let trimmed = val.trimEnd();
                insertPos = trimmed.length + 1;
                textarea.value = trimmed + '\n' + textToInsert;
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
            textarea.selectionStart = textarea.selectionEnd = newCursor;
        }

        textarea.focus();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
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

    function handleKeyup() {
        const textBefore = textarea.value.slice(0, textarea.selectionStart);
        if (/(?:\.(?:on|at|every)|every)\([^\)]*$/.test(textBefore)) {
            switchGroup('modifiers');
        } else if (/(?:seq|slicep|slicem|slicee|on|at|fast|slow|rev|band|harmonic|low|high|blur|sgranulate|add|sub|scale|rotate|skew|transpose|gain|invert)\b[^\n]*$/.test(textBefore)) {
            switchGroup('chain');
        } else if (!textBefore.trim()) {
            switchGroup('entries');
        }
    }

    textarea.addEventListener('keyup', handleKeyup);
    textarea.addEventListener('click', handleKeyup);

    renderSuggestions();

    codeWrap.append(chipsRow, codeBox.wrap, errorSpan, hint);

// Assemble lane
    lane.append(controls, specStack, codeWrap);
    trackLanes.appendChild(lane);
    track.el = lane;
}

// Apply DSL code to a track

export function applyTrackCode(track) {
    if (!state.playing) {
        startAllTracks();
    } else if (!track.isPlaying) {
        startSingleTrack(track);
    }

    state.activeTrack = track;

    const src = track.codeTextarea.value.trim();
    let { code, blur, clockMod, granulate, scale, rotate, skew, transpose, seqIndices, fftSize, pendingSlice, error } = src
        ? tryCompileDSL(src)
        : { code: 'mag', blur: null, clockMod: null, granulate: null, scale: null, rotate: null, skew: null, transpose: null, seqIndices: null, fftSize: null, pendingSlice: null, error: null };

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
                }
            }
        }
    } else {
        track.lastAppliedSliceKey = null;
    }

    track.clockMod = clockMod;
    track.workletNode?.port.postMessage({ type: 'updateFFT', size: fftSize ?? 1024 });
    track.workletNode?.port.postMessage({
        type: 'updateClockMod',
        clockMod: clockMod || { speedMultiplier: 1.0, isReversed: false },
    });
    track.workletNode?.port.postMessage({ type: 'updateCode', code });
    track.workletNode?.port.postMessage({
        type: 'updateBlur',
        freqAmt: blur?.freqAmt ?? 0,
        timeAmt: blur?.timeAmt ?? 0,
    });
    track.workletNode?.port.postMessage({ type: 'updateGranulate', params: granulate ?? null });
    track.workletNode?.port.postMessage({ type: 'updateScale', params: scale ?? null });
    track.workletNode?.port.postMessage({ type: 'updateRotate', params: rotate ?? null });
    track.workletNode?.port.postMessage({ type: 'updateSkew', params: skew ?? null });
    track.workletNode?.port.postMessage({ type: 'updateTranspose', params: transpose ?? null });
    track.workletNode?.port.postMessage({ type: 'updateSeq', indices: seqIndices ?? null });

    try {
        const ast = src ? parse(src) : null;
        renderTrackOverlay(track, ast?.type === 'Blur' ? null : ast);
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
