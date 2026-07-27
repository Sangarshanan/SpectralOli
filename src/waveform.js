import { state } from './state.js';

// ── Waveform drawing ─────────────────────────────────────────────────────────

export function drawWaveformOntoCanvas(ctx, W, H, track) {
    const { audioBuffer, loopStartRatio, loopEndRatio } = track;

    ctx.fillStyle = '#090909';
    ctx.fillRect(0, 0, W, H);

    if (!audioBuffer) return;

    const data = audioBuffer.getChannelData(0);

    if (!track.slices) {
        // Classic mode: shade the loop region
        const sx = Math.round(loopStartRatio * W);
        const ex = Math.round(loopEndRatio   * W);
        ctx.fillStyle = 'rgba(255,255,255,0.055)';
        ctx.fillRect(sx, 0, ex - sx, H);
    }

    // Centre line
    ctx.strokeStyle = '#1c1c1c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    // Min-max waveform
    const samplesPerPx = data.length / W;
    ctx.strokeStyle = '#383838';
    ctx.lineWidth = 1;
    ctx.beginPath();
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
        ctx.moveTo(x + 0.5, yTop);
        ctx.lineTo(x + 0.5, yBot);
    }
    ctx.stroke();

    if (track.slices) {
        const totalSamples = data.length;
        if (track.activeSliceIndices) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
            track.slices.forEach((sl, i) => {
                if (!track.activeSliceIndices.has(i)) {
                    const xStart = Math.round((sl.start / totalSamples) * W);
                    const xEnd = Math.round((sl.end / totalSamples) * W);
                    ctx.fillRect(xStart, 0, Math.max(1, xEnd - xStart), H);
                }
            });
        }

        // Draw numbered slice markers
        track.slices.forEach((sl, i) => {
            const isActive = !track.activeSliceIndices || track.activeSliceIndices.has(i);
            const x = Math.round((sl.start / totalSamples) * W);

            if (isActive) {
                const col = i === 0 ? '#00cc55' : '#00ccbb';
                ctx.strokeStyle = col;
                ctx.lineWidth = (i === 0) ? 2 : 1;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, H);
                ctx.stroke();

                // Active label chip
                ctx.fillStyle = col;
                ctx.fillRect(x, 0, 14, 12);
                ctx.fillStyle = '#000';
                ctx.font = 'bold 7px monospace';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillText(String(i), x + 2, 2);
            } else {
                // Inactive slice: dimmed boundary line and ghost/muted chip
                ctx.strokeStyle = 'rgba(34, 51, 51, 0.35)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, H);
                ctx.stroke();

                // Ghost/muted chip: dark gray background #111 with dim gray text #444
                ctx.fillStyle = '#111';
                ctx.fillRect(x, 0, 14, 12);
                ctx.fillStyle = '#444';
                ctx.font = 'bold 7px monospace';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillText(String(i), x + 2, 2);
            }
        });
    } else {
        // Classic loop start/end handles
        const sx = Math.round(loopStartRatio * W);
        const ex = Math.round(loopEndRatio   * W);
        [[sx, '#00cc55', 'S'], [ex, '#ff8800', 'E']].forEach(([hx, col, lbl]) => {
            ctx.fillStyle = col;
            ctx.fillRect(hx - 1, 0, 2, H);
            ctx.fillRect(hx - 5, 0, 10, 12);
            ctx.fillStyle = '#000';
            ctx.font = 'bold 7px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(lbl, hx, 2);
        });
    }
}

export function drawTrackWaveform(track) {
    if (!track.waveCtx) return;
    drawWaveformOntoCanvas(
        track.waveCtx, 
        track.waveCanvas.width, 
        track.waveCanvas.height, 
        track
    );
}

// ── Waveform drag setup ──────────────────────────────────────────────────────

export function setupWaveformDrag(track) {
    const canvas = track.waveCanvas;
    const W = canvas.width;

    function pointerRatio(e) {
        const r = canvas.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    }

    canvas.addEventListener('mousedown', e => {
        const r = pointerRatio(e);
        e.preventDefault();

        if (track.slices && track.slices.length > 1) {
            // Slices are active — dragging on the small track canvas is disabled
            // as it's too small for precise edits. Use the Slice Editor instead.
            return;
        }

        // Classic start/end drag
        const ds = Math.abs(r - track.loopStartRatio) * W;
        const de = Math.abs(r - track.loopEndRatio)   * W;
        track.dragging = ds < de ? 'start' : 'end';
        state.activeWaveDrag = track;
    });

    canvas.addEventListener('mousemove', e => {
        if (track.dragging) return; // main.js handles move while dragging
        const r  = pointerRatio(e);

        if (track.slices && track.slices.length > 1) {
            canvas.style.cursor = 'default';
        } else {
            const ds = Math.abs(r - track.loopStartRatio) * W;
            const de = Math.abs(r - track.loopEndRatio)   * W;
            canvas.style.cursor = (ds < 10 || de < 10) ? 'col-resize' : 'default';
        }
    });
}

// ── Send updated slices to worklet ──────────────────────────────────────────

export function sendSlicesToWorklet(track) {
    track.workletNode?.port.postMessage({ type: 'updateSlices', slices: track.slices ?? null });
}
