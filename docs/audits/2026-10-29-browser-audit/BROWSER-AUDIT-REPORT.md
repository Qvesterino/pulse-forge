# KYX Browser Audit — the first run

| Audit date    | 2026-10-29 (local machine time, ~00:35 → 01:33)                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope         | The real-browser verification gate `npm run test:browser` (`scripts/verify-browser.mjs`), run end-to-end **for the first time**. Read-only measurement — the audit changed no product code. |
| Environment   | Playwright **Chromium** (headless), `C:\Users\danie\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe`; Vite **dev server** on `PORT=5217` (not `dist/`).                   |
| Raw evidence  | `browser-audit.log` in this folder (875 lines, the complete run output).                                                                                                                    |
| Evidence rule | Every number below is copied from that log. **First measurement** means the class had no prior baseline — it is not a regression introduced by any wave.                                    |

## Executive summary

**424 of 438 checks passed. 14 failed, in three classes.**

The gate had never been run before, so this is the first honest picture of the browser product. The bulk of the surface is **proven working**: engine lifecycle, the whole factory/drum/preset banks (207 + 38 + 671 assets), 57 effects, the offline render and export path (pattern, song, stems, WAV), the ogg-opus and m4a-aac round-trips, the two-page collaborative session, the embed player, the share link, the touch gesture, the plug-in workflow, and the granular worklet's bit-identical repeats.

What it found is three classes that no automated gate had ever seen:

1. **live↔offline parity breaks on 4 of 67 effect cases** — `fx:ozvena` (−39.2 dB), `fx:morphdynamics` (−29.7 dB), `fx:bassHarmonic` (−27.2 dB), `fx:portal` (−7.1 dB). The null test needs ≤ −40 dB.
2. **The multi-tap delay worklet is not bit-deterministic across renders** — `maxDiff = 2.10e-3` on two renders of the same input.
3. **12 performance checks are over budget** — 9 of 15 templates blow the 8-bar render budget (up to 1.60× realtime), the realtime heartbeat runs 1.86× its expected period, and an 8-track × 4-effect render takes 4.32× its single-track baseline. **Caveat: the run shared the machine with parallel agent sessions at ~76 % CPU load, so this class needs an isolated re-measure before it is called a defect.**

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

The gate renders the same effect through the same engine twice: once on a live `AudioContext`, once on an `OfflineAudioContext`, then nulls the two waveforms. The criterion is a **clean null (≤ −40 dB)**, because the product promise is that the export is the thing you heard.

| Case               | null (live↔offline) | corr   | live↔live null | offline control | verdict               |
| ------------------ | ------------------- | ------ | -------------- | --------------- | --------------------- |
| `fx:ozvena`        | −39.2 dB            | 0.9999 | −332.9 dB      | −332.9 dB       | fails (−40 dB needed) |
| `fx:morphdynamics` | −29.7 dB            | 0.9997 | −331.0 dB      | −330.8 dB       | fails                 |
| `fx:bassHarmonic`  | −27.2 dB            | 0.9991 | −332.2 dB      | −332.2 dB       | fails                 |
| `fx:portal`        | −7.1 dB             | 0.9019 | −331.6 dB      | −331.6 dB       | fails                 |

**The gate's own escape hatch does not apply.** The corpus accepts a case when the _realtime_ branch is itself nondeterministic (live↔live within 3 dB of live↔offline, offline control clean) — i.e. when the divergence is the device clock rather than the engine. Here live↔live nulls at **−331 dB** (the realtime path is reproducible) and the offline control is clean, so `realtimeNondeterministic = false` on every case. **The divergence is between the two engine branches.**

**The correlation numbers must not be read as "close enough."** Pearson correlation saturates quadratically in the error (`corr ≈ 1 − e²/2`), so `corr = 0.9999` only says "the error is below roughly −40 dB" — it cannot distinguish −40 dB from −45 dB, and it says nothing useful about a −7 dB error. The **null in dB** is the acceptance criterion; the correlation is diagnostic, as the gate's own message states.

`fx:portal` is qualitatively different from the other three: `corr = 0.9019` with `segTail = −5.5 dB` is a spectral/timing difference, not a rounding tail.

The same four null figures were observed on a different platform earlier, so this is **engine divergence, not an environment artifact**.

## Class 2 — multi-tap delay determinism (1 check)

`maxDiff = 2.10e-3`, `wetPeak = 0.8718`. Two renders of the same multi-tap delay worklet are **not** bit-identical. The feedback path is audible (wetPeak 0.87), so the defect lives in the loop itself — a state variable that survives or leaks between renders (delay-line read/write ordering, or a denormal/dither path). Bounded and fixable: the class of defect that matters most in a product whose selling point is a **reproducible** export.

## Class 3 — performance (12 checks)

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
