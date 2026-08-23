# SpectralOli

**Spectral(ஒலி)** is a browser based livecoding environment for reshaping audio loops by treating the spectrogram as an editable two-dimensional canvas.

You drop in an audio loop and write short lines of code to reshape that spectrogram while it's playing. Blur it, rotate it, stretch it, carve a band out of it, chop it into slices and rearrange it. The spectrogram is drawn back on screen in real time, so you can visualise the canvas as you edit.

The spectrogram as a canvas idea draws inspirations from many existing projects in different ways, Here are a few: Metasynth, Strudel, SuperCollider, Composers Desktop Project and a whole lot more.

## Running it

This is how you can run it locally

```bash
npm install
npm run dev
```

For the Freesound panel you'll need an API key from [freesound.org](https://freesound.org/apiv2/apply/) in your environment:

```bash
FREESOUND_API_KEY=your_key_here
```

Requests go through a small proxy under `api/` so the key never reaches the browser. Everything else works fine without it.
