# PLUGIN & EFFECT SYSTEM — RELIABILITY + AI CONTROL AUDIT (KYX)

**Repo:** `D:\pulse-forge` (package `pulse-forge`) · **Date:** 2026-10-21 · **Mode:** Discover → Audit → Test → Repair → Verify → Report
**Scope:** every effect in `EFFECT_DEFS`, the flagship plugin suites, the MCP control surface, the effect-intent layer and the local-model path.

> **Reading rule.** Every count is read from the code. Where a repo document and the code disagree, both are given and the code wins. What could not be measured is marked **NOT VERIFIED** — never filled with an assumption.

---

## 0. Executive summary

|                                           |                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Effects                                   | **57** (`EFFECT_DEFS`) — 44 worklet-backed + 13 native WebAudio · AGENTS.md claims 48+5 (=53) — **stale** |
| Flagship suites                           | **6** (`fxeq, ultina, ozvena, kaskada, morphdynamics, rezonans`) + the `spectral-core`/PORTAL core        |
| Declared parameters                       | **222** (180 across 54 types + 42 rezonans)                                                               |
| MCP tools                                 | **37**, with a **37-entry** risk table — **zero declared-but-dead in either direction**                   |
| **Dead parameters across all 57 effects** | **ZERO** — verified at AudioParam-name level                                                              |
| Local model                               | **LFM2.5-1.2B-Instruct + LoRA, Q8_0** (the default) — _not_ 4-bit                                         |
| Defects repaired in this wave             | **1** (P2: four limiter controls the document could not carry)                                            |
| `npm run typecheck`                       | **exit 0** · 309 targeted effect/command tests **green**                                                  |

**The headline finding is not a defect — it is a clean bill of health on the hardest question.** The repo's own `docs/NEW-EFFECT-CHECKLIST.md` names _five_ ways a parameter can die silently between the UI and the DSP. All 57 effects were checked against all five, at the level of the processor's exact AudioParam names: **no declared parameter fails to reach its processor.** The three apparent misses that did surface are all wired and were false positives (deprecated EQ aliases, the tempo-sync controller, array-driven parameter maps).

---

## 1. Architecture map

```
  NL request ───▶ src/intent/route.ts
                   ├─ src/intent/mix.ts        parseEffectIntent (deterministic, effect×target×direction)
                   └─ src/effect-intent/       parseEffectIntent (curated goals: warmth/brightness/space)
                                          │
  Agent / MCP ──▶ src/mcp/tools.ts (37 tools, TOOL_RISK in agentTrust.ts)
                   └─ src/effect-intent/ (catalog · capabilities · planner) — ONE thin entry: mix-idea.ts
                                          │
                                          ▼
                   src/commands/*   ← canonical command layer (addEffect · setEffectParam · moveEffect · …)
                                          │  every mutating MCP handler calls ctx.execute(command)
                                          │  multi-target ops fold into ONE snapshot(...) → one undo step
                                          ▼
                   src/audio-engine/AudioEngine.ts
                     ├─ src/audio-worklets/*.js      (44 worklet-backed effects)
                     ├─ src/effects/*-node.ts         (node adapters → AudioParams)
                     └─ src/effects/*-core/           (6 vendored flagship cores)
                                          │
                    ┌─────────────────────┴──────────────────────┐
                    ▼                                            ▼
        src/project-model/schema.ts                   src/rendering/renderer.ts
        normalizeEffects → save/reload                FX chain render + degradedEffects report
        (keeps only ids present in defaultParamsOf(type))
```

**The mutation law, verified:** every mutating MCP handler dispatches through `src/commands/*` (the barrel import at `tools.ts:128-176`). Helper-function scan — `executeMixTool :6397`, `executeAutomationTool :7055`, `executeClipsTool :7321`, `executeRoutingTool :7820`, `executeTakesTool :8310`, `executePluginParamTool :8762`, `executeMusicTool :9121`, `executeSectionsTool :9401`, `executeStepsTool :10915`, `executeIntentTool :11116` — **all** call `ctx.execute(command)` and/or wrap in `snapshot(...)`. **No MCP tool writes DSP internals directly.** That satisfies the brief's "MCP should adapt to canonical DAW commands" requirement, as a verified fact rather than an aspiration.

---

## 2. Inventory and functionality matrix (57 effects)

Legend — DSP: `wl:` worklet, `nat` native WebAudio graph · Presets: count · Auto: `rack` = rack-surface params automatable, `+deep` = deep namespaced params too · Gap: `none` = verified wired at AudioParam-name level.

