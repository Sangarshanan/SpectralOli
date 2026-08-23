import { playBtn, trackNavigator } from './dom.js';
import { state } from './state.js';
import { drawLoop } from './spectrogram.js';
import { CLOCK_DEFAULTS } from './dsl.js';

// Clock: a track spans its own musical length (loopBeats) instead of the global
// beatsPerCycle, so multi-bar loops play at their true tempo, and retempoing is
// idempotent since rate is derived fresh from (bpm, loopBeats) each time.
// null loopBeats falls back to the global cycle length (unmetered material).

export function sendClockToWorklet(track) {
    track.workletNode.port.postMessage({
        type: 'updateClock',
        bpm: state.bpm,
        beatsPerCycle: state.beatsPerCycle,
        loopBeats: track.loopBeats ?? null,
    });
}

// Pushes a compiled DSL result to a track's worklet — shared by applyTrackCode
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
    port.postMessage({ type: 'updateBlur', freqAmt: blur?.freqAmt ?? 0, timeAmt: blur?.timeAmt ?? 0, mix: blur?.mix ?? 1 });
    port.postMessage({ type: 'updateGranulate', params: granulate ?? null });
    port.postMessage({ type: 'updateScale', params: scale ?? null });
    port.postMessage({ type: 'updateRotate', params: rotate ?? null });
    port.postMessage({ type: 'updateSkew', params: skew ?? null });
    port.postMessage({ type: 'updateTranspose', params: transpose ?? null });
    port.postMessage({ type: 'updateSeq', indices: seqIndices ?? null });
}

// Schedules a compiled DSL payload for the next downbeat. If the transport isn't
// running it applies immediately (nothing to sync to); otherwise it's stashed on
// the track and the worklet is told to flush it via 'applyPending' on the downbeat.
export function scheduleDSLUpdate(track, compiled, wasAlreadyPlaying = false) {
    if (!wasAlreadyPlaying) {
        // Not running yet — apply now rather than waiting for a downbeat that won't come.
        sendCompiledDSLToWorklet(track, compiled);
        return;
    }
    // Already playing — defer to the next downbeat to avoid a mid-bar glitch.
    track.pendingCompiledDSL = compiled;
    track.workletNode?.port.postMessage({ type: 'setPendingUpdate' });
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
