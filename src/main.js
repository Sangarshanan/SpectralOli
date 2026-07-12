import { setupFileImport } from './file-import.js';
import { setupFreesoundModal } from './freesound-modal.js';
import { state } from './state.js';
import { playBtn, statusText, dropZone, fileInput, bpmInput, beatsInput } from './dom.js';
import { initMasterCanvas } from './spectrogram.js';
import { drawTrackWaveform } from './waveform.js';
import { handleSvgDragMove, handleSvgDragEnd } from './overlay.js';
import { startAllTracks, stopAllTracks, updateMuteSolo } from './playback.js';
import { applyTrackCode } from './track-dom.js';
import { createTrack, addTrackFromArrayBuffer } from './tracks.js';
import { updatePlayButton, scrollToTrack } from './navigator.js';
import { ensureAudioCtx } from './audio-context.js';
import { isApplyShortcut } from './shortcuts.js';

// Viewport resize

function handleViewportResize() {
    if (state.resizeRaf) cancelAnimationFrame(state.resizeRaf);
    state.resizeRaf = requestAnimationFrame(() => {
        state.resizeRaf = null;
        initMasterCanvas();
        for (const track of state.tracks.values()) drawTrackWaveform(track);
    });
}

// Global mouse drag handlers

window.addEventListener('mousemove', e => {
    if (state.activeWaveDrag) {
        const track = state.activeWaveDrag;
        const rect  = track.waveCanvas.getBoundingClientRect();
        const r     = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (track.dragging === 'start') track.loopStartRatio = Math.min(r, track.loopEndRatio - 0.005);
        else                             track.loopEndRatio   = Math.max(r, track.loopStartRatio + 0.005);
        if (track.audioBuffer) {
            track.workletNode.port.postMessage({
                type: 'updateLoopPoints',
                loopStart: Math.floor(track.loopStartRatio * track.audioBuffer.length),
                loopEnd:   Math.floor(track.loopEndRatio   * track.audioBuffer.length),
            });
        }
        drawTrackWaveform(track);
    } else if (state.activeSvgDrag) {
        handleSvgDragMove(e);
    }
});

window.addEventListener('mouseup', () => {
    if (state.activeWaveDrag) {
        state.activeWaveDrag.dragging = null;
        state.activeWaveDrag = null;
    }
    if (state.activeSvgDrag) handleSvgDragEnd();
});

// Play button

playBtn.addEventListener('click', () => {
    if (state.playing) stopAllTracks();
    else               startAllTracks();
});

// BPM & beats-per-cycle inputs

function broadcastClock() {
    for (const track of state.tracks.values()) {
        track.workletNode.port.postMessage({ type: 'updateClock', bpm: state.bpm, beatsPerCycle: state.beatsPerCycle });
    }
}

bpmInput?.addEventListener('change', () => {
    state.bpm = Math.max(1, parseInt(bpmInput.value) || 80);
    broadcastClock();
});
bpmInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { state.bpm = Math.max(1, parseInt(bpmInput.value) || 80); broadcastClock(); }
});
beatsInput?.addEventListener('input', () => {
    state.beatsPerCycle = Math.max(1, parseInt(beatsInput.value) || 4);
    broadcastClock();
});

// Global Ctrl+Enter (mute-toggle / apply on selected track)

window.addEventListener('keydown', e => {
    if (!isApplyShortcut(e) || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    if (!state.selectedTrackId) return;
    const track = state.tracks.get(state.selectedTrackId);
    if (!track) return;
    if (state.playing && track.isPlaying) track.muted = !track.muted;
    else track.muted = false;
    const muteBtn = track.el.querySelector('.btn-mute');
    if (muteBtn) muteBtn.classList.toggle('active', track.muted);
    updateMuteSolo();
    applyTrackCode(track);
});

// File import + Freesound modal

setupFileImport({
    dropZone,
    fileInput,
    addTrackFromArrayBuffer,
    setStatus: text => { statusText.textContent = text; },
});

setupFreesoundModal({
    addTrackFromArrayBuffer,
    getBpm: () => state.bpm,
    getMasterDuration: () => {
        if (!state.masterTrackId) return null;
        const master = state.tracks.get(state.masterTrackId);
        return master?.audioBuffer?.duration ?? null;
    },
});

// Initial load

async function init() {
    initMasterCanvas();
    window.addEventListener('resize', handleViewportResize);

    try {
        const resp = await fetch('/media/break.wav');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const raw = await resp.arrayBuffer();
        await ensureAudioCtx();
        const buffer = await state.audioCtx.decodeAudioData(raw);
        await createTrack(buffer, 'amen_break');
    } catch {
        updatePlayButton();
    }
}

init();
