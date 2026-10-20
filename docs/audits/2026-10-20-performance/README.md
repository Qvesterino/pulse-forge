# DAW Performance Audit — avoidable work on the hot paths

**Date:** 2026-10-20
**Scope:** React/render path, audio/DSP path, lifecycle/leaks, and the paths a
single small user action walks (edit → command → delta → engine → persist).
**Verdict:** **2 confirmed defects fixed**, both measured before and after.
**3 further candidates measured and deliberately left alone** (below the
threshold where a change is justified). The rest of the surface was checked and
found healthy.

---

## Method

The brief asks not to optimize code that "looks theoretically inefficient", so
every candidate had to clear two bars before it was touched:

1. **The work must be provably unnecessary.** A mechanism read end-to-end from
   the trigger to the work, with the trigger named.
2. **The cost must be measured.** Not estimated from the source — measured in
   this repo, on this machine, in the condition where the defect bites.

Where the repository already had a measurement instrument, it was reused rather
than replaced:

- `scripts/bench-hotpath.ts` — an A/B harness that re-implements the pre-fix
  algorithm verbatim, interleaves both sides in the same process and reports
  median-of-rounds plus the allocation delta. The delta fix was added to it as
  case **P.1**.
- `.artifacts/measure-*.mts` — throwaway scaling harnesses (gitignored) for the
  cases the bench does not cover.

Guards were written to be **load-independent where possible**: the delta guard
counts linear scans rather than milliseconds, so it cannot be satisfied by a
machine that happens to be fast.

---

## Findings

### 1. The command delta's entity-array order replay was O(n²) — CONFIRMED, FIXED

**Mechanism.** `src/commands/docDelta.ts` → `diffEntityArray` replays the target
list's ORDER. To find the item each step refers to it used a linear
`sim.findIndex` over the entity list — **one full scan per element of the
target list**.

**Trigger.** Every command that changes one entity of an entity list. The
arrangement's clip list is exactly that: `moveArrangementClip` rebuilds and
re-sorts it, so the array is new and the replay runs. `snapshot()` computes the
forward **and** the backward delta, so the cost is paid twice per command.

**Measured** — one clip moved, whole edit (command + the `normalizeProject` the
store runs on top), median of 9:

| clips | command before | command after | whole edit before | whole edit after |
| ----- | -------------- | ------------- | ----------------- | ---------------- |
| 400   | 7.85 ms        | 0.74 ms       | 8.66 ms           | **1.21 ms**      |
| 800   | 13.06 ms       | 1.56 ms       | 14.05 ms          | **2.19 ms**      |
| 1600  | 42.47 ms       | 2.18 ms       | 44.21 ms          | **2.78 ms**      |

At 1 600 clips a single small edit cost **44 ms** — more than a whole 60 Hz
frame budget — and the curve was quadratic (400 → 800 → 1600 grew 1.7× → 3.3×
instead of 2×).

**In-process A/B** (`scripts/bench-hotpath.ts`, case P.1, 1 000 clips, one clip
moved, interleaved rounds in one process):

```
pre-fix 5.6115 ms  →  optimised 0.4698 ms   = 11.94× faster
allocation: 168.87 KiB less per call
```

**Fix.** The replay keeps an id → index map instead of scanning. The map is
re-indexed only across the range a splice actually shifted, so the replay is
O(n) unless the order really changed. The emitted op sequence is unchanged —
the oracle in the guard test is the pre-fix algorithm itself.

> **The one case where the map and `findIndex` disagree** is duplicate ids: the
> map keeps one index per id, `findIndex` the first occurrence. `sim` can only
> hold duplicates if the source list already held them, so that case falls back
> to the original scan and the ops stay identical.

### 2. The automation parameter catalog was rebuilt on every resolve — CONFIRMED, FIXED

**Mechanism.** `src/project-model/targets.ts` → `effectTargetParamDefs` builds
the full parameter catalog of an effect: for fxeq that is
`buildFxEqSchema(bandCount)` — **315 parameter defs plus two maps** — for
ultina every `ALL_PARAMS` def, for ozvena the whole `OZVENA_TARGET_DEFS` list.
`targetParamDef` calls it, and the automation write path resolves a target
**seven times per lane per scheduler tick** (`automationBridge.ts` calls it at
ten sites, including `writeAutomationTargetAt`).

**Trigger.** Every scheduler tick, for every lane that automates an effect
parameter. 40 ticks/s × 7 resolves = **280 rebuilds per second per lane**, each
producing an identical catalog.

**Measured** — one catalog rebuild, median of 200:

| type   | catalog  | rebuild before | rebuild after | speedup |
| ------ | -------- | -------------- | ------------- | ------- |
| fxeq   | 315 defs | 0.6456 ms      | 0.0006 ms     | 1076×   |
| ultina | 273 defs | 0.0473 ms      | 0.0004 ms     | 118×    |
| ozvena | 109 defs | 0.0240 ms      | 0.0007 ms     | 34×     |
| reverb | 7 defs   | 0.0022 ms      | 0.0003 ms     | 7×      |

