# SpectralOli

**Spectral(ஒலி)** (*oli* in Tamil means "sound") is a browser based livecoding instrument for sound design. You drop in an audio loop, it gets pulled apart into a spectrogram, and from there you write short lines of code to reshape that spectrogram while it's playing. Blur it, rotate it, stretch it, carve a band out of it, chop it into slices and rearrange it. The spectrogram is drawn back on screen in real time, so you can visualise the canvas as you edit.

The spectrogram as a canvas idea draws inspirations from tons of projects, Here are some of them: Metasynth, SuperCollider, Strudel, Composers Desktop Project and a whole lot more.


## Running it

```bash
npm install
npm run dev
```

For the Freesound panel you'll need an API key from [freesound.org](https://freesound.org/apiv2/apply/) in your environment:

```bash
FREESOUND_API_KEY=your_key_here
```

Requests go through a small proxy under `api/` so the key never reaches the browser. Everything else works fine without it.

Build with `vite build`. It's a static site plus a couple of serverless functions, and deploys to Vercel as-is (see `vercel.json`).

## Browser support

Needs Web Audio and AudioWorklet, so a recent Chrome, Firefox or Safari, served over HTTPS or localhost. It could be CPU hungry so large FFT sizes across many simultaneous tracks might make your fans spin.
