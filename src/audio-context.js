import { state } from './state.js';

// AudioContext bootstrap

export async function ensureAudioCtx() {
    if (state.audioCtx) return;
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    state.masterGain = state.audioCtx.createGain();
    state.masterAnalyser = state.audioCtx.createAnalyser();
    state.masterAnalyser.fftSize = 2048;
    state.masterAnalyser.smoothingTimeConstant = 0.3;
    state.masterGain.connect(state.masterAnalyser);
    state.masterAnalyser.connect(state.audioCtx.destination);

    state.masterFreqData = new Float32Array(state.masterAnalyser.frequencyBinCount);

    await state.audioCtx.audioWorklet.addModule('/spectral-worklet.js');
}

// Phase-vocoder time-stretch (pitch-preserving)
// Returns a new AudioBuffer stretched by stretchFactor (>1 = slower, <1 = faster)

export function phaseVocoderStretch(srcBuffer, stretchFactor, actx) {
    if (Math.abs(stretchFactor - 1.0) < 0.005) return srcBuffer;

    const N    = 2048;
    const hopA = N >> 2;   // analysis hop — 75 % overlap
    const hopS = Math.round(hopA * stretchFactor);
    const nCh  = srcBuffer.numberOfChannels;
    const inLen  = srcBuffer.length;
    const outLen = Math.round(inLen * stretchFactor);

// Hann window
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++)
        win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));

// In-place radix-2 Cooley–Tukey FFT
    function fft(re, im, inv) {
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
            const ang = 2 * Math.PI / len * (inv ? -1 : 1);
            const wr = Math.cos(ang), wi = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let cr = 1, ci = 0;
                for (let j = 0; j < (len >> 1); j++) {
                    const ur = re[i+j],              ui = im[i+j];
                    const vr = re[i+j+(len>>1)]*cr - im[i+j+(len>>1)]*ci;
                    const vi = re[i+j+(len>>1)]*ci + im[i+j+(len>>1)]*cr;
                    re[i+j]          = ur + vr;  im[i+j]          = ui + vi;
                    re[i+j+(len>>1)] = ur - vr;  im[i+j+(len>>1)] = ui - vi;
                    const tr = cr*wr - ci*wi; ci = cr*wi + ci*wr; cr = tr;
                }
            }
        }
        if (inv) { const s = 1 / n; for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; } }
    }

    const out     = actx.createBuffer(nCh, outLen, srcBuffer.sampleRate);
    const re      = new Float32Array(N);
    const im      = new Float32Array(N);
    const normEnv = new Float32Array(outLen);

// Pre-compute OLA normalization envelope (same for all channels)
    {
        let outPos = 0;
        for (let inPos = 0; inPos < inLen; inPos += hopA, outPos += hopS) {
            if (outPos >= outLen) break;
            for (let i = 0; i < N; i++) {
                const di = outPos + i - (N >> 1);
                if (di >= 0 && di < outLen) normEnv[di] += win[i] * win[i];
            }
        }
    }

    const halfN = (N >> 1) + 1;

    for (let ch = 0; ch < nCh; ch++) {
        const src = srcBuffer.getChannelData(ch);
        const dst = out.getChannelData(ch);

        const phaseAcc = new Float32Array(halfN);
        const lastPhi  = new Float32Array(halfN);
        let firstFrame = true;

        let outPos = 0;
        for (let inPos = 0; inPos < inLen; inPos += hopA, outPos += hopS) {
            if (outPos >= outLen) break;

            re.fill(0); im.fill(0);
            for (let i = 0; i < N; i++) {
                const si = inPos + i - (N >> 1);
                re[i] = (si >= 0 && si < inLen ? src[si] : 0) * win[i];
            }

            fft(re, im, false);

// Accumulate synthesis phase using true instantaneous frequency
            for (let k = 0; k < halfN; k++) {
                const mag = Math.sqrt(re[k]*re[k] + im[k]*im[k]);
                const phi = Math.atan2(im[k], re[k]);
                if (firstFrame) {
                    phaseAcc[k] = phi;
                } else {
                    const expected = k * 2 * Math.PI * hopA / N;
                    let dp = phi - lastPhi[k] - expected;
                    dp -= 2 * Math.PI * Math.round(dp / (2 * Math.PI)); // wrap to [-π, π]
                    phaseAcc[k] += (expected + dp) / hopA * hopS;       // ω_true × hopS
                }
                lastPhi[k] = phi;
                re[k] = mag * Math.cos(phaseAcc[k]);
                im[k] = mag * Math.sin(phaseAcc[k]);
            }
// Mirror spectrum for real-signal IFFT
            for (let k = 1; k < halfN - 1; k++) {
                re[N-k] =  re[k];
                im[N-k] = -im[k];
            }
            firstFrame = false;

            fft(re, im, true);

// Synthesis window + overlap-add
            for (let i = 0; i < N; i++) {
                const di = outPos + i - (N >> 1);
                if (di >= 0 && di < outLen) dst[di] += re[i] * win[i];
            }
        }

// Divide by OLA normalization envelope
        for (let i = 0; i < outLen; i++) {
            if (normEnv[i] > 1e-8) dst[i] /= normEnv[i];
        }
    }

    return out;
}
