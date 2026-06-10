import { tryCompileDSL, parse, serialize } from './dsl.js';

const playBtn       = document.getElementById('playBtn');
const codeInput     = document.getElementById('codeInput');
const paletteSelect = document.getElementById('paletteSelect');
const statusText    = document.getElementById('statusText');
const waveCanvas    = document.getElementById('waveform');
const preCanvas     = document.getElementById('spectrogramPre');
const postCanvas    = document.getElementById('spectrogramPost');
const overlaySvg    = document.getElementById('overlaysvg');
const wCtx          = waveCanvas.getContext('2d');
const preCtx        = preCanvas.getContext('2d');
const postCtx       = postCanvas.getContext('2d');

const UI_BANDS  = 256;
const SW        = preCanvas.width;   // 820
const SH        = preCanvas.height;  // 600
const WW        = waveCanvas.width;  // 820
const WH        = waveCanvas.height; // 72
const TIME_COLS = SW;                // 1 column = 1 pixel

let audioCtx, workletNode, sourceNode, audioBuffer;
let loopStartRatio = 0;
let loopEndRatio   = 1;
let playing    = false;
let rafRunning = false;

// ─── Circular visualization buffers (pre = raw FFT, post = after DSL) ────
let visHead = 0;
const visPreData  = Array.from({ length: TIME_COLS }, () => new Float32Array(UI_BANDS));
const visPostData = Array.from({ length: TIME_COLS }, () => new Float32Array(UI_BANDS));

// ─── Palette LUTs ─────────────────────────────────────────────────────────
// Each palette is an array of [position, [r, g, b]] colour stops.
const STOPS = {
    matrix:  [[0,[0,0,0]],[0.4,[0,70,0]],[0.75,[0,190,30]],[1,[130,255,100]]],
    heatmap: [[0,[0,0,0]],[0.25,[175,0,0]],[0.52,[255,80,0]],[0.78,[255,215,0]],[1,[255,255,255]]],
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

// ─── Waveform canvas ───────────────────────────────────────────────────────
function drawWaveform() {
    wCtx.fillStyle = '#090909';
    wCtx.fillRect(0, 0, WW, WH);

    if (!audioBuffer) return;

    const data        = audioBuffer.getChannelData(0);
    const samplesPerPx = data.length / WW;

    // Loop region shade
    const sx = Math.round(loopStartRatio * WW);
    const ex = Math.round(loopEndRatio * WW);
    wCtx.fillStyle = 'rgba(255,255,255,0.055)';
    wCtx.fillRect(sx, 0, ex - sx, WH);

    // Centre line
    wCtx.strokeStyle = '#1c1c1c';
    wCtx.lineWidth = 1;
    wCtx.beginPath();
    wCtx.moveTo(0, WH / 2);
    wCtx.lineTo(WW, WH / 2);
    wCtx.stroke();

    // Min-max waveform per pixel column
    wCtx.strokeStyle = '#383838';
    wCtx.lineWidth = 1;
    wCtx.beginPath();
    for (let x = 0; x < WW; x++) {
        const i0 = Math.floor(x * samplesPerPx);
        const i1 = Math.min(Math.floor((x + 1) * samplesPerPx), data.length - 1);
        let lo = 1, hi = -1;
        for (let s = i0; s <= i1; s++) {
            if (data[s] < lo) lo = data[s];
            if (data[s] > hi) hi = data[s];
        }
        const yTop = (1 - hi) / 2 * WH;
        const yBot = (1 - lo) / 2 * WH;
        wCtx.moveTo(x + 0.5, yTop);
        wCtx.lineTo(x + 0.5, yBot);
    }
    wCtx.stroke();

    // Loop handles  [start=green, end=orange]
    [[sx, '#00cc55', 'S'], [ex, '#ff8800', 'E']].forEach(([hx, col, lbl]) => {
        wCtx.fillStyle = col;
        wCtx.fillRect(hx - 1, 0, 2, WH);
        wCtx.fillRect(hx - 7, 0, 14, 16);
        wCtx.fillStyle = '#000';
        wCtx.font = 'bold 9px monospace';
        wCtx.textAlign = 'center';
        wCtx.textBaseline = 'top';
        wCtx.fillText(lbl, hx, 3);
    });
}

// ─── Waveform drag logic ───────────────────────────────────────────────────
let dragging = null;

function pointerRatio(e) {
    const r = waveCanvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / WW));
}

waveCanvas.addEventListener('mousedown', e => {
    const r  = pointerRatio(e);
    const ds = Math.abs(r - loopStartRatio) * WW;
    const de = Math.abs(r - loopEndRatio)   * WW;
    dragging = ds < de ? 'start' : 'end';
    e.preventDefault();
});

