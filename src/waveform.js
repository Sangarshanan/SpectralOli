import { state } from './state.js';

// ─── Waveform drawing ──────────────────────────────────────────────────────────

export function drawTrackWaveform(track) {
    const { waveCtx, waveCanvas, audioBuffer, loopStartRatio, loopEndRatio } = track;
    const W = waveCanvas.width;
    const H = waveCanvas.height;

    waveCtx.fillStyle = '#090909';
    waveCtx.fillRect(0, 0, W, H);

    if (!audioBuffer) return;

    const data        = audioBuffer.getChannelData(0);
    const samplesPerPx = data.length / W;

    // Loop region shading
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

    // Loop start/end handles
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

export function setupWaveformDrag(track) {
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
        state.activeWaveDrag = track;
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