| Effect ID         | DSP                    | Params     | Byp | Wet/dry         | Presets | Auto          | UI  | MCP | Intent | Gap                                        |
| ----------------- | ---------------------- | ---------- | --- | --------------- | ------- | ------------- | --- | --- | ------ | ------------------------------------------ |
| eq                | wl:eq-node             | 20         | ✅  | —               | 4       | rack          | ✅  | ✅  | ✅     | none (7 legacy aliases deprecated)         |
| msEq              | nat                    | 8          | ✅  | —               | 3       | rack          | ✅  | ✅  | —      | none                                       |
| haasWidener       | nat                    | 5          | ✅  | —               | 3       | rack          | ✅  | ✅  | ✅     | none                                       |
| multiband         | nat                    | 10         | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| compressor        | wl:compressor-node     | 12         | ✅  | mix             | 4       | rack          | ✅  | ✅  | ✅     | none                                       |
| saturation        | nat                    | 7          | ✅  | mix             | 3       | rack          | ✅  | ✅  | ✅     | none                                       |
| tapeSat           | wl:tape-node           | 5          | ✅  | mix             | 4       | rack          | ✅  | ✅  | —      | none                                       |
| wowFlutter        | wl:wowflutter-node     | 7          | ✅  | mix             | 2       | rack          | ✅  | ✅  | —      | none                                       |
| clipper           | nat                    | 5          | ✅  | mix             | 2       | rack          | ✅  | ✅  | —      | none                                       |
| reverb            | wl:reverb-node         | 7          | ✅  | mix             | 4       | rack          | ✅  | ✅  | ✅     | none                                       |
| delay             | wl:stock-delay-node    | 6          | ✅  | mix             | 3       | rack          | ✅  | ✅  | ✅     | none                                       |
| pump              | nat+envFollower        | 3          | ✅  | —               | 3       | rack          | ✅  | ✅  | ✅     | none                                       |
| distortion        | nat                    | 7          | ✅  | mix             | 2       | rack          | ✅  | ✅  | ✅     | none                                       |
| bitcrusher        | wl:bitcrusher-node     | 6          | ✅  | mix             | 3       | rack          | ✅  | ✅  | ✅     | none                                       |
| chorus            | wl:chorus-node         | 10         | ✅  | mix             | 4       | rack          | ✅  | ✅  | ✅     | none (`sync` via tempo-sync)               |
| phaser            | nat                    | 8          | ✅  | mix             | 3       | rack          | ✅  | ✅  | ✅     | none                                       |
| sidechain         | wl:sidechain-node      | 6          | ✅  | —               | 4       | rack          | ✅  | ✅  | —      | none                                       |
| transient         | wl:transient-processor | 5          | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| gate              | wl:gate-processor      | 8          | ✅  | mix             | 3       | rack          | ✅  | ✅  | ✅     | none                                       |
| shimmer           | nat                    | 6          | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| **fxeq**          | wl:fxeq-core           | 8 + deep   | ✅  | `globalMix`     | 83      | rack+deep     | ✅  | ✅  | —      | none                                       |
| **ultina**        | wl:ultina-core         | 9 + deep   | ✅  | `global.mix`    | 49      | rack+deep     | ✅  | ✅  | —      | none (scale bridge registered)             |
| **ozvena**        | wl:ozvena-core         | 9 + deep   | ✅  | `global.dryWet` | **0**   | rack+deep     | ✅  | ✅  | —      | none                                       |
| **morphdynamics** | wl:morph-dynamics-core | 9 + deep   | ✅  | `global.mix`    | 32      | **rack only** | ✅  | ✅  | —      | deep params not automatable                |
| **rezonans**      | wl:rezonans-core       | 42         | ✅  | mix             | 7       | rack (42)     | ✅  | ✅  | ✅     | none                                       |
| drumBuss          | nat                    | 8          | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| bassBuss          | nat                    | 10         | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| utility           | nat                    | 7          | ✅  | —               | 3       | rack          | ✅  | ✅  | —      | none                                       |
| **limiter**       | wl:limiter-node        | 6 → **10** | ✅  | mix             | 3       | rack          | ✅  | ✅  | ✅     | **REPAIRED — see §3.1**                    |
| stepGate          | wl:stepgate-node       | 4          | ✅  | mix             | 4       | rack          | ✅  | ✅  | —      | none                                       |
| svFilter          | wl:svfilter-node       | 5          | ✅  | mix             | 9       | rack          | ✅  | ✅  | ✅     | none                                       |
| flanger           | wl:flanger-node        | 8          | ✅  | mix             | 3       | rack          | ✅  | ✅  | ✅     | none                                       |
| tremolo           | wl:tremolo-node        | 6          | ✅  | mix             | 3       | rack          | ✅  | ✅  | ✅     | none                                       |
| autowah           | wl:autowah-node        | 10         | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| stutter           | wl:stutter-node        | 4          | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| comb              | wl:comb-node           | 5          | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| vowel             | wl:vowel-node          | 3          | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| duckDelay         | wl:ducking-delay-node  | 11         | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| ringMod           | wl:ringmod-node        | 4          | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| tapeStop          | wl:tapestop-node       | 5          | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| freqShifter       | wl:freqshifter-node    | 12         | ✅  | mix             | 7       | rack          | ✅  | ✅  | —      | none                                       |
| multiTapDelay     | wl:multitap-node       | 9          | ✅  | mix             | 6       | rack          | ✅  | ✅  | —      | none (array-driven ids)                    |
| pitchShift        | wl:pitchshift-node     | 5          | ✅  | mix             | 4       | rack          | ✅  | ✅  | —      | none                                       |
| pitchCorrect      | wl:pitchcorrect-node   | 5          | ✅  | mix             | 2       | rack          | ✅  | ✅  | —      | none                                       |
| vinyl             | wl:vinyl-node          | 18         | ✅  | mix             | 7       | rack          | ✅  | ✅  | —      | none                                       |
| zenit             | nat master rack        | 10         | ✅  | —               | 3       | rack          | ✅  | ✅  | —      | none                                       |
| apeks             | wl:zenit-m2-nodes      | 7          | ✅  | mix             | 3       | rack          | ✅  | ✅  | —      | none                                       |
| sirka             | wl:zenit-m2-nodes      | 6          | ✅  | mix             | 2       | rack          | ✅  | ✅  | —      | none                                       |
| prud              | wl:zenit-m2-nodes      | 11         | ✅  | —               | 2       | rack          | ✅  | ✅  | —      | none                                       |
| bassHarmonic      | wl:bass-harmonic-node  | 18         | ✅  | mix             | 4       | ✅            | ✅  | ✅  | ✅     | none (only effect with param descriptions) |
| skrutka           | wl:skrutka-node        | 18         | ✅  | mix,punchMix    | 24      | rack          | ✅  | ✅  | ✅     | none                                       |
| portal            | wl:spectral-core       | 16         | ✅  | mix             | 7       | rack          | ✅  | ✅  | —      | none (array-driven ids)                    |
| beatMangler       | wl:beatmangler-node    | 8          | ✅  | mix             | 2       | rack          | ✅  | ✅  | —      | none                                       |
| vocoder           | wl:vocoder-node        | 11         | ✅  | mix             | 5       | rack          | ✅  | ✅  | —      | none                                       |
| reverseSwell      | wl:reverseswell-node   | 7          | ✅  | mix             | 4       | rack          | ✅  | ✅  | —      | none                                       |
| granularFreeze    | wl:granularfreeze-node | 10         | ✅  | mix             | 5       | rack          | ✅  | ✅  | —      | none                                       |
| **kaskada**       | wl:kaskada-node        | 22         | ✅  | mix             | 7       | rack          | ✅  | ✅  | —      | none                                       |

