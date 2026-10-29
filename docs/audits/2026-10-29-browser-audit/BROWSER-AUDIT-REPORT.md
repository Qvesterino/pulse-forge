# KYX Browser Audit — the first run

| Audit date    | 2026-10-29 (local machine time, ~00:35 → 01:33)                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope         | The real-browser verification gate `npm run test:browser` (`scripts/verify-browser.mjs`), run end-to-end **for the first time**. Read-only measurement — the audit changed no product code. |
| Environment   | Playwright **Chromium** (headless), `C:\Users\danie\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe`; Vite **dev server** on `PORT=5217` (not `dist/`).                   |
| Raw evidence  | `browser-audit.log` in this folder (875 lines, the complete run output).                                                                                                                    |
| Evidence rule | Every number below is copied from that log. **First measurement** means the class had no prior baseline — it is not a regression introduced by any wave.                                    |

> **CORRECTION (2026-10-29, ~08:15).** This report's reading of the parity class was **wrong**, and the error is recorded here rather than quietly edited away. A parallel session measured the mechanism: the live branch's capture starts `CAPTURE_START_LEAD_SEC` (**0.5 s**) into the live context, so every realtime worklet had already processed half a second of history — a free-running modulation phase, a filter's memory, a comb's drift, a pitch tracker's buffer — while the offline branch started **cold**. The two branches were compared at the same **nominal** time while their internal state differed by a whole capture lead. With the offline render given the same lead (`ae372bf4`), three of the four cases become **bit-identical** and the fourth falls to **−72.7 dB**, below the corpus's own floor. The corpus then reports **439/439 passed, `passed = 67/67`** — with **no product change**. The divergence measured here was **the harness, not the engine**: see `HIDDEN_CREATIVE_POWER_AUDIT_REPORT.md` §10.16.5.
>
> The lesson generalises past audio: **reproducibility is a property of the measurement, not of the product.** A deterministic harness artefact looks identical on every platform and every commit, forever — which is exactly why it reads as a solid product finding.
>
> What this correction does **not** retract: the multi-tap delay class (2) and the performance class (3). Neither was explained by the capture lead, and the performance class was measured under load and still needs an isolated re-measure.

## Re-measurement — an idle machine, the committed tree

| Item       | Value                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| When       | 2026-10-29, ~08:50 → 09:40 (local)                                                                         |
| Tree       | `e1cfe92b` — the **committed** tree, in an isolated worktree (`D:\wt-w8`), **not** the shared working tree |
| Machine    | idle — CPU load **5 %** before the run (the first run shared the box with parallel sessions at ~76 %)      |
| Command    | `PORT=5217 npm run test:browser`                                                                           |
| Raw log    | `browser-audit-remeasure.log` in this folder                                                               |
| **Result** | **438 of 439 checks passed** — one red, and it is not the one this report first named                      |

**All three classes moved, and only one of them was a product defect.**

| Class                           | First run (loaded, shared tree)                               | Re-measurement (idle, committed tree)                                                                                                                                                                                                 | Verdict                                                                                          |
| ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1 — live↔offline parity         | failed **4/67** — ozvena, morphdynamics, bassHarmonic, portal | failed **1/77** — `instrument:ladic` (null **−9.8 dB**, corr 0.9471, **offset −336 samples**); **8 cases "not measurable"** (the realtime branch did not reproduce itself): fx:reverb, instrument:808/keys/bell/reese/clav/acid/pluck | the four effect cases are **gone** — they were the capture lead. **One instrument case is open** |
| 2 — multi-tap delay determinism | **FAIL**, `maxDiff = 2.10e-3`                                 | **PASS**, `maxDiff = 2.38e-7`                                                                                                                                                                                                         | **intermittent** — see below                                                                     |
| 3 — performance                 | 12 failures; renders 0.94–1.60× realtime                      | **all PASS** — 0.19–0.79× realtime; `environment=measurable`, `calib=10.9 ms`, `spread=1.0×`                                                                                                                                          | **not a defect** — the first run measured a loaded machine                                       |

### Class 3 measured properly — the product is fast enough

| Metric                                               | Loaded (first run)            | Idle (re-measurement)                                     |
| ---------------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| 8-bar render, average of 14 templates                | 16697 ms (**1.03×** realtime) | **5735 ms (0.36× realtime)**                              |
| 8-bar render, worst template                         | 29580 ms (1.37×)              | **11617 ms (0.79×)**                                      |
| Realtime heartbeat vs expected period                | 317.26 ms (**1.86×**)         | **173.89 ms (1.02×)**                                     |
| Realtime xruns                                       | 0                             | **0**                                                     |
| 8 tracks × 4 effects render vs single-track baseline | 34671 ms (4.32× baseline)     | **12152 ms (5.09× baseline, inside the 14389 ms budget)** |

