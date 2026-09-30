# AudioEngine decomposition plan (Robustness Wave 4)

> Status: IN PROGRESS — **4a MeteringRig SHIPPED** (`d81090f1`; AudioEngine 6140 → 5905) + **4b MasterChain SHIPPED** (absorbed `d4659fad`/`00bb9811`; AudioEngine → 5 134, MasterChain 841, liveContext helper). **4c PreviewDeck SHIPPED** (`4d8bb123`; AudioEngine → 4 823, PreviewDeck 350, declick 66). Next: 4d AutomationBridge. Owner: pro-DAW robustness campaign (Waves 1–3 shipped:
> crash journal, PDC export parity, audio-clock scheduler driver).
> Measured against the working tree on 2026-09-29 (commit `0bb5670f` era).

## 1. Diagnosis — what the god object actually is

`src/audio-engine/AudioEngine.ts`: **6 140 lines, 142 methods, ~130 state fields**,
consumed by 13 files (App, services, panels) exclusively through the `AudioEngine`
class. The `src/audio-engine/` directory already holds 27 extracted modules
(metering, latency calibration, PCM ring/playback, warp, spectral edit, …) — this
plan CONTINUES that pattern; the god file is the orchestrator plus everything that
never moved out.

Measured responsibility clusters (by method line ranges + owned fields):

| Cluster                        | Lines (≈) | Contents                                                                                                                                                                                                                                      |
| ------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Master chain**               | ~750      | `buildMaster` (552 lines alone), `applyMasterConfig`, `upgradeMasterDynamics`/`KwMeter`/`attachMasterWorklet`, ~25 `master*` fields (clipper, limiter native+worklet, glue, tilt pair, matchEq stages, bassMono, M/S matrix, tape, DC filter) |
| **Graph sync**                 | ~900      | `setProject`/`syncProject` (293), `rebuildFxChain`, `syncFxParams/Sidechains`, `syncSends`, `syncInstrument`, `syncPdc`, all `dispose*`, node maps (`trackNodes`, `groupNodes`, `returnNodes`, `instruments`)                                 |
| **Triggers / voices**          | ~1100     | `trigger` (164), `triggerSynth` (343!), `noteOn`, `triggerAudioClip` (309), `attachPadMod`, `choke`, `noteOff`, `polyTimbre/Pressure`, MIDI CC/pitch-bend                                                                                     |
| **Automation / modulation**    | ~960      | LFOs, macros, modulators (`applyModulators`, `makeModulatorWriter`, offline scheduling), scene intensity + lanes, `applyAutomation`, target resolvers                                                                                         |
| **Preview / audition**         | ~450      | `preview*` family (asset/buffer/slice/preset/note/fader/intent), `previewVoices`, `stopPreview`, `previewMarkerOnTrack`                                                                                                                       |
| **Warp / frozen sources**      | ~300      | stretch + warp caches (`WARP_CACHE_LIMIT`, epochs), `buildWarpJob`, `precomputeWarpSync`, frozen source restart                                                                                                                               |
| **Metering / analysis**        | ~450      | track/return/master meters, LUFS blocks, peak holds, spectrum/spectrogram/multi-tap analysers                                                                                                                                                 |
| **Context lifecycle**          | ~500      | `useContext` (the ONLY AudioNode-creation gate), `ensureContext`, worklet loading + refresh queueing, live-context subscription, offline bypass                                                                                               |
| **Metronome / markers / misc** | ~350      | `click`, `triggerMarker`, `panic`, `getDiagnostics`, device-change                                                                                                                                                                            |

The fields tell the same story: ~25 of them start with `master*`. The class does
not have a cohesion problem in any ONE cluster — it has nine clusters sharing one
`this`.

## 2. Target architecture — facade + domain owners + shared core

`AudioEngine` REMAINS the only public class. No consumer changes. Internally it
delegates to collaborators that each own one cluster's fields and methods:

```
AudioEngine (facade, ~600–800 lines: lifecycle + delegation + shared state struct)
 ├─ EngineCore (plain interface, passed to every collaborator)
 │    ctx: () => BaseAudioContext | null     // set ONLY by useContext
 │    doc: () => ProjectDocument | null
 │    nodes: { tracks, groups, returns, instruments }   // owned by GraphSync
 │    bpm: { syncedBpm, sceneBpmOverride }
 │    events: panic hooks, liveContextListeners
 ├─ ContextLifecycle   (useContext/ensureContext/worklet queue/offline bypass)
 ├─ MasterChain        (build/config/upgrade/bypass + hand taps to MeteringRig)
 ├─ MeteringRig        (analysers, snapshots, LUFS, peak holds, spectrogram taps)
 ├─ GraphSync          (project diff → node graph, FX chains, sends, PDC sizing)
 ├─ TriggerEngine      (voices: drum/synth/instrument/audioclip, choke, MIDI)
 ├─ AutomationBridge   (LFO/macros/modulators/scene lanes/target writers)
 ├─ PreviewDeck        (all preview*/audition/intent-preview + voices set)
 └─ WarpManager        (stretch/warp caches, frozen sources)
```

