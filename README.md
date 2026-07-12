# SpectralOli

**Spectral(ஒலி)** is a real-time, browser-based spectral livecoding/ sound design interface. It can load audio loops and their spectrograms can be manipulated by chaining different transformations. Audio spectrogram is a visual canvas that can be manipulated through code with various transformations that constantly change the canvas of the audio which you can now see and not just hear.

## How does it work

The transformations are built around operations that can affect both your loops frequency and time domain, so you can sketch what you want using a simple DSL and see it happens realtime on your spectrogram.

Let us start with simple Frequency/ Time operations before going onto more complex transformations.

**Frequency Methods**

These methods define which parts of the spectrum are passed through.

| Call | Behaviour |
|---|---|
| `low(hz)` | pass frequencies below `hz` |
| `high(hz)` | pass frequencies above `hz` |
| `band(min, max)` | pass frequencies between `min` and `max` |
| `.add(region)` | union with another region using `Math.max` |
| `.sub(region)` | subtract a region, masking it out from the current result |
| `.mul(region)` | intersect with another region using `Math.min` |
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
band(200, 4000).sub(band(300, 350)).gain(1.5)   // boost outer band, notch middle
low(1000).mul(high(500)).blur(0.2, 0.4)         // 500-1k intersection with blur
```

Chains are evaluated left to right. A region expression always becomes a magnitude multiplier applied to the current spectral bin.

**Time Methods**

These methods control playback timing and synchronization with the global BPM cycle.

| Call | Behaviour |
|---|---|
| `.fast(multiplier)` | speed up playback by a factor (any positive number) |
| `.slow(divisor)` | slow down playback by a factor (any positive number) |
| `.fit(cycles)` | fit loop to a specific number of BPM cycles |
| `.rev()` | reverse playback direction |

Arguments accept arithmetic expressions, including `Math.*`, and references to `time` for dynamic effects. Multiplier and divisor can be any positive value, including decimals.

```js
band(200, 4000).fast(2)                 // speed up 2x
band(200, 4000).slow(2)                 // slow down 2x
band(440*2, 440*8).fit(4)               // fit to 4 BPM cycles
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

`granulate(poolSize, scatter, grainRate, density, freeze)` fragments the spectrum into grains drawn from a rolling memory of past frames — turning any loop into a shimmering cloud or a frozen stutter.

| Parameter | Default | Description |
|---|---|---|
| `poolSize` | `2` | temporal scope of the memory pool in seconds — how wide a cloud the grains are drawn from |
| `scatter` | `0.5` | `0` stutters (repeats the same grain), `1` floats freely (random position each grain) |
| `grainRate` | `80` | grain speed in milliseconds — lower values shimmer, higher values chunk |
| `density` | `0.8` | wet/dry mix — `1` is fully granulated, `0` is the dry signal |
| `freeze` | `0` | `1` locks the pool and granulates a captured moment; `0` lets the pool update continuously |

`poolSize` and `grainRate` together define the *texture*: one sets the temporal scope, the other controls how fast you move through it. `scatter` is the core granular dial, from deterministic stutter to stochastic cloud. `freeze` is a performance event — pass `1` to capture and hold a moment in the pool.

All arguments accept arithmetic expressions, including `Math.*` and `time`.

```js
// basic granular cloud
granulate(2, 0.5, 80, 0.8, 0)

// tight stutter — same grain repeats fast
granulate(0.5, 0, 30, 1, 0)

// floating shimmer — wide pool, fully random
granulate(4, 1, 60, 0.9, 0)

// freeze current spectral moment and granulate it
granulate(2, 0.7, 80, 1, 1)

// granulate a bandpass region
band(200, 4000).granulate(2, 0.5, 80, 0.8, 0)

// breathing scatter — scatter oscillates between stutter and float
band(200, 4000).granulate(2, Math.sin(time * 0.3) * 0.5 + 0.5, 80, 0.8, 0)
```