waveCanvas.addEventListener('mousemove', e => {
    if (dragging) return;
    const r  = pointerRatio(e);
    const ds = Math.abs(r - loopStartRatio) * WW;
    const de = Math.abs(r - loopEndRatio)   * WW;
    waveCanvas.style.cursor = (ds < 12 || de < 12) ? 'col-resize' : 'default';
});

window.addEventListener('mousemove', e => {
    if (dragging) {
        const r = pointerRatio(e);
        if (dragging === 'start') loopStartRatio = Math.min(r, loopEndRatio - 0.005);
        else                      loopEndRatio   = Math.max(r, loopStartRatio + 0.005);
        if (sourceNode && audioBuffer) {
            sourceNode.loopStart = loopStartRatio * audioBuffer.duration;
            sourceNode.loopEnd   = loopEndRatio   * audioBuffer.duration;
        }
        drawWaveform();
    } else if (svgDrag) {
        handleSvgDragMove(e);
    }
});

window.addEventListener('mouseup', () => {
    dragging = null;
    if (svgDrag) handleSvgDragEnd();
});

// ─── Audio setup ───────────────────────────────────────────────────────────
async function loadAudio() {
    try {
        const resp = await fetch('/media/break.wav');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const raw   = await resp.arrayBuffer();
        audioCtx    = new (window.AudioContext || window.webkitAudioContext)();
        audioBuffer = await audioCtx.decodeAudioData(raw);
        drawWaveform();
        await setupAudioGraph();
        playBtn.disabled = false;
        statusText.textContent =
            `${audioBuffer.duration.toFixed(2)}s · ${audioBuffer.sampleRate} Hz · drag handles to set loop`;
    } catch (err) {
        statusText.textContent = `Error: ${err.message}`;
    }
}

playBtn.addEventListener('click', () => {
    if (playing) stopPlayback();
    else         startPlayback();
});

codeInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        if (!playing) startPlayback();
        const src  = codeInput.value.trim();
        const { code, blur } = src ? tryCompileDSL(src) : { code: 'mag', blur: null };
        workletNode?.port.postMessage({ type: 'updateCode', code });
        workletNode?.port.postMessage({ type: 'updateBlur', freqAmt: blur?.freqAmt ?? 0, timeAmt: blur?.timeAmt ?? 0 });
        try {
            const ast = src ? parse(src) : null;
            renderOverlay(ast?.type === 'Blur' ? null : ast);
        } catch { renderOverlay(null); }
    }
});

function startPlayback() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    sourceNode           = audioCtx.createBufferSource();
    sourceNode.buffer    = audioBuffer;
    sourceNode.loop      = true;
    sourceNode.loopStart = loopStartRatio * audioBuffer.duration;
    sourceNode.loopEnd   = loopEndRatio   * audioBuffer.duration;
    sourceNode.connect(workletNode);
    sourceNode.start(0, loopStartRatio * audioBuffer.duration);
    playing = true;
    playBtn.textContent = '■ Stop';
    if (!rafRunning) { rafRunning = true; requestAnimationFrame(drawSpectrogram); }
}

function stopPlayback() {
    sourceNode.stop();
    sourceNode.disconnect();
    playing = false;
    playBtn.textContent = '▶ Play';
}

async function setupAudioGraph() {
    await audioCtx.audioWorklet.addModule('/spectral-worklet.js');

    workletNode = new AudioWorkletNode(audioCtx, 'spectral-coder-processor', {
        outputChannelCount: [1],
    });

    workletNode.port.onmessage = ({ data }) => {
        if (data.type === 'render') {
            visPreData[visHead].set(data.preArray);
            visPostData[visHead].set(data.postArray);
            visHead = (visHead + 1) % TIME_COLS;
        }
    };

    workletNode.connect(audioCtx.destination);
    workletNode.port.postMessage({ type: 'updateCode', code: codeInput.value });
}

function drawFreqAxis() {
    const nyq   = audioCtx ? audioCtx.sampleRate / 2 : 22050;
    const ticks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    postCtx.save();
    postCtx.font = '8px monospace';
    postCtx.textAlign = 'right';
    postCtx.textBaseline = 'middle';
    for (const hz of ticks) {
        if (hz > nyq) continue;
        const y = SH * (1 - hz / nyq);
        postCtx.strokeStyle = 'rgba(255,255,255,0.06)';
        postCtx.lineWidth = 1;
        postCtx.setLineDash([2, 8]);
        postCtx.beginPath(); postCtx.moveTo(0, y); postCtx.lineTo(SW, y); postCtx.stroke();
        postCtx.setLineDash([]);
        postCtx.fillStyle = 'rgba(255,255,255,0.25)';
        postCtx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, SW - 4, y);
    }
    postCtx.restore();
}