**Shared facts, true of every row**

- **Bypass is real**, not a stub: `EffectInstance.bypassed` is honoured as a **chain-level skip** (`AudioEngine.ts:1250` build, `:1370` param sync, `:1426`/`:1436` sidechain). Toggle command: `src/commands/effectParams.ts:279`.
- **Undo/redo is uniform**: every effect command returns a `Command` executed through `store.execute()` → `YDocStore.applyCommand` → the Yjs `UndoManager` (`src/collab/YDocStore.ts:358`, `:107-114`).
- **Save/reload**: `src/project-model/schema.ts:817-835`. The generic path keeps **only** ids present in `defaultParamsOf(type)`; `normalizePluginParams` (`src/effects/definitions.ts:372-375`) handles exactly `ultina, fxeq, ozvena, morphdynamics`. **This generic path is what made the limiter defect (§3.1) possible.**
- **Export**: `src/rendering/renderer.ts` renders the FX chain and reports `degradedEffects` (`:34`, `:44`).
- **MCP**: the `kyx_fx` effect enum is `Object.keys(EFFECT_META)` → **all 57**.
- **Intent**: word-matched subset of **18** types (`src/intent/effect-words.ts`); the curated effect-intent mapper (`src/effect-intent/capabilities.ts:142`) covers only **2** (`eq`, `reverb`).
- **Supported channels / sample rates**: **not declared anywhere** — no `channelCount`/`sampleRate` field exists in `src/effects/types.ts`. **NOT VERIFIED per effect**; any matrix cell claiming it would be a guess.

---

## 3. Defects found and repaired

### 3.1 — P2 — four limiter controls were live in the DSP and dead everywhere else — **REPAIRED**

**Symptom.** The limiter's worklet exposes four AudioParams the **document** never declared: `transientLink`, `releaseLink`, `character`, `oversample`.

**Root cause — two independent mechanisms, both silent.**

1. The generic save path keeps only the ids present in `defaultParamsOf(type)` (`src/project-model/schema.ts:830-834`), and `limiterParams` did not list those four → they were **STRIPPED on every save/reload**.
2. `setEffectParam` (`src/commands/effectParams.ts:83`) refuses an id with no `EFFECT_META` entry — and the deep-def escape at `:82` exists **only for `ozvena`** → the four were **refused outright**: _"Effect param … not defined for limiter"_.

Net effect: a track limiter's transient link, release link, character and oversampling were permanently at the processor defaults, unreachable from the UI, from MCP and from automation. (The master limiter was unaffected — it sets them from the master config.)

**Repair.** Declared the four in `limiterParams` with the processor's own ranges (`transientLink` 0..1 default 1, `releaseLink` 0..1 default 1, `character` 0..2 default 0, `oversample` 1..2 default 1 as an enum), each with an agent-readable `description`. Because `defaultParamsOf` derives from `EFFECT_META[type].params`, the save path now keeps them automatically — no separate change was needed.
**Changed file:** `src/effects/definitions.ts` (landed in the tree with commit `3c4fc370`).
**Regression test:** `tests/limiterParameterCoverage.test.ts`, commit `2b60511e`.

**Verification.**

