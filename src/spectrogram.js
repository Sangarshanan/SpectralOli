import { UI_BANDS, TRACK_SPEC_W, TRACK_SPEC_H, DEFAULT_NYQUIST } from './constants.js';
import { LUTS } from './palette.js';
import { masterCanvas, masterStack, paletteSelect } from './dom.js';
import { state } from './state.js';

// Pre-computed pixel row bounds per frequency band, packed as [top, bottom] pairs.
function computeBandRows(height) {
    const rowH = height / UI_BANDS;
    const rows = new Int32Array(UI_BANDS * 2);
    for (let b = 0; b < UI_BANDS; b++) {
        rows[b * 2]     = Math.floor((UI_BANDS - 1 - b) * rowH);
        rows[b * 2 + 1] = Math.floor((UI_BANDS     - b) * rowH);
    }
    return rows;
}

const trackBandRows = computeBandRows(TRACK_SPEC_H);

// Master canvas init

export function initMasterCanvas() {
    const rect = masterStack.getBoundingClientRect();
    state.masterW = Math.floor(rect.width) || Math.max(900, window.innerWidth - 80);
    state.masterH = Math.floor(rect.height) || 220;
    masterCanvas.width  = state.masterW;
    masterCanvas.height = state.masterH;

    const ctx = masterCanvas.getContext('2d');
    state.masterImgData  = ctx.createImageData(state.masterW, state.masterH);
    state.masterPixels32 = new Uint32Array(state.masterImgData.data.buffer);

    state.masterVisData = Array.from({ length: state.masterW }, () => new Float32Array(UI_BANDS));
    state.masterVisHead = 0;
    state.masterBandRows = null;

// Frequency axis lives on its own static layer so it only needs to be
// redrawn on init/resize, not on every animation frame.
    if (!state.masterAxisCanvas) {
        state.masterAxisCanvas = document.createElement('canvas');
        state.masterAxisCanvas.className = 'master-axis-layer';
        state.masterAxisCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
        masterStack.appendChild(state.masterAxisCanvas);
    }
    state.masterAxisCanvas.width  = state.masterW;
    state.masterAxisCanvas.height = state.masterH;
    drawFreqAxis(state.masterAxisCanvas.getContext('2d'), state.masterW, state.masterH);
}

function ensureMasterBandRows() {
    if (state.masterBandRows) return;
    state.masterBandRows = computeBandRows(state.masterH);
}

// Frequency axis labels

export function drawFreqAxis(ctx, w, h) {
    const nyq   = state.audioCtx ? state.audioCtx.sampleRate / 2 : DEFAULT_NYQUIST;
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

// Per-track spectrogram

function drawTrackSpectrogram(track) {
    const lut      = LUTS[paletteSelect.value] || LUTS.matrix;
    const SW       = TRACK_SPEC_W;
    const SH       = TRACK_SPEC_H;
    const visHead  = track.visHead;
    const preData  = track.visPreData;
    const postData = track.visPostData;
    const timeCols = SW;

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
}

// Master spectrogram

function drawMasterSpectrogram() {
    if (!state.masterAnalyser || !state.masterImgData) return;

    const lut = LUTS[paletteSelect.value] || LUTS.matrix;
    ensureMasterBandRows();

    state.masterAnalyser.getFloatFrequencyData(state.masterFreqData);

    const col     = state.masterVisData[state.masterVisHead];
    col.fill(0);
    const binSize = state.masterFreqData.length / UI_BANDS;
    for (let b = 0; b < UI_BANDS; b++) {
        let maxVal = -Infinity;
        const start = Math.floor(b * binSize);
        const end   = Math.min(Math.floor((b + 1) * binSize), state.masterFreqData.length);
        for (let k = start; k < end; k++) {
            if (state.masterFreqData[k] > maxVal) maxVal = state.masterFreqData[k];
        }
        col[b] = Math.pow(10, Math.max(maxVal, -100) / 20);
    }
    state.masterVisHead = (state.masterVisHead + 1) % state.masterW;

    let maxMag = 0;
    for (let x = 0; x < state.masterW; x++) {
        const frame = state.masterVisData[x];
        for (let b = 0; b < UI_BANDS; b++) {
            if (frame[b] > maxMag) maxMag = frame[b];
        }
    }
    state.masterVizMax += (Math.max(maxMag, 0.001) - state.masterVizMax) * 0.05;

    state.masterPixels32.fill(0xFF000000);
    for (let x = 0; x < state.masterW; x++) {
        const frame = state.masterVisData[(state.masterVisHead + x) % state.masterW];
        for (let b = 0; b < UI_BANDS; b++) {
            const mag = frame[b];
            if (mag < 0.0001) continue;
            const ti    = Math.min(255, Math.floor(256 * Math.pow(mag / state.masterVizMax, 0.4)));
            const color = 0xFF000000 | (lut[ti * 3 + 2] << 16) | (lut[ti * 3 + 1] << 8) | lut[ti * 3];
            const yTop  = state.masterBandRows[b * 2];
            const yBot  = state.masterBandRows[b * 2 + 1];
            for (let row = yTop; row < yBot; row++) {
                if (row >= 0 && row < state.masterH) state.masterPixels32[row * state.masterW + x] = color;
            }
        }
    }

    const ctx = masterCanvas.getContext('2d');
    ctx.putImageData(state.masterImgData, 0, 0);
}

// Clock UI

let clockFillEl;

function updateClockUI() {
    if (!state.audioCtx) return;
    if (clockFillEl === undefined) clockFillEl = document.getElementById('global-clock-fill');
    if (!clockFillEl) return;
    const cyclesPerSecond = (state.bpm / 60) / state.beatsPerCycle;
    const masterPhase = (state.audioCtx.currentTime * cyclesPerSecond) % 1.0;
    clockFillEl.style.transform = `scaleX(${masterPhase})`;
}

// Animation loop
// Redraw is capped well below display refresh rate; spectrogram content changes
// on the order of STFT hops (~11ms), not every compositor frame, so 30fps reads
// identically while cutting redraw work roughly in half on 60/120Hz displays.
const REDRAW_INTERVAL_MS = 1000 / 30;
let lastDrawTime = 0;

export function drawLoop(now) {
    if (!state.rafRunning) return;

    if (now - lastDrawTime >= REDRAW_INTERVAL_MS) {
        lastDrawTime = now;
        updateClockUI();
        for (const track of state.tracks.values()) {
            if (!track.collapsed && track.visible !== false) drawTrackSpectrogram(track);
        }
        drawMasterSpectrogram();
    }
    requestAnimationFrame(drawLoop);
}