The new environment line did its job: the gate states `environment=measurable` (calibration 10.9 ms against an 18 ms floor, spread 1.0×) **before** deciding, instead of reporting a red count a reader has to interpret. The first run had no such line — which is precisely why a loaded box looked like a slow product.

### Class 2 is intermittent, so a green run proves nothing

The multi-tap check **failed at `maxDiff = 2.10e-3`** in the first run and **passed at `maxDiff = 2.38e-7`** in the second. Between the two runs **no commit touched `public/`, `src/audio-worklets/` or `src/effects/`** — the delay path is byte-identical. So the same committed bytes produced a red and a green, and the difference is either the shared tree's state (it carried a peer session's uncommitted work) or run-to-run intermittency.

The documented history says the alternation is real: _"render sequence r1..r6 gives A, B, A, B, A, B with A==A and B==B"_ (`docs/PLUGIN-AUDIT-FOLLOWUP-ROADMAP.md`). **An intermittent green is not a fix.** The defect is real; the gate is currently unreliable — which is the more dangerous shape, because it stops a regression from being seen.

## Executive summary

**Two runs, one product.** The first run (2026-10-29, ~00:35, shared tree, machine ~76 % busy) reported **424 of 438**. The re-measurement on an idle machine against the committed tree (`e1cfe92b`, ~08:50) reported **438 of 439**. The gate had never been run before, so the first picture was also the least trustworthy: it was taken on a loaded box, and it read the parity class through a harness that compared two branches at different internal state.

What is **proven working** (both runs): engine lifecycle, the whole factory/drum/preset banks (207 + 38 + 671 assets), 57 effects, the offline render and export path (pattern, song, stems, WAV), the ogg-opus and m4a-aac round-trips, the two-page collaborative session, the embed player, the share link, the touch gesture, the plug-in workflow, the granular worklet's bit-identical repeats, all 15 templates rendering, the intent production path, and the realtime thread with **zero xruns**.

What is **open**, in order:

1. **`instrument:ladic` — the live path and the export do not match.** Null **−9.8 dB** against a clean-null criterion of ≤ −40 dB, `corr = 0.9471`, and an **offset of −336 samples** (≈ 7 ms): the live render's note starts a hair away from where the offline render puts it. The offline control is clean (−319.2 dB) and the live branch reproduces itself (−319.2 dB), so neither the device clock nor the capture lead explains it. One instrument, one case, one number.
2. **The multi-tap delay is intermittently non-deterministic** — `maxDiff = 2.10e-3` (fail) in one run, `2.38e-7` (pass) in the next, with byte-identical delay code. The documented A/B alternation (`docs/PLUGIN-AUDIT-FOLLOWUP-ROADMAP.md`) says the defect is real; an intermittent green is not a fix.
3. **Eight parity cases this machine cannot measure** — fx:reverb and seven instruments (808, keys, bell, reese, clav, acid, pluck) where the realtime branch does not reproduce itself. The corpus now says so in the verdict instead of counting them as failures; on a measurable machine they still need a verdict.
4. **Performance is not a defect.** On an idle machine: 8-bar renders **0.19–0.79× realtime**, aggregate **0.36×**, realtime heartbeat **1.02×** of its expected period, **0 xruns**. The first run's 12 perf failures measured a loaded machine.

## What passed (424 checks)

| Area                                       | Evidence in the log                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine lifecycle                           | 3× init→process→teardown→reinit clean                                                                                                                     |
| Factory bank, audibility, reproducibility  | 207/207 buffers generated; all audible; catalogue reproducible ≤ 1 ULP (differing 6/7, maxDelta 8.94e-7)                                                  |
| Drum bank                                  | 38/38 audible, finite, distinct                                                                                                                           |
| Presets                                    | 671/671 finite, unclipped, loudness map in sync                                                                                                           |
| Effect constructors and rendering          | eq, msEq, multiband, compressor, saturation … construct and render a non-zero signal                                                                      |
| Parity obligation                          | fx = 38, instruments = 29, + 2 — every effect/instrument is null-tested or explicitly excluded                                                            |
| Curated library, RR variants, SVF fold     | 146/146 curated overrides loaded end-to-end; RR variants re-derived; folded harmonics 8.89e-6 of the fundamental                                          |
| Granular worklet                           | audible **and** bit-identical across repeats                                                                                                              |
| Offline render and export                  | pattern, song, stems, WAV                                                                                                                                 |
| Sampler / FM / LFO / automation ramps      | all pass                                                                                                                                                  |
| Codec round-trips                          | ogg-opus (rms 0.4193) and m4a-aac (rms 0.4146)                                                                                                            |
| PDC gate and export alignment              | pass                                                                                                                                                      |
| Offline generation                         | preview → accept → undo/redo → JSON export → reload preserved the pattern                                                                                 |
| App boot, collab sync, instant jam         | boot opens a template with panels mounted; two pages sync edits + presence; late joiner adopts the shared transport (spread 123 ticks)                    |
| Embed, share link, touch, plug-in workflow | embed player renders and plays; `?import=` opens the project; long-press opens the step editor; flagship effect add/collapse/bypass/undo/macro-nudge pass |

