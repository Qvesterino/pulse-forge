# KYX Starter Loops v1 — listening and technical review

**Audit date:** 2026-10-19  
**Status:** technical checks complete; human listening review still pending.

[Open the listening page](listen.html) to audition each source loop and the four paired previews. The paired previews keep each pair's relative layer balance and are attenuated or boosted as a whole to peak at approximately −1 dBFS. The original factory loops are untouched.

## Technical summary

- All eight source WAVs match the SHA-256 hashes in the pack manifest.
- All are stereo, 16-bit PCM at 22,050 Hz and match their declared four-bar duration within 17 microseconds.
- No source sample reaches full scale. Source sample peaks range from −2.20 to −11.72 dBFS; the loudest source has 2.20 dB of sample-peak headroom.
- Mean DC offsets are low (−45.13 dBFS or lower).
- A simple unity-gain digital sum of each genre's two loops has no over-range samples for House and UK Garage, but only 0.27 dB of sample-peak margin for Techno. The Trap pair reaches +0.97 dBFS and 449 summed sample values exceed full scale. The in-app master chain and track gains can change these results; check KYX's meters when opening the demo projects.
- The House and UKG musical layers have whole-file RMS levels 13.03 dB and 11.20 dB below their paired drum loops. This may be an intentional soft layer, but listen for whether the musical part is too buried.
- Four drum loops have a non-zero first sample from the intended beat-one transient. The last-to-first sample jump is 15.53–19.68 dB below the largest adjacent-sample change within each loop. This makes the boundary a listening check, not an automatic defect; replay each loop several times and listen for an extra tick.

## Per-loop measurements

Peak is sample peak, not an oversampled true-peak measurement. RMS is calculated across the full file, including quiet gaps. “Seam jump” is the amplitude difference between the final and first sample, expressed in dBFS; “vs internal step” compares it with the largest adjacent-sample change inside the loop.

| Loop                 | Genre     | BPM / key     | Peak dBFS | RMS dBFS | Clipped source samples | Seam jump dBFS | Seam vs internal step dB |
| -------------------- | --------- | ------------- | --------: | -------: | ---------------------: | -------------: | -----------------------: |
| Midnight House Drums | House     | 124 / Any     |     −2.23 |   −13.54 |                      0 |         −21.25 |                   −15.53 |
| Afterhours Keys      | House     | 124 / C minor |    −10.85 |   −26.57 |                      0 |         −78.27 |                   −51.68 |
| Warehouse Drums      | Techno    | 132 / Any     |     −2.20 |   −13.32 |                      0 |         −25.24 |                   −18.81 |
| Acid Pulse           | Techno    | 132 / E minor |     −7.76 |   −16.36 |                      0 |         < −240 |                   < −200 |
| Two-Step Drums       | UK Garage | 132 / Any     |     −2.33 |   −16.63 |                      0 |         −22.77 |                   −17.32 |
| Soul Stabs           | UK Garage | 132 / F minor |    −11.72 |   −27.83 |                      0 |         < −240 |                   < −200 |
| Half-Time Drums      | Trap      | 140 / Any     |     −2.22 |   −16.08 |                      0 |         −22.07 |                   −19.68 |
| Soft 808 Phrase      | Trap      | 140 / C minor |     −5.99 |   −15.42 |                      0 |         −71.22 |                   −51.82 |

## Paired preview checks

These are sample-level sums of each drum loop and its musical layer before the audition preview's whole-pair gain adjustment. “Over-range samples” counts sums whose absolute amplitude is at least 1.0.

| Pair      | Unity-sum peak | Unity-sum RMS | Over-range samples | Preview gain to about −1 dBFS |
| --------- | -------------: | ------------: | -----------------: | ----------------------------: |
| House     |     −1.51 dBFS |   −13.33 dBFS |                  0 |                      +0.51 dB |
| Techno    |     −0.27 dBFS |   −11.47 dBFS |                  0 |                      −0.73 dB |
| UK Garage |     −1.40 dBFS |   −16.31 dBFS |                  0 |                      +0.40 dB |
| Trap      |     +0.97 dBFS |   −12.35 dBFS |                449 |                      −1.97 dB |

## Human listening checklist

Use [the listening page](listen.html) with headphones first, then speakers at a comfortable level. Listen to the solo layers, then the pair preview. If something sounds wrong, note the loop and timestamp before changing the source.

| Genre     | Balance between layers | Click at loop repeat | Harsh / weak sound | Notes |
| --------- | ---------------------- | -------------------- | ------------------ | ----- |
| House     |                        |                      |                    |       |
| Techno    |                        |                      |                    |       |
| UK Garage |                        |                      |                    |       |
| Trap      |                        |                      |                    |       |

### Suggested follow-up if listening confirms the measured concerns

1. If Trap clips in the KYX demo project, lower the 808/drum bus or the tracks by at least 2 dB and confirm the master meter stays below full scale.
2. If the House or UKG musical layer is too quiet, adjust its source level and recheck the pair at the same playback volume.
3. Only add a seam fade or alter a transient if repeated listening reveals an unwanted click; the current numeric seam comparison alone does not establish an audible defect.

## Method and limits

The audit reads the PCM samples and WAV headers directly, checks each source hash against `manifest.json`, measures sample peak/RMS/DC and compares the loop boundary with internal sample changes. Pair diagnostics use an arithmetic sum at unity gain. The listening WAVs are simple pair sums with one constant gain per pair, no limiter, and no effects. This report does not establish sound quality, true peak, mono compatibility, device-specific playback or level balance by human judgment.

No automated test suite was run for this listening-review deliverable.
