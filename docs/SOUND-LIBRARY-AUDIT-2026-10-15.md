# KYX Sound Library — Audit & Improvement

**Date:** 2026-10-15

## Scope and method

The factory manifest contains 155 sounds. It has 142 curated WAV overrides and 13 intentionally synthesis-only voices: nine Field sounds, two Brush sounds, `ride.ding`, and `snare.ghost`. The optional piano and VSCO multisample packs are separate from the factory one-shots. I checked their file headers and decodability, and mixed house, trap, and boom-bap source-level test patterns from the shipped WAVs.

## STRONG SOUNDS

- The kick, snare, hat, percussion, bass, tonal, and FX families have useful contrast and well-defined roles. The library already covers soft through hard kicks, dry through roomy snares, closed through open hats, clean through driven bass, and short through sustained FX.
- Category loudness is consistent: maximum drift from the renderer target is 0.1 dB for kicks, 0.3 dB for snares, 0.8 dB for hats, 1.1 dB for rims, and 1.9 dB for percussion. All categories are within the existing 2.5 dB gate.
- Transient range remains intact: kick crest is 3.3–6.2 dB, snare/clap 8.4–10.5 dB, and cymbal/crash 16.3–21.5 dB. The sources are not uniformly flattened.
- The three velocity-zone 808 WAVs and held subs tune predictably. A steady-window sine fit measured the D1 808s within 0.4 cents of root; the coarse 150 ms audit FFT is not precise enough for this low register.

## IMPROVED

- Trimmed `factory.crash.china.wav` from 0.903 s to 0.469 s, retaining a 50 ms guard after the final sample above −60 dBFS. This removed 434 ms of quiet tail without changing its −5.49 dBFS peak or loud section.
- Updated the seed renderer to repeat its tail scan after content-DC removal. That stage can push a quiet synthesized noise tail below the trim floor, which the earlier scan could not see.

## WEAK / REDUNDANT

- No asset is a clear candidate for removal. There are no exact duplicate factory WAVs.
- The nearest-neighbour watchlist includes `clap.soft` / `clap.trad` (distance 0.141). Their softer three-hit spread and five-hit pitch-drifting handclap still have a plausible use distinction; keep them for now and review by ear when the clap family is next voiced.
- Other close pairs such as `hat.closed.soft` / `hat.closed`, `kick.knock` / `kick.lofi`, and `snare.drill` / `snare.main` are deliberate adjacent variants documented in the builders.

## LIBRARY GAPS

- The factory WAV set consists of rendered KYX synth seeds, not acoustic recordings. The Field and Brush voices are synthesis-only; the core has no recorded breaks or loop pack.
- All 142 factory WAVs are dual-mono stereo (identical left/right channels). This is fully mono-compatible and keeps drums centered, but the core has no genuinely wide source texture or transition FX.

## TECHNICAL ISSUES

- The post-fix audit passed for all 142 WAVs. They are consistently 44.1 kHz, 24-bit PCM WAVs; peaks range from −14.57 to −1.24 dBFS. No clipping, exact duplicates, material DC offset, or unintended leading silence remains. The riser, reverse, and sweep lead-ins are intentional ramps; the choir pad's 2.1 ms onset is its swell.
- The optional piano pack (120 files) and VSCO pack (2,485 files) both decode without errors; all are 44.1 kHz, 16-bit PCM WAVs. Their 0.143–26.733 s lengths are multisample regions, so they are not subject to one-shot tail trimming.
- In source-level four-bar beat stacks, house peaked at −2.7 dBFS, trap at −1.9 dBFS, and boom-bap at −7.8 dBFS; none clipped. The house stack's 20–120 Hz energy share was 81.1%, close to the Mix Doctor's 82% warning line, while trap was 53.1% and boom-bap 67.9%. The house result comes from overlapping the long kick and sub; lower the bass lane or avoid that overlap in a dense beat rather than attenuating the source asset.

## RECOMMENDED NEXT ADDITIONS

1. Record a small KYX drum set (kick, snare, hand clap, closed/open hat) with a few genuinely played velocity/round-robin takes. It would add human variation the synthesized seeds cannot.
2. Add a handful of original room, brush, and found-sound textures, including restrained stereo versions that fold down cleanly.
3. If loops are added, start with a few authored break, brush, and hand-percussion loops at distinct tempos. The current one-shot palette does not need more static synth variants.