## Class 1 — live↔offline parity (1 check, 4 failing cases)

> **Status after the re-measurement:** the four effect cases are **withdrawn** — they were the capture lead. The class now carries **one** failing case, `instrument:ladic` (null −9.8 dB, offset −336 samples), plus eight cases this machine cannot measure. The numbers below are the **first run's**, kept as the historical record of what the harness reported before the fix.

The gate renders the same effect through the same engine twice: once on a live `AudioContext`, once on an `OfflineAudioContext`, then nulls the two waveforms. The criterion is a **clean null (≤ −40 dB)**, because the product promise is that the export is the thing you heard.

| Case               | null (live↔offline) | corr   | live↔live null | offline control | verdict               |
| ------------------ | ------------------- | ------ | -------------- | --------------- | --------------------- |
| `fx:ozvena`        | −39.2 dB            | 0.9999 | −332.9 dB      | −332.9 dB       | fails (−40 dB needed) |
| `fx:morphdynamics` | −29.7 dB            | 0.9997 | −331.0 dB      | −330.8 dB       | fails                 |
| `fx:bassHarmonic`  | −27.2 dB            | 0.9991 | −332.2 dB      | −332.2 dB       | fails                 |
| `fx:portal`        | −7.1 dB             | 0.9019 | −331.6 dB      | −331.6 dB       | fails                 |

**The gate's own escape hatch does not apply.** The corpus accepts a case when the _realtime_ branch is itself nondeterministic (live↔live within 3 dB of live↔offline, offline control clean) — i.e. when the divergence is the device clock rather than the engine. Here live↔live nulls at **−331 dB** (the realtime path is reproducible) and the offline control is clean, so `realtimeNondeterministic = false` on every case. **The divergence is between the two engine branches.**

> **WITHDRAWN 2026-10-29.** The paragraph above is the reasoning this report gave at the time, and it is the reasoning that was **falsified**: the escape hatch was designed to catch a device-clock divergence, and it did not fire because the divergence was neither — it was the two branches sitting at different **internal state** levels, which the harness's own escape hatch does not model. The reading "therefore the engine diverges" was the wrong inference from correct numbers. See the correction at the top of this report and §10.16.5 of `HIDDEN_CREATIVE_POWER_AUDIT_REPORT.md`.

**The correlation numbers must not be read as "close enough."** Pearson correlation saturates quadratically in the error (`corr ≈ 1 − e²/2`), so `corr = 0.9999` only says "the error is below roughly −40 dB" — it cannot distinguish −40 dB from −45 dB, and it says nothing useful about a −7 dB error. The **null in dB** is the acceptance criterion; the correlation is diagnostic, as the gate's own message states.

`fx:portal` is qualitatively different from the other three: `corr = 0.9019` with `segTail = −5.5 dB` is a spectral/timing difference, not a rounding tail.

The same four null figures were observed on a different platform earlier — which was read here as "engine divergence, not an environment artifact". **That inference was wrong.** The stability across platforms is exactly what a deterministic _harness_ artefact looks like; it proved the cause was reproducible, not that the cause was the engine.

## Class 2 — multi-tap delay determinism (1 check)

> **Status after the re-measurement:** the check **passed** (`maxDiff = 2.38e-7`) on byte-identical delay code — which is _worse_ news than a stable red, because an intermittent gate stops a regression from being seen. The documented A/B alternation is the mechanism to fix.

`maxDiff = 2.10e-3`, `wetPeak = 0.8718`. Two renders of the same multi-tap delay worklet are **not** bit-identical. The feedback path is audible (wetPeak 0.87), so the defect lives in the loop itself — a state variable that survives or leaks between renders (delay-line read/write ordering, or a denormal/dither path). Bounded and fixable: the class of defect that matters most in a product whose selling point is a **reproducible** export.

