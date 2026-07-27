# SpectralOli

**Spectral(ஒலி)** is a real-time, browser-based spectral livecoding/ sound design interface. It can load audio loops and their spectrograms can be manipulated by chaining different transformations. Audio spectrogram is a visual canvas that can be manipulated through code with various transformations that constantly change the canvas of the audio which you can now see and not just hear.

## How does it work

The transformations are built around operations that can affect both your loops frequency and time domain, so you can sketch what you want using a simple DSL and see it happens realtime on your spectrogram.

Let us start with simple Frequency/ Time operations before going onto more complex transformations.

**Environment Setup**

`fft(size)` sets the FFT frame size used for spectral analysis on a track. It must be a power of two between `256` and `8192`, and — if used — must be the very first statement in the track's code, before any expression.

Smaller sizes give faster time resolution (good for percussive/granular material); larger sizes give finer frequency resolution (good for tonal/harmonic material). Defaults to `1024` when omitted.

```js
fft(2048)
band(200, 4000)               // fft(2048) applies to this track's spectral processing
```

**Frequency Methods**

These methods define which parts of the spectrum are passed through.

| Call | Behaviour |
|---|---|
| `low(hz)` | pass frequencies below `hz` |
| `high(hz)` | pass frequencies above `hz` |
| `band(min, max)` | pass frequencies between `min` and `max` |
| `.add(region)` | union with another region using `Math.max` |
| `.sub(region)` | subtract a region, masking it out from the current result |
| `.invert()` | invert the current region mask, so `band(min, max).invert()` becomes the complement of the band |

`gain(amount)` multiplies the final spectral magnitude, so you can add dynamics to any region expression or chain it after other methods.

Arguments accept arithmetic expressions, including `Math.*`, `%`, parentheses, and references to `time` when you want the cutoff to move during playback.

```js
band(440 * 2, 440 * 8)                        // harmonic window from 880 Hz to 3520 Hz
high(Math.PI * 700)                           // cutoff at about 2199 Hz
low(time * 800 % 8000)                        // sweeping lowpass
band(Math.sin(time * 0.5) * 1000 + 1500, 4000) // moving lower edge with fixed upper edge
band(200, 4000).add(high(8000))               // midrange plus air band
band(200, 4000).invert().add(band(5000, 8000)) // notch 200-4k, allow 5-8k
```

Chains are evaluated left to right. A region expression always becomes a magnitude multiplier applied to the current spectral bin.

**Time Methods**

These methods control playback timing and synchronization with the global BPM cycle.

| Call | Behaviour |
|---|---|
| `.fast(multiplier)` | speed up playback by a factor (any positive number) |
| `.slow(divisor)` | slow down playback by a factor (any positive number) |
| `.rev()` | reverse playback direction |

Arguments accept arithmetic expressions, including `Math.*`, and references to `time` for dynamic effects. Multiplier and divisor can be any positive value, including decimals.

```js
band(200, 4000).fast(2)                 // speed up 2x
band(200, 4000).slow(2)                 // slow down 2x
band(200, 4000).rev()                   // play loop in reverse
band(200, 4000).fast(2).rev()           // speed up and reverse
```

**Spectral Blur**

`.blur(freq_amt, time_amt)` smears the spectrum in freq & time axis. Both arguments are optional and default to `0.5`. Can be chained to frequency operations

```js
// frequency smear only
blur(0.8, 0)

// temporal smear only
blur(0, 0.85)

// light frequency spread with medium temporal decay
blur(0.3, 0.6)

// slow breathing blur width with steady temporal smear
blur(Math.sin(time * 0.25) * 0.25 + 0.5, 0.6)

// chain blur after a bandpass filter
band(200, 4000).blur(0.5, 0.4)
```

**Spectral Granulator**

`sgranulate(scatter, mix)` fragments the spectrum into grains drawn from past frames.

