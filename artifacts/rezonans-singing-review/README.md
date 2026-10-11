# REZONANS — sung-vocal review

Human listening material, not an automated pass. Source: [female vocal long.wav by owstu](https://freesound.org/people/owstu/sounds/628817/), marked CC0 1.0 on Freesound. The included source is the high-quality MP3 preview; its SHA-256 is pinned in README.json.

The mono source was decoded and resampled by Chromium to 48 kHz. Every file is stereo PCM16, aligned to Fine's measured 4095-sample (85.31 ms) path, RMS-matched over the sung phrase, and given the same peak-safe final gain. The processor runs Fine (4096 FFT), 100% wet, clarity 0.75, body gate 0.5, and no humanization.

| File | Signal | Phrase RMS | Peak | Voiced frames |
| --- | --- | ---: | ---: | ---: |
| 00-reference-aligned.wav | Sung source, latency aligned | 0.0813 | -10.24 dBFS | — |
| 01-fine-identity.wav | Fine, unison, neutral formant | 0.0813 | -10.24 dBFS | 83.5% |
| 02-fine-fifth.wav | Fine, perfect fifth (+7 st) | 0.0813 | -4.33 dBFS | 83.5% |
| 03-fine-fifth-formant-up.wav | Fine, fifth + formant (+6 st) | 0.0813 | -6.12 dBFS | 83.5% |
| 04-fine-fifth-formant-down.wav | Fine, fifth + formant (-6 st) | 0.0813 | -4.81 dBFS | 83.5% |

## Listen for

1. Compare 00 and 01 for tone stability and audible coloration at neutral settings.
2. Compare 02 against 00: does the fifth stay convincing as the singer changes notes?
3. Compare 03 and 04 against 02: do the formant extremes keep a believable vocal identity?
4. Note false note jumps, graininess on held notes, and any unevenness between syllables.

This sample contains sung notes but no lyric-rich consonant sequence. Use the separate speech review for intelligibility and consonant-smear checks. A human listening decision is still required.
