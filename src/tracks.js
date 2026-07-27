import { UI_BANDS, TRACK_SPEC_W } from './constants.js';
import { state } from './state.js';
import { ensureAudioCtx, phaseVocoderStretch } from './audio-context.js';
import { tryCompileDSL } from './dsl.js';
import { drawTrackWaveform, sendSlicesToWorklet } from './waveform.js';
import { updatePlayButton, updateNavigator, scrollToTrack } from './navigator.js';
import { startAllTracks, startSingleTrack, updateMuteSolo } from './playback.js';
import { hideSliceEditor } from './slice-editor.js';
// Note: buildTrackDOM / applyTrackCode are imported from track-dom.js, which in turn
import { buildTrackDOM } from './track-dom.js';

// Worklet buffer helpers

function sendBufferToWorklet(track) {
    const rawData = track.audioBuffer.getChannelData(0);
    const copy = new Float32Array(rawData);
    track.workletNode.port.postMessage(
        {
            type: 'setBuffer',
            buffer: copy.buffer,
            loopStart: Math.floor(track.loopStartRatio * rawData.length),
            loopEnd:   Math.floor(track.loopEndRatio   * rawData.length),
        },
        [copy.buffer]
    );
}

// Track creation

function createTrackId() {
    return crypto.randomUUID
        ? crypto.randomUUID()
        : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createTrack(audioBuffer, name) {
    await ensureAudioCtx();

    const id = createTrackId();

    const workletNode = new AudioWorkletNode(state.audioCtx, 'spectral-coder-processor', {
        outputChannelCount: [1],
    });
    const gainNode = state.audioCtx.createGain();
    workletNode.connect(gainNode);
    gainNode.connect(state.masterGain);

    const timeCols    = TRACK_SPEC_W;
    const visPreData  = Array.from({ length: timeCols }, () => new Float32Array(UI_BANDS));
    const visPostData = Array.from({ length: timeCols }, () => new Float32Array(UI_BANDS));

    workletNode.port.onmessage = ({ data }) => {
        if (data.type === 'render') {
            const track = state.tracks.get(id);
            if (!track) return;
            track.visPreData[track.visHead].set(data.preArray);
            track.visPostData[track.visHead].set(data.postArray);
            track.visHead = (track.visHead + 1) % timeCols;
        }
    };

    const track = {
        id,
        name: name || 'untitled',
        audioBuffer,
        workletNode,
        gainNode,
        volume: 1,
        muted: false,
        solo: false,
        loopStartRatio: 0,
        loopEndRatio: 1,
        code: '',
        visHead: 0,
        visPreData,
        visPostData,
        vizMaxPre: 1,
        vizMax: 1,
        el: null,
        waveCanvas: null, waveCtx: null,
        preCanvas: null,  preCtx: null,
        postCanvas: null, postCtx: null,
        overlaySvg: null,
        preImgData: null, prePixels32: null,
        postImgData: null, postPixels32: null,
        codeTextarea: null,
        nameInput: null,
        errorSpan: null,
        dragging: null,
        currentAst: null,
        svgDrag: null,
        collapsed: false,
        clockMod: null,
        isPlaying: false,
        slices: null,
        lastAppliedSliceKey: null,
        activeSliceIndices: null,
    };

    state.tracks.set(id, track);

    sendBufferToWorklet(track);
    track.workletNode.port.postMessage({ type: 'updateClock', bpm: state.bpm, beatsPerCycle: state.beatsPerCycle });
    buildTrackDOM(track);
    drawTrackWaveform(track);
    updatePlayButton();

    if (state.tracks.size === 1) {
        setMasterTrack(id);
    } else {
        updateNavigator();
    }

    hideSliceEditor();

    return track;
}

// Track removal

export function removeTrack(id) {
    const track = state.tracks.get(id);
    if (!track) return;

    track.workletNode.port.postMessage({ type: 'stop' });
    track.workletNode.disconnect();
    track.gainNode.disconnect();

    if (track.el && track.el.parentNode) track.el.parentNode.removeChild(track.el);

    state.tracks.delete(id);

    if (state.masterTrackId === id) {
        state.masterTrackId = state.tracks.size > 0 ? state.tracks.keys().next().value : null;
        if (state.masterTrackId) setMasterTrack(state.masterTrackId);
    }

    updateMuteSolo();
    updatePlayButton();
    updateNavigator();
}

// Master track selection

export function setMasterTrack(id) {
    state.masterTrackId = id;

    state.tracks.forEach(t => {
        const isMaster = t.id === state.masterTrackId;
        if (t.el) {
            const btn = t.el.querySelector('.btn-master');
            if (btn) btn.classList.toggle('is-master', isMaster);
        }
    });

    updateNavigator();
}

// Track duplication

export async function duplicateTrack(sourceTrackId) {
    const src = state.tracks.get(sourceTrackId);
    if (!src) return;

    const baseName = src.name.replace(/\s*\(\d+\)$/, '');
    let copyNum = 2;
    for (const t of state.tracks.values()) {
        const m = t.name.match(new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*\\((\\d+)\\))?$`));
        if (m) copyNum = Math.max(copyNum, (parseInt(m[1]) || 1) + 1);
    }

    const newTrack = await createTrack(src.audioBuffer, `${baseName} (${copyNum})`);
    if (!newTrack) return;

    newTrack.loopStartRatio = src.loopStartRatio;
    newTrack.loopEndRatio   = src.loopEndRatio;
    newTrack.lastAppliedSliceKey = src.lastAppliedSliceKey ?? null;
    newTrack.activeSliceIndices  = src.activeSliceIndices ? new Set(src.activeSliceIndices) : null;
    if (src.slices) newTrack.slices = src.slices.map(s => ({ ...s }));
    drawTrackWaveform(newTrack);
    if (newTrack.slices) sendSlicesToWorklet(newTrack);

    newTrack.workletNode.port.postMessage({
        type: 'updateLoopPoints',
        loopStart: Math.floor(newTrack.loopStartRatio * newTrack.audioBuffer.length),
        loopEnd:   Math.floor(newTrack.loopEndRatio   * newTrack.audioBuffer.length),
    });

    if (src.code) {
        newTrack.codeTextarea.value = src.code;
        newTrack.code = src.code;
        const { code, clockMod, granulate, scale, rotate, skew, transpose, fftSize, requiresCanvasPool, eval2D } = tryCompileDSL(src.code);
        newTrack.clockMod = clockMod;
        newTrack.workletNode.port.postMessage({ type: 'updateFFT', size: fftSize ?? 1024 });
        if (code) newTrack.workletNode.port.postMessage({ type: 'updateCode', code, requiresCanvasPool: !!requiresCanvasPool, eval2D: !!eval2D });
        if (clockMod) newTrack.workletNode.port.postMessage({ type: 'updateClockMod', clockMod });
        newTrack.workletNode.port.postMessage({ type: 'updateGranulate', params: granulate ?? null });
        newTrack.workletNode.port.postMessage({ type: 'updateScale', params: scale ?? null });
        newTrack.workletNode.port.postMessage({ type: 'updateRotate', params: rotate ?? null });
        newTrack.workletNode.port.postMessage({ type: 'updateSkew', params: skew ?? null });
        newTrack.workletNode.port.postMessage({ type: 'updateTranspose', params: transpose ?? null });
    }

    scrollToTrack(newTrack.id);
}

// Load track from raw audio bytes

export async function addTrackFromArrayBuffer(rawArrayBuffer, trackName, sourceBpm = null) {
    await ensureAudioCtx();
    let buffer = await state.audioCtx.decodeAudioData(rawArrayBuffer);

// Time-stretch to match global BPM when source BPM is known
    if (sourceBpm && sourceBpm > 0 && Math.abs(sourceBpm - state.bpm) > 0.5) {
        const ratio = state.bpm / sourceBpm;
        if (ratio > 0.25 && ratio < 4.0) {
            buffer = phaseVocoderStretch(buffer, ratio, state.audioCtx);
        }
    }

    const track = await createTrack(buffer, trackName);
    if (!state.playing) startAllTracks();
    else startSingleTrack(track);
    scrollToTrack(track.id);
    return track;
}
