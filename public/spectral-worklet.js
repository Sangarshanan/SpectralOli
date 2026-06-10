import FFT from 'https://esm.sh/fft.js@4.0.4';

class SpectralCoderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        
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
            }
        };
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0][0]; 
        const output = outputs[0][0];
        if (!input) return true;

        // 1. Send the first 128 samples of the OLA buffer to the speakers
        for (let i = 0; i < 128; i++) {
            output[i] = this.olaBuffer[i];
        }

        // 2. Shift the OLA buffer left by 128 to make room for the next overlap
        this.olaBuffer.copyWithin(0, 128, this.fftSize);
        this.olaBuffer.fill(0, this.fftSize - 128, this.fftSize);

        // 3. Process incoming 128 samples
        for (let i = 0; i < 128; i++) {
            this.inputBuffer[this.inputWriteIndex++] = input[i];

            // When we have accumulated enough samples for a hop (1024)
            if (this.inputWriteIndex >= this.fftSize) {
                this.performSTFT();
                
                // Shift the input buffer left by the hop size (Overlap)
                this.inputBuffer.copyWithin(0, this.hopSize, this.fftSize);
                this.inputWriteIndex = this.fftSize - this.hopSize; // Set to 1024
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