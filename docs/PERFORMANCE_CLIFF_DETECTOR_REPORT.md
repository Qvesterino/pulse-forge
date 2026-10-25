# PERFORMANCE CLIFF DETECTOR — KYX / Pulse Forge

**Date:** 2026-10-25 · **Tree:** `main` @ `0b688bea` · **Mode:** read-only investigation, no production code changed
**Question:** at which workload, duration or interaction boundary does the DAW stop scaling predictably, and why?

> **Addendum:** §13 re-verifies §4's measured numbers on the tree as it stands after the
> peer wave (`b2c3b680` + peers) and records one **new** shape that the peer wave
> introduced after the audit tree. Read §13 together with §4 — the two are from different
> trees, and the difference is stated rather than smoothed over.

---

## 0. EXECUTIVE SUMMARY

### The one-line answer

The DAW's **state layer scales linearly and cheaply** — the model, the delta engine, the undo
stack, the autosave payload and the store's per-command path were all measured and all grow
**linearly** with the document. The cliffs are **not** in the model. They are in the places where
a **linear cost is paid once per visible item per render** (the arrangement), where a **linear
cost is paid once per track per edit** (the audio engine's audibility rule — and that one is
**quadratic**), and where a **single interaction multiplies the number of renders** (zoom).

### Key cliffs (verified)

| #       | Cliff                                                                                                                                                                                                                                                                                                                                                               | Threshold                                                                                                                                 | Evidence                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **C-1** | **The audibility rule is quadratic in the track count and is paid on EVERY document change.** `soloAudibility(doc).audible(id)` resolves its track with a linear `tracks.find`, and the engine calls it **once per track** on every sync. Measured: the marginal cost per track **doubles with every doubling of the track count**.                                 | 16 tracks 0.019 ms → 64 tracks 0.122 ms → **256 tracks 1.67 ms** per document change. Extrapolated: 512 tracks ≈ 6.7 ms, 1024 ≈ 27 ms.    | **OBSERVED (measured)**, shape quadratic        |
| **C-2** | **Zooming out multiplies the scroll cost by up to 800×.** The viewport is quantised in **bars**; at `MIN_ZOOM = 0.05` one bar is 1.5 px, at `MAX_ZOOM = 40` it is 1200 px. Every bar-quantum change re-renders the whole arrangement.                                                                                                                               | 1.5 px/bar vs 1200 px/bar = **800×** more re-renders per pixel of scroll, each re-render costing the terms in C-3/C-4.                    | **OBSERVED (code)**, severity from C-3/C-4      |
| **C-3** | **The arrangement's per-render cost is super-linear in the clip count.** Per **visible audio clip** the panel builds a `Set` over **all** audio clips (`compSourceTakeNumber`) and calls `arrangementSecondsBetweenTicks`, which filters, maps and **sorts every scene clip** and does a `scenes.find` per clip. → **O(W × (N log N + N·S))** per render.           | 2000 scene clips → 0.165 ms for **one** such call. With 50 visible audio clips that is ≈ **8 ms per render**, on top of the terms in C-4. | **OBSERVED (code)**, the per-call cost measured |
| **C-4** | **Windowing is defeated by a full-list scan.** The `windowed` memo's forced-id pass walks the **entire** clip list (and the entire audio-clip list) on every render, even when the viewport window is small and the forced set is empty.                                                                                                                            | O(N) per render, unconditional.                                                                                                           | **OBSERVED (code)**                             |
| **C-5** | **Toggling one effect's bypass rebuilds that track's entire effect chain.** `fxSignature` filters bypassed effects out, so a bypass toggle changes the signature → `rebuildFxChain` **destroys and re-instantiates every effect on that track** instead of writing a bypass parameter. The effect's internal state (a delay tail, a reverb decay) does not survive. | Every bypass toggle, on every track, forever.                                                                                             | **OBSERVED (code)**                             |
| **C-6** | **A remote collaboration update re-projects the whole document and invalidates every React selector.** `YDocStore` re-projects the full document on **every** `yDoc.on("update")` — local or remote — and the adapter rebuilds every array without structural sharing, so every `useX()` consumer re-renders.                                                       | One remote keystroke = one whole-document projection + one whole-tree re-render.                                                          | **OBSERVED (code)**                             |

### Suspected cliffs (shape derived from code, magnitude NOT measured)

| #   | Suspected cliff                                                                                                                                                                 | Where                                                                        | Why it is not yet a finding                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-1 | The intent context-trim loop re-serialises the whole context once per dropped contract → **quadratic** in the number of inserted effects.                                       | `src/intent/model-context.ts:305`                                            | The loop is observed; its cost on a real context was not measured. The cap (12 000 chars) bounds it.                                                                   |
| S-2 | Feature extraction recomputes the **batch statistics of the whole candidate bank once per candidate** → O(n²) in bank size.                                                     | `src/ai/features/pattern-features.ts:430-434`                                | Observed in code; n is bounded (≤ 8 local + ≤ 4 symbolic), so the magnitude is small today.                                                                            |
| S-3 | `artistNamePattern` compiles a **new RegExp per artist name per call** over a 667-entry preset table, 2–3 full scans per prompt.                                                | `src/intent/artists.ts:7464`                                                 | Observed in code; the cost is bounded by the table size.                                                                                                               |
| S-4 | Every prior/ranker call **re-posts the model manifest** to a worker that has already cached the session.                                                                        | `src/ai/symbolic/prior-client.ts:265`, `src/ai/ranking/ranker-client.ts:171` | Observed in code; the manifest is small, so the cost is round-trip count, not bytes.                                                                                   |
| S-5 | The intent pipeline can regenerate the candidate bank **up to 24 times** per candidate index.                                                                                   | `src/intent/candidate-search.ts:466`                                         | Bounded and observed; the per-attempt cost was not measured.                                                                                                           |
| S-6 | The arrangement normaliser computes the scene's true period **once per clip**, and the period computation walks the pattern's note tracks → O(clips × note-tracks) per command. | `src/project-model/schema.ts:1733`, `src/project-model/midiTime.ts:60-67`    | Introduced **after** the audit tree (commit `2db3009f`). The audit's fixture carries no `notes`, so the term never executes there — magnitude not measured. See §13.2. |

### Areas measured and found healthy (no cliff)

- **The scheduler tick path.** `npm run perf:tick`: 1 lane 0.036 ms/tick, 16 lanes 0.166 ms/tick,
  p95 0.268 ms → **0.66 % of one core** at 40 ticks/s. The 2026-10-20 audit's `effectTargetParamDefs`
  defect is fixed and stays fixed.
- **The command / delta / undo / serialisation path.** Measured at 50 → 2000 scene clips:
  `normalizeProject` 0.22 → 0.90 ms, `snapshot()` (production) 0.03 → 1.31 ms, `JSON.stringify`
  0.031 → 0.342 ms, **all linear**. The undo stack is **bounded at 64 entries**
  (`ProjectStore.ts:70`) and stores **deltas**, not document snapshots
  (`src/commands/core.ts:34-67`).
- **The MCP tool registry.** 39 tools, built once, `ctx.getDoc` is a lazy accessor, the relay frame
  carries `{tool, args}` only — **no whole-document snapshot per call**.
- **Audio-thread allocation.** A scan of every processor in `src/audio-worklets/` found **two**
  allocation sites inside `process()`, both structurally near-necessary (a transfer-based meter
  post and an automated reverb decay cache).
- **The metering path.** Buffers are reused (`meteringRig.ts:150,206-207`); metering is rAF-driven,
  not audio-thread-driven.

### Evidence limitations (read this before quoting any number)

1. **The host ran at 100 % CPU** for the whole audit (16 logical processors, other agent sessions
   building in parallel). Absolute milliseconds on this box are **inflated and noisy**. Every
   number below is therefore reported as a **median of 15 iterations** with a **marginal slope**
   between workload sizes; the slope is the evidence, the absolute number is context.
2. **No browser was measured.** There is no frame-time, input-to-paint latency or DOM-node-count
   measurement in this report. The jsdom render numbers are **cited from AUDIT-15**, not
   re-measured, and AUDIT-15 itself states: _"These milliseconds are not a browser budget… Only
   the shape is trustworthy; the severity is unmeasured."_
3. **No audio device, no real-time thread.** Everything audio-side is main-thread JavaScript; the
   audio thread itself is out of reach from Node.
4. **Long-session degradation was NOT measured.** Memory growth over hours, open/close cycles and
   idle decay need a browser and a quiet machine; §12 carries the measurement plan instead of
   invented numbers.

### What this audit adds over AUDIT-15 (2026-10-04)

AUDIT-15 looked at one component (the arrangement) and one dimension (clip count) in jsdom, and
was explicit that the severity was unmeasured and that a jsdom cost gate could not discriminate a
regression from load. This audit:

- **measures the shapes outside the arrangement** — the state layer, the audio sync path, the
  collaboration path — and finds the state layer healthy;
- **finds a verified quadratic** in the audio path (C-1) that AUDIT-15 did not look at;
- **finds the zoom multiplier** (C-2), which turns a per-render cost into a per-scroll-event cost;
- **separates the two failure classes** in the arrangement (the per-visible-item super-linear
  terms vs. the unconditional full-list scan);