// ─── Spectrogram: dual ImageData (Layer 0 = pre grayscale, Layer 1 = post colored) ─
const preImgData   = preCtx.createImageData(SW, SH);
const prePixels32  = new Uint32Array(preImgData.data.buffer);
const postImgData  = postCtx.createImageData(SW, SH);
const postPixels32 = new Uint32Array(postImgData.data.buffer);
let   vizMaxPre = 1;
let   vizMax    = 1;

// Pre-fill pre canvas alpha to 255 (always opaque black background).
for (let i = 3; i < preImgData.data.length; i += 4) preImgData.data[i] = 255;
// Post canvas alpha is written per-pixel each frame (transparent where signal = 0).

// Pre-compute pixel row bounds per frequency band.
const rowH     = SH / UI_BANDS;
const bandRows = new Int32Array(UI_BANDS * 2);
for (let b = 0; b < UI_BANDS; b++) {
    bandRows[b * 2]     = Math.floor((UI_BANDS - 1 - b) * rowH); // yTop
    bandRows[b * 2 + 1] = Math.floor((UI_BANDS     - b) * rowH); // yBot
}

function drawSpectrogram() {
    const lut = LUTS[paletteSelect.value] || LUTS.heatmap;

    // ── Auto-scale: track peak across both buffers ───────────────────────
    let preMax = 0, postMax = 0;
    for (let x = 0; x < TIME_COLS; x++) {
        const pre = visPreData[x], post = visPostData[x];
        for (let b = 0; b < UI_BANDS; b++) {
            if (pre[b]  > preMax)  preMax  = pre[b];
            if (post[b] > postMax) postMax = post[b];
        }
    }
    vizMaxPre += (Math.max(preMax,  0.01) - vizMaxPre) * 0.05;
    vizMax    += (Math.max(postMax, 0.01) - vizMax)    * 0.05;

    // ── Layer 0: pre-FX grayscale, opaque black background ──────────────
    prePixels32.fill(0xFF000000);
    for (let x = 0; x < TIME_COLS; x++) {
        const frame = visPreData[(visHead + x) % TIME_COLS];
        for (let b = 0; b < UI_BANDS; b++) {
            const mag = frame[b];
            if (mag < 0.0001) continue;
            const g     = Math.min(255, Math.floor(256 * Math.pow(mag / vizMaxPre, 0.4)));
            const color = 0xFF000000 | (g << 16) | (g << 8) | g;
            const yTop  = bandRows[b * 2];
            const yBot  = bandRows[b * 2 + 1];
            for (let row = yTop; row < yBot; row++) prePixels32[row * SW + x] = color;
        }
    }
    preCtx.putImageData(preImgData, 0, 0);

    // ── Layer 1: post-FX colored, transparent where signal = 0 ──────────
    // CSS mix-blend-mode: screen composites this with Layer 0.
    // Cut bins are transparent → Layer 0 grey shows through (shadow).
    // Boosted bins are brighter than grey → spike in color.
    postPixels32.fill(0); // transparent black
    for (let x = 0; x < TIME_COLS; x++) {
        const frame = visPostData[(visHead + x) % TIME_COLS];
        for (let b = 0; b < UI_BANDS; b++) {
            const mag = frame[b];
            if (mag < 0.0001) continue;
            const ti    = Math.min(255, Math.floor(256 * Math.pow(mag / vizMax, 0.4)));
            const color = 0xFF000000 | (lut[ti * 3 + 2] << 16) | (lut[ti * 3 + 1] << 8) | lut[ti * 3];
            const yTop  = bandRows[b * 2];
            const yBot  = bandRows[b * 2 + 1];
            for (let row = yTop; row < yBot; row++) postPixels32[row * SW + x] = color;
        }
    }
    postCtx.putImageData(postImgData, 0, 0);
    drawFreqAxis();

    requestAnimationFrame(drawSpectrogram);
}

// ─── Frequency ↔ Y coordinate ─────────────────────────────────────────────
function freqToY(hz) {
    const nyq = audioCtx ? audioCtx.sampleRate / 2 : 22050;
    return SH * (1 - Math.max(0, Math.min(hz / nyq, 1)));
}
function yToFreq(y) {
    const nyq = audioCtx ? audioCtx.sampleRate / 2 : 22050;
    return Math.max(0, Math.round((1 - y / SH) * nyq));
}

// ─── SVG overlay: DSL regions as colored shapes, draggable handles ────────
const OVERLAY_COLORS = ['#ff3c6e', '#00e5ff', '#aaff00', '#ff9500'];
let currentAst = null;
let overlayRaf = null;
let svgDrag    = null;

function regionGeom(node) {
    switch (node.name) {
        case 'band':  return { yTop: freqToY(node.args[1]), yBot: freqToY(node.args[0]) };
        case 'low':   return { yTop: freqToY(node.args[0]), yBot: SH };
        case 'high':  return { yTop: 0,                     yBot: freqToY(node.args[0]) };
        case 'notch': return { yTop: freqToY(node.args[1]), yBot: freqToY(node.args[0]) };
        default:      return { yTop: 0, yBot: SH };
    }
}

