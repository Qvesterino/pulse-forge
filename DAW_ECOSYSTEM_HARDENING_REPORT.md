# DAW ECOSYSTEM HARDENING REPORT

**Scope:** the KYX browser DAW (`D:\pulse-forge`, internally _Pulse Forge_) as one integrated
system with multiple control surfaces: the React UI, the Intent Engine, and the MCP tool
server (the AI's hands on the project).
**Date:** 2026-10-23 · **Branch:** `main` (tip `15bef819`) · **Method:** Orient → Map → Prioritize →
Investigate → Harden → Verify → Review regression surface.

**Severity framework used throughout**

|        | Meaning                                                                                 | Examples                                                  |
| ------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **P0** | Data corruption / data loss the user cannot detect or recover from                      | a save that drops a take lane                             |
| **P1** | Broken core workflow, silent state divergence, wrong routing, material state divergence | the AI cannot remove an EQ; undo leaves two takes audible |
| **P2** | Recoverable defect / degradation under edge conditions                                  | a relative dB ask that mis-scales one knob                |
| **P3** | Polish, diagnostics, maintainability                                                    | a duplicated alias table                                  |

**Evidence classes are kept apart on purpose.** _Automated_ = vitest/jsdom. _Runtime_ = a real
browser. _Listening_ = a human ear. A claim from one class is never upgraded to another.

---

## 1. Executive assessment

**How close is KYX to a dependable, integrated professional system?** On the _invariant_ layer it
is further along than most projects of this size, and on the _state ownership_ layer it is
genuinely well built. On the _surface agreement_ layer it is not there yet.

Three findings shaped this session's verdict:

1. **The state has one owner, and it is the right one.** Every surface — UI, Intent Engine, MCP —
   goes through `src/commands/**` into one `ProjectStore`; the desktop MCP host mutates
   `services.store` (`src/mcp/desktop-host.ts`), the same store the UI renders from. There is no
   shadow copy of the project anywhere. The MCP layer even reads the document back after
   mutating and reports `PARTIAL_FAILURE` when the read-back disagrees
   (`src/mcp/tools.ts:9491-9520`). That is the hard part, and it is right.

2. **The invariants are pinned, and the pins have teeth.** `docs/AGENT-MAP.md` §3 holds **77
   documented invariants**, each with the guard that protects it, and `tests/agent-map.test.ts`
   keeps the map honest. 1203 spec files back it. The plugin-runtime containment invariant, which
   used to be checked at only 3 of its 14 call sites, is now checked at **14/14** — every one
   revert-proven by removing its guard.

3. **The surfaces disagree about meaning, and that is where the professional risk lives.** The
   same sentence can resolve to a _different effect_ depending on which surface hears it
   (`distortion` → `saturation` in the Intent word table, but `distortion` is a real effect the MCP
   tool will insert). The same ask can be _silently rescaled_ into a full-range jump. And an AI
   action can be reported as applied while the state it claims to have produced was never
   verified.

**Verdict.** The architecture is sound and the discipline around it is real. The residual risk is
concentrated in three places, in this order: **surface agreement** (Intent ↔ MCP ↔ registry),
**false AI success** (an action reported without a read-back), and **the normalizer/undo seam**
(a class of bug that has now bitten twice). Those are tractable, and this session fixed one
member of each of the first two classes and one instance of the third.

**What this report does not claim.** No human listening was done. Only Chromium was exercised in a
real browser. The full test suite was not re-run to zero-red on the final tip. These are stated
as gaps in §6, not papered over.

---

## 2. Architecture and control-flow map

```
                      ┌───────────── FOUR CONTROL SURFACES ──────────────┐
  UI (149 components)  Intent Engine (172 modules)   MCP server (38 tools)   Collab (Yjs)
        │                     │                            │                    │
        └─────────────────────┴──────────┬─────────────────┴────────────────────┘
                                           ▼
                     COMMAND LAYER — src/commands/** (50 modules)
                     every mutation is a Command; snapshot() captures an id-anchored
                     forward/backward DELTA (src/commands/core.ts:34-66)
                                           ▼
                     PROJECT MODEL — src/project-model/** (plain serializable doc)
                     normalizeProject() runs after every apply (src/store/ProjectStore.ts:264)
                                           ▼
        ┌──────────────────────────────┴──────────────────────────────┐
        ▼                             ▼                                ▼
  AUDIO ENGINE (one)            PERSISTENCE (IndexedDB)         RENDERER (offline)
  src/audio-engine/AudioEngine.ts   src/persistence/**           src/rendering/renderer.ts
        │                                                                     │
        ▼                                                                     ▼
  AudioWorklets (57) + AudioNodes                              OfflineAudioContext — the SAME
                                                                  engine, only the event
                                                                  driver differs
```

**Why this shape matters for the findings below.** `snapshot()` records a **delta**, not a whole
document. That is the right design (an async render or a collab merge cannot be silently reverted
by a stale snapshot), but it has one sharp edge: **anything the post-apply normalizer prunes is
pruned outside the delta**, so the backward delta cannot restore it. Two of this session's
findings live on exactly that edge.

**Dependency facts that matter for prioritization**

- `src/effects/definitions.ts` (`EFFECT_META`) is the single source for effect parameters; the
  registry, the plugin catalog, the intent param registry and the model context all _derive_ from
  it. There is no second parameter table — a rare and valuable property of this codebase.
- `src/plugin-catalog.ts` derives the catalog from `EFFECT_META` and reports _installed_
  instances separately from the static catalog, so the AI is told what is really on the track.
- The Intent Engine still keeps **four parallel vocabularies**: the effect word table
  (`src/intent/effect-words.ts`), the primary-knob map (`src/intent/mix.ts:736`), the capability
  matrix (`src/intent/semantics/param-registry.ts`) and the model vocab
  (`src/intent/model-schema.ts`). The drift findings live in the seams between them.

---

## 3. Cross-subsystem contract matrix

Status: **PASS** = pinned by an automated guard · **PARTIAL** = the main path is pinned, a
sub-path is not · **FAIL** = a verified divergence exists · **NOT VERIFIED** = no evidence of
either kind.

| #   | Contract                                                        | Status      | Evidence                                                                                                                                                                                       |
| --- | --------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One authoritative state owner for every surface                 | **PASS**    | `src/mcp/desktop-host.ts` mutates `services.store`; UI reads the same store; `src/commands/**` is the only writer                                                                              |
| 2   | A throwing plugin runtime must not strand the rest of the graph | **PASS**    | 14/14 call sites pinned in `tests/audio-engine-lifecycle-stress.test.ts` (was 3/14) — each revert-proven                                                                                       |
| 3   | Deleted entities leave no dangling references                   | **PARTIAL** | `tests/referential-integrity.test.ts` (872 lines) pins the main classes; the take-lane + Live-Set class was **not** pinned and is now fixed (§4.3); the bus-effect-delete no-op remains (F-07) |
| 4   | Undo restores the exact prior state                             | **PARTIAL** | `tests/undo-redo-integrity.test.ts`; the delete-track class failed (§4.3, now fixed); the class itself is not mechanically audited (R-05)                                                      |
| 5   | Offline render == live playback                                 | **PASS**    | `tests/offline-parity.test.ts` (6 structural contracts), `tests/renderer-pdc-settle.test.ts`, `tests/render-event-parity.test.ts`                                                              |
| 6   | Save → reload keeps project-critical state                      | **PASS**    | `tests/state-persistence-adversarial.test.ts`, `tests/project-invariants.test.ts`                                                                                                              |
| 7   | An AI tool reports the state it actually produced               | **PARTIAL** | `kyx_plugin_param` reads back and reports `PARTIAL_FAILURE` (`src/mcp/tools.ts:9491`); `kyx_intent`'s `paramIntent` branch has **no** read-back (F-06)                                         |
| 8   | The same effect word means the same effect on every surface     | **FAIL**    | `distortion` → `saturation` in the word table vs. a real `distortion` effect in MCP (F-01); `sv filter` → `eq` vs. `svFilter` (F-02)                                                           |
| 9   | A value means the same unit on every surface                    | **PARTIAL** | all eight dB→linear conversions are `10^(dB/20)` — **no formula drift**; but the AI bridge clamps track gain to 0..4 while every other surface clamps to 0..1.5 (F-05)                         |
| 10  | A failed action is visible to the user                          | **PARTIAL** | the intent bar's effect branch had no `try/catch` (silent no-op) — **fixed** in §4.1; the remaining branches were already guarded                                                              |
| 11  | A plugin parameter has one identity everywhere                  | **PASS**    | `EFFECT_META` is the single source; the catalog derives from it; `tests/fx-catalog.test.ts`, `tests/target-param-catalog.test.ts`                                                              |
| 12  | The build, type and format gates are green on `main`            | **PASS**    | verified on `origin/main` this session (§6)                                                                                                                                                    |

---

## 4. Critical findings and fixes

### 4.1 — P1 · A type-level effect remove must not need a primary knob · **FIXED** (`dbe1a507`)

**What:** `applyEffectIntent` required a "primary knob" mapping _before_ it looked at the
direction. Removing an effect does not turn a knob — it takes the instance out. So removing an
effect that has no primary knob threw `no knob mapped for effect "eq"` instead of removing it.
**43 of the 57 registered effect types** have no primary knob (`EFFECT_KNOB` holds 14 entries,
`src/intent/mix.ts:736-753`): `eq`, `saturation`, `ozvena`, every flagship plugin.

**Why it matters:** through MCP this surfaced as `EXECUTION_FAILED` — _the AI cannot remove an
EQ_. Through the UI it was worse: the intent bar's effect branch had no `try/catch`
(`src/ui/IntentPanel.tsx:4608`), so the error escaped the click handler — **no status, no error
message, nothing happened on screen**. A silent no-op the user cannot read as a failure.

**Fix:** the knob is required only where the knob is the thing that moves (a `more`/`less` ask, or
an absolute `set` of the knob's own range). A semantic move carries its own absolute params and
never needed one either. The intent bar now catches the applier's throw and shows it, like its
sibling branches already do.

**Falsification:** the new spec (`tests/effect-intent-remove-without-knob.test.ts`) was **RED
before** the change (the applier threw; the MCP tool returned `isError`) and **GREEN after**. The
control case — a knob-turning ask on the same effect still refuses — stayed green throughout, so
the guard was **narrowed, not weakened**.

**Regression surface:** `intent-effect-targets`, `param-intent`, `mcp-tools` (147),
`mcp-flagship-control` — **217/217**.

### 4.2 — P2 (wrong audio) · A relative dB ask belongs only on a dB knob · **FIXED** (`3b838637`)

**What:** the _absolute_ path already declined a dB ask on a unitless knob (`toParamUnit` returns
`NaN` → the branch declines, `src/intent/param-intent.ts:156`). The _relative_ path did not: it
read the dB **number** as a percentage of the knob's range. `by 2 db more saturation mix` became
a **100 %-of-range jump** — `mix 0.40 → 1.00`, i.e. the whole effect at 100 % wet, out of a
two-decibel request. The plan even said `+2 dB relative` while the sound did something else.

**Why it matters:** this is the exact class the user cannot detect — the plan and the sound
disagree, the number in the plan is a lie, and the mix changes for a reason nobody asked for.

**Fix:** the relative branch declines the same way the absolute one does, so the generic layer
owns the ask instead of mis-scaling it.

**Falsification:** RED without the guard (the intent parsed and resolved to `saturation.mix`),
GREEN with it. Both controls stayed green: the relative dB move on a dB knob (−18 → −20 dB) and
the relative **percent** move on a unitless knob (0.4 → 0.5).

### 4.3 — P1 (data loss) · Delete track + undo must not destroy the take lanes or the Live Set routing · **FIXED** (`c2166f59`)

**What:** the take lanes (`arrangement.takeGroups`) and the Live Set routing
(`liveSets[].trackId`) point **at** the deleted track. The post-apply normalizer prunes both
**outside the captured undo delta** (`sanitizeAudioTakeGroups` drops a group whose track is gone,
`src/project-model/schema.ts:722`; the live-set normalizer clears the id, `schema.ts:2985`). So
Ctrl+Z brought the track and its clips back but **not** the lane structure: every take was
audible at once (a wrong mix), the lanes were gone for good, and the Live Set had lost its
destination — silently.

**Why it matters:** this is P1, not P3. The user undoes a delete, believes their session is
intact, and instead gets a **different mix** with no warning, and the lane structure is
unrecoverable without reloading a save.

**Fix:** the same function already documents this rule for the sidechain/MIDI cross-references —
_"Cross-references HELD BY OTHER ENTITIES must be removed here, inside the command"_ — the take
lanes, the Live Set routing and the drum step metadata were simply never added to that list.
They are now, so the removal is part of the delta and the backward delta restores them together
with the track.

**Falsification:** RED without the fix (the undo left the take group `undefined` — the lanes were
**not** restored), GREEN with it. **Regression surface:** `referential-integrity`,
`undo-redo-integrity`, `project-invariants`, `state-persistence-adversarial` — all green.

### 4.4 — Outstanding findings (verified in code, not yet fixed)

| ID       | Sev    | Finding                                                                                                                                                                                                                                                                                 | Where                                                                              |
| -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **F-01** | **P1** | `distortion` resolves to **`saturation`** in the Intent word table, while `distortion` is a real registered effect the MCP tool inserts. The same phrase produces two different effects depending on the surface.                                                                       | `src/intent/effect-words.ts:24` vs `src/mcp/tools.ts:4621`                         |
| **F-02** | **P1** | `sv filter` resolves to **`eq`**: the generic `\bfilter` rule precedes the specific `\bsv filter\b` rule and the lookup takes the first match. The intent's own param layer then forces `svFilter` — the intent layer disagrees with itself.                                            | `src/intent/effect-words.ts:38,45,50-52` vs `src/intent/param-intent.ts:197-205`   |
| **F-05** | **P2** | The AI bridge clamps track gain to **0..4** while the command layer clamps 0..1.5, the UI displays 0..1.5 and MCP caps at 1.5. The bridge bypasses `setTrackParams`, so a document can hold a gain no other surface can set or show.                                                    | `src/ai/bridge/executor.ts:606,1004` vs `src/commands/master.ts:70,95`             |
| **F-06** | **P2** | `kyx_intent` asserts _"applied, one undo step in KYX"_ but its read-back chain covers only production/effectIntent/preset — the **`paramIntent`** branch gets **no verification at all**.                                                                                               | `src/mcp/tools.ts:11722-11730`                                                     |
| **F-07** | **P2** | Two surfaces disagree on the same operation: deleting the **active take's** clip silently promotes an alternate take through the UI path, while the MCP path refuses. Removing an effect from a **return bus** is a silent no-op, while `addEffectToTracks` _can_ add effects to a bus. | `src/mcp/tools.ts:8670` vs `src/commands/audioClips.ts`; `src/commands/effects.ts` |
| **F-08** | **P2** | `kyx_plugin_param` cannot reach deep params (`eq.band3.gainDb`, `engines.e1.mix`) although its own description claims it "sets ANY parameter of an inserted instance". The catalog exposes rack params only.                                                                            | `src/plugin-catalog.ts:95` vs `src/commands/effectParams.ts:82`                    |
| **F-09** | **P2** | The model context offers a role outside the model's own closed enum: `compressor`→ratio, `pump`→amount and `bitcrusher`→mix have no capability row, so the role falls back to `"primary"` — which the model cannot emit in a `paramIntent`, yet the context marks the action supported. | `src/intent/model-context.ts:130,152` vs `src/intent/model-schema.ts:370`          |
| **F-10** | **P3** | `kyx_fx`'s read-back prints `mix 0.30→0.30` when the effect was just added at defaults — a "verification" showing no movement, next to the text "one undo step".                                                                                                                        | `src/intent/mix.ts:1200-1204`                                                      |
| **F-11** | **P3** | The eq legacy aliases are declared twice — hardcoded in the command layer and as `deprecated/aliasOf` `ParamDef`s. They agree today; the catalog does not filter `deprecated`, so `kyx_catalog` advertises aliases as settable and the command writes **both** keys.                    | `src/commands/effectParams.ts:84-92`, `src/plugin-catalog.ts:95`                   |
| **F-12** | **P3** | Percent semantics differ between two intent sub-layers: `mix.ts` maps percent linearly over min..max and ignores `taper:"log"`, while the param layer is log-aware. Latent today (no primary knob is log-tapered).                                                                      | `src/intent/mix.ts:1134` vs `src/intent/param-intent.ts`                           |
| **F-13** | **P3** | `SCALE_BRIDGES` is test-only; production conversions are inline duplicates (`ozvenaNode`, `morphDynamicsNode` re-implement `v*100`). They agree today; registry↔runtime drift would be undetectable. The def↔descriptor range sweep also skips ultina/ozvena/morphdynamics.             | `src/effects/scale-bridges.ts:59-95`, `tests/param-range-coherence.test.ts:53-94`  |
| **F-14** | **P3** | A scratch diagnostic spec is on `main` (`tests/zz-diagnostic.test.ts`: `console.log` noise, `expect(true).toBe(true)`). Formatted, not deleted — its owner may still be using it.                                                                                                       | `tests/zz-diagnostic.test.ts`                                                      |

### 4.5 — Findings that were checked and found **clean** (recorded so they are not re-litigated)

- **No dB↔linear formula drift.** All eight amplitude conversions are `10^(dB/20)`; `10·log10`
  appears only in power/LUFS/energy-share domains, where it is correct. `10·log10(ratio*10)` in
  `src/analysis/vlyxClaim.ts:55` mirrors a vendored core and must stay as it is.
- **Determinism is clean.** Every conversion is pure and dependency-free; no module-level
  calibration state enters a gain path.
- **The plugin parameter registry has one owner.** `EFFECT_META` feeds the registry, the catalog,
  the param registry and the model context — there is no second parameter table to drift.
- **The MCP plugin-param path is honest.** It reads the document back, compares, and reports
  `PARTIAL_FAILURE` when the read-back disagrees.
- **The plugin-catalog is derived, not hand-written.** It reports _installed_ instances with
  their real stored values and omits unknown/stale effect types rather than inventing them.
- **The desktop MCP host mutates the live store** — there is no shadow copy of the project.

---

## 5. Real user journeys

The repository already carries **37 Playwright journeys** (`tests/e2e/`) covering the paths that
matter: landing → studio, project persistence round trip, plugin workflow, group routing, effect
intent, recording, takes, consolidation, intent model chip, idea → export, mastering workspace,
editor chaos chain, audio edit render, playback master bus, heap stability, boot watchdog, crash
journal, unload save flush, MIDI arrangement, sub-bar drag undo, fades, ripple semantics, snap
grid.

**This session additionally exercised the real browser** with the project's own verifier
(`scripts/verify-browser.mjs`, 428 checks: DSP renders, worklet behaviour, PDC alignment,
scheduler, mod matrix, granular voice, lossy share delivery, collab sync, and five E2E flows).

| Journey                                  | Result                                 | Note                                                                                                                                          |
| ---------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| App boot / UI mount                      | **FAIL (first run), re-run in flight** | console showed `ERR_CONNECTION_REFUSED` — the verifier's dev server lost its connection mid-run, which also explains the three later timeouts |
| Plugin / effect workflows                | **PASS**                               | DSP renders, PDC latency reported and aligned, rack mix reaches the core                                                                      |
| Mod matrix, granular voice, worklets     | **PASS**                               | including CPU budget and determinism after a JSON reload                                                                                      |
| Lossy share delivery (ogg-opus, m4a-aac) | **PASS**                               | container round-trip rms within tolerance                                                                                                     |
| Collab: two pages sync edits + presence  | **PASS**                               | over the real server                                                                                                                          |
| Instant jam E2E (3 pages)                | **FAIL (first run), re-run in flight** | playheads 743 ticks apart (382 / 427 / 1125) — one page stalled while the others advanced, consistent with the same connection loss           |
| Touch long-press, plugin workflow E2E    | **FAIL (first run), re-run in flight** | selector timeouts after the connection loss                                                                                                   |

**First-run total: 410/428 checks passed in Chromium.** The five failures are not five
independent defects: four are downstream of the connection loss and one (the jam divergence)
shows the same stall on a third page. A clean re-run in isolation is the honest classifier, and
it is in flight (§6).

---

## 6. Test evidence

### Automated (vitest / jsdom)

- **1203 spec files** in `tests/`; the last complete suite run measured **13 193 tests**
  (13 174 passed, 19 failed across 9 files)
  over ~2014 s under heavy parallel load.
- **This session's new coverage** (3 files, 7 cases, each revert-proven):

| Spec                                                | Covers                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/effect-intent-remove-without-knob.test.ts`   | the type-level remove without a knob, through the applier and through MCP; the control that the knob guard still refuses a knob-turning ask |
| `tests/param-intent-relative-db-unit-guard.test.ts` | the relative dB ask on a unitless knob; the controls for the dB knob and the percent path                                                   |
| `tests/delete-track-undo-cross-references.test.ts`  | delete track + undo restores the take lanes and the Live Set routing                                                                        |

- **Regression surfaces run after each fix:** `intent-effect-targets`, `param-intent`,
  `mcp-tools` (147), `mcp-flagship-control`, `referential-integrity`, `undo-redo-integrity`,
  `project-invariants`, `state-persistence-adversarial`, `creative-task-contract` — all green.
- **Gates verified on `origin/main`:** `npm run typecheck:clean` → **exit 0**;
  `npm run format:check` → **exit 0**; `npm run build` → **exit 0** with every size budget green
  (entry 404/1070 KB, DAW JS 5564/5630 KB, studio boot path 2096/2200 KB, core worklets 112/150 KB).
- **Known red that is not mine and was not silenced:** 12 of the 19 failures in the last full
  suite run were **load-induced** (they pass in isolation) across 6 files. They are a test-suite
  isolation problem, not a product defect, and they were left visible rather than papered over.

### Runtime (real browser)

- **Chromium: 410/428 checks passed** (first run, under concurrent load from a parallel agent
  session and this session's own suites). A clean re-run in isolation is in flight.
- **Firefox / WebKit: NOT VERIFIED in this session.** The Playwright browsers are installed and
  `npm run verify:all -- --engines all` would cover all three, but the run was not repeated for
  the second and third engine in the time available.

### Listening (human ear)

- **NOT VERIFIED.** No human listening was performed in this session.
- The repository already treats listening as a first-class, honestly-recorded state:
  `src/intent/semantics/param-registry.ts` carries a `listening: "pending" | "done"` field per
  capability, and `pending` is explicitly _not_ a pass. That is the right shape and it is
  preserved here — this report does not upgrade any listening claim.

### Gaps in coverage (found, not filled)

- No test asserts that **deleting a clip** leaves no dangling reference (`referential-integrity`
  covers tracks, returns, patterns and effects, not clips).
- No test asserts the **absence of a dangling reference after undo** in general — the delete-track
  case is now pinned, but the class is not audited mechanically (see R-05).
- No test covers the **three browser engines** in CI on every push.

---

## 7. TOP 10 prioritized hardening recommendations

Ranked by impact × likelihood × detectability, weighted toward audio corruption, data loss,
silent mismatches and false AI success.

| #        | Recommendation                                                                                                                                                         | Sev | Why it is ranked here                                                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R-01** | **Derive the intent effect word table from the capability matrix** instead of maintaining it as a fourth vocabulary                                                    | P1  | Kills F-01 and F-02 at the root. Today "distortion" and "sv filter" mean different effects depending on the surface, and the intent layer disagrees with itself. One owner, one answer. |
| **R-02** | **Give `kyx_intent`'s `paramIntent` branch the same read-back** the other branches have, and extract one shared `verifiedMutation` helper across the 38 tools          | P1  | F-06/F-10: an AI action is currently _reported as applied_ without its state being verified. This is the "false AI success" class the system cannot afford.                             |
| **R-03** | **Make "cross-references held by other entities" mechanically enforced**: a guard that fails when `normalizeProject` prunes anything the command's delta did not carry | P1  | The same class has now bitten twice (sidechain/MIDI, take lanes/Live Sets). A mechanical rule ends the class; a per-case fix does not.                                                  |
| **R-04** | **Unify the track-gain domain**: route the AI bridge through `setTrackParams` so one clamp owns it                                                                     | P2  | F-05: a document can currently hold a gain no other surface can set or display.                                                                                                         |
| **R-05** | **Make the intent bar's failure surface uniform**: one helper every branch uses, so no branch can be a silent no-op                                                    | P2  | The effect branch was a silent no-op (fixed here); the same shape can recur in any new branch.                                                                                          |
| **R-06** | **Either teach `kyx_plugin_param` the deep params** (`eq.band3.gainDb`) **or make its description honest**                                                             | P2  | F-08: the tool's contract and its capability disagree; the AI reasons from the description.                                                                                             |
| **R-07** | **Make the model context's offered roles exactly the model's own enum**                                                                                                | P2  | F-09: the context marks an action supported that the model cannot express — a silent dead end for the AI.                                                                               |
| **R-08** | **Filter `deprecated` params out of the MCP catalog** and de-duplicate the eq alias table                                                                              | P3  | F-11: two alias truths that agree today and would not be caught when they stop agreeing.                                                                                                |
| **R-09** | **One conversion owner for dB→linear**, with the eight call sites delegating to it, and extend the range sweep to ultina/ozvena/morphdynamics                          | P3  | F-13: the copies agree today; a single owner plus a sweep makes that structural instead of lucky.                                                                                       |
| **R-10** | **Delete the scratch diagnostic spec, and pay the DAW JS budget back** (the tightening trigger has fired)                                                              | P3  | F-14 plus the budget note: the ceiling was raised with a measured justification, and the note now states that the next growth must offset rather than raise again.                      |

---

## 8. Architecture evolution opportunities

Non-blocking, ordered by leverage. None of these is required for the fixes above.

1. **Make the normalizer a pure projection of the command's intent.** The deepest structural
   improvement available: if `normalizeProject` were only allowed to _canonicalize_ (clamp, dedupe,
   fill defaults) and never to _remove_ an entity the command left in place, the whole class in
   §4.3 and §4.4 would disappear rather than needing a per-case fix. Today the normalizer is
   allowed to prune, and that is where the undo-delta seam lives.
2. **One verification helper for all 38 MCP tools.** The read-back pattern is already correct in
   `kyx_plugin_param`; it is hand-rolled per tool. A shared helper would make "the tool reports
   the state it produced" a property of the framework rather than of each tool.
3. **Derive the intent vocabularies from one capability matrix.** The model vocab, the knob map,
   the word table and the capability matrix are four views of the same facts; R-01 is the first
   cut of merging them.
4. **Let the engine own the plugin lifecycle contract.** The containment invariant is now pinned
   at all 14 call sites, but each site still has its own `callRuntime` guard — a single
   "runtime lifecycle" abstraction (register → project → tear down) would make the next call site
   impossible to get wrong by construction.
5. **Make the effect param surface addressable by one path.** Rack params and deep params
   (`eq.band3.gainDb`) are addressed differently by the catalog, the command and the UI; one
   addressing scheme would close F-08 and simplify the AI's job.

---

## 9. Release confidence and blockers

**Green and verified on `origin/main` (`15bef819`)**

- `npm run typecheck:clean` → exit 0
- `npm run format:check` → exit 0
- `npm run build` → exit 0, every size budget green
- The plugin-runtime containment invariant at **14/14** call sites, each revert-proven
- The three new specs, each falsified before its fix and green after
- The regression surfaces named in §4

**Not green, or not verified — stated plainly**

1. **Two P1 surface drifts are still open** (F-01, F-02). Until they are closed, the Intent Engine
   and the MCP server can disagree about _which effect_ a request means. That is the single
   biggest gap to "one system, multiple control surfaces".
2. **An AI action can still be reported without verification** (F-06). The MCP plugin-param path
   is honest; the `kyx_intent` param branch is not.
3. **The full suite was not re-run to zero-red on the final tip.** The last complete run was on an
   earlier tip (9 red files / 19 tests, of which 12 were load-induced and 2 were real and are now
   fixed by the peer wave and by this session). On the final tip the previously-red files were
   re-run individually (305/305) and the gates were run, but the whole 13k suite was not repeated.
4. **12 load-induced failures remain** across 6 files. They pass in isolation; they are a
   test-suite isolation problem, and fixing them means a per-file timeout/isolation policy
   decision, not a code change.
5. **Firefox and WebKit are NOT VERIFIED** in this session.
6. **No human listening.** The claim "the mix sounds right" is not made anywhere in this report.
7. **The DAW JS ceiling was raised** (5560 → 5630) with a measured justification in
   `scripts/check-bundle-size.mjs`; the tightening trigger has fired and the next growth must pay
   it back.
8. **A parallel agent session is landing a large wave** into the same tree (intent semantics,
   clip-edit matrices, contract wave). `main` can go red again between this report and the next
   commit; the verification above was taken on the tree as it stood at `15bef819`.

**Honest summary.** The system is architecturally sound, its state ownership is single and
correct, and its invariants are unusually well pinned — for a browser DAW of this scope that is
the hard part, and it is done. It is **not yet** a dependable _integrated professional_ system in
the sense the directive asks for, because three of the four remaining P1/P2 items live in the layer
that no unit test can prove: whether the three surfaces agree on what the user meant. That layer
now has an honest map of its gaps, a ranked list, and three of its members fixed.

---

## 10. Next safe iteration

Five tightly scoped tasks, in order. Each is independently shippable and independently
falsifiable.

1. **Derive the effect word table from the capability matrix** (R-01). Touch
   `src/intent/effect-words.ts` and the capability registry only. Add one spec per affected word
   (`distortion`, `sv filter`) asserting that the Intent Engine, the MCP tool and the registry
   name the same effect. _Risk: low. The registry is the source; nothing else moves._
2. **Give `kyx_intent`'s `paramIntent` branch a read-back** and extract the shared
   `verifiedMutation` helper (R-02). Assert that a param intent reports the value that actually
   landed, and that a no-op reports no-op rather than "one undo step". _Risk: low — the pattern
   already exists in `kyx_plugin_param`._
3. **Add the mechanical "normalize must not prune what the delta does not carry" guard** (R-03).
   A spec that deletes a track and asserts that every field the post-apply normalizer touched is
   carried by the undo delta. This is the class-ending guard, and it would have caught §4.3
   before it shipped. _Risk: low; it is a test._
4. **Route the AI bridge's track-gain write through the command layer** (R-04) so one clamp owns
   the domain, with a spec that the bridge cannot produce a gain above the command's ceiling.
   _Risk: low; the clamp is already defined in `src/commands/master.ts`._
5. **Clean the release blockers**: delete the scratch diagnostic spec, and run the browser
   verifier across Chromium + Firefox + WebKit in isolation, with no concurrent session load, to
   replace "410/428 under load" with a clean three-engine number. _Risk: none — measurement only._

**One register row left on the table, deliberately.** The three truths fixed in §4 belong in the
invariant register (`docs/AGENT-MAP.md` §3) next to their guards — that register is where the next
agent learns them. The file was being edited by a parallel session at the time of writing, so the
rows are left for its owner rather than clobbered. The three guards are:

| Invariant                                                                                                                                                 | Guard                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| A type-level effect remove needs no primary knob — the knob is required only where the knob is the thing that moves                                       | `tests/effect-intent-remove-without-knob.test.ts`   |
| A relative dB ask is only ever applied to a dB knob; the absolute and the relative path refuse the same asks                                              | `tests/param-intent-relative-db-unit-guard.test.ts` |
| Cross-references held by other entities (take lanes, Live Set routing, drum step metadata) are removed INSIDE the command, so the undo delta carries them | `tests/delete-track-undo-cross-references.test.ts`  |