- **4/4 green**: every AudioParam the limiter processor declares is either a declared limiter parameter or an explicitly justified exception (the unit-converted `lookahead`; the monitor-only `deltaListen`, which the processor's own comment says is never stored); the four have sane ranges and descriptions; `setEffectParam` reaches all four and **clamps** out-of-range values; the save/reload path (`normalizeProject`) **keeps** all four.
- **NEGATIVE CONTROL** — the suite was re-run against the pre-fix `definitions.ts` (`git checkout 3c4fc370^ -- src/effects/definitions.ts`; the file restored **byte-identically**, SHA-256 verified): **4 failed / 4**, every failure `Error: Effect param transientLink not defined for limiter`. _The probe detects the defect; it does not merely pass._
- **No regression:** `npm run typecheck` → **exit 0**; `tests/commands.test.ts` 74/74, `tests/plugin-functional-audit.test.ts` 166/166, `tests/param-range-coherence.test.ts` 17/17 (including _"worklet descriptors cover EFFECT_META ranges"_), `tests/param-intent.test.ts` 45/45, `tests/fx-catalog.test.ts` 3/3 — **309/309 green**.

### 3.2 — P2 — no MCP path to load an effect preset — **NOT REPAIRED**

`applyEffectPreset` (`src/commands/effectOps.ts:53`), `applyEffectChainPreset` (`src/commands/effectParams.ts:192`) and `applyEssentialKit` (`:252`) exist — but a repo-wide search finds **zero callers in `src/mcp/`**. An agent can set individual parameters but cannot load a factory or chain preset: a large capability gap, and an asymmetry against the UI. The `kyx_fx` action enum (`tools.ts:1619`) has no preset member. **Repro:** `grep applyEffectPreset src/mcp` → empty.

### 3.3 — P2 — no generic MCP "add instance" operation — **NOT REPAIRED**

`kyx_fx` supports more/less/remove/bypass/enable/reorder only. Adding an effect is reachable only indirectly: `kyx_mix` → `addEffectToTracks`, `kyx_mix_idea` → `fxAddAssistant`, `kyx_intent` → `mix.ts:1130`, `kyx_master` (ZENIT only). `kyx_plugin_param` **explicitly refuses to auto-insert** (`tools.ts:1966`). So "insert a reverb on the lead" depends on a goal vocabulary rather than on a control.

### 3.4 — P2 — `remove` and `reorder` do not verify committed state — **NOT REPAIRED**

`tools.ts:4531` (reorder) and `:4604` (remove) report text computed from the **local** `next` document; only bypass/enable (`:4625`) and more/less (`:4644`) read back `ctx.getDoc()`. Contrast `kyx_plugin_param`, which re-reads the document (`:9047`), compares (`:9073`) and emits `PARTIAL_FAILURE` (`:9101`). An agent may be told _"removed reverb#1 — one undo step"_ when the committed document still contains it.

### 3.5 — P2 — `kyx_fx remove` is gated but does not auto-checkpoint — **NOT REPAIRED**

`tools.ts:4543` calls `ctx.allowDestructive?.()` directly; every other destructive site uses `destructiveAllowedWithCheckpoint` (`:6838`) — `kyx_tracks`, `kyx_notes`, `kyx_routing`, `kyx_sections`, `kyx_master`, `kyx_intent`. A destructive FX removal can leave no recoverable checkpoint.

### 3.6 — P2 — every verification is document-level; the DSP is never read back — **NOT REPAIRED**

`McpToolContext` (`tools.ts:2893-2944`) exposes `getDoc()`, `execute()` and live telemetry handles (`meters`, `fxMeters`, `renderMix`) — but **no parameter readback**. "Read actual applied value" answers _"what the document says"_, not _"what the running AudioWorklet has"_. The effect-intent layer's only verification is `isEffectIntentProposalCurrent` (`planner.ts:274`), a **fingerprint** on the document.

### 3.7 — P2 — two disjoint discovery surfaces and two `parseEffectIntent` functions — **NOT REPAIRED**

- `kyx_catalog` builds its parameter table from `EFFECT_META` (`src/effects/definitions.ts:3050`); `src/effect-intent/catalog.ts` builds a _different_ catalog (`effectParameterDescriptorCatalog` `:250`, schema fingerprints `:413`/`:425`, snapshot `:452`, coverage `:470`). Two surfaces, no bridge.
- `parseEffectIntent` exists **twice**: `src/intent/mix.ts:962` (deterministic, MCP-reachable) and `src/effect-intent/parser.ts:207` (curated goals). `src/intent/route.ts:1081-1091` prefers the first. The curated parser is consulted only by `mix-idea`. The same sentence ("warmer") routes to different machinery depending on the path.

### 3.8 — P2 — degree language is universally scaled, not per-parameter-family — **NOT REPAIRED**

Two disconnected scales:

- `src/intent/degree.ts` — one global 7-band vocabulary and **three universal** calibration curves (`calibrateKnobScale` `:369`, `calibrateParamFraction` `:387`). The param-fraction curve is taper-aware (linear vs log) but its **anchors are universal**.
- `src/effect-intent/parser.ts` — a **3-rung universal scalar** (`intensityOf` `:180-205`): 0.9 / 0.6 / 0.3.

Per-parameter differentiation comes only from hand-authored `positiveStep` per `(effectType, paramId)` in `capabilities.ts`, not from the degree vocabulary. _"slightly warmer"_ and _"slightly brighter"_ move the same fraction of their respective targets; the perceptual cost of 0.9 dB of shelf gain differs from 0.9 of a reverb mix, and nothing encodes that. (The brief's example words — _"significantly"_, _"a bit"_, _"more intimate"_, _"less bright"_ — are **not** in either vocabulary; _"a little"_ is, _"a bit"_ is not.)

### 3.9 — P2 — relative-step semantics switch unit systems — **NOT REPAIRED**

`src/intent/mix.ts:1148-1152`: with `percent` → `(percent/100) * range`; **without** `percent` → `(TARGETED_KNOB_DELTA[type] ?? 0.16*range*0.25) * scale`, where `TARGETED_KNOB_DELTA` is `{eq: 2 /* dB */, compressor: 2 /* ratio turns */}` (`:1066-1069`) — **native units**, while every other effect gets `0.04 * range`. For `eq`, _"percent: 10"_ ≈ 2.4 dB but no-percent ≈ 2 dB; for `compressor` the two branches are not even the same quantity. The same request produces a different magnitude depending on which field the agent supplies.

### 3.10 — P2 — the relative path builds its intent through a type escape — **NOT REPAIRED**

`tools.ts:4632-4639` casts an object literal `as unknown as Parameters<typeof applyEffectIntent>[1]`, so a change to `EffectIntent` will not break the build at the MCP boundary.

### 3.11 — P3 — OZVENA has zero presets — **NOT REPAIRED**

`src/effects/presets.ts` covers 53 of 57 types; the four missing are `fxeq`, `ultina`, `ozvena`, `morphdynamics` — but the first three carry their own libraries (`fxeq-core/core/presets.ts`, `ultina-core/presets/factoryPresets.ts`, `morph-dynamics-core/presets/factoryPresets.ts`). **OZVENA has none**: no preset module in `src/effects/ozvena-core/`, no preset export in `ozvena-params.ts`, no preset UI file.

### 3.12 — P3 — morphdynamics' deep parameters are not automatable — **NOT REPAIRED**

`effectTargetParamDefs` (`src/project-model/targets.ts`) special-cases `ultina` and `fxeq` with the vendored `ALL_PARAMS` `automatable` flag and `ozvena` via `OZVENA_TARGET_DEFS`. `morphdynamics` has no such case, so only its 9 rack-surface params are valid automation targets (`:181-184`). The sibling file `src/effects/morphDynamicsAutomation.ts` exists but is not wired into the target list.

### 3.13 — P3 — REZONANS has no golden-vector suite — **NOT REPAIRED**

fxeq, ultina, ozvena, morphdynamics and spectral each have a golden test file; rezonans has only `tests/rezonans-soak.test.ts` and `tests/rezonans-pitchtrack.test.ts`. Its DSP (`src/effects/rezonans-core/dsp/`, 12 files) is the largest flagship untested by vector.

### 3.14 — P3 — the effect count in the docs is stale — **NOT REPAIRED**

`AGENTS.md:270` claims _"48 core effects + 5 flagship plugin suites"_ (= 53); the actual `EFFECT_DEFS` is **57** with **6** flagship suites. `docs/CURRENT-STATE.md:17` already carries the correct 57. `src/plugin-audit-checks.ts:9` says _"52 effect types"_ while its loop iterates all 57. `docs/CURRENT-STATE.md:18`'s "native/core effects 50" does not reconcile (57 − 6 = 51, unless ZENIT is also counted as a suite — which the code does not do).

### 3.15 — P3 — `registerProcessor("portal")` is declared twice — **currently benign**

`src/audio-worklets/portal-processor.js:22` imports `../effects/spectral-worklet.entry.js`, and the entry itself calls `registerProcessor("portal", …)`. If both modules were ever `addModule`'d into one `AudioContext`, the second would throw `NotSupportedError`. Today it is benign: `core-processor.js` does not import `portal-processor.js`, and the loader adds `/spectral-worklet.js`. The file's own header says it exists purely for audit tooling.

### 3.16 — P3 — parameter `description` metadata exists for one effect only — **NOT REPAIRED**

Across 222 declared parameters, `description:` appears on **18/18** of `bassHarmonicParams` and on **0** of the other 54 types. `ParamDef.description` is documented as the agent-facing explanation ("Exposed by `kyx_catalog subject:effect`"), and `tests/koren-catalog.test.ts` requires it on every KOREŇ parameter — but only KOREŇ is held to it. `kyx_catalog` exposes only `id/value/min/max/default/unit` (`tools.ts:1116-1131`) — no `taper`, no `options`, no `format` — even though `EFFECT_BLURBS` has full 57/57 coverage (`src/effects/blurbs.ts:10`).

---

## 4. The five silently-dead parameter modes — and the answer

`docs/NEW-EFFECT-CHECKLIST.md:9-48` names five ways a parameter dies between the UI and the DSP:

1. **Blanket disconnect** — a cleanup helper severs internal sub-path links (`connectStages()` reconnected inputs/outputs but not `stages[i] → stages[i+1]`; the phaser's wet chain was silent for its whole life).
2. **Stop callback cancels the scheduled release** — `cancelScheduledValues` + hard-gate wipe the envelope `noteOn` scheduled.
3. **Dual-scale parameter without a registered bridge** — the document stores 0..1, the DSP wants percent/dB; an unregistered param gets clamped or automated on the wrong scale (ultina `global.mix` shipped this).
4. **Per-sample constant applied per-block** — a smoothing blend computed once per 128-sample block inflates the time constant by the block length.
5. **Port messages are not delivered during OfflineAudioContext renders** — event-queue worklets render **silent offline**.

**MEASURED RESULT: for all 57 effects, ZERO declared parameters fail to reach the DSP.** For the 44 worklet-backed effects the registry `ParamDef` id set was compared against (a) the processor's exact `parameterDescriptors` names and (b) every id written by the node adapter or the registry wrapper. For the 13 native effects the registry id set was compared against the `apply()` switch in each `EffectDefinition`. The three apparent misses are all **wired**, and are the reason a naive scanner produces false positives:

- the `eq` **legacy aliases** (`lowGain`/`lowFreq`/`midGain`/`midFreq`/`midQ`/`highGain`/`highFreq`) are deprecated and remapped at `src/project-model/schema.ts:836-851`;
- the tempo-sync `sync` parameter is handled by `createLfoSyncController` (`src/effects/tempo-sync.ts`);
- array-driven parameter maps (`DIV_PARAM_IDS` in `multitap-node.ts:22`, `PORTAL_PARAMS` in `portal-node.ts`).

**What this does NOT prove.** No test was executed; no waveform was rendered; no listening happened. It is a **static wiring audit at the AudioParam-name level**. It is the strongest available static guarantee that a parameter is not silently dead, and it is not a substitute for a listening pass.

---

## 5. The MCP control surface (37 tools)

| Tool                   | Mutating      | Canonical commands?                                                                                             | Authorization                                                      | Readback / postcondition                                                       |
| ---------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `kyx_intent`           | yes           | ✅ `route.ts` → `applyEffectIntent` → `setEffectParam`                                                          | destructive routes gated + checkpoint                              | label-level only                                                               |
| `kyx_state`            | no            | —                                                                                                               | —                                                                  | read                                                                           |
| `kyx_undo`             | yes           | store hooks                                                                                                     | declines while recording                                           | honest step count                                                              |
| `kyx_transport`        | runtime       | —                                                                                                               | —                                                                  | tick read-back, `PARTIAL_FAILURE` on drift                                     |
| `kyx_export`           | runtime       | —                                                                                                               | —                                                                  | `UNAVAILABLE_ON_TRANSPORT` if absent                                           |
| `kyx_audio_preview`    | no            | —                                                                                                               | —                                                                  | audio content                                                                  |
| `kyx_generate`         | yes           | ✅ `ctx.execute`                                                                                                | —                                                                  | pattern name + BPM                                                             |
| `kyx_groove`           | yes           | ✅                                                                                                              | —                                                                  | partial-detection                                                              |
| **`kyx_fx`**           | yes           | ✅ `moveEffectToIndex`/`moveEffect`/`removeEffect`/`toggleEffectBypass`/`applyEffectIntent`/`applyBypassIntent` | `remove` only: `ctx.allowDestructive?.()` — **no auto-checkpoint** | **partial** — bypass/enable/more/less verify; **remove/reorder do not**        |
| `kyx_sections`         | yes           | ✅ (14 `ctx.execute`)                                                                                           | `remove` gated                                                     | `PARTIAL_FAILURE`                                                              |
| `kyx_markers`          | yes           | ✅                                                                                                              | —                                                                  | verified vs committed state                                                    |
| `kyx_tracks`           | yes           | ✅                                                                                                              | `remove` gated + checkpoint                                        | verified                                                                       |
| `kyx_pattern`          | yes           | ✅                                                                                                              | —                                                                  | —                                                                              |
| `kyx_steps`            | yes           | ✅                                                                                                              | —                                                                  | —                                                                              |
| `kyx_notes`            | yes           | ✅                                                                                                              | delete gated + checkpoint                                          | `PARTIAL_FAILURE` per op                                                       |
| `kyx_music`            | yes           | ✅                                                                                                              | —                                                                  | verified                                                                       |
| **`kyx_catalog`**      | no            | —                                                                                                               | —                                                                  | parameter tables built at runtime from `EFFECT_META`                           |
| **`kyx_plugin_param`** | yes           | ✅ `setEffectParam` + `snapshot`                                                                                | `mutate` class                                                     | **strongest in the repo**: re-reads the doc, compares, emits `PARTIAL_FAILURE` |
| `kyx_meter`            | no            | —                                                                                                               | —                                                                  | live engine; honest refusal if absent                                          |
| `kyx_automation`       | yes           | ✅                                                                                                              | `clearLane`/`removeLane` gated                                     | range-aware lane label                                                         |
| `kyx_clips`            | yes           | ✅ (23 `ctx.execute`)                                                                                           | delete/cut gated + checkpoint                                      | `PARTIAL_FAILURE`                                                              |
| `kyx_batch`            | yes           | ✅ delegates per item                                                                                           | **per-tool gates apply inside the batch**                          | per-item; atomic → `PARTIAL_FAILURE`                                           |
| `kyx_loudness`         | yes           | ✅                                                                                                              | —                                                                  | measured                                                                       |
| `kyx_import_sfz`       | yes           | ✅                                                                                                              | —                                                                  | host capability                                                                |
| `kyx_publish_gallery`  | runtime       | —                                                                                                               | —                                                                  | share id                                                                       |
| `kyx_render_summary`   | no            | —                                                                                                               | —                                                                  | measured                                                                       |
| `kyx_diagnose_mix`     | no            | —                                                                                                               | —                                                                  | measured                                                                       |
| **`kyx_mix_idea`**     | yes           | ✅ → `fxAddAssistant` → `addEffectWithLandingCommand` → `snapshot`                                              | `mutate`                                                           | **no value-level verification**                                                |
| `kyx_checkpoint`       | yes (restore) | store-level                                                                                                     | restore/delete mutate                                              | list/diff/save are `read` risk                                                 |
| `kyx_mix`              | yes           | ✅ `applyMixIntent`                                                                                             | `mutate`                                                           | decision summary                                                               |
| `kyx_arrange`          | yes           | ✅                                                                                                              | —                                                                  | `PARTIAL_FAILURE`                                                              |
| `kyx_song`             | yes           | ✅                                                                                                              | —                                                                  | —                                                                              |
| `kyx_routing`          | yes           | ✅                                                                                                              | `removeReturn` gated + checkpoint                                  | verified vs committed state                                                    |
| `kyx_unsuno`           | yes           | ✅                                                                                                              | —                                                                  | —                                                                              |
| `kyx_master`           | yes           | ✅                                                                                                              | `remove` gated + checkpoint                                        | —                                                                              |
| `kyx_takes`            | yes           | ✅                                                                                                              | `deleteTake` gated                                                 | verified                                                                       |
| `kyx_blind_ab`         | yes           | ✅                                                                                                              | —                                                                  | binomial verdict                                                               |

**Declared-but-dead: none.** 37 declared ↔ 37 `case "kyx_*"` handlers ↔ 37 `TOOL_RISK` entries, in both directions.

### Coverage against the brief's required operations

| Required                                                                    | State                                                                                                                                                            |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List plugin types / instances / chains / routing                            | ✅ `kyx_catalog`, `kyx_state`, `kyx_routing`                                                                                                                     |
| List capabilities                                                           | ⚠️ partial — parameter tables only; risk lives in `agentTrust.ts`                                                                                                |
| Read parameter metadata (id, type, unit, min, max, curve, default, current) | ⚠️ split — everything but `current` via `kyx_catalog`; `current` only via `kyx_plugin_param op:"list"` (**inserted instances only**); `curve` present as `taper` |
| Add instance                                                                | ⚠️ **PARTIAL** — no generic op (§3.3)                                                                                                                            |
| Remove instance / reorder / bypass                                          | ✅                                                                                                                                                               |
| Load preset                                                                 | ❌ **MISSING** (§3.2)                                                                                                                                            |
| Set exact parameter                                                         | ✅ `kyx_plugin_param op:"set"` (absolute native value, clamped to range)                                                                                         |
| Bounded relative change                                                     | ✅ `kyx_fx more/less` + `percent`                                                                                                                                |
| Read actual applied value                                                   | ✅ **document-level only** — never DSP-level (§3.6)                                                                                                              |
| Read / write automation                                                     | ✅                                                                                                                                                               |
| Verify resulting project state                                              | ✅ **document-level only**                                                                                                                                       |

---

## 6. The local model (Phase 5)

**The brief says "Fine-tuned LFM 2.5 1.2B, 4-bit quantized". In KYX that is HALF RIGHT: the base model is LFM2.5-1.2B-Instruct, but the shipped quantization is 8-bit, not 4-bit.**

|                         |                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base                    | **LiquidAI/LFM2.5-1.2B-Instruct** (1,181,448,960 params — the adapter config's `base_model_name_or_path` proves it; the training scripts' `DEFAULT_BASE` still names the older `LFM2-1.2B`, but the shipped artifacts were trained with an explicit override) |
| Fine-tune               | LoRA r=32 / α=64, 4 epochs, bf16, 11,108,352 trainable params (0.94 %)                                                                                                                                                                                        |
| Quantization shipped    | **Q8_0** — `kyx-intent-v33-q8.gguf`, 1.16 GB — the runtime default `kyx-intent-v33-q8`                                                                                                                                                                        |
| Also present            | **F16** — `zyvo-intent-v8-f16.gguf`, 2.18 GB; `kyx-intent-v30-q8`                                                                                                                                                                                             |
| **Q4 / 4-bit artifact** | **NONE FOUND** — no Q4/Q4_0/Q4_K_M GGUF of the intent model exists in the repo or in `public/models`                                                                                                                                                          |
| Browser path            | **NOT the LFM** — `public/models/intent-model-v1.onnx` (2.6 MB) + manifest + vocab: a tiny ONNX intent model. The LFM is the **desktop/Ollama** path.                                                                                                         |
| Decoder                 | **GBNF-constrained**, then `validateModelAction` runtime validation                                                                                                                                                                                           |
| Recorded evaluation     | `lfm-eval-v33-q8-2026-10-09.json`: 220/240 attempted-exact (**91.7 %**), wrongKind 3, **abstain 58/298** on the 298-row val set                                                                                                                               |
| Thread safety           | ✅ the model runs in a **separate process**; no model work inside an `AudioWorkletProcessor`                                                                                                                                                                  |
| Live inference today    | **NOT VERIFIED** — requires a running Ollama with the model pulled, or the llama.cpp host; not executed in this wave                                                                                                                                          |

**So the brief's premise is true in ZYVO (Q4_K_M, SHA-256 pinned, present on this machine) and false in KYX (Q8_0).** They are two different models of the same family in two different repos; the audit treats them separately.

**Two disconnected intent parsers**, both correct in their own scope: the deterministic numeric path (`src/intent/mix.ts`, MCP-reachable, `parseDegree` from the shared 7-band vocabulary) and the curated semantic path (`src/effect-intent/parser.ts`, 3 goals × 2 directions, `AMOUNT_SCALE` 0.3/0.6/0.9). The planner composes `mapping.positiveStep * goal.amount * signed` (`planner.ts:167`) and clamps to `safeMin`/`safeMax` (`:225-227`).

---

## 7. Tests run and remaining gaps

### 7.1 Commands run (exit codes captured directly from the producer)

| Command                                                               | Result                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                   | **exit 0**                                                                                                                                                                                                                                  |
| `vitest run tests/commands.test.ts`                                   | **74/74**                                                                                                                                                                                                                                   |
| `vitest run tests/plugin-functional-audit.test.ts`                    | **166/166**                                                                                                                                                                                                                                 |
| `vitest run tests/param-range-coherence.test.ts`                      | **17/17**                                                                                                                                                                                                                                   |
| `vitest run tests/param-intent.test.ts`                               | **45/45**                                                                                                                                                                                                                                   |
| `vitest run tests/fx-catalog.test.ts`                                 | **3/3**                                                                                                                                                                                                                                     |
| `vitest run tests/limiterParameterCoverage.test.ts`                   | **4/4** (new)                                                                                                                                                                                                                               |
| **total**                                                             | **309/309 green**                                                                                                                                                                                                                           |
| `npm run typecheck + drift:check + verify:mcp-mirrors` (combined run) | **timed out at 1800 s** — the typecheck had already failed on _another session's_ in-flight `src/ui/IntentPanel.tsx` WIP at that moment; `drift:check` and `verify:mcp-mirrors` were re-run separately later. **Re-verify before quoting.** |

### 7.2 Not verified — stated, not assumed

| Item                                                         | Status                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| Per-effect sample-rate / channel support                     | **NOT VERIFIED** — no such field exists                 |
| Whether any golden/parity/vendor script **passes**           | **NOT VERIFIED** — files were read, never executed      |
| Native addon builds on this machine                          | **NOT VERIFIED** — `npm run cpp:doctor` not run         |
| Live LFM inference                                           | **NOT VERIFIED** — no Ollama/llama.cpp host was started |
| The recorded 91.7 % exact-match figure                       | **quoted from the report artifact, not re-measured**    |
| Any subjective audio quality / listening result              | **NOT VERIFIED** — no listening test was performed      |
| `koren-catalog.test.ts` completeness pin over all 57 effects | **NOT VERIFIED** — the pin covers KOREŇ only (§3.16)    |

### 7.3 Manual listening checklist (NOT performed)

Level-matched A/B for: limiter character and oversampling (1× vs 2×) at three ceilings; ROOM space/decay/brightness; CURVE band transparency and the 2× crossover order; STACK de-esser band tracking; ECHO/ROOM feedback tails at maximum; every effect's bypass snap on/off; parameter extremes (limiter ceiling 0 dB, threshold −24 dB, release 10 ms; rezonans full tilt); automation sweeps of every automatable parameter; mono compatibility of every stereo source; click and artefact audit at every bypass, reorder and preset boundary; and a loop-sweep of the 57 effects at their defaults for aliasing and denormal artefacts.

---

## 8. Remaining risks, unsupported capabilities, next actions

| #   | Item                                                    | Sev    | Next action                                                                                                          |
| --- | ------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| 1   | No MCP preset load (§3.2)                               | **P1** | Add a `loadPreset` action to `kyx_fx` over the existing `applyEffectPreset` command                                  |
| 2   | No generic MCP add-instance (§3.3)                      | **P1** | Add an `add` action over `addEffectToTracks` so "insert a reverb on the lead" stops depending on the goal vocabulary |
| 3   | `remove`/`reorder` do not verify committed state (§3.4) | **P1** | Mirror the `kyx_plugin_param` read-back (`:9047-9104`)                                                               |
| 4   | No DSP-level readback anywhere (§3.6)                   | **P1** | Expose the running node's applied value through `McpToolContext`                                                     |
| 5   | Degree language is universal, not per-family (§3.8)     | **P2** | Choose **one** degree model and bridge or delete the other                                                           |
| 6   | Relative-step unit switching (§3.9)                     | **P2** | Make `percent` and native-unit paths the same quantity                                                               |
| 7   | `remove` without auto-checkpoint (§3.5)                 | **P2** | Route through `destructiveAllowedWithCheckpoint`                                                                     |
| 8   | Two `parseEffectIntent` + two catalogs (§3.7)           | **P2** | Rename one before it becomes a shipped-API collision                                                                 |
| 9   | morphdynamics deep params not automatable (§3.12)       | **P2** | Wire `morphDynamicsAutomation.ts` into `effectTargetParamDefs`                                                       |
| 10  | OZVENA has zero presets (§3.11)                         | **P2** | Add a preset library, or state that OZVENA ships without presets                                                     |
| 11  | REZONANS has no golden vectors (§3.13)                  | **P3** | Add a golden-render fixture for `rezonans-core`                                                                      |
| 12  | Parameter descriptions on 1 of 57 effects (§3.16)       | **P3** | Extend the `koren-catalog` description pin to every effect                                                           |
| 13  | The docs' effect counts are stale (§3.14)               | **P3** | Update `AGENTS.md:270`, `plugin-audit-checks.ts:9`, `CURRENT-STATE.md:18`                                            |
| 14  | `registerProcessor("portal")` twice (§3.15)             | **P3** | Guard the entry, or drop the audit shim                                                                              |

**Explicitly unsupported, not a defect:** the curated effect-intent layer covers **2** effect types with **7** mappings (`capabilities.ts:9-121`); any other type returns `status: "unsupported"` (`planner.ts:102-104`). `src/effect-intent/` is reachable from the UI and from exactly one MCP tool (`kyx_mix_idea`). The MCP mirrors (`desktop/mcp-tool-defs.cjs`, `server/mcp-core.mjs`) carry **tool schemas only** — parameter ranges are obtainable only from a live `kyx_catalog` call.

---

_Generated by the plugin/effect reliability audit, 2026-10-21. Findings are cited to `file:line`; anything unmeasured is marked NOT VERIFIED rather than assumed._