Hard rules for every extraction:

1. **Move, don't redesign.** Behavior-neutral refactors only; logic changes are
   separate commits and separate waves. A wave that mixes both is unreviewable.
2. **Collaborators never import `AudioEngine`.** They see `EngineCore` (or a
   narrower slice). Extend `tests/architecture-cycles.test.ts` to pin this —
   the engine module graph must stay acyclic toward the facade.
3. **`useContext` stays the only path that creates `AudioNode`s** (invariant 7):
   collaborators create nodes exclusively on the ctx they receive from the core.
4. **`BaseAudioContext` everywhere** — collaborators must not branch on
   live-vs-offline (the PDC wave proved offline is where the landmines are;
   `prepareOfflineRender`/`offlineExactPdc` stay facade-level state).
5. **The scheduler-facing surface (`trigger`, `noteOn`, `applyAutomation`, …) and
   the 13 consumers' surface do not change** — `tsc --noEmit` over `src/` +
   `tests/` untouched-by-hand is the contract gate.

## 3. Waves (each independently shippable, ordered by risk)

### Wave 4a — MeteringRig (risk: low) — SHIPPED `d81090f1`

Extract metering/analysis: `getTrackLevel` … `getMasterMeterSnapshot`,
`computeMasterMeterSnapshot`, spectrogram/spectrum tap getters, meter caches and
the analyser fields. Read-mostly, no scheduling interaction, existing sibling
`metering.ts` shows the shape, browser-checks already assert master meters.
Gates: existing metering checks green + new unit pins for snapshot caching.

### Wave 4b — MasterChain (risk: medium, biggest single win) — SHIPPED (absorbed `d4659fad` + fixes `00bb9811`)

`buildMaster` + config/upgrade paths + the ~25 `master*` fields. The master chain
is the most self-contained graph island (input gain → devices → taps →
destination) and the most merge-contested region of the file (three sessions
touched it in this campaign). Gate: browser-checks master section (TILT/TRIM,
limiter, matchEq, M/S) + offline `bypassMasterChainForOfflineRender` parity.

### Wave 4c — PreviewDeck (risk: medium-low) — SHIPPED `4d8bb123` (audition deck + declick.ts; graph-param previews deliberately stayed)

All preview paths + `previewVoices` + effect-intent preview session. Fully
lifecycle-shaped (start/stop/dispose), already partially mirrored by
`GhostPreviewPlayer`. Gate: preview/audition browser-checks + audit suites that
pin `stopPreview` semantics.

### Wave 4d — AutomationBridge (risk: medium-high)

LFO/macros/modulators/scene lanes + the device target resolvers
(`effectRuntimeForTarget`/`instrumentRuntimeForTarget`/`baseValueForTarget`).
First step INSIDE the wave: extract the resolvers into a shared `DeviceLookup`
both GraphSync and the bridge consume — that decouples the two biggest clusters
before anything moves. Gate: automation audit + modulator/scene suites.

### Wave 4e — WarpManager (risk: medium-low)

Stretch/warp caches + frozen sources. Self-contained, cache-key logic already
unit-shaped. Do it after 4b (frozen sources route through the graph) and before
4f (audio-clip triggers consume warp buffers). Gate: warp cache + take-audition
suites.

### Wave 4f — TriggerEngine (risk: high, do LAST)

`trigger`/`triggerSynth`/`noteOn`/choke/pad-mods/MIDI. This is the realtime
performance path — extract only after 4a–4e have stabilized the seams it touches
(graph nodes, automation pad-mods, preview voices). Consider a second split
(sampler voices vs synth voices) inside the wave. Gate: full trigger family +
real-browser audio + factory-preset QA (298 audible).

## 4. What this buys — and what it does not

**Buys:** reviewable merges (the concurrent-session absorb races keep hitting this
exact file), unit-testable config/preview/automation logic without full-engine
mocks, a clean seam for Wave 5 (shared KYX↔ZYVO core), and honest diff sizes for
every future audio change.

**Does not buy:** runtime performance (pure moves, zero hot-path changes) or a
smaller bundle (same code, more files — budgets are unaffected by module count;
verify with `npm run build` per wave anyway).

## 5. Process laws (campaign-proven)

- One wave = one pathspec commit series; expect the concurrent session to absorb
  in-flight files (Waves 1–3 pattern) — grep-verify absorbed content, never
  `git add -A`.
- After every wave: `npm run typecheck`, cluster test family, `npm run build`
  (budgets), browser-check subset named in the wave.
- A wave ships only if `docs/CURRENT-STATE.md` + ADR (an amendment to 0003
  project-model/runtime separation, or a new 0019 "engine decomposition") record
  the new module map.
- If any wave uncovers a live behavior change (meter values, preview cutoffs,
  automation timing): STOP the move, land the fix as its own commit first.