## Class 3 — performance (12 checks)

> **Status after the re-measurement:** **withdrawn as a defect.** On an idle machine every perf check passes — 0.19–0.79× realtime, heartbeat 1.02×, 0 xruns. The numbers below are the first run's, and they measured a **loaded machine**, not the product. The gate now says so itself (`environment=measurable`) before it decides.

### Template render budget (8-bar render, budget = 0.9 × audio duration)

| Template   | render   | audio    | budget   | factor |
| ---------- | -------- | -------- | -------- | ------ |
| house      | 14687 ms | 15684 ms | 14115 ms | 0.94×  |
| techno     | 19093 ms | 14745 ms | 13271 ms | 1.29×  |
| ukg        | 17446 ms | 14636 ms | 13172 ms | 1.19×  |
| phonk      | 13006 ms | 13441 ms | 12097 ms | 0.97×  |
| drill      | 14675 ms | 13721 ms | 12349 ms | 1.07×  |
| lofi-house | 26313 ms | 16471 ms | 14824 ms | 1.60×  |
| reggaeton  | 25808 ms | 20200 ms | 18180 ms | 1.28×  |
| boombap    | 29580 ms | 21533 ms | 19380 ms | 1.37×  |
| vlyx-demo  | 20646 ms | 16200 ms | 14580 ms | 1.27×  |

Aggregate: `avg = 16697 ms`, `worst = 29580 ms` over 14 templates, `aggregate = 1.03× realtime`.

### Realtime budget

`blocks = 512`, **`xruns = 0`**, heartbeat `avg = 317.26 ms`, `max = 327.10 ms` against an expected `≈ 170.67 ms` (**1.86×**), quantum 2.667 ms.

`xruns = 0` matters: the realtime thread **never dropped a block**. The heartbeat is _late_, not _starved_ — a different failure from an xruns problem, and it points at scheduling granularity and per-quantum work rather than at buffer underrun.

### Multi-track render scaling

8 tracks × 4 effects: **34671 ms** against an 8026 ms single-track baseline for 16500 ms of audio (budget 20026 ms → **4.32× baseline**). The render cost does not scale with the track count; it scales far worse.

### The load caveat — read this before calling it a defect

The run shared the machine with parallel agent sessions; **CPU load was measured at ~76 % during the run**. These numbers are therefore **evidence that the class exists and needs an isolated measurement**, not yet evidence of a product defect. A re-run on an idle machine decides it. (Compare: the same numbers were reproducible across platforms, which is how class 1 was separated from class 3 — reproducible-across-platforms means product, differs-between-runs means environment.)

## Limits of this audit

1. **Chromium only.** The gate ran one engine. `scripts/verify-browser.mjs` supports `KYX_BROWSER_ENGINE=firefox|webkit`, but no run happened.
2. **No human listening.** Every check is a numeric or null assertion. "Audible" in the gate means "above a numeric floor" — never "sounds good".
3. **Dev server, not `dist/`.** The script boots the Vite dev server, so this validates the source path, not the production bundle.
4. **Load contamination** in class 3 — see above.
5. **No prior baseline.** Every failure above is a _first_ measurement, not a regression.
6. **The gate is a browser-check suite (`src/browser-checks.ts`), not the vitest specs.** That is exactly the blind spot `docs/AGENT-MAP.md` records: a DSP-level regression guard written as a vitest spec guarded by `skipIf(typeof OfflineAudioContext === "undefined")` never runs anywhere — jsdom has no `OfflineAudioContext`, and the browser suite never picks the spec up. A gate that never fires looks exactly like a gate that holds.

## Next actions, ordered by what a user feels

1. **Live↔offline parity** — the engine's core contract ("the export is the thing you heard"). Four named effects, a named threshold, a reproducible measurement. Highest value, and it is the one finding here that is already proven to be a product defect.
2. **Re-measure performance on an idle machine** — decide whether class 3 is a defect or an artifact of a loaded box. Same script, same command, only the machine state changes.
3. **Multi-tap determinism** — a determinism defect in a product that promises reproducible exports is a bug worth fixing before either of the above.

## How to reproduce

```bash
PORT=5217 npm run test:browser          # dev server; override the port when 5199 is contended
```

The run leaves `dist/` untouched. The budget gate is separate and does not depend on this suite:

```bash
node scripts/check-bundle-size.mjs       # [size-budget] OK
```