// Which handles (draggable edges) does each region type expose?
function getHandleDefs(node) {
    switch (node.name) {
        case 'band':  return [{ argIdx: 1, edge: 'top' }, { argIdx: 0, edge: 'bot' }];
        case 'low':   return [{ argIdx: 0, edge: 'top' }];
        case 'high':  return [{ argIdx: 0, edge: 'bot' }];
        case 'notch': return [{ argIdx: 1, edge: 'top' }, { argIdx: 0, edge: 'bot' }];
        default:      return [];
    }
}

function renderOverlay(ast) {
    if (overlayRaf !== null) { cancelAnimationFrame(overlayRaf); overlayRaf = null; }
    while (overlaySvg.firstChild) overlaySvg.removeChild(overlaySvg.firstChild);
    currentAst = ast;
    if (!ast) return;

    // Collect all regions: base + any .add() args
    const regions = [{ node: ast.base, chainPos: 'base' }];
    for (let i = 0; i < ast.chain.length; i++) {
        if (ast.chain[i].method === 'add') regions.push({ node: ast.chain[i].args[0], chainPos: i });
    }

    regions.forEach(({ node, chainPos }, ci) => {
        // Dynamic args (containing 'time'/'freq') have no fixed boundary to draw
        if (node.args.some(a => typeof a !== 'number')) return;

        const color  = OVERLAY_COLORS[ci % OVERLAY_COLORS.length];
        const cpStr  = String(chainPos);
        const { yTop, yBot } = regionGeom(node);

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
        overlaySvg.appendChild(rect);

        // Draggable edge handles — visible dashed line + invisible wide hit-area line
        for (const { argIdx, edge } of getHandleDefs(node)) {
            const y    = edge === 'top' ? yTop : yBot;

            // Visible dashed line (decorative only, no pointer events)
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', 0); line.setAttribute('x2', SW);
            line.setAttribute('y1', y); line.setAttribute('y2', y);
            line.setAttribute('stroke', color);
            line.setAttribute('stroke-width', '2');
            line.setAttribute('stroke-dasharray', '6 4');
            line.style.pointerEvents = 'none';
            line.dataset.chainPos = cpStr;
            overlaySvg.appendChild(line);

            // Wide transparent hit-area line (captures mouse events)
            const hit = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            hit.setAttribute('x1', 0); hit.setAttribute('x2', SW);
            hit.setAttribute('y1', y); hit.setAttribute('y2', y);
            hit.setAttribute('stroke', 'transparent');
            hit.setAttribute('stroke-width', '20');
            hit.style.cursor = 'ns-resize';
            hit.dataset.chainPos = cpStr;
            hit.dataset.argIdx   = argIdx;
            hit.addEventListener('mousedown', e => {
                e.preventDefault();
                svgDrag = {
                    line,
                    hit,
                    chainPos,
                    argIdx,
                    ast: JSON.parse(JSON.stringify(currentAst)),
                };
            });
            overlaySvg.appendChild(hit);
        }
    });

}

function handleSvgDragMove(e) {
    const bounds = overlaySvg.getBoundingClientRect();
    const y  = Math.max(0, Math.min(SH, e.clientY - bounds.top));
    const hz = yToFreq(y);

    // Update the dragged argument in the working AST copy
    const target = svgDrag.chainPos === 'base'
        ? svgDrag.ast.base
        : svgDrag.ast.chain[svgDrag.chainPos].args[0];
    target.args[svgDrag.argIdx] = hz;

    // Update code input live (no audio recompile yet)
    codeInput.value = serialize(svgDrag.ast);

    // Update both the visible line and the hit-area line
    svgDrag.line.setAttribute('y1', y);
    svgDrag.line.setAttribute('y2', y);
    svgDrag.hit.setAttribute('y1', y);
    svgDrag.hit.setAttribute('y2', y);

    // Update the region rect
    const { yTop, yBot } = regionGeom(target);
    const rect = overlaySvg.querySelector(`rect[data-chain-pos="${svgDrag.chainPos}"]`);
    if (rect) {
        rect.setAttribute('y', yTop);
        rect.setAttribute('height', Math.max(0, yBot - yTop));
    }
}

function handleSvgDragEnd() {
    // Commit on mouseup: update currentAst, re-render overlay, fire audio update
    currentAst = svgDrag.ast;
    renderOverlay(currentAst);
    const { code, blur } = tryCompileDSL(codeInput.value);
    workletNode?.port.postMessage({ type: 'updateCode', code });
    workletNode?.port.postMessage({ type: 'updateBlur', freqAmt: blur?.freqAmt ?? 0, timeAmt: blur?.timeAmt ?? 0 });
    svgDrag = null;
}

loadAudio();