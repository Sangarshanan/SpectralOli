import { state } from './state.js';

// AudioContext bootstrap

export async function ensureAudioCtx() {
    if (state.audioCtx) return;
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    state.masterGain = state.audioCtx.createGain();
    state.masterAnalyser = state.audioCtx.createAnalyser();
    state.masterAnalyser.fftSize = 1024;
    state.masterAnalyser.smoothingTimeConstant = 0.3;
    state.masterGain.connect(state.masterAnalyser);
    state.masterAnalyser.connect(state.audioCtx.destination);

    state.masterFreqData = new Float32Array(state.masterAnalyser.frequencyBinCount);

    await state.audioCtx.audioWorklet.addModule('/spectral-worklet.js');
}

// Loop length estimation
// Musical loops are almost always a whole number of bars, so a loop's length in
// beats is a far more reliable playback anchor than its stated BPM. Deriving it
// once at load time lets the clock retempo the loop non-destructively: playback
// rate becomes a pure function of (globalBpm, loopBeats), so changing BPM is
// idempotent instead of stacking transformations on an already-modified buffer.

const BEAT_GRID = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

// Log-domain distance so the tolerance is proportional, not absolute.
function snapToBeatGrid(rawBeats) {
    let beats = BEAT_GRID[0];
    let err = Infinity;
    for (const candidate of BEAT_GRID) {
        const d = Math.abs(Math.log2(rawBeats / candidate));
        if (d < err) { err = d; beats = candidate; }
    }
    return { beats, err };
}

/**
 * Derive a loop's length in beats from its duration and stated source tempo.
 * Returns null when the audio doesn't sit convincingly on the grid (one-shots,
 * unmetered recordings, bad metadata) so the caller can fall back rather than
 * warp to an invented tempo. Octave errors in automated BPM metadata are left
 * to an explicit user override — silently re-interpreting a tempo that doesn't
 * fit produces confident wrong answers on exactly the material least suited to
 * being warped.
 * @param {number} durationSec
 * @param {number} sourceBpm
 * @returns {number|null} Beat count, or null when the loop doesn't fit the grid.
 */
export function deriveLoopBeats(durationSec, sourceBpm) {
    if (!(durationSec > 0) || !(sourceBpm > 0)) return null;

    const rawBeats = durationSec * sourceBpm / 60;
    // Below two beats there isn't enough material to distinguish a loop from a
    // one-shot; above 96 it's an arrangement or stem, not a loop.
    if (rawBeats < 2 || rawBeats > 96) return null;

    const { beats, err } = snapToBeatGrid(rawBeats);
    // ~5.7% tolerance — beyond that the tempo metadata doesn't describe this
    // audio, and forcing a beat count would do more harm than good.
    return err < 0.08 ? beats : null;
}
