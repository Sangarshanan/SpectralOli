import FFT from 'https://esm.sh/fft.js@4.0.4';

class SpectralCoderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        // ─── Clock & buffer state ───────────────────────────────────────────
        this.bpm = 120;
        this.beatsPerCycle = 4;
        this.sourceBuffer = null; // Float32Array of raw PCM samples
        this.loopStart = 0;       // sample index
        this.loopEnd = 0;         // sample index (exclusive)
        this.clockMod = null;     // { fitCycles, speedMultiplier, isReversed }
        this.playing = false;

        this.fftSize = 2048;
        this.hopSize = 1024; // 50% overlap
        this.fft = new FFT(this.fftSize);
        
        this.inputBuffer = new Float32Array(this.fftSize);
        this.olaBuffer = new Float32Array(this.fftSize); // Simplified to exact FFT size
        
        this.windowedBuffer = new Float32Array(this.fftSize);
        this.complexData = this.fft.createComplexArray();
        this.complexOutput = this.fft.createComplexArray();
        
        this.uiBands  = 256;
        this.uiArray  = new Float32Array(this.uiBands); // post-DSL magnitudes
        this.preArray = new Float32Array(this.uiBands); // raw (pre-DSL) magnitudes
        
        this.inputWriteIndex = 0;
        
        this.userFunc = (mag, freq, time) => mag;

        // Blur processing arrays
        const numBins = this.fftSize / 2 + 1;
        this.origMags    = new Float32Array(numBins);
        this.modMags     = new Float32Array(numBins);
        this.blurredMags = new Float32Array(numBins);
        this.prevMags    = new Float32Array(numBins);

        // Spectral granulator state (null when inactive)
        this.gran = null;

        // General frame-level parameter system.
        // Any method with dynamic arguments registers its expressions here;
        // _evalParams() compiles and evaluates them all once per STFT frame.
        // To add a new method: populate _paramExprs and _paramFuncs in its
        // message handler, then read from _paramVals in performSTFT.
        this._paramExprs = {};   // name → raw expression string (for change detection)
        this._paramFuncs = {};   // name → compiled function(time) → number
        this._paramVals  = {};   // name → clamped [0,1] value for current frame

        // Pre-compute sqrt-Hann window for both analysis and synthesis.
        // sqrt(w) * sqrt(w) = w, and OLA of w at 50% hop sums to ~1 → perfect reconstruction.
        this.hannWindow = new Float32Array(this.fftSize);
        for (let i = 0; i < this.fftSize; i++) {
            this.hannWindow[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.fftSize - 1))));
        }

        this.port.onmessage = (event) => {
            if (event.data.type === 'updateCode') {
                try {
                    this.userFunc = new Function('mag', 'freq', 'time', `return ${event.data.code};`);
                } catch (e) {}
            } else if (event.data.type === 'updateBlur') {
                const freqExpr = String(event.data.freqAmt ?? '0');
                const timeExpr = String(event.data.timeAmt ?? '0');
                if (freqExpr !== this._paramExprs.blurFreq ||
                    timeExpr !== this._paramExprs.blurTime) {
                    this._paramExprs.blurFreq = freqExpr;
                    this._paramExprs.blurTime = timeExpr;
                    this._paramFuncs.blurFreq = SpectralCoderProcessor._compileExpr(freqExpr);
                    this._paramFuncs.blurTime = SpectralCoderProcessor._compileExpr(timeExpr);
                    this.prevMags.fill(0);
                }
            } else if (event.data.type === 'setBuffer') {
                this.sourceBuffer = new Float32Array(event.data.buffer);
                this.loopStart = event.data.loopStart;
                this.loopEnd = event.data.loopEnd;
                // Reset STFT state to avoid glitches when buffer changes
                this.inputBuffer.fill(0);
                this.olaBuffer.fill(0);
                this.inputWriteIndex = 0;
            } else if (event.data.type === 'updateLoopPoints') {
                this.loopStart = event.data.loopStart;
                this.loopEnd = event.data.loopEnd;
            } else if (event.data.type === 'updateClock') {
                this.bpm = event.data.bpm;
                this.beatsPerCycle = event.data.beatsPerCycle;
            } else if (event.data.type === 'updateClockMod') {
                this.clockMod = event.data.clockMod;
            } else if (event.data.type === 'updateGranulate') {
                const p = event.data.params;
                if (!p) {
                    this.gran = null;
                } else {
                    const numBins = this.fftSize / 2 + 1;
                    const framesPerSecond = sampleRate / this.hopSize;
                    const poolFrames      = Math.max(4, Math.round(Number(p.poolSize) * framesPerSecond));
                    const grainPeriodFrames = Math.max(1, Math.round(Number(p.grainRate) / 1000 * framesPerSecond));
                    const needsNewPool = !this.gran || this.gran.poolFrames !== poolFrames;
                    if (needsNewPool) {
                        this.gran = {
                            pool:             new Float32Array(poolFrames * numBins),
                            poolFrames,
                            writeIdx:         0,
                            grainReadIdx:     0,
                            grainPhase:       0,
                            grainPeriodFrames,
                            scatter:          Math.max(0, Math.min(1, Number(p.scatter))),
                            density:          Math.max(0, Math.min(1, Number(p.density))),
                            frozen:           Boolean(Number(p.freeze)),
                        };
                    } else {
                        this.gran.grainPeriodFrames = grainPeriodFrames;
                        this.gran.scatter = Math.max(0, Math.min(1, Number(p.scatter)));
                        this.gran.density = Math.max(0, Math.min(1, Number(p.density)));
                        this.gran.frozen  = Boolean(Number(p.freeze));
                    }
                }
            } else if (event.data.type === 'play') {
                this.playing = true;
            } else if (event.data.type === 'stop') {
                this.playing = false;
                this.olaBuffer.fill(0);
                this.inputWriteIndex = 0;
            }
        };
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0][0];

        if (!this.sourceBuffer || !this.playing) {
            if (output) output.fill(0);
            return true;
        }

        const loopLen = this.loopEnd - this.loopStart;
        if (loopLen <= 0) {
            if (output) output.fill(0);
            return true;
        }

        // 1. Send the first 128 samples of the OLA buffer to the speakers
        for (let i = 0; i < 128; i++) {
            output[i] = this.olaBuffer[i];
        }

        // 2. Shift the OLA buffer left by 128 to make room for the next overlap
        this.olaBuffer.copyWithin(0, 128, this.fftSize);
        this.olaBuffer.fill(0, this.fftSize - 128, this.fftSize);

        // 3. Generate 128 samples via declarative clock phase → buffer index
        const cyclesPerSecond = (this.bpm / 60) / this.beatsPerCycle;
        const { fitCycles = 1, speedMultiplier = 1.0, isReversed = false } = this.clockMod || {};

        for (let i = 0; i < 128; i++) {
            const t = currentTime + i / sampleRate;
            // Use continuous (unwrapped) cycle count so slow() spans multiple cycles
            const masterCycles = t * cyclesPerSecond;
            let bufferPhase = ((masterCycles / fitCycles) * speedMultiplier) % 1.0;
            if (bufferPhase < 0) bufferPhase += 1.0;
            if (isReversed) bufferPhase = 1.0 - bufferPhase;

            let sampleIndex = this.loopStart + Math.floor(bufferPhase * loopLen);
            sampleIndex = Math.max(this.loopStart, Math.min(sampleIndex, this.loopEnd - 1));

            this.inputBuffer[this.inputWriteIndex++] = this.sourceBuffer[sampleIndex];

            if (this.inputWriteIndex >= this.fftSize) {
                this.performSTFT();
                this.inputBuffer.copyWithin(0, this.hopSize, this.fftSize);
                this.inputWriteIndex = this.fftSize - this.hopSize;
            }
        }

        return true;
    }

    performSTFT() {
        // A. Windowing on analysis
        for (let i = 0; i < this.fftSize; i++) {
            this.windowedBuffer[i] = this.inputBuffer[i] * this.hannWindow[i];
        }

        // B. Forward Transform
        this.fft.realTransform(this.complexData, this.windowedBuffer);
        
        // Ensure complexOutput is clean before writing
        this.complexOutput.fill(0);
        this.uiArray.fill(0);
        this.preArray.fill(0);
        const binSize = (this.fftSize / 2) / this.uiBands;

        // C. Spectral manipulation — three passes:
        //   C1. Per-bin user transform  →  modMags
        //   C2. Frequency blur (box blur across neighbouring bins)
        //   C3. Temporal blur  (IIR mix with previous frame)
        //   C4. Write complex output using final mags + original phases
        const numBins = this.fftSize / 2 + 1;
        const frameTime = currentTime;
        this._evalParams(frameTime);
        const freqAmt = this._paramVals.blurFreq ?? 0;
        const timeAmt = this._paramVals.blurTime ?? 0;

        // C1.
        for (let k = 0; k < numBins; k++) {
            const real    = this.complexData[k * 2];
            const imag    = this.complexData[k * 2 + 1];
            const origMag = Math.sqrt(real * real + imag * imag);
            this.origMags[k] = origMag;
            let mag = origMag;
            const freq = k * sampleRate / this.fftSize;
            try { mag = this.userFunc(mag, freq, currentTime); } catch(e) {}
            if (!isFinite(mag) || mag < 0) mag = 0;
            this.modMags[k] = mag;
            const uiIndex = Math.floor(k / binSize);
            if (uiIndex < this.uiBands && origMag > this.preArray[uiIndex])
                this.preArray[uiIndex] = origMag;
        }

        // C1.5. Spectral granulation
        if (this.gran) {
            const g = this.gran;
            // Write current frame into pool unless frozen
            if (!g.frozen) {
                const base = g.writeIdx * numBins;
                for (let k = 0; k < numBins; k++) g.pool[base + k] = this.modMags[k];
                g.writeIdx = (g.writeIdx + 1) % g.poolFrames;
            }
            // Advance grain phase; pick a new grain position when period elapses
            g.grainPhase++;
            if (g.grainPhase >= g.grainPeriodFrames) {
                g.grainPhase = 0;
                if (Math.random() < g.scatter) {
                    // Float: jump to a random frame in the pool
                    g.grainReadIdx = Math.floor(Math.random() * g.poolFrames);
                }
                // else scatter=0: stutter — keep replaying the same grain frame
            }
            // Mix grain frame into modMags according to density
            const grainBase = g.grainReadIdx * numBins;
            const d = g.density;
            for (let k = 0; k < numBins; k++) {
                this.modMags[k] = d * g.pool[grainBase + k] + (1 - d) * this.modMags[k];
            }
        }

        // C2. Frequency blur
        const freqRadius = Math.round(freqAmt * 30);
        if (freqRadius > 0) {
            this._boxBlur(this.modMags, numBins, freqRadius, this.blurredMags);
        } else {
            this.blurredMags.set(this.modMags);
        }

        // C3. Temporal blur (IIR: blend with previous frame)
        const ta = timeAmt;
        if (ta > 0) {
            for (let k = 0; k < numBins; k++) {
                const m = ta * this.prevMags[k] + (1 - ta) * this.blurredMags[k];
                this.prevMags[k] = m;
                this.blurredMags[k] = m;
            }
        } else {
            this.prevMags.set(this.blurredMags);
        }

        // C4. Recombine: scale original complex vectors by final mag ratio
        for (let k = 0; k < numBins; k++) {
            const finalMag = this.blurredMags[k];
            const origMag  = this.origMags[k];
            const uiIndex  = Math.floor(k / binSize);
            if (uiIndex < this.uiBands && finalMag > this.uiArray[uiIndex])
                this.uiArray[uiIndex] = finalMag;
            const real = this.complexData[k * 2];
            const imag = this.complexData[k * 2 + 1];
            if (origMag > 0) {
                const ratio = finalMag / origMag;
                this.complexOutput[k * 2]     = real * ratio;
                this.complexOutput[k * 2 + 1] = imag * ratio;
            } else {
                this.complexOutput[k * 2] = this.complexOutput[k * 2 + 1] = 0;
            }
            if (k > 0 && k < this.fftSize / 2) {
                this.complexOutput[(this.fftSize - k) * 2]     =  this.complexOutput[k * 2];
                this.complexOutput[(this.fftSize - k) * 2 + 1] = -this.complexOutput[k * 2 + 1];
            }
        }

        this.port.postMessage({ type: 'render', preArray: this.preArray, postArray: this.uiArray });

        // D. Inverse Transform
        this.fft.inverseTransform(this.complexData, this.complexOutput);

        // E. Windowing on synthesis and Overlap-Add
        for (let i = 0; i < this.fftSize; i++) {
            // fft.js inverseTransform already normalises by 1/N, so no extra division needed.
            const outSample = this.complexData[i * 2] * this.hannWindow[i];
            
            // 4. Add the new processed window into the OLA buffer
            this.olaBuffer[i] += outSample;
        }
    }

    // ─── General utilities ────────────────────────────────────────────────

    // Compile a JS expression string into a function(time) → number.
    // Used by all message handlers that receive dynamic method arguments.
    static _compileExpr(src) {
        try { return new Function('time', `return +(${src});`); }
        catch { return () => 0; }
    }

    // Evaluate every registered parameter function for the current frame
    // and store the clamped [0, 1] result in _paramVals.
    _evalParams(time) {
        for (const [key, fn] of Object.entries(this._paramFuncs)) {
            let v = 0;
            try { v = fn(time); } catch {}
            this._paramVals[key] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
        }
    }

    _boxBlur(src, n, radius, out) {
        for (let k = 0; k < n; k++) {
            let sum = 0, count = 0;
            const lo = Math.max(0, k - radius);
            const hi = Math.min(n - 1, k + radius);
            for (let j = lo; j <= hi; j++) { sum += src[j]; count++; }
            out[k] = sum / count;
        }
    }
}

registerProcessor('spectral-coder-processor', SpectralCoderProcessor);