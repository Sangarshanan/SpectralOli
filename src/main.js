import { setupFileImport } from './file-import.js';
import { setupFreesoundModal } from './freesound-modal.js';
import { state } from './state.js';
import { playBtn, statusText, dropZone, fileInput, bpmInput, beatsInput } from './dom.js';
import { initMasterCanvas } from './spectrogram.js';
import { drawTrackWaveform, sendSlicesToWorklet } from './waveform.js';
import { handleSvgDragMove, handleSvgDragEnd } from './overlay.js';
import { startAllTracks, stopAllTracks, updateMuteSolo, sendClockToWorklet } from './playback.js';
import { applyTrackCode } from './track-dom.js';
import { createTrack, addTrackFromArrayBuffer } from './tracks.js';
import { updatePlayButton } from './navigator.js';
import { ensureAudioCtx } from './audio-context.js';
import { isApplyShortcut } from './shortcuts.js';
import { initSliceEditor, redrawEditor, hideSliceEditor } from './slice-editor.js';

// Viewport resize

function handleViewportResize() {
    if (state.resizeRaf) cancelAnimationFrame(state.resizeRaf);
    state.resizeRaf = requestAnimationFrame(() => {
        state.resizeRaf = null;
        initMasterCanvas();
        for (const track of state.tracks.values()) drawTrackWaveform(track);
        redrawEditor();
    });
}

// Global mouse drag handlers

window.addEventListener('mousemove', e => {
    if (state.activeWaveDrag) {
        const track = state.activeWaveDrag;
        // Classic loop start/end drag only (slice drag is handled by slice-editor.js)
        const rect = track.waveCanvas.getBoundingClientRect();
        const r    = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
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
        const track = state.activeWaveDrag;
        if (track.dragging && track.dragging.kind === 'slice') {
            sendSlicesToWorklet(track);
        }
        track.dragging = null;
        state.activeWaveDrag = null;
    }
    if (state.activeSvgDrag) handleSvgDragEnd();
});

// Global click listener to determine active track for the slice editor
window.addEventListener('click', e => {
    // Walk up the DOM to see if we clicked inside a track-lane
    let el = e.target;
    while (el && el !== document.body) {
        if (el.classList.contains('track-lane')) {
            const trackId = el.getAttribute('data-track-id');
            const track = state.tracks.get(trackId);
            if (track && state.activeTrack !== track) {
                state.activeTrack = track;
                hideSliceEditor();
            }
            return;
        }
        el = el.parentElement;
    }
});

// Play button

playBtn.addEventListener('click', () => {
    if (state.playing) stopAllTracks();
    else               startAllTracks();
});

// BPM & beats-per-cycle inputs

function broadcastClock() {
    for (const track of state.tracks.values()) {
        sendClockToWorklet(track);
    }
}

bpmInput?.addEventListener('change', () => {
    state.bpm = Math.max(1, parseInt(bpmInput.value) || 80);
    broadcastClock();
    freesoundModal?.syncBpmFromGlobal();
});
bpmInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        state.bpm = Math.max(1, parseInt(bpmInput.value) || 80);
        broadcastClock();
        freesoundModal?.syncBpmFromGlobal();
    }
});
beatsInput?.addEventListener('input', () => {
    state.beatsPerCycle = Math.max(1, parseInt(beatsInput.value) || 4);
    broadcastClock();
});

// Global Ctrl+Enter (apply on selected track)

window.addEventListener('keydown', e => {
    if (!isApplyShortcut(e) || e.target.closest?.('.cm-editor')) return;
    e.preventDefault();
    if (!state.selectedTrackId) return;
    const track = state.tracks.get(state.selectedTrackId);
    if (!track) return;
    applyTrackCode(track);
});

// File import + Freesound modal

setupFileImport({
    dropZone,
    fileInput,
    addTrackFromArrayBuffer,
    setStatus: text => { statusText.textContent = text; },
});

const freesoundModal = setupFreesoundModal({
    addTrackFromArrayBuffer,
    getBpm: () => state.bpm,
    getGlobalLoopDuration: () => (state.beatsPerCycle / state.bpm) * 60,
});

// Initial load

async function init() {
    initMasterCanvas();
    initSliceEditor();
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
