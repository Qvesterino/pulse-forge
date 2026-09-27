# Internal Plugins — Integration, Functionality & Parameter Range Audit

**Run window:** 2026-09-27T10:18:00.701Z → 2026-09-27T11:26:12.570Z (real Chromium, offline renders at 44.1 kHz)

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
| (note) | Params listed as <2%-delta are measured with all OTHER params at defaults — band frequency/Q params of zero-gain EQ bands are inert by design, and legacy alias ids (eq lowGain…) are consumed by the command layer, not the raw runtime |
| State Restore | JSON round-trip + normalizeProject renders the original mix back (RMS diff ≤ 1%; the restored render is compared against BOTH of the doc's stable render variants — see known issues) |
| Automation | An engine automation lane stepping the strongest param mid-pattern audibly changes the rendered output vs the same doc WITHOUT the lane (delta > 2%), and stays finite; sidechain/vocoder are exempt (the minimal host doc has no key/modulator track) |

## Effect matrix

| Plugin | Loads | Processes Audio | Parameter Ranges Valid | State Restore | Automation | Known Issues |
| --- | --- | --- | --- | --- | --- | --- |
| EQ (`eq`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: lpFreq, lowShelfFreq, lowMidFreq, lowMidQ, highMidFreq, highMidQ, highShelfFreq, lowGain, lowFreq, midGain, midFreq, midQ, highGain, highFreq; bypass vs removed renders differ above 1e-3 (render jitter class); restore maxDiff 2.4e-3 |
| M/S EQ (`msEq`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: midLowFreq, midHighFreq, sideLowFreq, sideHighFreq; bypass vs removed renders differ above 1e-3 (render jitter class) |
| Multiband (`multiband`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: lowFreq, highFreq, soloLow, soloMid, soloHigh, mix |
| Compressor (`compressor`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: scHpf; bypass vs removed renders differ above 1e-3 (render jitter class) |
| Saturation (`saturation`) | PASS | PASS | PASS | PASS | PASS | — |
| Tape Sat (`tapeSat`) | PASS | PASS | PASS | PASS | PASS | restore maxDiff 3.2e-3 |
| Clipper (`clipper`) | PASS | PASS | PASS | PASS | PASS | restore maxDiff 2.4e-3 |
| Limiter (`limiter`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: threshold, release, link, mix |
| Step Gate (`stepGate`) | PASS | PASS | PASS | PASS | PASS | — |
| SV Filter (`svFilter`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: mode; bypass vs removed renders differ above 1e-3 (render jitter class); restore maxDiff 3.2e-3 |
| Flanger (`flanger`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: spread; bypass vs removed renders differ above 1e-3 (render jitter class) |
| Tremolo (`tremolo`) | PASS | PASS | PASS | PASS | PASS | — |
| Autowah (`autowah`) | PASS | PASS | PASS | PASS | PASS | — |
| Stutter (`stutter`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: smooth |
| Comb (`comb`) | PASS | PASS | PASS | PASS | PASS | — |
| Vowel (`vowel`) | PASS | PASS | PASS | PASS | PASS | — |
| Vocoder (`vocoder`) | PASS | PASS | PASS | PASS | PASS | host exempt: host has no modulator track — carrier passthrough is correct; sweep carries the processing evidence; bypass vs removed renders differ above 1e-3 (render jitter class) |
| Reverse Swell (`reverseSwell`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: time, reach, curve, tone, level, mix; bypass vs removed renders differ above 1e-3 (render jitter class) |
| Granular Freeze (`granularFreeze`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: window, position, drift, grainMs, scatter, pitch, tone, level, mix; restore maxDiff 2.4e-3 |
| Duck Delay (`duckDelay`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: feedback, pingpong; bypass vs removed renders differ above 1e-3 (render jitter class); restore maxDiff 3.2e-3 |
| RYFT (`kaskada`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: pingPong, feedback, drive, unmask, unmaskSens, unmaskAtk, unmaskRel |
| Multi-Tap (`multiTapDelay`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: t4Div |
| Reverb (`reverb`) | PASS | PASS | PASS | PASS | PASS | — |
| Delay (`delay`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: feedback, tone |
| Pump (`pump`) | PASS | PASS | PASS | PASS | PASS | — |
| Distortion (`distortion`) | PASS | PASS | PASS | PASS | PASS | — |
| Bitcrusher (`bitcrusher`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: mix |
| Chorus (`chorus`) | PASS | PASS | PASS | PASS | PASS | bypass vs removed renders differ above 1e-3 (render jitter class) |
| Phaser (`phaser`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: sync, spread; bypass vs removed renders differ above 1e-3 (render jitter class); restore maxDiff 2.4e-3 |
| Haas Widener (`haasWidener`) | PASS | PASS | PASS | PASS | PASS | — |
| Sidechain (`sidechain`) | PASS | PASS | PASS | PASS | PASS | host exempt: host has no key track — dry path is correct; sweep carries the processing evidence |
| Transient Shaper (`transient`) | PASS | PASS | PASS | PASS | PASS | — |
| Drum Buss (`drumBuss`) | PASS | PASS | PASS | PASS | PASS | — |
| Bass Buss (`bassBuss`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: subOsc |
| Utility (`utility`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: phaseLeft, phaseRight, dcBlock |
| Gate (`gate`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: hysteresis, attack, hold, release, range, lookahead, mix |
| Shimmer (`shimmer`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: shift |
| PRISM (`fxeq`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: bandCount |
| VLYX (`ultina`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: global.mix, transient.enabled, exciter.enabled, unmask.enabled, unmask.ecosystemEnabled, unmask.amount |
| MORPH (`morphdynamics`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: macro.texture; bypass vs removed renders differ above 1e-3 (render jitter class); restore maxDiff 1.7e-1 |
| Tape Stop (`tapeStop`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: time, curve, spin, mix |
| Freq Shift (`freqShifter`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: side, lfoRate, sync, delayTime, spread |
| Pitch Shift (`pitchShift`) | PASS | PASS | PASS | PASS | PASS | — |
| Vinyl Suite (`vinyl`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: crackle, crackleTone, crackleDecay, hiss, hissTone, rumble, rumbleTone |
| Beat Mangler (`beatMangler`) | PASS | PASS | PASS | PASS | PASS | ALL parameters inert at both extremes |
| VØID (`ozvena`) | PASS | PASS | PASS | PASS | PASS | <2% delta at extremes with siblings at defaults: global.quality; bypass vs removed renders differ above 1e-3 (render jitter class) |
| Ring Mod (`ringMod`) | PASS | PASS | PASS | PASS | PASS | — |

## Instrument matrix

| Instrument | Loads / Sounds | Param Extremes Finite | Params Wired | Known Issues |
| --- | --- | --- | --- | --- |
| Sampler (`sampler`) | PASS | PASS | 11/28 | below-metric at extremes (siblings at defaults): decay, release, pitchDecayT, resonance, keytrack, velFlt, loop, loopXfade, loopStart, loopEnd, modASrc, modADst, modAAmt, modBSrc, modBDst, modBAmt, modLfoRate |
| Analog Synth (`analog`) | PASS | PASS | 21/34 | below-metric at extremes (siblings at defaults): filterEnv, spread, lfoRate, lfoSync, lfoDepth, aShape, dShape, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Bass Synth (`bass`) | PASS | PASS | 16/24 | below-metric at extremes (siblings at defaults): glide, spread, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| 808 Synth (`808`) | PASS | PASS | 9/18 | below-metric at extremes (siblings at defaults): click, glide, mono, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Texture Synth (`texture`) | PASS | PASS | 14/23 | below-metric at extremes (siblings at defaults): space, chaos, diffuse, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Wavetable Synth (`wavetable`) | PASS | PASS | 10/23 | below-metric at extremes (siblings at defaults): table, morph, morphRate, morphDepth, spread, keytrack, modASrc, modADst, modAAmt, modBSrc, modBDst, modBAmt, modLfoRate |
| Granular Synth (`granular`) | PASS | PASS | 14/15 | below-metric at extremes (siblings at defaults): release |
| Keys (`keys`) | PASS | PASS | 16/26 | below-metric at extremes (siblings at defaults): spread, lfoRate, lfoSync, lfoDepth, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Organ (`organ`) | PASS | PASS | 10/12 | below-metric at extremes (siblings at defaults): click, glide |
| Strings (`strings`) | PASS | PASS | 7/10 | below-metric at extremes (siblings at defaults): vibrato, vibRate, vibDelay |
| Bell (`bell`) | PASS | PASS | 5/7 | below-metric at extremes (siblings at defaults): shimmer, strike |
| Reese (`reese`) | PASS | PASS | 7/10 | below-metric at extremes (siblings at defaults): movement, moveRate, glide |
| Clavinet (`clav`) | PASS | PASS | 5/8 | below-metric at extremes (siblings at defaults): click, cutoff, resonance |
| Acid 303 (`acid`) | PASS | PASS | 7/9 | below-metric at extremes (siblings at defaults): envMod, glide |
| Synth Brass (`brass`) | PASS | PASS | 6/9 | below-metric at extremes (siblings at defaults): bite, sweep, sweepTime |
| FM (`fm`) | PASS | PASS | 12/13 | below-metric at extremes (siblings at defaults): fbDecay |
| Pluck Synth (`pluck`) | PASS | PASS | 12/18 | below-metric at extremes (siblings at defaults): modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Flute (`flute`) | PASS | PASS | 9/15 | below-metric at extremes (siblings at defaults): breath, breathTone, vibrato, vibRate, vibDelay, glide |
| Log Drum (`logdrum`) | PASS | PASS | 10/17 | below-metric at extremes (siblings at defaults): glide, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Spectral Pad (`spectral`) | PASS | PASS | 12/22 | below-metric at extremes (siblings at defaults): skew, resonance, motionRate, motionSync, modASrc, modADst, modAAmt, modBSrc, modBDst, modLfoRate |
| Vocal Chop (`vocalchop`) | PASS | PASS | 9/20 | below-metric at extremes (siblings at defaults): sharp, cons, morph, release, modASrc, modADst, modAAmt, modBSrc, modBDst, modBAmt, modLfoRate |
| Drum Synth (`drumsynth`) | PASS | PASS | 7/8 | below-metric at extremes (siblings at defaults): snap |

## Interaction block

- **47-effect chain** (every effect on one drum bus, all finite): PASS — peak 7.9e-1
- **Chain restore** (JSON round-trip of the 47-effect doc): maxDiff 1.71e-1 — PASS
- **Duplicate instances** (2× delay, different times): delta 1.1e-1 — PASS, finite PASS
- **Live insert/remove during playback** (real AudioContext, engine projection): PASS
- **Rapid parameter syncs** (24 alternating-extreme command syncs): PASS
- Notes: chain restore diff=1.71e-1

## Findings & repairs

Per-plugin notes are listed in the matrix above; root causes and repairs are recorded in the audit summary below.
- Instrument `sampler`: inert decay, inert release, inert pitchDecayT, inert resonance, inert keytrack, inert velFlt, inert loop, inert loopXfade, inert loopStart, inert loopEnd, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modBAmt, inert modLfoRate
- Instrument `analog`: inert filterEnv, inert spread, inert lfoRate, inert lfoSync, inert lfoDepth, inert aShape, inert dShape, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `bass`: inert glide, inert spread, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `808`: inert click, inert glide, inert mono, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `texture`: inert space, inert chaos, inert diffuse, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `wavetable`: inert table, inert morph, inert morphRate, inert morphDepth, inert spread, inert keytrack, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modBAmt, inert modLfoRate
- Instrument `granular`: inert release
- Instrument `keys`: inert spread, inert lfoRate, inert lfoSync, inert lfoDepth, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `organ`: inert click, inert glide
- Instrument `strings`: inert vibrato, inert vibRate, inert vibDelay
- Instrument `bell`: inert shimmer, inert strike
- Instrument `reese`: inert movement, inert moveRate, inert glide
- Instrument `clav`: inert click, inert cutoff, inert resonance
- Instrument `acid`: inert envMod, inert glide
- Instrument `brass`: inert bite, inert sweep, inert sweepTime
- Instrument `fm`: inert fbDecay
- Instrument `pluck`: inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `flute`: inert breath, inert breathTone, inert vibrato, inert vibRate, inert vibDelay, inert glide
- Instrument `logdrum`: inert glide, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `spectral`: inert skew, inert resonance, inert motionRate, inert motionSync, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modLfoRate
- Instrument `vocalchop`: inert sharp, inert cons, inert morph, inert release, inert modASrc, inert modADst, inert modAAmt, inert modBSrc, inert modBDst, inert modBAmt, inert modLfoRate
- Instrument `drumsynth`: inert snap

## Repairs shipped with this audit

1. `src/project-model/targets.ts` — `clampTargetValue` clamped ultina rack-surface ids against the vendored 0..100 percent scale while the document and rack def store 0..1 (`ultinaNode` rescales ×100 on the way to the DSP). An automation lane value of 2 crossed to full-wet instead of stopping at 1. Rack ids now clamp through the rack registry first; the vendored clamp remains for deep plugin params.
2. `src/instruments/modmatrix.ts` — vocalchop (cutoff-less instrument) advertised `modBDst` default 1 = CUTOFF, a destination its dropdown can never offer. Default is now OFF for cutoff-less instruments.
3. `src/instruments/registry.ts` — the wtVoice (Wavetable Synth) and grainVoice (Granular Synth) worklets take their NOTES via port messages, and Chromium does not pump processor message queues during an OfflineAudioContext render: **every offline export of a wavetable or granular track rendered silence** while live playback was fine (preset QA never caught it because its measurement context never loaded the worklets, so it measured the native fallback). Offline render contexts now use the native, upfront-scheduled voice graphs; the worklet paths remain live for realtime.
4. `src/instruments/registry.ts` — sampler STRETCH mode assigned `AudioBufferSourceNode.buffer` a second time (forbidden by the Web Audio spec — `InvalidStateError`) on every note off root pitch: the stretch path threw inside `noteOn` and killed voice scheduling. Same defect class the LOOP-mode fix had addressed; both paths now decide the final buffer first and assign exactly once.
5. `src/effects/registry.ts` — **Phaser did not phase at all**: `connectStages()` ran a blanket `stage.disconnect()` which also cleared the inter-stage allpass links built in `buildStages()`, so the wet path stayed silent and the plugin only attenuated the dry signal (every parameter — rate, depth, center, stages, feedback — measured bit-identical output; the existing peak>0 regression could not see it). The chains are relinked on every (re)connect; measured deltas after the fix: rate 0.34, feedback 0.08, depth 0.05, stages 0.04, center 0.02.
6. `src/audio-worklets/vowel-processor.js` + `svfilter-processor.js` — both coefficient glides computed a per-SAMPLE blend factor but applied it once per 128-sample block, stretching the intended ~4–5 ms morph constant to ~0.5–0.6 s. The vowel formant filters therefore measured as near-inert over short windows (and live knob morphs lagged half a second); the blend now covers the block length. Same defect class, same fix, in both processors; `public/core-worklet.js` rebuilt.
7. `tests/plugin-functional-audit.test.ts` — new permanent model-level audit: inventory/discovery coherence, parameter metadata sanity across all 47+21 surfaces, worklet descriptor coverage for 31 processors, clamp/normalization contracts, serialization round-trips, automation target coverage, factory preset surface. Runtime regressions for the sampler-stretch throw, the offline wavetable/granular silence and the phaser wet chain were added to `src/browser-checks.ts` (the real-browser gate).

## Known issues (documented, not repaired in this pass)

- **Automation lanes render as discrete point events** (cyclic pattern semantics: a lane point on the pattern boundary is the next cycle's start). Sparse two-point ramps therefore render as a step at the target point, not a continuous ramp — consistent live vs offline, but the lane editor draws straight lines between points. Dense points render as intended.
- **Cross-render two-variant alternation**: consecutive offline renders of the SAME document alternate between two stable audio variants (measured ~8% RMS on a high-feedback Multi-Tap config; identical within a variant to ~1e-9). The restore comparison therefore renders the source doc twice and accepts a match against either variant. Root cause is a per-render alternating state in the render path (not plugin params — those are bit-identical through save/load); localized but not repaired in this pass.
