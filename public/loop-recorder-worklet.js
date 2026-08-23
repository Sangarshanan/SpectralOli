// Mic capture is kept in an AudioWorklet rather than MediaRecorder so a loop
// can start and end on exact AudioContext sample frames. The main thread gives
// us absolute frame boundaries on the same clock used by playback.
class LoopRecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.armed = false;
        this.started = false;
        this.startFrame = 0;
        this.endFrame = 0;
        this.chunks = [];
        this.totalFrames = 0;

        this.port.onmessage = ({ data }) => {
            if (data.type === 'arm') {
                this.armed = true;
                this.started = false;
                this.startFrame = Math.max(0, Math.floor(data.startFrame));
                this.endFrame = Math.max(this.startFrame + 1, Math.floor(data.endFrame));
                this.chunks = [];
                this.totalFrames = 0;
            } else if (data.type === 'setEndFrame' && this.armed) {
                // An early-stop request is a future bar boundary. It may
                // shorten the original recording, but never discard frames
                // already processed by this worklet.
                this.endFrame = Math.max(currentFrame + 1, Math.floor(data.endFrame));
            } else if (data.type === 'cancel') {
                this._reset();
            }
        };
    }

    _reset() {
        this.armed = false;
        this.started = false;
        this.chunks = [];
        this.totalFrames = 0;
    }

    _finish() {
        const result = new Float32Array(this.totalFrames);
        let offset = 0;
        for (const chunk of this.chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        this.port.postMessage({ type: 'complete', buffer: result.buffer, frames: result.length }, [result.buffer]);
        this._reset();
    }

    process(inputs, outputs) {
        // This node is connected through a silent gain in the main graph to
        // keep it alive; never pass microphone audio through to the speakers.
        for (const output of outputs) {
            for (const channel of output) channel.fill(0);
        }

        if (!this.armed) return true;

        const input = inputs[0] || [];
        const frameCount = input[0]?.length || 128;
        const blockStart = currentFrame;
        const blockEnd = blockStart + frameCount;

        if (blockEnd <= this.startFrame) return true;

        const captureStart = Math.max(0, this.startFrame - blockStart);
        const captureEnd = Math.min(frameCount, this.endFrame - blockStart);

        if (captureEnd > captureStart) {
            if (!this.started) {
                this.started = true;
                this.port.postMessage({ type: 'started' });
            }

            const chunk = new Float32Array(captureEnd - captureStart);
            for (let i = captureStart; i < captureEnd; i++) {
                let sample = 0;
                for (let channel = 0; channel < input.length; channel++) sample += input[channel][i] || 0;
                chunk[i - captureStart] = input.length ? sample / input.length : 0;
            }
            this.chunks.push(chunk);
            this.totalFrames += chunk.length;
        }

        if (blockEnd >= this.endFrame) this._finish();
        return true;
    }
}

registerProcessor('loop-recorder-processor', LoopRecorderProcessor);
