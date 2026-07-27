import { UI_BANDS, TRACK_SPEC_W, TRACK_SPEC_H } from './constants.js';
import { LUTS } from './palette.js';
import { masterCanvas, masterStack, paletteSelect } from './dom.js';
import { state } from './state.js';

// Pre-computed pixel row bounds per frequency band (track spectrograms)
const trackRowH = TRACK_SPEC_H / UI_BANDS;
const trackBandRows = new Int32Array(UI_BANDS * 2);
for (let b = 0; b < UI_BANDS; b++) {
    trackBandRows[b * 2]     = Math.floor((UI_BANDS - 1 - b) * trackRowH);
    trackBandRows[b * 2 + 1] = Math.floor((UI_BANDS     - b) * trackRowH);
}

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
}

function ensureMasterBandRows() {
    if (state.masterBandRows) return;
    const rowH = state.masterH / UI_BANDS;
    state.masterBandRows = new Int32Array(UI_BANDS * 2);
    for (let b = 0; b < UI_BANDS; b++) {
        state.masterBandRows[b * 2]     = Math.floor((UI_BANDS - 1 - b) * rowH);
        state.masterBandRows[b * 2 + 1] = Math.floor((UI_BANDS     - b) * rowH);
    }
}

// Frequency axis labels

function drawFreqAxis(ctx, w, h) {
    const nyq   = state.audioCtx ? state.audioCtx.sampleRate / 2 : 22050;
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

    drawFreqAxis(track.postCtx, SW, SH);
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
    drawFreqAxis(ctx, state.masterW, state.masterH);
}

// Clock UI

function updateClockUI() {
    if (!state.audioCtx) return;
    const cyclesPerSecond = (state.bpm / 60) / state.beatsPerCycle;
    const masterPhase = (state.audioCtx.currentTime * cyclesPerSecond) % 1.0;
    const fill = document.getElementById('global-clock-fill');
    if (fill) fill.style.width = `${masterPhase * 100}%`;
}

// Animation loop

export function drawLoop() {
    updateClockUI();
    for (const track of state.tracks.values()) {
        if (!track.collapsed) drawTrackSpectrogram(track);
    }
    drawMasterSpectrogram();
    requestAnimationFrame(drawLoop);
}