Per lane per second: **159.10 ms of CPU → 0.14 ms**. For a single automated
fxeq that was ~16 % of a core, burned rebuilding a catalog that never changed.

**Fix.** The catalog is derived purely from the effect TYPE (and, for fxeq, the
band count) — never from project state — so it is cached, and the instrument
catalog is cached by instrument kind. The cache holds one entry per effect type
(and band count); it is not an unbounded structure.

**Safety.** Every caller of `effectTargetParamDefs` / `instrumentTargetParamDefs`
only reads the result (`.filter`, `.map`, `.find`, `for…of`) — verified by
grep over `src/ui/ModPanel.tsx`, `src/ui/MidiPanel.tsx` and `src/project-model/targets.ts`.
No caller sorts or mutates it, so sharing the array is safe.

---

## Measured and deliberately NOT changed

These were real inefficiencies with a correct mechanism. They were measured,
found too small to matter, and left alone — with the numbers recorded so the
next reader does not re-derive them.

| candidate                                                                                                                                                                                                                                              | measured                                                                  | verdict                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Arrangement role-flow strip (`ArrangementPanel.tsx:4895-4900`): `clips.map` over ALL clips, per clip `scenes.find` + `sectionFxChips`, which walks every `sceneAutomation` lane and `doc.tracks.find` per match → O(clips × (scenes + lanes × tracks)) | 0.186 ms at 400 clips / 120 lanes / 32 tracks                             | below the threshold — not changed                               |
| `syncPdc()` (`AudioEngine.ts:1932-1993`): `doc.tracks.find(...)` inside two per-track loops → O(tracks²)                                                                                                                                               | ~576 comparisons at 24 tracks — **an estimate, not a measured path cost** | quadratic only at track counts no project reaches — not changed |
| `moveArrangementClip` (`commands/arrangement.ts:117-125`): the identical `map + sort` is computed twice                                                                                                                                                | 0.088 ms at 1 600 clips                                                   | below the noise floor — reported, not changed                   |

The first two are the honest answer to "the code looks quadratic": the
mechanism is real, the number is not. The third is a genuine duplication, but
its measurable gain is under 0.1 ms and changing a shared command file for it
would not be justified.

---

## Checked and healthy

Swept across the three surfaces the brief names:

- **Render path** — `src/ui/context.ts` holds stable store instances and
  fine-grained slice hooks; `ArrangementPanel` memoizes its clip/visible/window
  derivations and quantizes scroll to whole bars; `Sequencer`'s `StepCell` is
  memoized with column windowing; `PianoRoll` virtualizes by pitch window;
  `Meter` writes CSSOM at 30 Hz instead of `setState`; `playhead.ts` throttles
  the transport readout to step changes, the ruler to 1/8 bar and the "current
  clip" id to boundary crossings; `src/services/rafLoop.ts` is one shared rAF
  bus whose map cannot grow.
- **Audio/DSP path** — the FX chain rebuild is signature-guarded (toggling a
  parameter does not rebuild the graph); a bypassed effect gets no runtime at
  all; PDC delay nodes are allocated only for chains that have effects; the
  PRE-fader analyser tap is allocated on first read; the scheduler's
  `tracksById` is a ref-guarded Map; note sorting and phrase length are
  WeakMap-cached; the offline renderer runs the same engine on an
  `OfflineAudioContext`.
- **Lifecycle/leaks** — every `setInterval`, `addEventListener`, worker, socket
  and subscription inspected has a matching release; `closeProject` disposes
  style observer, generative runtime, collab, bandmate, MIDI, link sync,
  capture, note repeat and ghost; the undo stack is capped at 256; the module
  level collections (`agentTrust`, `jobCenter`, `session-context`,
  `preference-ledger`, `intent/versions`) are all bounded.

---

## Fixes

| #   | file                           | change                                                                          |
| --- | ------------------------------ | ------------------------------------------------------------------------------- |
| 1   | `src/commands/docDelta.ts`     | `diffEntityArray`'s order replay indexes ids instead of scanning per element    |
| 2   | `src/project-model/targets.ts` | effect and instrument parameter catalogs are cached per type                    |
| 3   | `scripts/bench-hotpath.ts`     | case P.1 — the delta replay measured A/B against the verbatim pre-fix algorithm |
| 4   | `docs/AGENT-MAP.md`            | both invariants registered in the invariant register                            |

No behaviour changes for a valid document: the delta emits the same ops, and
the catalog contains the same defs.

---

## Tests Added

