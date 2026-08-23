// Slice onset detection — percussive (HFE) and melodic (Spectral Flux) //

// ── Radix-2 DIT FFT (in-place, complex) ────────────────────────────────────

function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wRe = Math.cos(ang), wIm = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cRe = 1, cIm = 0;
            const half = len >> 1;
            for (let j = 0; j < half; j++) {
                const h   = i + j + half;
                const uRe = re[i+j], uIm = im[i+j];
                const vRe = re[h]*cRe - im[h]*cIm;
                const vIm = re[h]*cIm + im[h]*cRe;
                re[i+j] = uRe+vRe; im[i+j] = uIm+vIm;
                re[h]   = uRe-vRe; im[h]   = uIm-vIm;
                const nr = cRe*wRe - cIm*wIm;
                cIm = cRe*wIm + cIm*wRe; cRe = nr;
            }
        }
    }
}

// ── Hann window ─────────────────────────────────────────────────────────────

function makeHann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    return w;
}

// ── Frame-level magnitude spectra ───────────────────────────────────────────

function frameMagnitudes(data, fftSize, hopSize) {
    const win    = makeHann(fftSize);
    const nBins  = (fftSize >> 1) + 1;
    const nFrames = Math.max(1, Math.floor((data.length - fftSize) / hopSize) + 1);
    const frames  = [];
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    for (let f = 0; f < nFrames; f++) {
        const off = f * hopSize;
        for (let i = 0; i < fftSize; i++) {
            re[i] = (off + i < data.length ? data[off + i] : 0) * win[i];
            im[i] = 0;
        }
        fft(re, im);
        const mag = new Float32Array(nBins);
        for (let k = 0; k < nBins; k++) mag[k] = Math.sqrt(re[k]*re[k] + im[k]*im[k]);
        frames.push(mag);
    }
    return frames;
}

// ── Peak picker ─────────────────────────────────────────────────────────────

function pickPeaks(arr, minGap, threshMult) {
    let sum = 0;
    for (const v of arr) sum += v;
    const th = arr.length ? (sum / arr.length) * threshMult : 0;
    const out = [];
    for (let i = 1; i < arr.length - 1; i++) {
        if (arr[i] > th && arr[i] > arr[i-1] && arr[i] >= arr[i+1]) {
            if (!out.length || i - out[out.length-1] >= minGap) out.push(i);
        }
    }
    return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect transient onsets and return slice boundary objects.
 *
 * @param {AudioBuffer} audioBuffer
 * @param {number}      fftSize   - power of 2 (256–8192)
 * @param {'percussion'|'melodic'} type
 * @returns {{ start: number, end: number }[]}  sample-accurate slice list
 */
export function detectSlices(audioBuffer, fftSize, type) {
    const data  = audioBuffer.getChannelData(0);
    const sr    = audioBuffer.sampleRate;
    const hop   = fftSize >> 2;          // 75 % overlap
    const nBins = (fftSize >> 1) + 1;
    const frames   = frameMagnitudes(data, fftSize, hop);
    const nFrames  = frames.length;
    const minGap   = Math.max(2, Math.ceil(0.05 * sr / hop)); // ≥ 50 ms

    let onsetFrames;

    if (type === 'percussion') {
        // High-Frequency Energy: sum top-40% bin magnitudes, detect positive-derivative peaks.
        const hfStart = Math.floor(nBins * 0.6);
        const hfe  = new Float32Array(nFrames);
        for (let f = 0; f < nFrames; f++) {
            let e = 0;
            for (let k = hfStart; k < nBins; k++) e += frames[f][k];
            hfe[f] = e;
        }
        const diff = new Float32Array(nFrames);
        for (let f = 1; f < nFrames; f++) diff[f] = Math.max(0, hfe[f] - hfe[f-1]);
        onsetFrames = pickPeaks(diff, minGap, 1.5);
    } else {
        // Spectral Flux: half-wave rectified positive bin-magnitude increase.
        const flux = new Float32Array(nFrames);
        for (let f = 1; f < nFrames; f++) {
            let s = 0;
            for (let k = 0; k < nBins; k++) {
                const d = frames[f][k] - frames[f-1][k];
                if (d > 0) s += d;
            }
            flux[f] = s;
        }
        onsetFrames = pickPeaks(flux, minGap, 1.5);
    }

    // Frame 0 is always a slice start
    if (!onsetFrames.length || onsetFrames[0] !== 0) onsetFrames.unshift(0);

    const total   = data.length;
    let samples = onsetFrames.map(f => Math.min(f * hop, total - 1));
    // Deduplicate & sort
    samples = [...new Set(samples)].sort((a, b) => a - b);

    // Build {start, end} objects — each slice's end == next slice's start
    const slices = [];
    for (let i = 0; i < samples.length; i++) {
        slices.push({
            start: samples[i],
            end:   i + 1 < samples.length ? samples[i + 1] : total,
        });
    }
    return slices;
}
