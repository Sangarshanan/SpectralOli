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
        this.clockMod = null;     // { speedMultiplier, isReversed }
        this.playing = false;

        this.uiBands  = 256;
        this.uiArray  = new Float32Array(this.uiBands); // post-DSL magnitudes
        this.preArray = new Float32Array(this.uiBands); // raw (pre-DSL) magnitudes

        // Visualization frames are batched before posting to the main thread —
        // this cuts postMessage/structured-clone overhead roughly 3x with no
        // change to visual time resolution (frames still arrive in order).
        this._renderBatch = [];
        this._renderBatchSize = 3;

        this.userFunc = (mag, freq, time, x, y, tRel, fRel) => mag;
        this.requiresCanvasPool = false;
        this.eval2D = false;

        // Spectral granulator state (null when inactive)
        this.gran = null;

        // Scale / Rotate / Skew / Transpose 2D canvas warp state (false when inactive)
        this.scaleFx = false;
        this.rotateFx = false;
        this.skewFx = false;
        this.transposeFx = false;

        // Slice sequencer state
        this.slices      = null;  // [{start, end}, ...] in samples, set by updateSlices
        this.seqIndices  = null;  // [0, 1, 3, ...] or null (= play all sequentially)
        this.seqStep     = 0;     // current position in seqIndices pattern
        this.seqSamplePos = 0;    // samples consumed within the current seq slice

        // General frame-level parameter system.
        // Any method with dynamic arguments registers its expressions here;
        // _evalParams() compiles and evaluates them all once per STFT frame.
        // To add a new method: populate _paramExprs/_paramFuncs (and optionally
        // _paramRanges to clamp outside the default [0,1]) in its message
        // handler, then read from _paramVals in performSTFT.
        this._paramExprs  = {};   // name → raw expression string (for change detection)
        this._paramFuncs  = {};   // name → compiled function(time) → number
        this._paramVals   = {};   // name → clamped value for current frame
        this._paramRanges = {};   // name → [min, max] clamp range (default [0,1])

        // fftSize, hopSize, FFT instance, all STFT buffers, blur history and
        // the scale/rotate canvas pool are all (re)initialised here so the
        // fft() DSL statement can resize everything at runtime.
        this._initFFT(1024);

        this.port.onmessage = (event) => {
            if (event.data.type === 'updateCode') {
                try {
                    this.userFunc = new Function('mag', 'freq', 'time', 'x', 'y', 'tRel', 'fRel', `return ${event.data.code};`);
                    this.requiresCanvasPool = !!event.data.requiresCanvasPool || /\b(?:x|y|tRel|fRel)\b/.test(event.data.code || '');
                    this.eval2D = !!event.data.eval2D || /\b(?:x|y|tRel|fRel)\b/.test(event.data.code || '');
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
                    this._paramRanges.blurFreq = [0, 1];
                    this._paramRanges.blurTime = [0, 1];
                    this.prevMags.fill(0);
                }
            } else if (event.data.type === 'updateFFT') {
                const size = Math.round(Number(event.data.size)) || 1024;
                const isPow2 = size > 0 && (size & (size - 1)) === 0;
                if (isPow2 && size >= 256 && size <= 8192 && size !== this.fftSize) {
                    this._initFFT(size);
                }
            } else if (event.data.type === 'updateScale') {
                const p = event.data.params;
                if (!p) {
                    this.scaleFx = false;
                    delete this._paramFuncs.scaleX;
                    delete this._paramFuncs.scaleY;
                    delete this._paramFuncs.scaleMix;
                } else {
                    this.scaleFx = true;
                    this._paramFuncs.scaleX   = SpectralCoderProcessor._compileExpr(String(p.xStretch ?? '1'));
                    this._paramFuncs.scaleY   = SpectralCoderProcessor._compileExpr(String(p.yStretch ?? '1'));
                    this._paramFuncs.scaleMix = SpectralCoderProcessor._compileExpr(String(p.mix ?? '1'));
                    this._paramRanges.scaleMix = [0, 1];
                }
            } else if (event.data.type === 'updateRotate') {
                const p = event.data.params;
                if (!p) {
                    this.rotateFx = false;
                    delete this._paramFuncs.rotateDeg;
                    delete this._paramFuncs.rotateMix;
                } else {
                    this.rotateFx = true;
                    this._paramFuncs.rotateDeg = SpectralCoderProcessor._compileExpr(String(p.degrees ?? '0'));
                    this._paramFuncs.rotateMix = SpectralCoderProcessor._compileExpr(String(p.mix ?? '1'));
                    this._paramRanges.rotateMix = [0, 1];
                    // degrees intentionally left unclamped so sweeps like
                    // `time * 45 % 360` behave naturally.
                }
            } else if (event.data.type === 'updateSkew') {
                const p = event.data.params;
                if (!p) {
                    this.skewFx = false;
                    delete this._paramFuncs.skewX;
                    delete this._paramFuncs.skewY;
                    delete this._paramFuncs.skewMix;
                } else {
                    this.skewFx = true;
                    this._paramFuncs.skewX   = SpectralCoderProcessor._compileExpr(String(p.xSkew ?? '0'));
                    this._paramFuncs.skewY   = SpectralCoderProcessor._compileExpr(String(p.ySkew ?? '0'));
                    this._paramFuncs.skewMix = SpectralCoderProcessor._compileExpr(String(p.mix ?? '1'));
                    // xSkew / ySkew left unclamped; mix clamped to [0,1]
                    this._paramRanges.skewMix = [0, 1];
                }
            } else if (event.data.type === 'updateTranspose') {
                const p = event.data.params;
                if (!p) {
                    this.transposeFx = false;
                    delete this._paramFuncs.transposeMix;
                } else {
                    this.transposeFx = true;
                    this._paramFuncs.transposeMix = SpectralCoderProcessor._compileExpr(String(p.mix ?? '1'));
                    this._paramRanges.transposeMix = [0, 1];
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
                            mix:              Math.max(0, Math.min(1, Number(p.mix ?? p.density))),
                            frozen:           Boolean(Number(p.freeze)),
                        };
                    } else {
                        this.gran.grainPeriodFrames = grainPeriodFrames;
                        this.gran.scatter = Math.max(0, Math.min(1, Number(p.scatter)));
                        this.gran.mix     = Math.max(0, Math.min(1, Number(p.mix ?? p.density)));
                        this.gran.frozen  = Boolean(Number(p.freeze));
                    }
                }
            } else if (event.data.type === 'play') {
                this.playing = true;
            } else if (event.data.type === 'stop') {
                this.playing = false;
                this.olaBuffer.fill(0);
                this.inputWriteIndex = 0;
            } else if (event.data.type === 'updateSlices') {
                this.slices = event.data.slices ?? null;
                // Reset sequencer position when slices change
                this.seqStep      = 0;
                this.seqSamplePos = 0;
            } else if (event.data.type === 'updateSeq') {
                this.seqIndices   = event.data.indices ?? null;
                // Reset sequencer position when pattern changes
                this.seqStep      = 0;
                this.seqSamplePos = 0;
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
        const { speedMultiplier = 1.0, isReversed = false } = this.clockMod || {};

        // When seq() is active but no manual slices have been detected,
        // synthesise equal-width slices from the source buffer so seq()
        // always has something to play regardless of prior slice detection.
        if (this.seqIndices && this.seqIndices.length > 0 && (!this.slices || this.slices.length === 0)) {
            const N = this.seqIndices.length;
            const total = this.sourceBuffer.length;
            const chunk = Math.floor(total / N);
            this.slices = [];
            for (let s = 0; s < N; s++) {
                this.slices.push({ start: s * chunk, end: s === N - 1 ? total : (s + 1) * chunk });
            }
        }

        for (let i = 0; i < 128; i++) {
            let sample;

            if (this.seqIndices && this.seqIndices.length > 0) {
                // ─ Seq mode: play slices in pattern order ─
                // clockMod.speedMultiplier scales how many source samples are consumed
                // per output sample (fast(4) → 4x, slow(2) → 0.5x).
                const stepIdx  = this.seqStep % this.seqIndices.length;
                const stepItem = this.seqIndices[stepIdx];
                const isObj    = typeof stepItem === 'object' && stepItem !== null;
                const sliceIdx = Math.min(isObj ? stepItem.sliceIndex : stepItem, this.slices.length - 1);
                const sl       = this.slices[sliceIdx];
                const slLen    = sl ? sl.end - sl.start : 0;
                const isMuted  = isObj ? stepItem.muted : false;
                // Per-step reversed (from reverse() op) OR global clockMod rev()
                const isRev    = (isObj ? stepItem.reversed : false) || isReversed;
                const stepSpeed = isObj ? (stepItem.speedMultiplier || 1.0) : 1.0;
                const totalSpeed = speedMultiplier * stepSpeed;

                if (slLen > 0 && !isMuted) {
                    const pos = Math.floor(this.seqSamplePos) % slLen;
                    const sampleOffset = isRev ? (slLen - 1 - pos) : pos;
                    sample = this.sourceBuffer[sl.start + sampleOffset];
                    this.seqSamplePos += totalSpeed;
                    if (this.seqSamplePos >= slLen) {
                        this.seqStep++;
                        // Carry fractional overshoot into the next slice
                        this.seqSamplePos = Math.max(0, this.seqSamplePos - slLen);
                    }
                } else {
                    sample = 0;
                    this.seqSamplePos += totalSpeed;
                    const targetLen = slLen > 0 ? slLen : 1024;
                    if (this.seqSamplePos >= targetLen) {
                        this.seqStep++;
                        this.seqSamplePos = Math.max(0, this.seqSamplePos - targetLen);
                    }
                }
            } else {
                // ─ Classic clock-phase mode (respects loopStart/loopEnd gate) ─
                const t = currentTime + i / sampleRate;
                const masterCycles = t * cyclesPerSecond;
                let bufferPhase = (masterCycles * speedMultiplier) % 1.0;
                if (bufferPhase < 0) bufferPhase += 1.0;
                if (isReversed) bufferPhase = 1.0 - bufferPhase;

                let sampleIndex = Math.floor(bufferPhase * this.sourceBuffer.length);
                sampleIndex = Math.max(0, Math.min(sampleIndex, this.sourceBuffer.length - 1));

                if (sampleIndex < this.loopStart || sampleIndex >= this.loopEnd) {
                    sample = 0.0;
                } else {
                    sample = this.sourceBuffer[sampleIndex];
                }
            }

            this.inputBuffer[this.inputWriteIndex++] = sample;

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
            if (!this.eval2D) {
                try { mag = this.userFunc(mag, freq, currentTime, 1.0, numBins > 1 ? k / (numBins - 1) : 0, 1.0, numBins > 1 ? k / (numBins - 1) : 0); } catch(e) {}
            }
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
            // Mix grain frame into modMags according to mix
            const grainBase = g.grainReadIdx * numBins;
            const m = g.mix;
            for (let k = 0; k < numBins; k++) {
                this.modMags[k] = m * g.pool[grainBase + k] + (1 - m) * this.modMags[k];
            }
        }

        // C1.7. Scale / Rotate / Skew / Transpose — treat recent frame history (this.canvas) as a
        // 2D time x frequency canvas and warp it before blurring/recombining.
        if (this.scaleFx || this.rotateFx || this.skewFx || this.transposeFx || this.eval2D) {
            const cv = this.canvas;
            const wBase = cv.writeIdx * numBins;
            for (let k = 0; k < numBins; k++) cv.pool[wBase + k] = this.modMags[k];

            if (this.eval2D) {
                for (let m = 0; m < cv.poolFrames; m++) {
                    const x = cv.poolFrames > 1 ? m / (cv.poolFrames - 1) : 1;
                    const frameIdx = (cv.writeIdx - cv.poolFrames + 1 + m + cv.poolFrames) % cv.poolFrames;
                    const rowBase = frameIdx * numBins;
                    for (let k = 0; k < numBins; k++) {
                        const y = numBins > 1 ? k / (numBins - 1) : 0;
                        const freq = k * sampleRate / this.fftSize;
                        let mag = cv.pool[rowBase + k];
                        try { mag = this.userFunc(mag, freq, currentTime, x, y, x, y); } catch(e) {}
                        if (!isFinite(mag) || mag < 0) mag = 0;
                        cv.pool[rowBase + k] = mag;
                    }
                }
                if (!this.scaleFx && !this.rotateFx && !this.skewFx && !this.transposeFx) {
                    for (let k = 0; k < numBins; k++) this.modMags[k] = cv.pool[wBase + k];
                }
            }

            if (this.scaleFx) {
                const xStretch = this._paramVals.scaleX   ?? 1;
                const yStretch = this._paramVals.scaleY   ?? 1;
                const mix      = this._paramVals.scaleMix ?? 1;

                // time multiplier: xStretch = 1 is normal speed, 2 is 2x faster
                // negative xStretch reverses direction, 0 freezes time
                cv.scaleReadPos = (cv.scaleReadPos + xStretch) % cv.poolFrames;
                if (cv.scaleReadPos < 0) cv.scaleReadPos += cv.poolFrames;

                const f0 = Math.floor(cv.scaleReadPos);
                const f1 = (f0 + 1) % cv.poolFrames;
                const ft = cv.scaleReadPos - f0;
                const base0 = f0 * numBins, base1 = f1 * numBins;

                for (let k = 0; k < numBins; k++) {
                    let srcK = 0;
                    if (yStretch > 0) {
                        srcK = k / yStretch;
                    } else if (yStretch < 0) {
                        srcK = (numBins - 1) + (k / yStretch);
                    }

                    const k0 = Math.floor(srcK);
                    const k1 = k0 + 1;
                    const kt = srcK - k0;
                    
                    let m0 = 0, m1 = 0;
                    if (k0 >= 0 && k0 < numBins) m0 = cv.pool[base0 + k0] * (1 - ft) + cv.pool[base1 + k0] * ft;
                    if (k1 >= 0 && k1 < numBins) m1 = cv.pool[base0 + k1] * (1 - ft) + cv.pool[base1 + k1] * ft;
                    
                    const warped = m0 * (1 - kt) + m1 * kt;
                    this._scratchWarp[k] = mix * warped + (1 - mix) * this.modMags[k];
                }
                this.modMags.set(this._scratchWarp);
            }

            if (this.rotateFx) {
                const degrees = this._paramVals.rotateDeg  ?? 0;
                const mix     = this._paramVals.rotateMix ?? 1;
                // Shear-based rotation: each frequency bin reads from a
                // time-shifted point in the canvas, shifted proportionally to
                // its distance from the center bin — skewing time into frequency.
                const shearPerBin = Math.max(-50, Math.min(50, Math.tan((degrees % 360) * Math.PI / 180)));
                const center = numBins / 2;

                for (let k = 0; k < numBins; k++) {
                    let rf = cv.writeIdx - (k - center) * shearPerBin;
                    rf = ((rf % cv.poolFrames) + cv.poolFrames) % cv.poolFrames;
                    const f0 = Math.floor(rf);
                    const f1 = (f0 + 1) % cv.poolFrames;
                    const ft = rf - f0;
                    const warped = cv.pool[f0 * numBins + k] * (1 - ft) + cv.pool[f1 * numBins + k] * ft;
                    this._scratchWarp[k] = mix * warped + (1 - mix) * this.modMags[k];
                }
                this.modMags.set(this._scratchWarp);
            }

            if (this.skewFx) {
                const xSkew = this._paramVals.skewX   ?? 0;
                const ySkew = this._paramVals.skewY   ?? 0;
                const mix   = this._paramVals.skewMix ?? 1;

                // X-Axis Skew (Spectral Delay / Dispersion):
                // Each bin k reads from a time position offset proportional to
                // its bin index. High bins are delayed (or advanced) relative to
                // low bins — smearing a transient into a "pew-pew" sweep.
                // Scale factor: maxFrameShift = poolFrames * 0.5 so xSkew ±1
                // spans half the canvas history.
                if (xSkew !== 0) {
                    const maxFrameShift = cv.poolFrames * 0.5;
                    for (let k = 0; k < numBins; k++) {
                        const timeOffset = xSkew * maxFrameShift * (k / numBins);
                        let rf = cv.writeIdx - timeOffset;
                        rf = ((rf % cv.poolFrames) + cv.poolFrames) % cv.poolFrames;
                        const f0 = Math.floor(rf);
                        const f1 = (f0 + 1) % cv.poolFrames;
                        const ft = rf - f0;
                        const warped = cv.pool[f0 * numBins + k] * (1 - ft) + cv.pool[f1 * numBins + k] * ft;
                        this._scratchWarp[k] = mix * warped + (1 - mix) * this.modMags[k];
                    }
                    this.modMags.set(this._scratchWarp);
                }

                // Y-Axis Skew (Continuous Glissando / Tape-Stop):
                // For each time column in history, the further back it is the
                // more its frequency axis is shifted. Reading older frames at
                // a progressively offset bin position produces a pitch-glide
                // that accumulates the longer the sound plays.
                // The read frame is the write head (current frame); we instead
                // apply it to the current mags — the effective pitch shift grows
                // as the material ages through the canvas, so we shift the
                // current read bin by ySkew * maxBinShift as a continuous offset
                // that advances by one bin-unit per frame.
                if (ySkew !== 0) {
                    const maxBinShift = numBins * 0.5;
                    // Accumulated bin offset advances each frame by ySkew bins
                    cv.ySkewPhase = (cv.ySkewPhase ?? 0) + ySkew;
                    const binOffset = cv.ySkewPhase % numBins;
                    for (let k = 0; k < numBins; k++) {
                        const srcK = k - binOffset;
                        const k0 = Math.floor(srcK);
                        const k1 = k0 + 1;
                        const kt = srcK - k0;
                        const wk0 = ((k0 % numBins) + numBins) % numBins;
                        const wk1 = ((k1 % numBins) + numBins) % numBins;
                        const warped = this.modMags[wk0] * (1 - kt) + this.modMags[wk1] * kt;
                        this._scratchWarp[k] = mix * warped + (1 - mix) * this.modMags[k];
                    }
                    this.modMags.set(this._scratchWarp);
                }
            }

            if (this.transposeFx) {
                const mix = this._paramVals.transposeMix ?? 1;

                // True axis swap (matrix transpose):
                // The pool is a 2D buffer: pool[frameIdx * numBins + binIdx].
                // A normal read is: output[k] = pool[writeIdx][k]  (current frame, bin k).
                // The transpose swaps time ↔ frequency:
                //   output[k] = pool[k % poolFrames][transposePhase % numBins]
                // — the output frequency bin index selects *which historical frame* to read,
                //   while transposePhase (advancing 1 per STFT frame) sweeps through the
                //   frequency axis of each historical snapshot.
                // Sonic result: the loop's temporal evolution becomes a frequency sweep,
                // and spectral energy at position k plays at time k (not freq k).
                cv.transposePhase = ((cv.transposePhase ?? 0) + 1) % numBins;
                const phaseBin = Math.floor(cv.transposePhase);

                for (let k = 0; k < numBins; k++) {
                    const srcFrame = k % cv.poolFrames;
                    const warped = cv.pool[srcFrame * numBins + phaseBin];
                    this._scratchWarp[k] = mix * warped + (1 - mix) * this.modMags[k];
                }
                this.modMags.set(this._scratchWarp);
            }

            cv.writeIdx = (cv.writeIdx + 1) % cv.poolFrames;
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

        this._renderBatch.push({ pre: this.preArray.slice(), post: this.uiArray.slice() });
        if (this._renderBatch.length >= this._renderBatchSize) {
            const frames = this._renderBatch;
            this._renderBatch = [];
            const transfer = [];
            for (const f of frames) transfer.push(f.pre.buffer, f.post.buffer);
            this.port.postMessage({ type: 'renderBatch', frames }, transfer);
        }

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

    // (Re)initialise fftSize, hopSize, the FFT instance, every STFT/blur
    // buffer, and the scale/rotate canvas pool. Called from the constructor
    // and whenever the DSL's fft(size) statement requests a new size.
    _initFFT(size) {
        this.fftSize = size;
        this.hopSize = size / 2; // 50% overlap
        this.fft = new FFT(size);

        this.inputBuffer = new Float32Array(size);
        this.olaBuffer = new Float32Array(size);
        this.windowedBuffer = new Float32Array(size);
        this.complexData = this.fft.createComplexArray();
        this.complexOutput = this.fft.createComplexArray();
        this.inputWriteIndex = 0;

        const numBins = size / 2 + 1;
        this.origMags     = new Float32Array(numBins);
        this.modMags      = new Float32Array(numBins);
        this.blurredMags  = new Float32Array(numBins);
        this.prevMags     = new Float32Array(numBins);
        this._scratchWarp = new Float32Array(numBins);

        // Pre-compute sqrt-Hann window for both analysis and synthesis.
        this.hannWindow = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            this.hannWindow[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1))));
        }

        // Granulate pool and scale/rotate canvas are both sized by numBins,
        // so they must be rebuilt whenever the FFT size changes.
        this.gran = null;
        const framesPerSecond = sampleRate / this.hopSize;
        const canvasFrames = Math.max(8, Math.round(1.5 * framesPerSecond));
        this.canvas = {
            pool: new Float32Array(canvasFrames * numBins),
            poolFrames: canvasFrames,
            writeIdx: 0,
            scaleReadPos: 0,
        };
    }

    // Compile a JS expression string into a function(time) → number.
    // Used by all message handlers that receive dynamic method arguments.
    static _compileExpr(src) {
        try { return new Function('time', `return +(${src});`); }
        catch { return () => 0; }
    }

    // Evaluate every registered parameter function for the current frame,
    // clamp to its registered range (default [0, 1] when none is set — used
    // by blur — or left unclamped when explicitly registered as null, e.g.
    // rotate's degrees), and store the result in _paramVals.
    _evalParams(time) {
        for (const [key, fn] of Object.entries(this._paramFuncs)) {
            let v = 0;
            try { v = fn(time); } catch {}
            if (!Number.isFinite(v)) v = 0;
            const range = this._paramRanges[key];
            if (range) v = Math.max(range[0], Math.min(range[1], v));
            this._paramVals[key] = v;
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