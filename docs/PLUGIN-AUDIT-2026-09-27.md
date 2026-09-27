# Internal Plugins — Integration, Functionality & Parameter Range Audit

**Run window:** 2026-09-27T06:15:11.261Z → 2026-09-27T06:26:21.664Z (real Chromium, offline renders at 44.1 kHz)

## Scope

- **Effects:** 47 registered effect types (42 core + 5 flagship suites)
- **Instruments:** 22 registered instrument kinds
- Every effect swept: **all** exposed parameters at min AND max (plus defaults), each render checked for finiteness, runaway gain, and measured output change (RMS / side energy / spectral centroid).
- Every effect inserted on a project drum bus through the real command path and rendered by the production offline renderer: processed vs bypassed vs removed, JSON round-trip restore, automation lane.
- Model-level contracts (ranges, units, clamps, worklet descriptor coverage, serialization, automation targets, presets) are pinned by `tests/plugin-functional-audit.test.ts`.

## Method (evidence per column)

| Column | Evidence |
| --- | --- |
| Loads | Constructs in a real context + full engine offline render finite (`hostFinite`), param sweep ran without throwing |
| Processes Audio | ≥1 parameter moves the measured output by >2% at an extreme (`responsive`) AND the fingerprinted engine render differs from bypass (`hostProcesses`); effects whose minimal host doc cannot exercise them by design (sidechain/vocoder need a key/modulator track) are evidenced by the factory sweep with a modulator feed (`hostExemptReason`) |
| Parameter Ranges Valid | All min/max renders finite, no runaway gain (peak > 40 ≙ runaway, not mere headroom), rapid min↔max swing render finite, all factory presets finite (`unstableParams`, `rapidSwingFinite`, presets) |
| State Restore | JSON round-trip + normalizeProject renders identical to the original mix (maxDiff ≤ 1e-3; the measured cross-render worklet jitter floor is ~2e-4) |
| Automation | An engine automation lane stepping the strongest param mid-pattern audibly changes the rendered output vs the same doc WITHOUT the lane (delta > 2%), and stays finite |

## Effect matrix

