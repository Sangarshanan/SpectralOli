import { ensureAudioCtx, ensureLoopRecorderWorklet } from './audio-context.js';
import { state } from './state.js';
import { addRecordedTrack } from './tracks.js';

const START_SAFETY_SECONDS = 0.25;

function cycleDuration(bpm, beatsPerCycle) {
    return (60 / bpm) * beatsPerCycle;
}

// The worklet and playback engine derive their phase from currentTime, so this
// is deliberately based on the AudioContext epoch rather than Date.now().
function nextBoundary(now, duration, safety = 0) {
    return Math.ceil((now + safety) / duration) * duration;
}

function recordingName() {
    const number = [...state.tracks.values()].filter(track => /^recording(?:\s|$)/i.test(track.name)).length + 1;
    return `recording ${number}`;
}

export function setupLoopRecorder({
    openButton, modal, closeButton, recordButton, barsSelect, status, bpmInput, beatsInput,
}) {
    if (!openButton || !modal || !closeButton || !recordButton || !barsSelect || !status) {
        return { dispose() {} };
    }

    let session = null;
    let statusRaf = null;
    let isStarting = false;

    function setStatus(text) {
        status.textContent = text;
    }

    function setControls(mode) {
        const active = mode !== 'idle';
        barsSelect.disabled = active;
        bpmInput.disabled = active;
        beatsInput.disabled = active;
        closeButton.disabled = active;
        openButton.classList.toggle('recording', active);
        recordButton.classList.toggle('recording', mode === 'armed' || mode === 'recording');
        recordButton.classList.toggle('finishing', mode === 'finishing');
        recordButton.setAttribute('aria-pressed', String(active));

        if (mode === 'idle') recordButton.textContent = '● Record loop';
        else if (mode === 'armed') recordButton.textContent = '× Cancel recording';
        else if (mode === 'recording') recordButton.textContent = '■ Stop after bar';
        else recordButton.textContent = '… Finishing bar';
    }

    function openModal() {
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
        recordButton.focus();
    }

    function closeModal() {
        if (session) return;
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
        openButton.focus();
    }

    function stopStatusUpdates() {
        if (statusRaf !== null) cancelAnimationFrame(statusRaf);
        statusRaf = null;
    }

    function updateStatus() {
        if (!session) return;
        const now = state.audioCtx.currentTime;
        if (session.mode === 'armed') {
            setStatus(`Starts in ${Math.max(0, session.startAt - now).toFixed(1)}s`);
        } else {
            const elapsedBars = Math.min(session.bars, Math.floor(Math.max(0, now - session.startAt) / session.barDuration) + 1);
            setStatus(`${session.mode === 'finishing' ? 'Finishing' : 'Recording'} · bar ${elapsedBars} / ${session.bars}`);
        }
        statusRaf = requestAnimationFrame(updateStatus);
    }

    function cleanup() {
        stopStatusUpdates();
        if (!session) return;
        session.source?.disconnect();
        session.node?.disconnect();
        session.silentGain?.disconnect();
        for (const track of session.stream?.getTracks() || []) track.stop();
        session = null;
        setControls('idle');
    }

    function cancel() {
        if (!session) return;
        session.node.port.postMessage({ type: 'cancel' });
        cleanup();
        setStatus('Recording cancelled.');
    }

    function finishAfterBar() {
        if (!session || session.mode !== 'recording') return;
        const now = state.audioCtx.currentTime;
        // Finishing never extends the length the user selected; it only
        // shortens a multi-bar take to the next safe boundary.
        const endAt = Math.min(session.endAt, nextBoundary(now, session.barDuration, 0.03));
        const endFrame = Math.round(endAt * state.audioCtx.sampleRate);
        session.node.port.postMessage({ type: 'setEndFrame', endFrame });
        session.endAt = endAt;
        session.bars = Math.max(1, Math.round((endAt - session.startAt) / session.barDuration));
        session.loopBeats = session.bars * session.beatsPerCycle;
        session.mode = 'finishing';
        setControls('finishing');
    }

    async function complete(data, completedSession) {
        if (session !== completedSession) return;
        try {
            const pcm = new Float32Array(data.buffer);
            if (!pcm.length) throw new Error('No microphone audio was captured.');
            const buffer = state.audioCtx.createBuffer(1, pcm.length, state.audioCtx.sampleRate);
            buffer.copyToChannel(pcm, 0);

            cleanup();
            setStatus('Adding synced loop…');
            await addRecordedTrack(
                buffer,
                recordingName(),
                completedSession.loopBeats,
                completedSession.bpm,
                state.playing,
            );
            setStatus(`Added ${completedSession.bars}-bar loop.`);
        } catch (err) {
            cleanup();
            setStatus(`Recording failed: ${err.message}`);
            console.error('Failed to create recorded loop:', err);
        }
    }

    async function begin() {
        if (isStarting) return;
        isStarting = true;
        recordButton.disabled = true;
        const bars = Math.max(1, parseInt(barsSelect.value, 10) || 1);
        let stream = null;
        let source = null;
        let node = null;
        let silentGain = null;
        try {
            await ensureAudioCtx();
            if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('Microphone recording is not supported by this browser.');
            }
            await ensureLoopRecorderWorklet();

            // Ask before calculating the start so a slow permissions prompt
            // can never make us miss an already-selected downbeat.
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
            });

            const bpm = state.bpm;
            const beatsPerCycle = state.beatsPerCycle;
            const barDuration = cycleDuration(bpm, beatsPerCycle);
            const startAt = nextBoundary(state.audioCtx.currentTime, barDuration, START_SAFETY_SECONDS);
            const endAt = startAt + (bars * barDuration);
            source = state.audioCtx.createMediaStreamSource(stream);
            node = new AudioWorkletNode(state.audioCtx, 'loop-recorder-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
            });
            silentGain = state.audioCtx.createGain();
            silentGain.gain.value = 0;
            source.connect(node);
            node.connect(silentGain);
            silentGain.connect(state.masterGain);

            const newSession = {
                mode: 'armed', stream, source, node, silentGain, bars, bpm, beatsPerCycle,
                barDuration, startAt, endAt, loopBeats: bars * beatsPerCycle,
            };
            session = newSession;
            node.port.onmessage = ({ data }) => {
                if (session !== newSession) return;
                if (data.type === 'started') {
                    newSession.mode = 'recording';
                    setControls('recording');
                } else if (data.type === 'complete') {
                    complete(data, newSession);
                }
            };

            node.port.postMessage({
                type: 'arm',
                startFrame: Math.round(startAt * state.audioCtx.sampleRate),
                endFrame: Math.round(endAt * state.audioCtx.sampleRate),
            });
            setControls('armed');
            recordButton.disabled = false;
            updateStatus();
        } catch (err) {
            if (!session) {
                source?.disconnect();
                node?.disconnect();
                silentGain?.disconnect();
                for (const track of stream?.getTracks() || []) track.stop();
            }
            cleanup();
            const message = err?.name === 'NotAllowedError'
                ? 'Microphone access was not allowed.'
                : `Could not start recording: ${err.message}`;
            setStatus(message);
            console.error('Failed to start loop recording:', err);
        } finally {
            isStarting = false;
            if (!session) recordButton.disabled = false;
        }
    }

    openButton.addEventListener('click', openModal);
    closeButton.addEventListener('click', closeModal);
    modal.addEventListener('click', event => {
        if (event.target === modal) closeModal();
    });
    window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modal.classList.contains('open')) closeModal();
    });

    recordButton.addEventListener('click', () => {
        if (!session) begin();
        else if (session.mode === 'armed') cancel();
        else if (session.mode === 'recording') finishAfterBar();
    });

    window.addEventListener('pagehide', cancel);
    setControls('idle');
    setStatus('');

    return {
        dispose() {
            cancel();
        },
    };
}
