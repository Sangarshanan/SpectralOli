## SpectralOli

**SpectralOli** is real-time browser based spectral livecoding interface. It can load audio loops whose spectrogram can then be manipulated by chaining different transformations. The goal is to treat the audio spectrogram as a visual canvas that can be manipulated through code with various frequency and spectral transformations that constant change the canvas of the audio which you can now see and not just hear.

Light and Sound together! **Oli (ஒலி)** in Tamil means both sound and light.

## How does it work

The transformations are build around a DSL which includes frequency and spectral operations so you can sketch filters and textures quickly without writing full processing code.

**Frequency Methods**

These methods define which parts of the spectrum are passed through.

| Call | Behaviour |
|---|---|
| `low(hz)` | pass frequencies below `hz` |
| `high(hz)` | pass frequencies above `hz` |
| `band(min, max)` | pass frequencies between `min` and `max` |
| `notch(min, max)` | cut frequencies between `min` and `max` |
| `.add(region)` | union with another region using `Math.max` |

Arguments accept arithmetic expressions, including `Math.*`, `%`, parentheses, and references to `time` when you want the cutoff to move during playback.

```
band(440 * 2, 440 * 8)                        // harmonic window from 880 Hz to 3520 Hz
high(Math.PI * 700)                           // cutoff at about 2199 Hz
low(time * 800 % 8000)                        // sweeping lowpass
band(Math.sin(time * 0.5) * 1000 + 1500, 4000) // moving lower edge with fixed upper edge
band(200, 4000).add(high(8000))               // midrange plus air band
```

Chains are evaluated left to right. A region expression always becomes a magnitude multiplier applied to the current spectral bin.

**Spectral Blur**

`.blur(freq_amt, time_amt)` smears the spectrum after the frequency region has been selected. Both arguments are optional and default to `0.5`.

`freq_amt` controls frequency smearing: energy is spread into neighbouring bins.

`time_amt` controls temporal smearing: the current frame is blended with previous frames to create a trailing, reverb-like persistence.

```
blur(0.8, 0)                                  // frequency smear only
blur(0, 0.85)                                 // temporal smear only
blur(0.3, 0.6)                                // light frequency spread with medium temporal decay
blur(Math.sin(time * 0.25) * 0.25 + 0.5, 0.6) // slow breathing blur width with steady temporal smear
band(200, 4000).blur(0.5, 0.4)                // chain blur after a bandpass filter
```