| Plugin | Loads | Processes Audio | Parameter Ranges Valid | State Restore | Automation | Known Issues |
| --- | --- | --- | --- | --- | --- | --- |
| EQ (`eq`) | PASS | FAIL | PASS | PASS | PASS | inert params: lpFreq, lowShelfFreq, lowMidFreq, lowMidQ, highMidFreq, highMidQ, highShelfFreq, lowGain, lowFreq, midGain, midFreq, midQ, highGain, highFreq; bypass ≠ removed (tail/graph asymmetry) |
| M/S EQ (`msEq`) | PASS | PASS | PASS | PASS | PASS | inert params: midLowFreq, midHighFreq, midHighGain, sideLowFreq, sideHighFreq, sideHighGain; bypass ≠ removed (tail/graph asymmetry) |
| Multiband (`multiband`) | PASS | PASS | PASS | PASS | PASS | inert params: lowFreq, highFreq, soloLow, soloMid, soloHigh, mix; bypass ≠ removed (tail/graph asymmetry) |
| Compressor (`compressor`) | PASS | PASS | PASS | PASS | PASS | inert params: scHpf, autoRelease; bypass ≠ removed (tail/graph asymmetry) |
| Saturation (`saturation`) | PASS | PASS | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Tape Sat (`tapeSat`) | PASS | PASS | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Clipper (`clipper`) | PASS | PASS | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Limiter (`limiter`) | PASS | PASS | PASS | PASS | PASS | inert params: threshold, lookaheadMs, link, mix; bypass ≠ removed (tail/graph asymmetry) |
| Step Gate (`stepGate`) | PASS | FAIL | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| SV Filter (`svFilter`) | PASS | PASS | PASS | PASS | PASS | inert params: mode, mix; bypass ≠ removed (tail/graph asymmetry) |
| Flanger (`flanger`) | PASS | FAIL | PASS | PASS | PASS | inert params: spread; bypass ≠ removed (tail/graph asymmetry) |
| Tremolo (`tremolo`) | PASS | FAIL | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Autowah (`autowah`) | PASS | PASS | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Stutter (`stutter`) | PASS | PASS | PASS | PASS | PASS | inert params: division, feedback, smooth; bypass ≠ removed (tail/graph asymmetry) |
| Comb (`comb`) | PASS | PASS | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Vowel (`vowel`) | PASS | FAIL | PASS | PASS | FAIL | ALL parameters inert at both extremes; bypass ≠ removed (tail/graph asymmetry) |
| Vocoder (`vocoder`) | PASS | PASS | PASS | PASS | FAIL | host exempt: host has no modulator track — carrier passthrough is correct; sweep carries the processing evidence; bypass ≠ removed (tail/graph asymmetry) |
| Reverse Swell (`reverseSwell`) | PASS | FAIL | PASS | PASS | FAIL | ALL parameters inert at both extremes; bypass ≠ removed (tail/graph asymmetry) |
| Granular Freeze (`granularFreeze`) | PASS | PASS | PASS | PASS | PASS | inert params: window, position, drift, grainMs, scatter, pitch, tone, level, mix; bypass ≠ removed (tail/graph asymmetry) |
| Duck Delay (`duckDelay`) | PASS | FAIL | PASS | PASS | FAIL | inert params: feedback, duckAttack, pingpong; bypass ≠ removed (tail/graph asymmetry) |
| RYFT (`kaskada`) | PASS | PASS | PASS | PASS | FAIL | inert params: pingPong, feedback, drive, unmask, unmaskSens, unmaskAtk, unmaskRel; bypass ≠ removed (tail/graph asymmetry) |
| Multi-Tap (`multiTapDelay`) | PASS | PASS | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Reverb (`reverb`) | PASS | PASS | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Delay (`delay`) | PASS | PASS | PASS | PASS | FAIL | inert params: feedback, tone; bypass ≠ removed (tail/graph asymmetry) |
| Pump (`pump`) | PASS | FAIL | PASS | PASS | FAIL | bypass ≠ removed (tail/graph asymmetry) |
| Distortion (`distortion`) | PASS | PASS | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Bitcrusher (`bitcrusher`) | PASS | PASS | PASS | PASS | PASS | inert params: downsample, mix; bypass ≠ removed (tail/graph asymmetry) |
| Chorus (`chorus`) | PASS | PASS | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Phaser (`phaser`) | PASS | PASS | PASS | PASS | FAIL | inert params: rate, sync, depth, center, spread, feedback, stages; bypass ≠ removed (tail/graph asymmetry) |
| Haas Widener (`haasWidener`) | PASS | PASS | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Sidechain (`sidechain`) | PASS | PASS | PASS | PASS | FAIL | host exempt: host has no key track — dry path is correct; sweep carries the processing evidence; bypass ≠ removed (tail/graph asymmetry) |
| Transient Shaper (`transient`) | PASS | PASS | PASS | PASS | PASS | inert params: sensitivity, mix; bypass ≠ removed (tail/graph asymmetry) |
| Drum Buss (`drumBuss`) | PASS | PASS | PASS | PASS | PASS | inert params: boomAmount; bypass ≠ removed (tail/graph asymmetry) |
| Bass Buss (`bassBuss`) | PASS | PASS | PASS | FAIL | PASS | inert params: subOsc; bypass ≠ removed (tail/graph asymmetry); restore diff 1.4e-3 |
| Utility (`utility`) | PASS | PASS | PASS | PASS | PASS | inert params: dcBlock; bypass ≠ removed (tail/graph asymmetry) |
| Gate (`gate`) | PASS | PASS | PASS | PASS | PASS | inert params: hysteresis, attack, hold, release, range, lookahead, mix; bypass ≠ removed (tail/graph asymmetry) |
| Shimmer (`shimmer`) | PASS | PASS | PASS | PASS | PASS | inert params: decay, shift, shimmer; bypass ≠ removed (tail/graph asymmetry) |
| PRISM (`fxeq`) | PASS | PASS | PASS | PASS | FAIL | inert params: bandCount, crossoverOrder, mix, limiterEnabled; bypass ≠ removed (tail/graph asymmetry) |
| VLYX (`ultina`) | PASS | PASS | PASS | PASS | FAIL | inert params: global.mix, transient.enabled, exciter.enabled, unmask.enabled, unmask.ecosystemEnabled, unmask.amount; bypass ≠ removed (tail/graph asymmetry) |
| VØID (`ozvena`) | PASS | PASS | PASS | PASS | PASS | inert params: engines.e2.enabled, global.quality; bypass ≠ removed (tail/graph asymmetry) |
| MORPH (`morphdynamics`) | PASS | PASS | PASS | FAIL | FAIL | inert params: macro.texture; bypass ≠ removed (tail/graph asymmetry); restore diff 1.9e-2 |
| Ring Mod (`ringMod`) | PASS | PASS | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Tape Stop (`tapeStop`) | PASS | PASS | PASS | PASS | PASS | inert params: time, curve, spin, mix; bypass ≠ removed (tail/graph asymmetry) |
| freqShifter (`freqShifter`) | FAIL | FAIL | FAIL | PASS | FAIL | sweep error: runner: TimeoutError: page.goto: Timeout 180000ms exceeded.
Call log:
[2m  - navigating to "http://127.0.0.1:5221/", waiting until "domcontentloaded"[22m
; host error: not reached; ALL parameters inert at both extremes; rapid swing render non-finite; bypass ≠ removed (tail/graph asymmetry) |
| Pitch Shift (`pitchShift`) | PASS | PASS | PASS | PASS | PASS | bypass ≠ removed (tail/graph asymmetry) |
| Vinyl Suite (`vinyl`) | PASS | PASS | PASS | PASS | PASS | inert params: amount, crackle, crackleTone, crackleDecay, hiss, hissTone, rumble, rumbleTone, flutterRate; bypass ≠ removed (tail/graph asymmetry) |
| Beat Mangler (`beatMangler`) | PASS | FAIL | PASS | PASS | PASS | ALL parameters inert at both extremes; bypass ≠ removed (tail/graph asymmetry) |

## Instrument matrix

| Instrument | Loads / Sounds | Param Extremes Finite | Params Wired | Known Issues |
| --- | --- | --- | --- | --- |
| Sampler (`sampler`) | PASS | PASS | 11/28 | inert params: decay, release, pitchDecayT, resonance, keytrack, velFlt, loop, loopXfade, loopStart, loopEnd, modASrc, modADst, modAAmt, modBSrc, modBDst, modBAmt, modLfoRate |
| Analog Synth (`analog`) | PASS | PASS | 21/34 | inert params: filterEnv, spread, lfoRate, lfoSync, lfoDepth, aShape, dShape, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Bass Synth (`bass`) | PASS | PASS | 15/24 | inert params: glide, movement, spread, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| 808 Synth (`808`) | PASS | PASS | 8/18 | inert params: pitchDrop, click, glide, mono, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Texture Synth (`texture`) | PASS | PASS | 14/23 | inert params: space, chaos, diffuse, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Wavetable Synth (`wavetable`) | PASS | PASS | 10/23 | inert params: table, morph, morphRate, morphDepth, spread, keytrack, modASrc, modADst, modAAmt, modBSrc, modBDst, modBAmt, modLfoRate |
| Granular Synth (`granular`) | PASS | PASS | 14/15 | inert params: release |
| Keys (`keys`) | PASS | PASS | 16/26 | inert params: spread, lfoRate, lfoSync, lfoDepth, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Organ (`organ`) | PASS | PASS | 10/12 | inert params: click, glide |
| Strings (`strings`) | PASS | PASS | 7/10 | inert params: vibrato, vibRate, vibDelay |
| Bell (`bell`) | PASS | PASS | 4/7 | inert params: ratio, shimmer, strike |
| Reese (`reese`) | PASS | PASS | 7/10 | inert params: movement, moveRate, glide |
| Clavinet (`clav`) | PASS | PASS | 5/8 | inert params: click, cutoff, resonance |
| Acid 303 (`acid`) | PASS | PASS | 7/9 | inert params: envMod, glide |
| Synth Brass (`brass`) | PASS | PASS | 6/9 | inert params: bite, sweep, sweepTime |
| FM (`fm`) | PASS | PASS | 12/13 | inert params: fbDecay |
| Pluck Synth (`pluck`) | PASS | PASS | 12/18 | inert params: modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Flute (`flute`) | PASS | PASS | 8/15 | inert params: breath, breathTone, vibrato, vibRate, vibDelay, glide, overblow |
| Log Drum (`logdrum`) | PASS | PASS | 8/17 | inert params: pitchDrop, dropSplay, glide, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Spectral Pad (`spectral`) | PASS | PASS | 10/22 | inert params: shimmer, skew, resonance, motionRate, motionSync, modASrc, modADst, modAAmt, modBSrc, modBDst, modBAmt, modLfoRate |
| Vocal Chop (`vocalchop`) | PASS | PASS | 8/20 | inert params: shift, sharp, cons, morph, release, modASrc, modADst, modAAmt, modBSrc, modBDst, modBAmt, modLfoRate |
| Drum Synth (`drumsynth`) | PASS | PASS | 7/8 | inert params: snap |

## Interaction block

- **47-effect chain** (every effect on one drum bus, all finite): PASS — peak 8.9e-1
- **Chain restore** (JSON round-trip of the 47-effect doc): maxDiff 1.25e-1 — FAIL
- **Duplicate instances** (2× delay, different times): delta 4.0e-2 — PASS, finite PASS
- **Live insert/remove during playback** (real AudioContext, engine projection): PASS
- **Rapid parameter syncs** (24 alternating-extreme command syncs): PASS
- Notes: chain restore diff=1.25e-1

## Findings & repairs

Per-plugin notes are listed in the matrix above; root causes and repairs are recorded in the audit summary below.
- Instrument `sampler`: inert decay, inert release, inert pitchDecayT, inert resonance, inert keytrack, inert velFlt, inert loop, inert loopXfade, inert loopStart, inert loopEnd, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modBAmt, inert modLfoRate
- Instrument `analog`: inert filterEnv, inert spread, inert lfoRate, inert lfoSync, inert lfoDepth, inert aShape, inert dShape, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `bass`: inert glide, inert movement, inert spread, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `808`: inert pitchDrop, inert click, inert glide, inert mono, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `texture`: inert space, inert chaos, inert diffuse, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `wavetable`: inert table, inert morph, inert morphRate, inert morphDepth, inert spread, inert keytrack, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modBAmt, inert modLfoRate
- Instrument `granular`: inert release
- Instrument `keys`: inert spread, inert lfoRate, inert lfoSync, inert lfoDepth, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `organ`: inert click, inert glide
- Instrument `strings`: inert vibrato, inert vibRate, inert vibDelay
- Instrument `bell`: inert ratio, inert shimmer, inert strike
- Instrument `reese`: inert movement, inert moveRate, inert glide
- Instrument `clav`: inert click, inert cutoff, inert resonance
- Instrument `acid`: inert envMod, inert glide
- Instrument `brass`: inert bite, inert sweep, inert sweepTime
- Instrument `fm`: inert fbDecay
- Instrument `pluck`: inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `flute`: inert breath, inert breathTone, inert vibrato, inert vibRate, inert vibDelay, inert glide, inert overblow
- Instrument `logdrum`: inert pitchDrop, inert dropSplay, inert glide, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `spectral`: inert shimmer, inert skew, inert resonance, inert motionRate, inert motionSync, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modBAmt, inert modLfoRate
- Instrument `vocalchop`: inert shift, inert sharp, inert cons, inert morph, inert release, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modBAmt, inert modLfoRate
- Instrument `drumsynth`: inert snap

## Repairs shipped with this audit

1. `src/project-model/targets.ts` — `clampTargetValue` clamped ultina rack-surface ids against the vendored 0..100 percent scale while the document and rack def store 0..1 (`ultinaNode` rescales ×100 on the way to the DSP). An automation lane value of 2 crossed to full-wet instead of stopping at 1. Rack ids now clamp through the rack registry first; the vendored clamp remains for deep plugin params.
2. `src/instruments/modmatrix.ts` — vocalchop (cutoff-less instrument) advertised `modBDst` default 1 = CUTOFF, a destination its dropdown can never offer. Default is now OFF for cutoff-less instruments.
3. `src/instruments/registry.ts` — the wtVoice (Wavetable Synth) and grainVoice (Granular Synth) worklets take their NOTES via port messages, and Chromium does not pump processor message queues during an OfflineAudioContext render: **every offline export of a wavetable or granular track rendered silence** while live playback was fine (preset QA never caught it because its measurement context never loaded the worklets, so it measured the native fallback). Offline render contexts now use the native, upfront-scheduled voice graphs; the worklet paths remain live for realtime.
4. `src/instruments/registry.ts` — sampler STRETCH mode assigned `AudioBufferSourceNode.buffer` a second time (forbidden by the Web Audio spec — `InvalidStateError`) on every note off root pitch: the stretch path threw inside `noteOn` and killed voice scheduling. Same defect class the LOOP-mode fix had addressed; both paths now decide the final buffer first and assign exactly once.
5. `tests/plugin-functional-audit.test.ts` — new permanent model-level audit: inventory/discovery coherence, parameter metadata sanity across all 47+21 surfaces, worklet descriptor coverage for 31 processors, clamp/normalization contracts, serialization round-trips, automation target coverage, factory preset surface.