| Parameter | Default | Description |
|---|---|---|
| `scatter` | `0.5` | `0` stutters (repeats the same grain), `1` floats freely (random position each grain) |
| `mix` | `0.8` | wet/dry mix — `1` is fully granulated, `0` is the dry signal |

Both arguments accept arithmetic expressions, including `Math.*` and `time`.

```js
// basic granular cloud
sgranulate(0.5, 0.8)

// tight stutter — fully wet
sgranulate(0, 1)

// floating shimmer — fully random
sgranulate(1, 0.8)

// granulate a bandpass region
band(200, 4000).sgranulate(0.5, 0.8)

// breathing scatter — scatter oscillates between stutter and float
band(200, 4000).sgranulate(Math.sin(time * 0.3) * 0.5 + 0.5, 0.8)
```

**Spectral Scale, Rotate, Skew & Transpose**

These treat the spectrogram as a 2D canvas (time on the X axis, frequency on the Y axis) and warp it directly.

`.scale(x_stretch, y_stretch, mix)` — both stretch factors default to `1`, `mix` defaults to `1`.

- **X (`x_stretch`):** Time-stretch factor (`1` is normal, `2` is half speed).
- **Y (`y_stretch`):** Frequency inharmonicity factor — stretches spacing between spectral bins, distorting harmonic ratios.

`.rotate(degrees, mix)` — blends the X and Y axes, skewing time into frequency and vice versa. `degrees` defaults to `0`, `mix` defaults to `1`.

`.skew(x_skew, y_skew, mix)` — locks one axis in place and progressively slides the other. It creates a slanted parallelogram out of your canvas.

- **X-Axis Skew (Time offset by Frequency):** This forces high frequencies to play slightly later (or earlier) than low frequencies. A single, punchy drum hit gets smeared out across time. 
  - *Sonic Equivalent:* This is Spectral Delay or Dispersion. It sounds exactly like Ableton's Spectral Time "Tilt", the Kilohearts Disperser plugin, or the natural "pew-pew" sound of dropping a rock on a frozen lake (where high-frequency sound waves travel through the ice faster than low ones).
- **Y-Axis Skew (Frequency offset by Time):** The longer a sound plays on the X-axis, the further its pitch gets shifted on the Y-axis. 
  - *Sonic Equivalent:* This mimics a Continuous Glissando, an endless pitch-riser, or a slow Tape-Stop effect depending on the direction of the skew.

`.transpose(mix)` — the most radical pure affine transformation. Reflects the spectrogram matrix across its main diagonal, swapping the time and frequency axes entirely (`x' = y`, `y' = x`). `mix` defaults to `1`.

- **Visually:** The spectrogram is flipped on its side. The X-axis (Time) becomes the Y-axis (Frequency).
- **Sonically:** The length of your audio loop literally becomes the frequency bandwidth. A heavy sub-bass (lots of energy at the bottom of the Y-axis) becomes an immediate, massive burst of energy at the start of the output. An evolving 4-second pad becomes a 4-second frequency sweep.

All arguments accept arithmetic expressions, including `Math.*` and `time`.

```js
// Time-stretch by 2x (X-axis) without altering pitch (Y-axis)
band(200, 8000).scale(2, 1, 1)

// Stretch harmonic ratios by 1.5x (Y-axis) to create inharmonic, metallic bells
band(100, 4000).scale(1, 1.5, 1)

// Rhythmic rotation: spins the matrix forward over time, 80% wet
low(5000).rotate(time * 45 % 360, 0.8)

// X-Axis Skew: smear frequencies across time (pew-pew dispersion)
band(200, 8000).skew(0.5, 0, 1)

// Y-Axis Skew: endless pitch-riser (continuous glissando)
band(200, 8000).skew(0, 0.5, 1)

// Transpose: turn sub-bass energy into a transient burst, pads into frequency sweeps
band(20, 20000).transpose(1)

// Transpose at 50% wet — blended with original for a ghostly mirrored texture
band(20, 20000).transpose(0.5)
```