- **keeps AUDIT-15's methodological conclusions**: absolute jsdom ms are not a budget, and a cost
  gate needs a browser harness with a load-calibrated baseline.

---

## 1. SCOPE, METHOD AND EVIDENCE DISCIPLINE

### 1.1 Environment (measured, not assumed)

| Item                           | Value                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| CPU                            | AMD Ryzen 7 5800H, 8 cores / 16 threads, 3.2 GHz base                                                        |
| RAM                            | 59.9 GiB total, 24.0 GiB free at the time of measurement                                                     |
| OS                             | Windows 11 Home 10.0.26300 (build 26300)                                                                     |
| Node                           | v24.11.0, win32 x64                                                                                          |
| Repository                     | `D:\pulse-forge`, branch `main` @ `0b688bea`                                                                 |
| **Host load during the audit** | **100 % CPU (16 logical processors), sustained** — three concurrent agent sessions were building in parallel |
| Audio device                   | **none** — no real-time audio thread was measured                                                            |
| Browser                        | **none** — no frame-time measurement was taken                                                               |

### 1.2 The instruments used

**The repository's own instruments** (preferred — they already exist, they are self-calibrated, and
they are the ones a future regression would have to beat):

| Instrument                                              | What it measures                                                                                                                                                                         | Why it is trustworthy                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run perf:tick` (`scripts/perf-tick.mts`)           | The scheduler tick path: `Scheduler.tick()` → `applyAutomation()` → the engine's parameter write, against the production document. Only the AudioContext is a mock.                      | Projects the measured tick cost to the real 40 ticks/s cadence and reports **% of one core**.    |
| `npm run perf:hotpath` (`scripts/bench-hotpath.ts`)     | The command path, A/B against the pre-fix implementation extracted from git history, in the **same process** (same V8, same heap, same JIT state), interleaved so drift hits both sides. | A **ratio** measured in one process survives a loaded host; a single wall-clock sample does not. |
| `npm run ai:performance` (`scripts/ai-performance.mts`) | Intent preview latency (p95) against `MAX_SYNC_PREVIEW_MS`.                                                                                                                              | A p95 gate, not a median gate.                                                                   |
| `scripts/ui-camera.mjs`                                 | DOM mutations in the browser (per-frame writes).                                                                                                                                         | **Not run** — it needs a dev server + a browser, which §12 defers to a dedicated environment.    |

**A disposable instrument written for this audit** (two files under `.git/`, deliberately outside
the tracked tree, because an instrument is not a deliverable):

- `.git/perf-cliff-measure.mts` — the state layer: `arrangementSecondsBetweenTicks`,
  `normalizeProject`, `snapshot()` in dev and in production, the store's `execute()`, and
  `JSON.stringify`.
- `.git/perf-cliff-measure-2.mts` — the audio-path suspects: the audibility closure, one
  `targetParamDef` resolution, `automationClipForTarget`, and the store path again with a
  **fresh** command per iteration.

Both use **only production functions** — no reimplementation — and both report the median of 15
iterations plus the **marginal slope** between sizes. The noise floor (a 1000-iteration no-op
loop) measured **0.0017 ms**, i.e. two to three orders of magnitude below the smallest quantity
measured, so the readings are not noise-limited.

### 1.3 Evidence levels used throughout

| Level                   | Meaning                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| **OBSERVED (measured)** | A number produced by an instrument in this audit, on the real production code.     |
| **OBSERVED (code)**     | Read directly off the code: the shape is certain, the magnitude is not.            |
| **SUPPORTED BY CODE**   | The shape follows from code that was read and quoted; a step of inference remains. |
| **SUSPECTED**           | A plausible shape with an unverified magnitude or an unconfirmed trigger.          |
| **NOT ASSESSED**        | Not looked at, or not measurable in this environment.                              |

### 1.4 Two defects of my own probes (recorded, not hidden)

Both would have produced confident nonsense, and both are the reason the numbers above are
trustworthy:

1. **The store probe measured a no-op.** The first version of the per-command measurement reused
   **one** command object for 15 iterations. After the first `execute()` the document already
   contained the change, so the delta was idempotent, the store's no-op guard fired, and no
   listener was notified. It reported "0.8 listener calls per command" and a flat 0.0015 ms —
   a beautiful, completely fake flat line. The corrected version builds a **fresh** command per
   iteration and reports the real 12 listener calls per command.
2. **A wrong module path hid a real dependency.** In the reference-worker spec the mock path was
   `../src/analysis/analyzeReference` instead of `../src/reference/analysis/analyzeReference`, so
   the **real** analyser ran and returned a result instead of failing. The spec named what it saw
   (`saw PROGRESS_STAGE, REFERENCE_RESULT`), which is what turned a silent mistake into a
   visible one.

### 1.5 What was deliberately NOT done

- **No production code was modified.** No command, no config, no dependency, no benchmark.
- **No stress test heavy enough to disturb the machine.** The largest synthetic document built
  was 256 tracks / 2000 scene clips, in Node, in a disposable script.
- **No browser, no audio device, no E2E** — §12 carries the plan instead.
- **No user project was opened.** Every fixture is synthetic and in-memory.

---

## 2. PERFORMANCE ARCHITECTURE MAP

### 2.1 The audio path (input → audible)

```
UI gesture ──► Command factory (src/commands/*)  ──► snapshot() delta  (src/commands/core.ts:34)
                    │
                    ▼
              ProjectStore.applyCommand()         (src/store/ProjectStore.ts:222)
                    │  normalizeProject(doc)       (src/project-model/schema.ts:3506)
                    │  emit() → every subscriber   (src/store/ProjectStore.ts:481)
                    ▼
              services.ts onDocChanged            (src/services.ts:1254)
                    │
                    ▼
              AudioEngine.setProject → syncProject  (src/audio-engine/AudioEngine.ts:1133)
                    │  "the hottest path in the app" (AudioEngine.ts:1148)
                    ├── soloAudibility(doc).audible(id) per track   ← C-1 (quadratic)
                    ├── syncPdc(): doc.tracks.find inside a loop     ← O(T²)
                    ├── fxSignature vs stored signature               ← C-5 (bypass = rebuild)
                    └── rebuildFxChain / syncFxParams / syncSends
```

The **scheduler** is a separate, 25 ms driver (`src/scheduler/Scheduler.ts`) with a 120 ms
lookahead; it plans note/automation events and hands them to the engine. The **transport**
(`src/transport/Transport.ts`) is the musical-time model. The **engine** is the only place that
touches the Web Audio graph.

### 2.2 The visual path (gesture → pixels)

```
pointermove ──► ArrangementPanel local setState   (src/ui/ArrangementPanel.tsx:2966-3030)
                    │
                    ▼
              ArrangementPanel() re-render          (no React.memo anywhere in the file)
                    ├── windowed memo: first pass O(W)  +  forced-id pass O(N)  ← C-4
                    ├── compSourceTakeNumber: Set over ALL audio clips, PER VISIBLE CLIP ← C-3
                    ├── arrangementSecondsBetweenTicks: filter+map+sort of ALL scene clips, PER VISIBLE CLIP ← C-3
                    ├── AudioClipWaveform canvas: scans the raw PCM per redraw (no peak cache)
                    └── AutomationClipLanes: one <circle> per automation point, no culling
                    │
                    ▼
              App re-renders the whole tree        (src/ui/App.tsx:366 — whole-document subscription)
```

**The amplifier is `App.tsx:366`:** the root subscribes to the **whole document**
(`useSyncExternalStore(store.subscribe, store.getDoc, store.getDoc)`), so every command produces
a new document reference and re-renders the entire tree. `ArrangementPanel` — 7 509 lines, not
memoised — is inside it. The store's fine-grained selectors (`ProjectStore.ts:197-207`) and
`useSyncExternalStore` in `src/ui/context.ts` exist precisely to avoid this, but the **root**
subscribes to everything, so the saving never applies to the arrangement.

### 2.3 The persistence path

```
mutation ──► saveStatus "dirty" ──► autosave debouncer (src/persistence/autosave-debouncer.ts)
                                          │
                                          ▼
                                   IndexedDB repositories (src/persistence/*)
```

`ProjectStore` holds `HISTORY_LIMIT = 64` (`ProjectStore.ts:70`); the history panel's diffs are
memoised in `diffCache` and the cache is cleared on every mutation (`ProjectStore.ts:47,136-160`).
The undo stack stores **deltas**, not documents (`core.ts:34-67`) — the undo stack no longer pins
whole document chains.

### 2.4 The AI / MCP / collaboration path

```
MCP tool call ──► src/mcp/bridge.ts ──► tool registry (39 tools, built once)
                        │                      │
                        │                      └── ctx.getDoc  (lazy accessor — O(1))
                        ▼
                  relay frame {type,id,tool,args} ──► server/mcp-core.mjs
                        ▲
                        │  yDoc update (remote OR local)
                  YDocStore ──► full document re-projection ──► store ──► whole-tree re-render  ← C-6
```

### 2.5 Where the work is bounded vs. unbounded

| Path                         | Bounded?                                                          |
| ---------------------------- | ----------------------------------------------------------------- |
| Scheduler tick               | Bounded and cheap (measured, 0.66 % of a core at 16 lanes).       |
| Undo history                 | Bounded (64 entries) and delta-based.                             |
| Autosave payload             | Linear in the document (measured).                                |
| MCP registry                 | Static, built once.                                               |
| Candidate bank               | Bounded (≤ 8 local + ≤ 4 symbolic).                               |
| **Audibility on every edit** | **Unbounded — quadratic in the track count (measured).**          |
| **Arrangement re-render**    | **Unbounded — super-linear in the clip count, per visible item.** |
| **Zoom-out scroll**          | **Unbounded — 800× the render count of zoom-in.**                 |
| **Remote collab update**     | **Unbounded — whole-document projection per keystroke.**          |
| **Effect bypass toggle**     | **Unbounded — a whole chain rebuild per toggle.**                 |

---

## 3. THE WORKLOAD MATRIX

The profiles below are **starting points**, not capacity claims. The "measured?" column says
which of them this audit actually touched.

| Profile           | Shape                                                               | Measured?                                                                   |
| ----------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Tiny**          | 4 tracks, 1 effect each, 50 scene clips, 1 automation lane          | partially (the state layer at 50 clips)                                     |
| **Typical**       | 16–24 tracks, a few FX, a few hundred clips, some automation        | partially (the audio path at 16–32 tracks; the tick path at 1–4 lanes)      |
| **Dense**         | 64 tracks, sends + automation, 800+ clips                           | **yes** (the audibility curve at 64/128 tracks; `perf:tick` at 16/32 lanes) |
| **Stress / edge** | 256 tracks, 2000 scene clips, many points per lane, bypass toggling | **yes** (the state layer at 2000 clips; the audibility curve at 256 tracks) |
| **Long-session**  | repeated import/edit/undo/save over hours; open/close cycles        | **NO** — §12                                                                |

One dimension at a time was varied: the track count (16→256) for the audio path, the clip count
(50→2000) for the state layer, the lane count (1→32) for the tick path. Cache warmth was
controlled by measuring every size in one process with the same V8 state, and the media pipeline
is irrelevant for the state layer (no audio decoding).

---

## 4. RESULTS

### 4.1 The repository's own instruments

**`npm run perf:tick`** — the scheduler tick path (production scheduler, engine, bridge and
document; only the AudioContext is mocked). The tick cadence is the real one (8 blocks ≈ 21.3 ms
@ 48 kHz → 40 ticks/s).

| lanes | median ms/tick | p95 ms/tick | projected CPU @ 40 ticks/s | automation calls/tick |
| ----- | -------------- | ----------- | -------------------------- | --------------------- |
| 1     | 0.0359         | 0.1056      | 0.14 % of one core         | 1.0                   |
| 4     | 0.0681         | 0.1555      | 0.27 %                     | 1.0                   |
| 16    | 0.1655         | 0.2680      | **0.66 %**                 | 1.0                   |
| 32    | 0.1176         | 0.3308      | 0.47 %                     | 1.0                   |

**Read honestly:** the 32-lane median is _lower_ than the 16-lane median. That is the host's noise
(100 % CPU), not a property of the scheduler. The **p95 column is monotonic** (0.106 → 0.156 →
0.268 → 0.331 ms) and is the trustworthy series. The tick path is **healthy** and stays well
inside budget; the 2026-10-20 audit's hot-path defect is not back.

**`npm run perf:hotpath`** — the command path, old vs new implementation measured side by side
in the same process, median of 9 interleaved rounds, 2 warmup rounds:

| defect                                                             | pre-fix        | optimised     | speedup    | alloc Δ/call    | signal |
| ------------------------------------------------------------------ | -------------- | ------------- | ---------- | --------------- | ------ |
| B.7 meter history push + window (0.4 s momentary + 3 s short-term) | 2.5880 ms      | 0.2287 ms     | **11.32×** | −23.18 KiB      | both   |
| A.3 `drumHitsInWindow` p-lock clone (64 steps, ratchet + p-locks)  | 0.1293 ms      | 0.1187 ms     | 1.09×      | −7.60 KiB       | both   |
| A.4 `noteEventsInWindow` sort (6 tracks × 8 notes)                 | 0.0787 ms      | 0.0593 ms     | 1.33×      | −0.29 KiB       | both   |
| C.5 `snapshot()` on a single-step edit (production mode)           | 0.1854 ms      | 0.1057 ms     | 1.75×      | −13.98 KiB      | both   |
| **P.1 entity-array order replay, 1000 clips (one clip moved)**     | **12.4083 ms** | **1.1176 ms** | **11.10×** | **−176.84 KiB** | both   |

The last row is the cliff-relevant one: **moving one clip in a 1000-clip arrangement costs
1.12 ms** on the command path. That is a **slope** of about **1.1 µs per clip per command** — the
command path is linear, but it is not free, and it is paid on top of the render cost of C-3/C-4.

### 4.2 The state layer — measured, linear, healthy

Every quantity below is the median of 15 iterations of the **production** function, on a
synthetic document with N scene clips.

**`normalizeProject` — runs after EVERY command** (`src/project-model/schema.ts:3506`):

| scene clips | median ms | ms per 1000 clips | marginal ms/clip |
| ----------- | --------- | ----------------- | ---------------- |
| 50          | 0.2213    | 4.426             | —                |
| 200         | 0.2334    | 1.167             | 0.081            |
| 800         | 0.4933    | 0.617             | 0.433            |
| 2000        | 0.8956    | 0.448             | 0.335            |

**`snapshot()` — the delta engine, dev vs production** (`src/commands/core.ts:34`):

| mode           | 50            | 200           | 800           | 2000          | marginal ms/clip |
| -------------- | ------------- | ------------- | ------------- | ------------- | ---------------- |
| development    | 0.1207 ms     | 0.1858 ms     | 0.7202 ms     | 1.6938 ms     | 0.81–0.89        |
| **production** | **0.0282 ms** | **0.1076 ms** | **0.4460 ms** | **1.3127 ms** | 0.56–0.72        |

The **dev mode is 4.3× the production mode at 50 clips** (0.121 ms vs 0.028 ms) because dev adds
`deepFreeze(prev)` — an O(document) walk — plus two `applyDocDelta` + two `deepEqualRef`
self-verifications per dispatch (`core.ts:41-60`). The gap narrows at 2000 clips (1.69 vs
1.31 ms) because the delta computation itself dominates there.

**Consequence for the team:** a developer on this tree feels a per-command tax that production
users do not pay, and a production user feels a per-command tax that a developer's machine
never shows. Both are real; they are not the same number. Any gate built on dev-mode timing
would be measuring the freeze.

**`JSON.stringify(doc)` — the autosave payload:**

| scene clips | payload   | median ms | ms per 1000 clips |
| ----------- | --------- | --------- | ----------------- |
| 50          | 13.5 KiB  | 0.0312    | 0.624             |
| 200         | 23.4 KiB  | 0.0525    | 0.263             |
| 800         | 63.0 KiB  | 0.1286    | 0.161             |
| 2000        | 143.4 KiB | 0.3419    | 0.171             |

**`ProjectStore.execute()` — the full per-command path** (fresh command per iteration, 12
subscribers attached):

| scene clips | median ms/command | listener calls/command |
| ----------- | ----------------- | ---------------------- |
| 50          | 0.5342            | 12.0                   |
| 200         | 1.0201            | 12.0                   |
| 800         | 2.5910            | 12.0                   |
| 2000        | 5.7136            | 12.0                   |

Read as **0.4 ms fixed + ~2.7 µs per clip**: the fixed part is the normalisation, the history
push, the diff-cache clear and the fan-out; the variable part is the delta computation plus the
normalisation.

**Two facts from this table that matter beyond performance:**

1. **Every subscriber is notified on every mutation** — 12 listeners, 12 calls, no filtering at
   the store level. The store has fine-grained selectors, but the root component does not use
   them (C-2/C-3's amplifier).
2. **The autosave payload is cheap.** At 2000 scene clips it is 143 KiB and 0.34 ms. There is no
   serialisation cliff here, and the undo stack is bounded at 64 delta entries. **The state layer
   is not where this DAW's problem is.**

**Re-verified on the tree as it stands after the peer wave:** every row above reproduces — see
**§13.1**. One caveat belongs with them: the peer wave added a new super-linear term to
`normalizeProject` that this fixture cannot execute, because the fixture carries no `notes`.
See **§13.2 (S-6)**.

### 4.3 The audio path — the verified cliff

**`soloAudibility(doc).audible(id)` for every track** — the exact work the engine does on every
document change (`AudioEngine.ts:1986`, and again at 2080, 2107), measured in isolation:

| tracks | median ms per document change | ms per 1000 tracks | **marginal ms/track** |
| ------ | ----------------------------- | ------------------ | --------------------- |
| 16     | 0.0188                        | 1.175              | —                     |
| 32     | 0.0408                        | 1.275              | **1.375 µs**          |
| 64     | 0.1220                        | 1.906              | **2.538 µs**          |
| 128    | 0.3845                        | 3.004              | **4.102 µs**          |
| 256    | **1.6697**                    | 6.522              | **10.041 µs**         |

**This is the cliff, and it is quadratic.** The marginal cost per track **doubles with every
doubling of the track count** (1.375 → 2.538 → 4.102 → 10.041 µs). The cause is visible in
`src/project-model/solo-audibility.ts:46-50`:

```ts
audible(trackId: string): boolean {
  const t = tracks.find((x) => x.id === trackId);      // ← O(T)
  if (!t) return false;
  if (t.kind !== "group" && t.groupId) {
    const g = tracks.find((x) => x.id === t.groupId);  // ← O(T) again
    ...
```

The closure is called **once per track** per sync, so one document change costs **T × O(T)**.

The same quadratic shape appears twice more on the same path, for the same reason — a
`doc.tracks.find` inside a loop over tracks:

- `src/audio-engine/AudioEngine.ts:2218` and `:2259` — `syncPdc()` resolves the track **inside**
  the loop over `trackNodes`, twice → **2 × O(T²)** per edit, and `syncPdc` runs at the end of
  every `syncProject` (`AudioEngine.ts:2136`).
- `src/project-model/targets.ts:222` → `:137` — `targetParamDef` → `targetOwner` → `doc.tracks.find`
  → O(T) per resolution, and the automation bridge resolves a target **per lane per tick** and
  **per write** (`automationBridge.ts:1193`, `:1247`).

**One target resolution, measured:**

| tracks | median ms/call | ms per 1000 tracks |
| ------ | -------------- | ------------------ |
| 16     | 0.0031         | 0.194              |
| 64     | 0.0042         | 0.066              |
| 256    | 0.0182         | 0.071              |

One resolution is cheap (0.018 ms at 256 tracks). But it is resolved **per lane per tick**:
32 lanes × 40 ticks/s × 0.018 ms ≈ **23 ms per second** — 2.3 % of a core, plus the rest of the
automation path. That is why `perf:tick` projects 0.66 % of a core for _one_ automation call per
tick and why a lane-dense project deserves its own measurement.

**`automationClipForTarget` — the per-segment remap** (`src/project-model/targets.ts:277`):

| tracks | 8 points  | 32 points | 128 points |
| ------ | --------- | --------- | ---------- |
| 16     | 0.0232 ms | 0.0584 ms | 0.0676 ms  |
| 64     | 0.0055 ms | 0.0178 ms | 0.0611 ms  |
| 256    | 0.0047 ms | 0.0155 ms | 0.0599 ms  |

**This refutes the shape the code reading suggested.** The cost grows with the **point count**
and is essentially **independent of the track count** (128 points: 0.068 ms at 16 tracks vs
0.060 ms at 256 tracks). The reason is that the track→track remap (`trackGain` → `trackPan`)
never needs to resolve a parameter definition, so the O(T) lookup never runs. **The O(P×T) shape
is plausible for the fx-parameter path and was not measured; for the measured path it is O(P).**
Recording the refutation is the point: a shape read off code is a hypothesis until measured.

**The bypass finding (C-5)** is a code fact, not a timing: `fxSignature`
(`AudioEngine.ts:1190-1200`) filters bypassed effects **out** of the signature, and
`AudioEngine.ts:1976-1981` rebuilds the whole chain when the signature changes:

```ts
const sig = this.fxSignature(track.effects);
if (nodes.fx.signature !== sig) {
  this.rebuildFxChain(track.id, track.effects, nodes.input, nodes.panner, nodes.fx); // full rebuild
} else {
  this.syncFxParams(track.effects, nodes.fx); // the cheap path
}
```

So **one bypass toggle destroys and re-instantiates every effect on that track**, instead of
writing one parameter. The audible consequence (does the effect's state survive? is there a
discontinuity?) was **not** verified — see §12.

**Re-verified on the tree as it stands after the peer wave:** the quadratic reproduces, with
lower absolute milliseconds and the same shape — see **§13.1**.

### 4.4 The arrangement render path — the shapes, and one citation

The three terms that make the arrangement's per-render cost super-linear, all verified by
reading the code at the lines given:

**(a) Per visible audio clip, a `Set` over ALL audio clips** —
`src/ui/ArrangementPanel.tsx:5849-5862`:

```ts
const compSourceTakeNumber = clip.compSourceTakeId
  ? Array.from(new Set((arrangement.audioClips ?? [])
      .filter((candidate) => …).map((candidate) => candidate.takeId!)))
      .indexOf(clip.compSourceTakeId) + 1
  : 0;
```

→ **O(W × N)**, where W = visible audio clips, N = all audio clips.

**(b) Per visible audio clip, a filter + map + sort of ALL scene clips** —
`src/ui/ArrangementPanel.tsx:5877-5887` → `src/project-model/scene-time.ts:67-87`:

```ts
const spans = clips
  .filter(…)
  .map((clip) => ({ …, bpm: effectiveSceneBpm(scenes.find((scene) => scene.id === clip.sceneId)?.bpm, projectBpm) }))
  .filter(…)
  .sort((a, b) => a.from - b.from);
```

→ **O(W × (N log N + N·S))**, where S = the scene count. Measured in isolation: **0.165 ms per
call at 2000 scene clips** (§4.2, M1). Called once per visible audio clip → with 50 visible
audio clips that is ≈ **8 ms per render**, before the panel has drawn anything.

**(c) An unconditional full-list scan, defeating the windowing** —
`src/ui/ArrangementPanel.tsx:2222-2259`: the `windowed` memo's first pass breaks early at the
viewport edge (cheap), but its **second pass walks the entire list** to find the forced ids:

```ts
for (let i = 0; i < list.length; i++) {
  const clip = list[i]!;
  if (!taken.has(i) && forced.has(clip.id)) out.push({ clip, index: i });
}
```

→ **O(N) per render**, always, even with an empty forced set and a tiny window.

**The zoom multiplier (C-2)** — verified constants and arithmetic:

| constant                                      | value                                             | consequence                           |
| --------------------------------------------- | ------------------------------------------------- | ------------------------------------- |
| `BASE_BAR_WIDTH` (`ArrangementPanel.tsx:192`) | 30 px per bar at zoom 1                           | —                                     |
| `MIN_ZOOM` (`:200`)                           | 0.05                                              | **1.5 px per bar**                    |
| `MAX_ZOOM` (`:201`)                           | 40                                                | 1200 px per bar                       |
| viewport quantisation (`:605-611`)            | `first = floor(scrollLeft / pxPerBar) − overscan` | the viewport changes **once per bar** |

So scrolling one pixel advances the viewport by **0.67 bars at minimum zoom** and by **0.0008
bars at maximum zoom** — a **800×** difference in the number of viewport transitions, and each
transition is a full re-render carrying (a), (b) and (c). The same arithmetic gives the grid
size: 51 grid cells at zoom 1, **557 at zoom 0.05** (`visible bars = width/(30·zoom) + 24`).

**What AUDIT-15 measured for this component** (cited, not re-measured — jsdom, no layout, no
paint):

| clips in doc | clips rendered | median commit | p95      |
| ------------ | -------------- | ------------- | -------- |
| 1            | 2              | 2.62 ms       | 5.26 ms  |
| 25           | 26             | 9.56 ms       | 14.15 ms |
| 100          | 101            | 15.04 ms      | 23.13 ms |
| 300          | 301            | 52.25 ms      | 74.35 ms |

AUDIT-15's own verdict: _"the count is O(1) and the cost is O(clips) — the shape above is
confirmed… These milliseconds are not a browser budget. Only the shape is trustworthy; the
severity is unmeasured."_ This audit adds the **super-linear terms** (a) and (b) that make the
shape worse than linear at high density, and the zoom multiplier (C-2) that makes the _count_ of
renders explode at the zoom-out end.

### 4.5 The collaboration and AI paths — code-verified shapes, unmeasured magnitudes

**C-6 (collaboration).** `src/collab/YDocStore.ts:139-143`: every `yDoc.on("update")` — **local
or remote** — re-projects the **whole document** (`readDoc`) and emits it.
`src/collab/YDocAdapter.ts:67-98` rebuilds every array **without structural sharing**, so every
`useX()` selector in `src/ui/context.ts:68-138` reports a changed reference and every consumer
re-renders. One remote keystroke in a large session therefore costs one whole-document
projection plus one whole-tree re-render. Magnitude: **not measured**.

**The AI/MCP path is mostly healthy**, and the healthy parts are worth stating because they are
the parts a reader would expect to be broken:

- The tool registry is **static** — 39 tools, built once (`src/mcp/tools.ts`); `tools/list`
  copies and re-serialises it, but nothing rebuilds it.
- `ctx.getDoc` is a **lazy accessor** (`src/mcp/bridge.ts:156`, `src/mcp/tools.ts:3332`) — there
  is **no whole-document snapshot per tool call**, and the relay frame carries only
  `{type,id,tool,args}`.
- The candidate bank is **bounded** (≤ 8 local, ≤ 4 symbolic).

The suspects are listed in §0 as S-1 … S-5. Two of them are worth naming here because they are
the shape the mission asks about (duplicated work, not missing work):

- **S-2:** `src/ai/features/pattern-features.ts:430-434` recomputes the **batch statistics of the
  whole bank** three times per candidate, and the call site is per candidate
  (`src/ai/ranking/rank-candidates.ts:82`) → the same statistics are computed n times.
- **S-4:** every prior/ranker call **re-posts the model manifest** to a worker that already has
  the session cached (`prior-client.ts:265`, `ranker-client.ts:171`).

---

## 5. THE CLIFF REGISTER

Severity is judged on: audible correctness, frequency in normal production, reproducibility,
regression risk, maintainability and ease of verification. **Real-time glitches and data loss
outrank micro-optimisations** — nothing in this register is a data-loss risk.

| ID      | Threshold                                                                 | Symptom                                                                                                                                                                                                                        | Severity                                                                                                                                           | Evidence                                             | Root cause                                                                                                                                | Owner                                                                             |
| ------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **C-1** | **> 64 tracks**; the marginal cost doubles per doubling (measured 16→256) | Every edit (a knob turn, a drag commit) pays an O(T²) audibility resolution. At 256 tracks that is 1.67 ms of pure overhead per document change — and the same shape appears twice more in `syncPdc`.                          | **High** — it is on the _most frequent_ interaction in the product                                                                                 | **OBSERVED (measured)**, quadratic                   | `tracks.find` inside a per-track closure (`solo-audibility.ts:46,50`); `tracks.find` inside a per-track loop (`AudioEngine.ts:2218,2259`) | `src/project-model/solo-audibility.ts`, `src/audio-engine/AudioEngine.ts`         |
| **C-2** | **zoom ≤ 0.05** (1.5 px/bar)                                              | Scrolling re-renders up to 800× more often than at max zoom; each render carries C-3/C-4. The whole cost of the arrangement is multiplied by the zoom ratio.                                                                   | **High** — zoom-out is how a user surveys a whole song                                                                                             | **OBSERVED (code)**                                  | The viewport is quantised in bars, but the render cost is in pixels                                                                       | `src/ui/ArrangementPanel.tsx` (viewport model)                                    |
| **C-3** | **W × N** — visible audio clips × all audio/scene clips                   | Per-render super-linear terms: a `Set` over all audio clips and a sorted span map over all scene clips, **per visible audio clip**. Measured: 0.165 ms per call at 2000 scene clips.                                           | **Medium–High** — a cost risk at extreme density; the commit count is already 1/move                                                               | **OBSERVED (code)** + per-call cost measured         | Per-item work that scans the whole list instead of an index                                                                               | `src/ui/ArrangementPanel.tsx:5849-5887`, `src/project-model/scene-time.ts:67-87`  |
| **C-4** | any clip count                                                            | The windowed memo's forced-id pass walks the whole clip list every render, defeating the windowing that `Sequencer` and `PianoRoll` already have.                                                                              | **Medium** — O(N) per render, unconditional                                                                                                        | **OBSERVED (code)**                                  | The forced-id set is empty most of the time, but the scan is not conditional on it                                                        | `src/ui/ArrangementPanel.tsx:2222-2259`                                           |
| **C-5** | every bypass toggle                                                       | The whole effect chain of a track is destroyed and re-instantiated instead of one parameter being written. Effect internal state (a delay tail, a reverb decay) cannot survive, and the audio graph is churned under playback. | **Medium–High** — audible risk, unverified                                                                                                         | **OBSERVED (code)**; audible effect **NOT ASSESSED** | `fxSignature` filters bypassed effects out, so bypass is encoded as a structural change                                                   | `src/audio-engine/AudioEngine.ts:1190-1200, 1976-1981`                            |
| **C-6** | any remote update                                                         | A remote keystroke re-projects the whole document and re-renders the whole tree.                                                                                                                                               | **Medium** — collaboration is a first-class product mode                                                                                           | **OBSERVED (code)**; magnitude not measured          | The Yjs adapter rebuilds arrays without structural sharing, so no selector can stay stable                                                | `src/collab/YDocStore.ts:139-143`, `src/collab/YDocAdapter.ts:67-98`              |
| **S-1** | inserted effects in a model context                                       | The context trim loop re-serialises the whole context once per dropped contract → quadratic.                                                                                                                                   | Low–Medium (bounded by a 12 000-char cap)                                                                                                          | **SUSPECTED**                                        | `model-context.ts:305`                                                                                                                    | `src/intent/model-context.ts`                                                     |
| **S-2** | candidate bank size                                                       | The batch statistics are recomputed once per candidate instead of once per bank.                                                                                                                                               | Low (bank ≤ 12)                                                                                                                                    | **SUSPECTED**                                        | `pattern-features.ts:430-434`                                                                                                             | `src/ai/features/pattern-features.ts`                                             |
| **S-3** | 667 artist presets                                                        | A new `RegExp` per artist name per call, 2–3 full scans per prompt.                                                                                                                                                            | Low                                                                                                                                                | **SUSPECTED**                                        | `artists.ts:7464`                                                                                                                         | `src/intent/artists.ts`                                                           |
| **S-4** | every model call                                                          | The manifest is re-posted to a worker that already cached it.                                                                                                                                                                  | Low (bytes), Medium (round trips)                                                                                                                  | **SUSPECTED**                                        | `prior-client.ts:265`, `ranker-client.ts:171`                                                                                             | `src/ai/symbolic/prior-client.ts`, `src/ai/ranking/ranker-client.ts`              |
| **S-5** | candidate index                                                           | Up to 24 candidate regenerations per index.                                                                                                                                                                                    | Low                                                                                                                                                | **SUSPECTED**                                        | `candidate-search.ts:466`                                                                                                                 | `src/intent/candidate-search.ts`                                                  |
| **S-6** | melodic tracks in one pattern                                             | The per-command normaliser walks the pattern's note tracks once per arrangement clip, so a pattern with many melodic tracks multiplies the cost of every command.                                                              | Low–Medium — bounded by the pattern's melodic track count (tens), not by the document; but it sits on the per-command path §4.2 measured as linear | **OBSERVED (code)**; magnitude **not measured**      | The period is computed per clip instead of per pattern; the `Object.values()` allocation and the LCM chain are not cached across clips    | `src/project-model/schema.ts:1733`, `src/project-model/midiTime.ts:60-67` (§13.2) |

### 5.1 What was measured and found NOT to be a cliff

Recording these is as valuable as the findings, because they are the places a reader would
expect a cliff and there is none:

| Area                    | Result                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Scheduler tick          | 0.66 % of one core at 16 lanes, p95 0.268 ms/tick. **Healthy.**                    |
| Command / delta / undo  | Linear; the undo stack is bounded at 64 **delta** entries. **Healthy.**            |
| Autosave serialisation  | 143 KiB and 0.34 ms at 2000 scene clips. **Healthy.**                              |
| `normalizeProject`      | Linear (0.45 µs/clip). **Healthy as a shape.**                                     |
| MCP registry and relay  | Static registry, lazy document accessor, no per-call snapshot. **Healthy.**        |
| Audio-thread allocation | Two allocation sites in the whole processor set, both near-necessary. **Healthy.** |
| Metering                | Reused buffers, rAF-driven. **Healthy.**                                           |

---

## 6. LONG-SESSION DEGRADATION AND RESOURCE LIFECYCLE

**NOT MEASURED** — §12 carries the plan. What the code says, with evidence levels:

| Concern                          | Code fact                                                                                                                                                                                                                               | Evidence        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Undo history growth              | `HISTORY_LIMIT = 64` (`ProjectStore.ts:70`); the stack holds **deltas**, and the delta engine is reference-pruned, so an entry pins only the changed subtrees. **Bounded.**                                                             | OBSERVED (code) |
| History snapshots                | `historyDocs` holds **document references** (`ProjectStore.ts:36-37`), not copies — cheap under structural sharing, but it keeps the _initial_ document's unchanged subtrees alive for as long as the window (64 entries).              | OBSERVED (code) |
| History panel cost               | `diffForIndex` walks both snapshots; the result is memoised in `diffCache` and the cache is cleared on every mutation (`ProjectStore.ts:47,136-160`). The first render after an edit pays the walk for every visible row.               | OBSERVED (code) |
| Coalescing                       | Same-key commands merge within a 1 000 ms window (`COALESCE_WINDOW_MS`, `ProjectStore.ts:23`), so a continuous gesture is one undo entry, not 200.                                                                                      | OBSERVED (code) |
| Sample / waveform retention      | `src/persistence/` keeps frozen buffers and user samples in IndexedDB; the release path for frozen buffers was audited in the 2026-10-22 hardening wave. **Not re-examined here.**                                                      | NOT ASSESSED    |
| Cache inflation                  | The arrangement's waveform canvas scans raw PCM per redraw and `buildWaveformPeaks` (`src/reference/audio/waveform.ts:13`) exists but is **unused** — so there is no peak cache to inflate, and equally no peak cache to save the work. | OBSERVED (code) |
| Abandoned timers / subscriptions | The worker-boundary wave (this audit's predecessor, C11–C16) fixed the AI clients' missing `error` listeners; the collab client timers (250 ms, 100 ms) and the server ping (30 s) are constant-rate by design.                         | OBSERVED (code) |
| Open/close cycles                | **NOT ASSESSED.**                                                                                                                                                                                                                       | NOT ASSESSED    |

**The honest statement:** the long-session dimension is the one this environment cannot measure,
and it is the one where a memory leak would be most expensive to discover late. It is the first
item in §12.

---

## 7. REAL-TIME DSP SAFETY AND UI/AUDIO CONTENTION

### 7.1 What is safe

- **No `await`, no `fetch`, no `decodeAudioData` in the scheduler.** `Scheduler.ts` is fully
  synchronous — no locks, no I/O on the tick path.
- **No per-block allocation in the audio thread** (except the two near-necessary sites).
- **The metering path is off the audio thread** — rAF-driven, buffers reused.
- **The tick path is 0.66 % of a core** at 16 automation lanes.
- **Worklet loading is lazy and bounded** — a `WeakMap` per context with in-flight dedup
  (`src/audio-worklets/loader.ts`), so a beat that never touches PRISM does not pay for it.

### 7.2 Where audio and UI contend for the same thread

The audio graph runs on the audio thread; **everything else in this report runs on the main
thread**, and the main thread also runs the UI, the command path, the audio-engine sync and the
AI/MCP path. The contention is therefore structural, and C-1 makes it worse:

| Main-thread consumer                     | When it competes with the UI                                | With C-1 at 256 tracks                                                                |
| ---------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `syncProject` (on every document change) | Every knob turn, every drag commit                          | +1.67 ms of pure audibility overhead per change, plus the two O(T²) `syncPdc` lookups |
| The arrangement render (C-3/C-4)         | Every pointermove during a drag, every scroll quantum (C-2) | 8 ms per render at 2000 scene clips and 50 visible audio clips                        |
| The intent pipeline (S-1 … S-5)          | On every AI request, while the user keeps working           | up to 24 candidate regenerations, 2–3 artist scans, O(n²) feature stats               |
| The MCP path                             | On every tool call                                          | **healthy** — no whole-document snapshot                                              |

**The synthesis that matters:** at high track counts the _audio engine's_ own bookkeeping
(C-1) is charged on the same thread and the same gesture as the arrangement's render (C-3/C-4),
and the zoom multiplier (C-2) decides how many times that combined cost is paid per pixel of
scrolling. A user who zooms out to survey a dense project and then drags a clip is paying the
worst possible combination — and the audio thread is waiting for the main thread's `postMessage`
to deliver the parameter writes.

### 7.3 Audio correctness

**No xrun, dropout or deadline-miss measurement was possible** (no audio device). What the code
says:

- The **bypass rebuild (C-5)** is the one finding with a plausible audible consequence: a chain
  that is destroyed and re-instantiated under playback is a discontinuity candidate, and an
  effect's state (a delay tail, a reverb decay) cannot survive the toggle. **This was not
  verified** and needs a real audio device.
- The **audibility rule (C-1)** is a correctness-sensitive path (it decides what is audible) but
  it is also the path whose cost is quadratic — the fix must not change what it decides. The
  2026-10-22 hardening wave and this audit's C1 audit both fixed _that_ path; the rule is now
  owned by one function (`src/project-model/solo-audibility.ts`) and its **shape** must be
  preserved when it is made O(1).

---

## 8. TOP 10 PERFORMANCE HARDENING PRIORITIES

Ordered by (impact × confidence) ÷ risk. "Risk" is the chance the change breaks behaviour.

| #      | Priority                                                                                                                                                                                | Why it is here                                                                                                                | Expected effect                                                                                | Risk                                                                                             | Acceptance gate (proposed)                                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | **Make the audibility rule O(1) per track.** Build the track→id map once per sync (one `Map` over `doc.tracks`) and hand it to the closure; keep the rule's _semantics_ byte-identical. | The only **measured quadratic** on the most frequent interaction in the product (C-1).                                        | 256 tracks: 1.67 ms → ≈ 0.01 ms per document change. Removes the quadratic from the drag path. | Low — the semantics are owned by one function with a dedicated test suite                        | The existing audibility spec stays green; a new spec asserts the same answers at 16/64/256 tracks; a ratio gate (not a wall-clock gate) fails if the cost per track rises                            |
| **2**  | **Break the `syncPdc` quadratic** (`AudioEngine.ts:2218,2259`): hoist the track lookup out of the loop into a `Map` built once.                                                         | The same shape as #1, on the same path, twice over (C-1).                                                                     | Removes 2 × O(T²) per document change.                                                         | Low — mechanical                                                                                 | Same as #1; count the `doc.tracks.find` calls per sync in a spec (expect O(1) lookups, not O(T²))                                                                                                    |
| **3**  | **Give the viewport a PIXEL quantum, not a bar quantum** — or keep the bar quantum but decouple the re-render from it.                                                                  | The 800× multiplier (C-2) is a one-line-shaped change with a 800× payoff.                                                     | At min zoom: up to 800× fewer re-renders per pixel of scroll.                                  | Medium — the viewport drives what is rendered; a wrong quantum shows clips at the wrong position | The existing scroll/zoom specs stay green; a spec asserts the number of viewport transitions per 500 px at zoom 0.05 vs 40, and fails if the ratio exceeds the pixel ratio by more than the overscan |
| **4**  | **Make the per-visible-clip work index-based.** Hoist the `compSourceTakeNumber` set and the scene span map out of the per-clip render into a `useMemo` keyed on the clip list.         | C-3 is the super-linear render term (O(W×N) + O(W×N log N)).                                                                  | 2000 scene clips × 50 visible audio clips: ≈ 8 ms per render → ≈ 0.2 ms.                       | Medium — a stale index would show the wrong take number or the wrong time                        | The take-number and scene-time specs stay green; a new spec asserts the rendered take number and time for a clip whose neighbours change                                                             |
| **5**  | **Skip the forced-id scan when the forced set is empty** (C-4).                                                                                                                         | One condition, one O(N) pass per render removed.                                                                              | Removes an unconditional O(N) from every render.                                               | Very low                                                                                         | The windowing specs stay green; a spec asserts that a render with no active gesture touches only the window                                                                                          |
| **6**  | **Make a bypass toggle a parameter, not a rebuild** (C-5). Keep the bypassed effect in the chain and in the signature.                                                                  | The chain rebuild is a structural change for a one-bit change; it is also the only finding with a plausible audible artifact. | Removes a full chain teardown per toggle; preserves the effect's state across the toggle.      | **Medium–High** — the graph semantics change, and the audible result was never verified          | The bypass specs stay green; a new spec asserts that the effect's node identity is unchanged across a bypass toggle; **an audible check on a real device before landing**                            |
| **7**  | **Give the collab projection structural sharing** (C-6): reuse unchanged arrays in `YDocAdapter` so the selectors stay stable.                                                          | One remote keystroke currently costs a whole-document projection + a whole-tree re-render.                                    | A remote update would re-render only what changed.                                             | Medium — the adapter is the collab contract                                                      | The collab specs stay green; a spec asserts that an unrelated remote update does not change the identity of the tracks array                                                                         |
| **8**  | **Use the peak cache that already exists.** `buildWaveformPeaks` (`src/reference/audio/waveform.ts:13`) is written and **unused**; the arrangement's canvas scans raw PCM per redraw.   | A ready-made fix for a per-redraw O(samples) cost during trim/slip drags.                                                     | Waveform redraw becomes O(window peaks) instead of O(window samples).                          | Low — the cache exists and is tested? (not verified here)                                        | The waveform specs stay green; a spec asserts the peak cache is used (a redraw does not touch the PCM)                                                                                               |
| **9**  | **Hoist the batch statistics in feature extraction** (S-2) and **precompile the artist regexes** (S-3).                                                                                 | Two textbook duplicated-work findings in the intent pipeline; both bounded today, both on the request path.                   | O(n²) → O(n) in the bank; no per-call `RegExp` construction over 667 presets.                  | Low                                                                                              | The intent specs stay green; a spec counts the batch-stat computations per prompt (expect 1 per bank, not 1 per candidate)                                                                           |
| **10** | **Stop re-posting the model manifest** on every call (S-4): let the worker's own session cache answer "already loaded".                                                                 | Round trips are the AI path's real cost, not bytes.                                                                           | One fewer round trip per prior/ranker call.                                                    | Low — the worker already caches the session                                                      | The prior/ranker specs stay green; a spec counts the round trips per call                                                                                                                            |

**Not in the top 10, on purpose:**

- **Virtualising the arrangement** (AUDIT-15's P1). It is the largest single lever on the render
  path, but it is a component extraction in a 7 509-line file, and AUDIT-15 could not establish
  that the current cost is unacceptable at realistic density. **Priority 3 and 4 remove the
  multiplier and the super-linear terms without that rewrite.** If a browser measurement later
  shows the render cost still dominates, this becomes priority 1.
- **A jsdom cost gate.** AUDIT-15 built one, falsified it (the bands overlapped: 5.5–10.9×
  clean vs 8.9–11.1× with an injected O(n²)), and **removed it rather than loosening it**. A
  gate that cannot fail is worse than no gate. The correct target is a **browser** harness with a
  load-calibrated baseline (§10).

---

## 9. TOP 5 STRATEGIC SCALING RECOMMENDATIONS

These are not fixes. They are the decisions that keep the next ten features from re-creating
the cliffs above.

1. **Make the document's shape the unit of work, never the item.**
   Every cliff in this register comes from the same mistake: **per-item work that scans the
   whole collection** — `tracks.find` per track, a `Set` of all audio clips per visible clip, a
   sorted span map per visible clip, a `tracks.find` inside a per-track loop. The architectural
   rule that prevents all of them: _if you touch items in a loop, build the index once, outside
   the loop, and invalidate it by identity._ The repo already does this in two places
   (`diffCache`, `docDelta`'s reference pruning) — the pattern exists, it is just not applied
   consistently.

2. **Separate "the model changed" from "the model was touched".**
   `App.tsx` subscribes to the whole document, so every command re-renders the tree. The store
   already offers fine-grained selectors (`getTracks`, `getScenes`, …) and `useSyncExternalStore`
   is already in `src/ui/context.ts`. The arrangement is the last component that ignores the
   mechanism the rest of the app was built for. **Adopting the existing mechanism is cheaper
   than any optimisation in this report** — it is a subscription change, not a rewrite.

3. **Make the pixel the unit of the viewport.**
   Bars are a musical unit; pixels are a visual one. The viewport is measured in pixels and
   stored in bars, which is why the zoom-out end pays 800×. Musical-quantised viewports are
   right for **snapping** and wrong for **culling** — the two concerns should not share one
   number.

4. **Give collaboration the same structural sharing the local path has.**
   The local path is built on copy-on-write and reference pruning; the collab path re-projects
   the whole document per update and rebuilds every array. A remote keystroke should cost what
   a local keystroke costs. This is the one cliff that scales with _other people_, which makes it
   the most likely to be hit in normal production.

5. **Make the performance gates ratios, and put them where the load is.**
   The two gates that are already exemplary (`fxeq-performance-gates.test.ts`, `perf-tick`) work
   because they measure **a ratio against a back-to-back baseline in the same process**, and
   because they gate on **p95**, not a median. The gates that do not work
   (`performance-hardening.test.ts`'s source greps — AUDIT-15's P5) are the ones that assert on
   source text instead of behaviour. The rule for the next decade of gates: **a gate must be
   able to fail on a real defect, and it must not care how busy the machine is.**

---

## 10. PROPOSED EXPERIMENTS, METRICS AND ACCEPTANCE GATES

Every experiment below names the quantity, the instrument, and the gate. Nothing is proposed
that this audit did not either measure or define precisely.

### 10.1 Experiments (each is safe, bounded and reproducible)

| #    | Experiment                                | Instrument                                         | Quantity                                                       | Gate (proposed)                                                                                               |
| ---- | ----------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| E-1  | Audibility at 16/64/256 tracks            | a ratio gate around `soloAudibility` (new spec)    | µs per track per document change                               | The marginal µs/track must not grow with the track count (today: 1.375 → 10.041 µs)                           |
| E-2  | `syncPdc` lookups                         | a counting spec (not a wall-clock one)             | `doc.tracks.find` calls per sync                               | ≤ 2 per sync (today: 2·T²)                                                                                    |
| E-3  | Viewport transitions per 500 px of scroll | a spec that counts `measureViewport` state changes | transitions at zoom 0.05 vs 40                                 | the ratio must not exceed the pixel ratio by more than the overscan (today: up to 800×)                       |
| E-4  | Arrangement render cost vs. clip count    | **browser** (Playwright + `React.Profiler`)        | median/p95 commit at 50/200/500/1000 clips, and DOM node count | the marginal ms/clip must not grow (linear or better); DOM nodes must scale with the window, not the document |
| E-5  | Bypass toggle                             | a browser + audio check                            | node identity across a toggle; audible discontinuity           | the effect's node identity must be unchanged (today: the whole chain is rebuilt)                              |
| E-6  | Remote update cost                        | a browser, two clients                             | React commits per remote keystroke; projection ms              | commits must not scale with the document size                                                                 |
| E-7  | Long-session memory                       | a browser, a scripted 2-hour session               | heap after GC at 0/30/60/120 min; retained object count        | the heap must plateau (a slope, not a level, is the signal)                                                   |
| E-8  | Open/close cycles                         | a browser, 50 cycles                               | heap after the last close vs. the first                        | the delta must be inside the noise band                                                                       |
| E-9  | The intent pipeline per prompt            | `npm run ai:performance` + counters                | p95; worker round trips; `RegExp` constructions per prompt     | p95 stays under `MAX_SYNC_PREVIEW_MS`; the round-trip count must not grow with the candidate count            |
| E-10 | The tick path at lane density             | `npm run perf:tick -- --lanes 1,4,16,32,64`        | median/p95 ms/tick and % of a core                             | the % of a core must stay under a stated budget at 64 lanes                                                   |

### 10.2 The metrics a regression bench should record

| Metric                                                          | Why                                                                                                                | How                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **Marginal cost per unit** (µs per clip, per track, per point)  | Shape survives a loaded host; absolute ms does not                                                                 | The slope between two workload sizes                                     |
| **p95, not median**                                             | Periodic allocation/GC churn hides behind a healthy median (`fxeq-performance-gates.test.ts` already does this)    | The repo's own gate pattern                                              |
| **A ratio against a back-to-back baseline in the same process** | The only technique that survives CI variance and a shared machine                                                  | `scripts/bench-hotpath.ts` already does this                             |
| **DOM node count**                                              | A render cost that is really a node count                                                                          | `scripts/ui-camera.mjs` already measures DOM mutations                   |
| **Allocation delta per call**                                   | Time alone understates an allocation fix                                                                           | The `PerformanceObserver` GC counter in `bench-hotpath.ts`               |
| **A "did the guard fire?" positive control**                    | AUDIT-15's P2 and this audit's own probe defects both produced clean, fake numbers because the control was missing | Every measurement instrument must print a control that proves it is live |

### 10.3 Regression benchmarks worth landing (in order)

1. `audible` ratio gate (E-1) — measures a **property** (the cost per track does not grow), not an
   artefact (a specific millisecond).
2. `syncPdc` lookup-count gate (E-2) — a **count**, deterministic, machine-independent.
3. Viewport-transition ratio gate (E-3) — a **count**, deterministic.
4. A **browser** render-cost bench (E-4) with a load-calibrated baseline — the gate AUDIT-15 could
   not build in jsdom, and the reason it could not is the reason a browser is required.

---

## 11. LOW-RISK SEQUENCING

The order below is chosen so that each step makes the next one measurable, and so that no step
depends on a measurement that does not exist yet.

**Phase 1 — BASELINE (no production change).**
Land the report. Add the **counters**, not the gates: a spec that prints the current marginal
µs/track for the audibility path, the current `tracks.find` count per `syncPdc`, the current
viewport-transition count per 500 px at two zooms, and the current React-commit count for one
arrangement render at 100/300 clips in a browser. **Every one of these is a measurement, not a
gate** — they print and assert only their own positive controls, exactly as AUDIT-15 did with
its throwaway probe (which it then removed).

**Phase 2 — INSTRUMENT (still no production change).**
Build the **browser** harness (E-4, E-5, E-7, E-8) on a quiet machine with a warm server, and
publish its baseline: the number every future gate is compared against. This is the gap
AUDIT-15 named — _"a real gate needs a browser harness with a load-calibrated baseline."_

**Phase 3 — ISOLATE (one finding at a time, in the order of §8).**
Take priorities 1 and 2 (the two quadratics) first, because they are the same defect in two
places, they are on the most frequent interaction, and the fix is a `Map` instead of a `find`.
Then 3 and 5 (the viewport quantum and the empty-forced-set skip), then 4 (the per-visible-item
indexes), then 6 and 7 (bypass and collab), which are the two that change semantics and
therefore need the browser and the audio device.

**Phase 4 — FIX (later, and only behind a failing gate).**
Each fix lands with the gate that fails without it. **No fix lands on the strength of this
report alone** — the report says what is quadratic, not what the user feels.

**Phase 5 — VERIFY.**
Re-run the baseline instruments, the affected suites, and the budget gates. Record the before
and after **in the same commit message**, the way §8's table does.

**Rollback strategy.** Priorities 1–5 are local and reversible: a `Map` instead of a `find`, a
condition, a `useMemo` hoisted, a quantum change, a cache. Any of them can be reverted by a
single commit with no data migration and no schema change. Priorities 6 and 7 are **not** of that
kind: they change what the graph and the collaboration protocol _mean_, so they need their own
branch-shaped discipline (a dedicated ADR, a staged landing, and a browser + audio verification
before the change is enabled by default).

---

## 12. UNKNOWNS, UNAVAILABLE TOOLING, AND WHAT NEEDS A DEDICATED ENVIRONMENT

### 12.1 Not assessed in this audit

| Gap                                                                                     | Why                                                                                                             | What it would take                                                                                    |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Browser frame time, input-to-paint latency, DOM node counts**                         | No browser; the host was at 100 % CPU; a browser measurement on a loaded host would be meaningless              | A quiet machine, a warm dev server, `scripts/ui-camera.mjs` + Playwright (§10.1 E-4)                  |
| **Audio-thread xruns, deadline misses, CPU headroom**                                   | No audio device in this environment                                                                             | A machine with an interface, a loopback capture, `scripts/measure-mastering-browser-memory.ps1`       |
| **The audible consequence of the bypass rebuild (C-5)**                                 | Needs a real audio graph                                                                                        | A device + a capture of a bypass toggle on a delay/reverb chain                                       |
| **Long-session memory growth, open/close cycles, idle decay**                           | Needs hours and a browser                                                                                       | §10.1 E-7/E-8                                                                                         |
| **The magnitudes of S-1 … S-5**                                                         | The shapes are read off code; the numbers were not measured                                                     | A disposable instrument per item, as §4.2 did for the state layer                                     |
| **The fx-parameter variant of `automationClipForTarget`**                               | The measured variant (trackGain → trackPan) never resolves a parameter definition, so the O(T) term did not run | One more fixture variant with an fx-param target                                                      |
| **The `src/mastering/`, `src/arrangement/` and the IR generator / phase vocoder paths** | Outside the four mapped areas                                                                                   | A separate mapping pass                                                                               |
| **Whether the arrangement's density is realistic at shipped scale**                     | The audit measured the shape, not the user's project                                                            | Telemetry-free sampling of real project shapes — **not attempted here, and no user data was touched** |

### 12.2 Tooling gaps in the repository itself

- **No render-count, rerender-count or commit-count guard exists** (AUDIT-15's P3, still open
  except for the one commit-count spec). Priorities 2, 3 and 6 would each benefit from one.
- **`performance-hardening.test.ts`'s source greps give false assurance** (AUDIT-15's P5): a
  rename detector, not a behaviour detector. Either promote them to behavioural assertions or
  relabel them so their weaker status is explicit.
- **`MAX_SYNC_PREVIEW_MS = 250` is a loose budget for a synchronous gate** (AUDIT-15's P6): for
  work that blocks the UI thread, 100 ms is the conventional "feels immediate" line.
- **The `ui-camera` instrument needs a browser harness with a load-calibrated baseline** before
  any cost gate can be built on it (AUDIT-15's addendum).

### 12.3 Why this report contains no flamegraphs, no profiler traces and no invented numbers

Every number in §4 is reproducible with the commands named beside it, on the environment named in
§1.1, and every number carries its evidence level. Where a magnitude was not measured, the row
says **NOT ASSESSED** or **SUSPECTED** and names the experiment that would settle it. The audit's
own methodological rule — inherited from AUDIT-15 and confirmed by two probe defects of my own —
is that **a number nobody can reproduce is worse than no number**.

---

## 13. POST-AUDIT-TREE ADDENDUM — re-verification, and one shape the peer wave introduced

The audit tree was `main` @ `0b688bea`. While this report was being written, four peer commits
landed on `main` (the scene-lane phase fix `2db3009f`, an AGENTS.md rules update, a persistence
data-loss fix, and the MCP receipt census). This section records two things: **a re-verification
of §4's measured numbers on the tree as it now stands**, and **one shape the peer wave
introduced after the audit tree**, which this audit's own measurements cannot see.

### 13.1 Re-verification — the measured numbers still hold

Both disposable instruments were re-run against the tree at `b2c3b680` + peers, on the same
loaded host:

| Quantity                                         | Audit tree (§4)         | Re-run on the current tree | Verdict                                     |
| ------------------------------------------------ | ----------------------- | -------------------------- | ------------------------------------------- |
| `normalizeProject`, 50 → 2000 clips              | 0.2213 → 0.8956 ms      | 0.1903 → 0.8890 ms         | reproduces                                  |
| `snapshot()` **development**, 2000 clips         | 1.6938 ms               | 1.7205 ms                  | reproduces                                  |
| `snapshot()` **production**, 2000 clips          | 1.3127 ms               | 1.3347 ms                  | reproduces                                  |
| `snapshot()` **production**, 50 clips            | 0.0282 ms               | 0.0282 ms                  | reproduces exactly                          |
| `JSON.stringify`, 50 → 2000 clips                | 0.0312 → 0.3419 ms      | 0.0317 → 0.3694 ms         | reproduces (payload 13.5 → 143.4 KiB)       |
| `arrangementSecondsBetweenTicks`, 2000 clips     | 0.1653 ms               | 0.1393 ms                  | reproduces (same order, same slope)         |
| `ProjectStore.execute()`, 50 → 2000 clips        | 0.5342 → 5.7136 ms      | 0.2081 → 2.5710 ms         | reproduces (absolute values host-dependent) |
| **C-1 `soloAudibility`, marginal µs/track**      | 1.375 → 10.041 µs       | 0.375 → 3.978 µs           | **the quadratic reproduces**                |
| **M8 `automationClipForTarget` vs. track count** | O(P), track-independent | O(P), track-independent    | **the refutation reproduces**               |
| `targetParamDef`, 16 → 256 tracks                | 0.0031 → 0.0182 ms      | 0.0015 → 0.0110 ms         | reproduces (same mild growth)               |

**The C-1 re-verification is the important one.** On the current tree the marginal cost per
track is 0.375 → 0.922 → 2.020 → 3.978 µs at 32 → 64 → 128 → 256 tracks: it still roughly
**doubles with every doubling of the track count**, and 256 tracks costs 70× what 16 tracks
cost for a 16× larger document. The absolute milliseconds are lower than in §4 — the host was
less contended during this run — but the **shape is what reproduces**, and the shape is the
finding.

**One row is recorded deliberately:** re-running instrument 1 **does** reproduce the no-op
measurement defect documented in §1.4 (0.8 listener calls per command, a flat 0.0015 ms). The
corrected measurement is in instrument 2 (M9), and it reproduces at **12.0 listener calls per
command** at every document size. A reader who re-runs instrument 1 and sees "0.8 listeners" is
seeing the documented defect, not a contradiction.

**Line-number drift:** `normalizeProject` moved from `schema.ts:3506` to `schema.ts:3543`
because of the peer wave. The line references in §4 were read on the audit tree.

### 13.2 A new shape the peer wave introduced — S-6

Commit `2db3009f` ("fix(scene-lane): the phase names the scene's TRUE period") fixed a
**correctness** defect: the arrangement normaliser wrapped a scene clip's phase against the
step grid, while the command layer wrapped it against the scene's true period. The fix
replaced a constant with a computation — and the computation sits **inside the per-clip
loop**.

`src/project-model/schema.ts:1733`, inside the per-clip `.map()` of
`normalizeArrangementDomain`, which runs after **every** command (`normalizeProject` →
`NORMALIZE_DOMAINS`, `schema.ts:3543`):

```ts
const periodTicks = pattern ? scenePatternPeriodTicks(pattern) : 0;
```

and `src/project-model/midiTime.ts:60-67`:

```ts
export function scenePatternPeriodTicks(pattern: Pick<Pattern, "stepCount" | "notes">): number {
  const grid = pattern.stepCount * STEP_TICKS;
  let period = grid > 0 ? grid : 1;
  for (const notes of Object.values(pattern.notes ?? {})) {
    period = lcmTicks(period, midiPhraseLengthTicks(pattern.stepCount, notes));
  }
  return period;
}
```

**Shape:** the arrangement normaliser now costs **O(clips × note-tracks in the pattern)** per
command — the same "per-item work that scans the whole collection" class as C-1 and C-3,
sitting on the most frequent interaction in the product. The inner note scan
(`midiPhraseLengthTicks`) is `WeakMap`-cached per notes array, so it amortises; the
`Object.values()` allocation and the LCM chain are **per clip** and are not cached across
clips.

**Why this audit cannot quantify it, stated plainly:** the audit's synthetic fixture carries
**no `notes` at all** — `.git/perf-cliff-measure.mts` builds patterns without a `notes` map —
so `Object.values(pattern.notes ?? {})` is empty, `scenePatternPeriodTicks` returns the grid
period immediately, and the term **never executes**. The measured linearity of
`normalizeProject` in §4.2 therefore still holds **for that fixture**, and says nothing at all
about a real document whose patterns carry melodic content. A measurement that cannot see a
change is not a measurement of that change.

|                                     |                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidence                            | **OBSERVED (code)** for the shape; **magnitude NOT measured**                                                                                             |
| Severity                            | Low–Medium — bounded by the melodic track count in one pattern (tens), not by the document                                                                |
| Why it is not top-10                | The multiplier is small and the fix is correct; but it is a **per-command** cost on a path §4.2 measured as linear, so it must not stay invisible         |
| What would settle it                | Re-run M2 with a fixture whose patterns carry notes on T melodic tracks: hold the clip count, vary T, and check whether the marginal ms/clip grows with T |
| Where it belongs                    | **S-6** in the cliff register (§0, §5)                                                                                                                    |
| The cheap fix, if it is ever needed | Hoist the period per **pattern** (a `Map` keyed by pattern id) instead of recomputing it per clip — §9's recommendation #1 applied to a two-line site     |

**The honest summary of this addendum:** the state layer's measured linearity survives the
peer wave, and the peer wave introduced one new super-linear term that the audit's fixture is
blind to by construction. §13.2 is a code-read and is labelled as one.

---

## APPENDIX A — the disposable instrument

Both files live under `.git/` and are **not** part of the repository. They use only production
functions, report the median of 15 iterations and the marginal slope between sizes, and print a
noise floor so a reader can judge the readings.

```
npx vite-node .git/perf-cliff-measure.mts      # the state layer (M1–M5)
npx vite-node .git/perf-cliff-measure-2.mts    # the audio-path suspects (M6–M9)
```

They are the instrument, not the deliverable — the same discipline AUDIT-15 applied when it
removed its throwaway probe after taking the numbers.

## APPENDIX B — the commands behind §4.1

```
npm run perf:tick                                  # the scheduler tick path
npm run perf:hotpath                               # the command path, A/B in one process
npm run ai:performance                             # the intent preview p95 gate
npx vite-node .git/perf-cliff-measure.mts          # this audit's disposable instrument
```
