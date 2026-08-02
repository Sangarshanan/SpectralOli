import { playBtn, trackNavigator } from './dom.js';
import { state } from './state.js';
import { drawLoop } from './spectrogram.js';
import { CLOCK_DEFAULTS } from './dsl.js';

// Clock
// A track spans its own musical length (loopBeats) rather than being force-fit
// into the global beatsPerCycle, so multi-bar loops play at their true tempo.
// Because the rate is derived fresh from (bpm, loopBeats) on every change,
// retempoing is idempotent — it never stacks onto a previous transformation.
// null loopBeats → fall back to the global cycle length (unmetered material).

export function sendClockToWorklet(track) {
    track.workletNode.port.postMessage({
        type: 'updateClock',
        bpm: state.bpm,
        beatsPerCycle: state.beatsPerCycle,
        loopBeats: track.loopBeats ?? null,
    });
}

// Pushes a compiled DSL result to a track's worklet. Shared by applyTrackCode
// and duplicateTrack so the two call sites can't drift out of sync.

export function sendCompiledDSLToWorklet(track, compiled) {
    const port = track.workletNode?.port;
    if (!port) return;
    const {
        code, blur, clockMod, granulate, scale, rotate, skew, transpose,
        requiresCanvasPool, eval2D, seqIndices, fftSize,
    } = compiled;

    port.postMessage({ type: 'updateFFT', size: fftSize ?? 1024 });
    port.postMessage({ type: 'updateClockMod', clockMod: clockMod || CLOCK_DEFAULTS });
    port.postMessage({ type: 'updateCode', code, requiresCanvasPool: !!requiresCanvasPool, eval2D: !!eval2D });
    port.postMessage({ type: 'updateBlur', freqAmt: blur?.freqAmt ?? 0, timeAmt: blur?.timeAmt ?? 0 });
    port.postMessage({ type: 'updateGranulate', params: granulate ?? null });
    port.postMessage({ type: 'updateScale', params: scale ?? null });
    port.postMessage({ type: 'updateRotate', params: rotate ?? null });
    port.postMessage({ type: 'updateSkew', params: skew ?? null });
    port.postMessage({ type: 'updateTranspose', params: transpose ?? null });
    port.postMessage({ type: 'updateSeq', indices: seqIndices ?? null });
}

// Single-track start (called when a track is added while already playing)

export function startSingleTrack(track) {
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    sendClockToWorklet(track);
    track.workletNode.port.postMessage({
        type: 'updateClockMod',
        clockMod: track.clockMod || CLOCK_DEFAULTS,
    });
    track.workletNode.port.postMessage({ type: 'play' });
    track.isPlaying = true;
}

// Start / stop all

export function startAllTracks() {
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    for (const track of state.tracks.values()) {
        sendClockToWorklet(track);
        track.workletNode.port.postMessage({
            type: 'updateClockMod',
            clockMod: track.clockMod || CLOCK_DEFAULTS,
        });
        track.workletNode.port.postMessage({ type: 'play' });
        track.isPlaying = true;
    }

    state.playing = true;
    playBtn.textContent = '■ Stop All';
    playBtn.classList.add('active');

    if (!state.rafRunning) {
        state.rafRunning = true;
        requestAnimationFrame(drawLoop);
    }
}

export function stopAllTracks() {
    for (const track of state.tracks.values()) {
        track.workletNode.port.postMessage({ type: 'stop' });
        track.isPlaying = false;
    }

    state.playing = false;
    state.rafRunning = false;
    playBtn.textContent = '▶ Play All';
    playBtn.classList.remove('active');
}

// Pause the draw loop while the tab is hidden; resume on return if still playing.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        state.rafRunning = false;
    } else if (state.playing && !state.rafRunning) {
        state.rafRunning = true;
        requestAnimationFrame(drawLoop);
    }
});

// Mute / Solo

export function updateMuteSolo() {
    const anySolo = [...state.tracks.values()].some(t => t.solo);
    for (const t of state.tracks.values()) {
        const audible = anySolo ? t.solo && !t.muted : !t.muted;
        t.gainNode.gain.value = audible ? t.volume : 0;
    }
    trackNavigator.querySelectorAll('.nav-pill').forEach(pill => {
        const t = state.tracks.get(pill.dataset.trackId);
        if (t) pill.classList.toggle('muted', t.muted || (anySolo && !t.solo));
    });
}