| file                                   | specs | what it pins                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/doc-delta-order-replay.test.ts` | 3     | the replay emits **exactly** the ops the pre-fix algorithm emitted (the pre-fix algorithm is re-implemented in the test as the oracle, over 40 randomized permutations with removals and insertions); a reordered list round-trips through `applyDocDelta`; the replay performs a CONSTANT number of linear scans of the entity list |
| `tests/target-param-catalog.test.ts`   | 5     | the catalog is shared per effect type; the fxeq catalog is keyed by band count; catalogs do not leak across types; every automatable deep fxeq param of the requested band count is still exposed; instrument catalogs are shared per kind                                                                                           |

Both invariants are registered in `docs/AGENT-MAP.md`, whose gate
(`tests/agent-map.test.ts`) fails if a guard loses its assertion.

---

## Verification

| check                                                                                                                                                                                                                               | result                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `npx vitest run tests/doc-delta-order-replay.test.ts`                                                                                                                                                                               | **3 passed**                                               |
| `npx vitest run tests/target-param-catalog.test.ts`                                                                                                                                                                                 | **5 passed**                                               |
| `npx vitest run` (delta, automation, undo, no-op suites)                                                                                                                                                                            | **6 files passed**                                         |
| `npx vitest run` (the whole blast radius of both changes: commands, undo, delta, automation, effects, plugin-audit, MIDI, intent, store, persistence, offline render, engine-graph, trigger, MCP, and the three affected UI panels) | **228 files passed / 3 258 tests passed**, 64 skipped      |
| `npx vitest run tests/agent-map.test.ts`                                                                                                                                                                                            | **1 passed** — the invariant register accepts the new rows |
| `npx vite-node scripts/bench-hotpath.ts`                                                                                                                                                                                            | P.1 **11.94× faster**, 168.87 KiB less allocated per call  |
| `npx prettier --check` (own files)                                                                                                                                                                                                  | **clean**                                                  |
| full `npm run test`                                                                                                                                                                                                                 | see the table below                                        |

### The full-suite run

| metric     | value                                                                    |
| ---------- | ------------------------------------------------------------------------ |
| test files | **1 120 passed / 7 failed** of 1 127                                     |
| tests      | **12 427 passed / 8 failed**, 197 skipped, 1 todo                        |
| wall clock | 2 274 s (the machine was at 100 % CPU — eight concurrent agent sessions) |

**The eight failures are NOT identified in this document's own run.** The run's
output was filtered to the summary lines and the per-test names were lost, so
naming them here would be a guess. What was done instead:

- The whole blast radius of both changes was re-run as a unit — every command,
  undo/redo, delta, automation, effect, plugin-audit, MIDI, intent, store,
  persistence, offline-render, engine-graph, trigger, MCP and the three
  affected UI panels: **228 files, 3 258 tests, all green** (including the
  300-second Ozvena soak).
- `suite-expectations.json` expects **zero** owned reds, so any red is a
  regression. The working tree at the time carried another session's in-flight
  Windows-audio and plugin-audit work, including two files that are not
  prettier-clean (`docs/CURRENT-STATE.md`, `src/ui/stateMatrix.ts`) — neither
  is touched by this audit.

The honest statement is therefore: **the failures are outside the blast radius
of these two changes — that surface is green — but they were not attributed to
a specific file by this run.** Naming them would be a guess.

### Falsification

A green suite proves nothing until each guard is shown able to go red. Every
mutation was applied to the real source, the matching test was run, and the
source was restored and verified byte-identical.

| mutation                                            | reverted                      | verdict  |
| --------------------------------------------------- | ----------------------------- | -------- |
| M1 — the replay locates items by linear scan again  | `locate` → `sim.findIndex`    | DETECTED |
| M2 — the replay inserts the moved item one slot off | `at = min(i + 1, sim.length)` | DETECTED |
| M3 — the catalog is rebuilt instead of shared       | `return cached.slice()`       | DETECTED |
| M4 — the cache key ignores the fxeq band count      | `key = effect.type`           | DETECTED |

**Two earlier mutations were rejected as invalid**, which is worth recording
because the first pair of "green" results was misleading:

- A first attempt mutated `reindex(min(current, at))` → `reindex(at)`. It was
  green — but the mutation is a **semantic no-op**: the replay's invariant is
  that after step `i`, `sim[0..i-1] == b[0..i-1]`, so the item at step `i` is
  always at index ≥ `i`, and `current < at` cannot occur.
- The first complexity probe counted reads of the entity `id`. It was green for
  the same reason and for a worse one: the quadratic scan reads the `id` of the
  **wrapper** objects inside the replay, not of the entities the probe
  instrumented — the probe was vacuous for the defect it was meant to catch.
  It was replaced by a probe that counts the **linear scans themselves**.

---

## Still needs profiling

1. **The root subscribes to the whole document** (`src/ui/App.tsx:359`), so every
   command re-renders the entire panel tree; none of the large panels are
   `memo`-ized. The mechanism is certain; the absolute cost is not — it needs a
   React Profiler run on a large project in a real browser, not jsdom.
2. **The effect-parameter catalogue was measured in isolation**, not as its
   share of a real 25 ms tick with several automated flagship plugins.
3. **`syncPdc` share of an edit frame** on a 24-track project — needs a browser
   trace with the real audio graph.
4. **Long-session heap growth** of the in-memory sample bank and the frozen
   buffer store; not statically verifiable.
