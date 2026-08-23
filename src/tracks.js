import { UI_BANDS, TRACK_SPEC_W } from './constants.js';
import { state } from './state.js';
import { ensureAudioCtx, deriveLoopBeats } from './audio-context.js';
import { tryCompileDSL } from './dsl.js';
import { drawTrackWaveform, sendSlicesToWorklet } from './waveform.js';
import { updatePlayButton, updateNavigator, scrollToTrack } from './navigator.js';
import { updateMuteSolo, sendClockToWorklet, sendCompiledDSLToWorklet } from './playback.js';

// Note: buildTrackDOM / applyTrackCode are imported from track-dom.js, which in turn
import { buildTrackDOM, unobserveTrackLane } from './track-dom.js';
import { setTrackCode } from './code-editor.js';

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

export async function createTrack(audioBuffer, name, initialVolume = 1) {
    await ensureAudioCtx();

    const id = createTrackId();

    const workletNode = new AudioWorkletNode(state.audioCtx, 'spectral-coder-processor', {
        outputChannelCount: [1],
    });
    const gainNode = state.audioCtx.createGain();
    gainNode.gain.value = initialVolume;
    workletNode.connect(gainNode);
    gainNode.connect(state.masterGain);

    const timeCols    = TRACK_SPEC_W;
    const visPreData  = Array.from({ length: timeCols }, () => new Float32Array(UI_BANDS));
    const visPostData = Array.from({ length: timeCols }, () => new Float32Array(UI_BANDS));

    workletNode.port.onmessage = ({ data }) => {
        if (data.type === 'renderBatch') {
            const track = state.tracks.get(id);
            if (!track) return;
            for (const frame of data.frames) {
                track.visPreData[track.visHead].set(frame.pre);
                track.visPostData[track.visHead].set(frame.post);
                track.visHead = (track.visHead + 1) % timeCols;
            }
        } else if (data.type === 'applyPending') {
            // The worklet detected the downbeat and is asking us to flush the
            // pending compiled DSL. Apply it now — sendCompiledDSLToWorklet
            // posts each update message synchronously so they are processed
            // before the next process() call.
            const track = state.tracks.get(id);
            if (track && track.pendingCompiledDSL) {
                sendCompiledDSLToWorklet(track, track.pendingCompiledDSL);
                track.pendingCompiledDSL = null;
            }
        }
    };

    const track = {
        id,
        name: name || 'untitled',
        audioBuffer,
        // Pristine decode, never mutated. Tempo adaptation is derived from this
        // so repeated BPM changes can't stack transformations on each other.
        originalBuffer: audioBuffer,
        sourceBpm: null,
        loopBeats: null,
        workletNode,
        gainNode,
        volume: initialVolume,
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
        codeView: null,
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
        pendingCompiledDSL: null,  // compiled DSL payload waiting for the next downbeat
    };

    state.tracks.set(id, track);

    sendBufferToWorklet(track);
    sendClockToWorklet(track);
    buildTrackDOM(track);
    drawTrackWaveform(track);
    updatePlayButton();
    if (state.tracks.size === 1) {
        setMasterTrack(id);
    } else {
        updateNavigator();
    }



    return track;
}

// Track removal

export function removeTrack(id) {
    const track = state.tracks.get(id);
    if (!track) return;

    track.workletNode.port.postMessage({ type: 'stop' });
    track.workletNode.disconnect();
    track.gainNode.disconnect();

    unobserveTrackLane(track);
    if (track.el && track.el.parentNode) track.el.parentNode.removeChild(track.el);

    state.tracks.delete(id);

    updateMuteSolo();
    updatePlayButton();
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

    newTrack.originalBuffer = src.originalBuffer;
    newTrack.sourceBpm      = src.sourceBpm;
    newTrack.loopBeats      = src.loopBeats;
    sendClockToWorklet(newTrack);

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
        setTrackCode(newTrack.codeView, src.code);
        newTrack.code = src.code;
        const compiled = tryCompileDSL(src.code);
        newTrack.clockMod = compiled.clockMod;
        sendCompiledDSLToWorklet(newTrack, compiled);
    }

    scrollToTrack(newTrack.id);
}

// Load track from raw audio bytes

// Freshly imported loops land quiet rather than at full volume: a performer
// bringing in a new loop mid-set is auditioning it against what's already
// playing, not replacing it outright, so it shouldn't jump in at the same
// level as a track that's been faded up deliberately.
const IMPORT_DEFAULT_VOLUME = 0.12;

export async function addTrackFromArrayBuffer(rawArrayBuffer, trackName, sourceBpm = null) {
    await ensureAudioCtx();
    const buffer = await state.audioCtx.decodeAudioData(rawArrayBuffer);

    // Tempo is matched at playback time from the loop's musical length, not
    // baked into the samples here — so loading at 60 BPM then switching to 80
    // sounds identical to loading at 80 directly.
    const track = await createTrack(buffer, trackName, IMPORT_DEFAULT_VOLUME);
    if (sourceBpm && sourceBpm > 0) {
        track.sourceBpm = sourceBpm;
        track.loopBeats = deriveLoopBeats(buffer.duration, sourceBpm);
        sendClockToWorklet(track);
    }

    // Do not automatically start playback when a new loop is added.
    scrollToTrack(track.id);
    return track;
}
