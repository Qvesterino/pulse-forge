# REZONANS listening review

A human listening reference, not a pass/fail golden. Source: Wikimedia Commons, “Do you mind if I open the window.wav” by Czechcamp, CC0 1.0. The fixture is pinned in the test suite (SHA-1 1bf2d93eb310128ed323457ddc70ef2b0b9f980b).

All clips are stereo 48 kHz / 16-bit PCM, latency-aligned to the measured Fine path (4095 samples / 85.31 ms), RMS-matched over the phrase, and peak-safe with a shared final gain. REZONANS uses Fine (4096 FFT), 100% wet, one centered voice, clarity 0.75, body gate 0.5, no humanization.

| File | Signal | Phrase RMS | Peak |
| --- | --- | ---: | ---: |
| 00-reference-aligned.wav | Source, latency aligned | 0.0868 | -4.91 dBFS |
| 01-fine-identity.wav | Fine, unison, formant 0 st | 0.0868 | -4.91 dBFS |
| 02-fine-harmony-plus-7.wav | Fine, +7 st harmony, formant 0 st | 0.0868 | -3.38 dBFS |
| 03-fine-harmony-plus-7-formant-plus-6.wav | Fine, +7 st harmony, formant +6 st | 0.0868 | -1.01 dBFS |
| 04-fine-harmony-plus-7-formant-minus-6.wav | Fine, +7 st harmony, formant -6 st | 0.0868 | -3.65 dBFS |

## Listen for

1. Compare 00 and 01: does identity processing smear or color consonants?
2. Compare 02 with 00: are word onsets intelligible at a perfect fifth?
3. Compare 03 and 04 with 02: do the formant extremes remain natural, or become hollow / pinched?
4. Note any syllable where the harmony jumps or sounds like the wrong singer.

These files stress the spectral path at 100% wet. They do not replace a musical sung-vocal review.
