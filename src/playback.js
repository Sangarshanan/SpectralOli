import { playBtn, trackNavigator } from './dom.js';
import { state } from './state.js';
import { drawLoop } from './spectrogram.js';

// Single-track start (called when a track is added while already playing)

export function startSingleTrack(track) {
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    track.workletNode.port.postMessage({ type: 'updateClock', bpm: state.bpm, beatsPerCycle: state.beatsPerCycle });
    track.workletNode.port.postMessage({
        type: 'updateClockMod',
        clockMod: track.clockMod || { speedMultiplier: 1.0, isReversed: false },
    });
    track.workletNode.port.postMessage({ type: 'play' });
    track.isPlaying = true;
}

// Start / stop all

export function startAllTracks() {
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

    for (const track of state.tracks.values()) {
        track.workletNode.port.postMessage({ type: 'updateClock', bpm: state.bpm, beatsPerCycle: state.beatsPerCycle });
        track.workletNode.port.postMessage({
            type: 'updateClockMod',
            clockMod: track.clockMod || { speedMultiplier: 1.0, isReversed: false },
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
