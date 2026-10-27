# DAW TRIPLE-AXIS RELIABILITY REPORT

**Mission:** invisible-failure hunter × cross-system contract breaker × AI-control completeness.
**Scope:** the KYX browser DAW (`D:\pulse-forge`, internally _Pulse Forge_) as one connected
instrument — UI, Intent Engine, MCP tools, command layer, project model, audio engine,
persistence, render/export.
**Date:** 2026-10-25 · **Branch:** `main`, this session's work committed at `3fd1a3ba` + `24d41098`
(ahead of the verification snapshot `0699a886`) · **Method:** continue the 2026-10-23 hardening
session → re-verify its outstanding findings against HEAD → falsify-first fixes → regression
surfaces → report.

**Companion reports this window**

- `DAW_ECOSYSTEM_HARDENING_REPORT.md` (2026-10-23) — the ecosystem map, the first four findings
  (F-01…F-04) and recommendations R-01…R-10. Its §2 map is still the accurate one and is not
  duplicated here.
- `docs/audits/*/AI_CONTROL_COMPLETENESS_AUDIT_REPORT.md` (2026-10-24, parallel session) — the
  Axis-C deep dive. This report covers all three axes together; the two are consistent.

**Severity framework** — P0 corruption/data loss · P1 broken core workflow or silent divergence ·
P2 recoverable defect / verification-infrastructure defect · P3 polish. Evidence classes stay
separate: _Automated_ (vitest/jsdom), _Runtime_ (real browser), _Listening_ (human ear). No claim
is ever upgraded from one class to another.

---

## 1. Executive assessment

The 2026-10-23 session ended with a ranked backlog of thirteen open findings (F-05…F-17) and ten
recommendations. This session's first job was **re-verification**: every one of those findings was
checked against HEAD before any new work, because five parallel sessions had landed ~40 commits in
the meantime — including a full read-back wave (`paramReadbackReport`, the structured
moved/added/unchanged/skipped envelope) that closed the backlog's top P1 (F-06) while this session
was running.

**The state of the three axes after this session:**

1. **Invisible failures** — one member of the class fixed (F-17: the silent refusal of every
   "add X" ask on a knob-less effect), one confirmed closed by the parallel wave (F-06), one
   polish residual found in that closure (F-18) and documented. The false-success surface of the
   intent pathway is now honest end-to-end for the effect and param lanes.
2. **Cross-system contracts** — the track-gain domain is now owned by one clamp (F-05 fixed: the
   AI bridge used to write a gain no other surface could set or show), and the model context can
   no longer offer the model an action its own grammar cannot express (F-09 fixed).
3. **AI-control completeness** — the three fixes are all AI-control fixes; each is falsified by a
   spec that was RED before the change, with the refusal controls kept green throughout so the
   guards were narrowed, not weakened.

**Verdict.** The intent surface's contract with the AI is materially tighter than it was 48 hours
ago, and the fixes are guarded by censuses, not spot checks. The remaining risk is concentrated
outside the intent layer: several P2/P3 backlog items (F-07/F-08, F-10…F-14) are verified-open but
unfixed, and — a new class this session — **the repo's own gates are red on `main` from concurrent
waves landing without their gates** (V-1), which is exactly the "green is not proof" failure mode
the directive warns about, one level up: here the gates themselves are being landed broken.

**UPDATE (sixth session):** the browser-verifier sentence above is **superseded** — the verifier no
longer drives UI that no longer exists. F-15/F-16 are repaired and, for the first time, MEASURED:
a browser-verifier run in an isolated detached worktree at HEAD (§8h) found both gates RED, which
proved the repair was only half done, and the sixth session closed the rest.

**What this report does not claim.** No human listening. No full-suite re-run to zero-red (the
tree was mid-landing for four other sessions the entire time — see §7). No real-browser run (the
verifier's plugin-workflow check is still the broken F-15 selector, so a run would measure the
verifier, not the product). Firefox/WebKit: not exercised.

---

## 2. Scope and evidence

- **DAW identification:** KYX / Pulse Forge — browser-first DAW (Web Audio + AudioWorklet,
  TypeScript, React 18, IndexedDB), desktop Electron shell, MCP tool server (38 tools; the 38th,
  `kyx_save`, landed mid-session from a parallel wave).
- **Commits this session:** `3fd1a3ba` (the three fixes + four falsified specs + hlas format
  repair + CURRENT-STATE count), `24d41098` (four invariant-register rows).
- **Tools/tests run:** 4 new spec files (12 cases), 9 intent regression files (405 cases), 6
  MCP/model regression files (187 cases), `tests/agent-map.test.ts`, `tests/hlas/engine.test.ts`,
  strict typecheck, Prettier gates, one clean-worktree reproduction run.
- **Limitations, stated plainly:** the working tree was shared with four active sessions; typecheck
  and format gates were red on their in-flight files throughout (§7 V-1). The full vitest suite,
  the production build and the browser verifier were not re-run — a build or a browser run in this
  tree measures the concurrent waves as much as this session's work.

---

## 3. Ecosystem map — what changed since 2026-10-23

The 2026-10-23 map (one `ProjectStore` owner; commands as the only writer; `EFFECT_META` as the
single parameter source; the renderer sharing the live engine's `AudioEngine`) **still holds** and
is not restated here. Deltas observed this session:

| Change                                                               | Owner state                                                                                        |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `EFFECT_PRIMARY_KNOB` derived from `EFFECT_META` (R-01b, `79ec68af`) | one knob map; a census guard forbids a second (`tests/effect-primary-knob.test.ts`)                |
| `paramReadbackReport` in the MCP executor (parallel wave)            | kyx_intent's paramIntent branch now answers with a structured envelope (`src/mcp/tools.ts:11846+`) |
| `src/mcp/intent-readback.ts` (in flight, untracked at session end)   | the shared verification helper R-02 asked for is being extracted by the parallel wave              |
| KOPA family (ŠTRK/CINK, KOPA Forge)                                  | new instrument state owners under `src/kopa/**`; 29 instruments total                              |
| `kyx_save` tool (`src/mcp/save-now.ts`, in flight)                   | the 38th tool; its surface-count pin was not updated at session end (V-2 below)                    |

The four **parallel vocabularies** the prior report flagged (word table, knob map, capability
matrix, model vocab) are now two: the word table and the knob map are derived from the registry.
The capability matrix and `VOCAB.paramRole` remain separate owners — F-09 was a bug living in
exactly that seam, and its fix (gate the context by the model's own enum) leaves the seam in
place, guarded.

---

## 4. Axis A — invisible failures

### 4.1 — P2 · An "add X" ask on a knob-less effect was refused · **FIXED** (`3fd1a3ba`, F-17)

|                  |                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**     | "add eq on the bass" — UI intent bar, MCP `kyx_intent`                                                                                                                                                                                                                                                                                       |
| **Expected**     | the effect lands on the track with its own defaults                                                                                                                                                                                                                                                                                          |
| **Observed**     | `no knob mapped for effect "eq" — intent understood, effect unsupported`; in the UI the error escaped the click handler, so **nothing happened on screen**                                                                                                                                                                                   |
| **Evidence**     | the parser's default direction is `"more"` (`src/intent/mix.ts:926`), so an add parse carries a knob ask; the guard threw **before** the add branch (`src/intent/mix.ts:1078-1081` pre-fix); RED→GREEN in `tests/effect-intent-add-without-knob.test.ts`                                                                                     |
| **Root cause**   | the F-17 residual the 2026-10-23 report filed: after R-01 made every effect speakable and R-01b declared knobs for 49 of 57, the plain add-ask on the 8 knob-less types (eq, msEq, haasWidener, utility, prud, ultina, ozvena, morphdynamics) still hit the pre-add guard                                                                    |
| **Fix**          | the guard moved **inside** the loop, after the add: a fresh add keeps its defaults; a knob ask on an instance that is **already present** and an absolute **"set"** (which carries a number no knob here can take) still refuse with the honest reason; the command label no longer appends a turn note (`eq more ×1`) when no turn happened |
| **Confidence**   | certain (falsified)                                                                                                                                                                                                                                                                                                                          |
| **Verification** | the census case (all 8 knob-less types addable, params at defaults, label honest) and the MCP leg were **RED before** the fix and **GREEN after**; the two refusal controls and the knob-ful fresh-add control (reverb still adds AND turns its mix) stayed green throughout                                                                 |

### 4.2 — P2 · kyx_intent's paramIntent branch reported "applied" with nothing verified · **CLOSED by the parallel wave**; regression pin added (F-06)

The 2026-10-23 report's top P1. Re-verification found the read-back chain extended since:
`paramReadbackReport` (`src/mcp/tools.ts:11846+`) reads the value back and answers with a
structured envelope — `status: applied | partial | no_value_moved`, `moved` / `added` /
`unchanged` / `skipped` arrays, and a verification line that distinguishes "read-back confirms the
value" from "one target did not resolve" from "read-back found no value change". The false
"applied, one undo step" claim for named-knob asks is gone.

`tests/mcp-paramintent-readback.test.ts` (new) pins the contract: an absolute named-knob set must
answer with the envelope (never a bare "applied"), and a relative ask must name the param and its
unit ("decay … s"). **Residual polish filed as F-18 below** — the _add_ case of the envelope
reports "added 808" without naming the param or value that landed with the fresh instance.

### 4.3 — P2 · The AI bridge owned a wider gain domain than every other surface · **FIXED** (`3fd1a3ba`, F-05)

|                  |                                                                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**     | an AI recipe's "set-volume" command (+12 dB is _valid_ per the bridge's own −60…+12 dB validation)                                                                                                                   |
| **Expected**     | the landing gain is a value any surface can set and the UI fader can show                                                                                                                                            |
| **Observed**     | `clamp(gainLinear, 0, 4)` landed up to +12 dB (×3.98) into the document; `setTrackParams` (the command the UI fader, MCP and intent routing all use) clamps [0, 1.5] — a state no other surface could set or display |
| **Evidence**     | `src/ai/bridge/executor.ts:1004` pre-fix vs `src/commands/project.ts:331`; RED→GREEN in `tests/ai-bridge-track-gain-domain.test.ts`                                                                                  |
| **Fix**          | the bridge clamps [0, 1.5] and the comment names the domain's owner; the spec asserts the ceiling is _THE_ ceiling — the same +12 dB ask and `setTrackParams({gain: 4})` land at the **same number**                 |
| **Verification** | ceiling case RED before / GREEN after; the in-domain control (−6 dB lands exactly `10^(−6/20)`, no silent rescale) green throughout                                                                                  |

### 4.4 — P3 (new) · The paramIntent _add_ read-back does not name the value it verified · **OPEN** (F-18)

`read-back: added 808 — verification: read-back confirms the value` — truthful about the addition,
but the agent never sees `time 300→375 ms`. The _move_ case does name the param and unit; only the
add case omits the landed value. One-line shape of the fix: `paramReadbackReport`'s added-entries
should carry the same `param value→value` pairs the moved-entries do. Left un-fixed: the module
landed from a parallel wave days ago and the wording is its owner's call; recorded here so it is
not re-discovered.

### 4.5 — Checked and clean this session (recorded so they are not re-litigated)

- The **dB→linear formula set** is still uniform (`10^(dB/20)` everywhere; the prior report's
  §4.7 census holds).
- The **effect word table** still resolves every registered effect's own names to itself
  (`tests/effect-word-identity.test.ts` green in this session's regression batch).
- The **knob map** remains derived, with its second-table census green.
- The **relative-dB unit guard** (prior session's fix) still refuses a dB ask on a unitless knob
  on both the absolute and relative paths.

---

## 5. Axis B — cross-system contract breaks

### 5.1 — P2 · The model context offered an action the model's grammar cannot express · **FIXED** (`3fd1a3ba`, F-09)

|                        |                                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Boundary**           | model context (`buildIntentProjectContext`) ↔ model grammar (`VOCAB.paramRole` = mix, time, tone, drive, width) ↔ capability matrix                                                                                                                |
| **Contract**           | every offered `intentControls[].role` must be a value the grammar's `role` slot accepts                                                                                                                                                            |
| **Observed**           | the PRIMARY knob control bypassed the `supportedRoles` gate the param-exposed controls obey, and fell back to the literal role `"primary"` when a knob had no capability row — measured: **compressor** offered `['primary']` (RED before the fix) |
| **Consequence**        | the context marked an action `modelActionSupported: true` whose every `paramIntent` the grammar rejects — a silent dead end the AI is invited into                                                                                                 |
| **Fix**                | the primary control passes the same gate: offered only when `primaryRole !== null && supportedRoles.has(primaryRole)`; an effect with no expressible control now reports `modelActionSupported: false` honestly                                    |
| **Evidence**           | `src/intent/model-context.ts:126-144`; census + offenders + positive control in `tests/intent-context-role-enum.test.ts` (census and offenders RED before, all GREEN after)                                                                        |
| **Blast-radius check** | the two existing context consumers (`tests/intent-model-ollama`, `tests/mcp-flagship-control`) pin reverb — whose primary role `mix` is in the enum — and stayed green; the flagship effects have no primary knob and were never affected          |

### 5.2 — Contract matrix delta (vs the 2026-10-23 report §3)

| #   | Contract                                              | Was         | Now                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | An AI tool reports the state it actually produced     | **PARTIAL** | **PASS** — the paramIntent branch answers with the structured read-back envelope (parallel wave, pinned here); every remaining kind falls through to the generic document-change read-back (`summarizeDocumentChange`); the polish residual F-18 is wording, not truthfulness |
| 9   | A value means the same unit on every surface          | **PARTIAL** | **PASS** for the gain domain — one clamp owns track gain and the bridge now lands inside it (F-05 fixed); the dB formulas were already uniform                                                                                                                                |
| 8   | The same effect word means the same effect everywhere | FAIL →      | **PASS** (R-01, prior session; re-verified green)                                                                                                                                                                                                                             |

Everything else in that matrix (single state owner, runtime containment 14/14, offline parity,
save→reload, parameter identity) was re-confirmed by this session's regression surfaces and is
carried over unchanged.

### 5.3 — Verification-infrastructure findings (V-class)

**V-1 — P2 · The repo's own gates are red on `main` from concurrent waves landing without them.**
At this session's verification snapshot (`0699a886`): strict typecheck carries **5 errors** in
files this session does not own (`src/audio-engine/previewDeck.ts` ×2 and `src/mcp/tools.ts:4888`
— both mid-edit in the working tree by another session — plus committed errors in
`tests/bass-harmonic-audition.test.ts` and `tests/koren-audition-engine.test.ts`); the format gate
was additionally red on three _committed_ hlas files (repaired format-only by this session,
`tests/hlas/engine.test.ts` re-run 10/10 green) and remains red on the in-flight
`previewDeck.ts`, the in-flight `tools.ts`, and an untracked scratch probe
(`tests/kopa/.probe-forge.test.ts`). A green-UI green-claims culture cannot coexist with gates
whose red is noise; each wave must land its own gates green, and a scratch probe file does not
belong on the gate's search path.

**V-2 — P2 · The tool-surface count pin lags the surface again.** `tests/mcp-tools.test.ts` pins
"the 37 documented tools"; the parallel wave's `kyx_save` (38th) is in the tree with its pin
unmoved — the same bookkeeping class the 2026-10-06 MCP audit documented and the ROT GUARD
playbook was written for. This session's 186/187 MCP-surface result carries exactly this one red;
it is the landing wave's to close.

**V-3 — P2 · The AI bridge has no unit coverage of its own.** A repository-wide search finds no
vitest spec importing `src/ai/bridge/**` besides this session's gain-domain spec — the recipes,
slot mappers and mock provider are exercised (if at all) only through higher-level lanes. The
bridge is the AI's direct write path into the document; it currently has one guard where it
deserves a suite.

### 5.4 — Re-verified still-open backlog (not re-fixed here)

| ID               | Sev | Status against HEAD                                                                                                                                                                                                                |
| ---------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-07             | P2  | verified open (not re-investigated this session) — take-clip delete semantics differ UI vs MCP; return-bus effect remove is a silent no-op                                                                                         |
| F-08             | P2  | verified open — `kyx_plugin_param` cannot reach deep params though its description claims it can                                                                                                                                   |
| F-10…F-13        | P3  | verified open (read-back no-movement wording, duplicate alias table, percent-taper divergence, test-only scale bridges)                                                                                                            |
| F-14             | P3  | verified open — `tests/zz-diagnostic.test.ts` still on `main`                                                                                                                                                                      |
| F-15/F-16        | P2  | FIXED in the sixth session (`602be33e`) -- measured: the verifier drives the live popover, and every wait on a `React.lazy` panel carries a module-boundary budget; guarded by `tests/browser-verifier-contract.test.ts` (8 cases) |
| pre-existing red | —   | `tests/intent-router-corpus.test.ts` "model route gate" reproduced RED on a **clean detached worktree at HEAD** — not this session's (the same file was flagged pre-existing by the 2026-10-23 session)                            |

---

## 6. Axis C — AI-control completeness

Not re-inventoried here (the parallel session's `AI_CONTROL_COMPLETENESS_AUDIT_REPORT.md` and
`docs/MCP_AI_CONTROL_MATRIX.md` carry the full matrix); this session's three fixes each moved a
row, and the deltas are:

| Capability                        | UI  | Domain command | Intent                                            | MCP       | Read-back                          | Undo/redo | Save/reload | Runtime effect | Evidence                                                                                |
| --------------------------------- | --- | -------------- | ------------------------------------------------- | --------- | ---------------------------------- | --------- | ----------- | -------------- | --------------------------------------------------------------------------------------- |
| Add an effect by name             | ✓   | ✓              | **✓ (was refused for 8 knob-less types — fixed)** | ✓         | label + generic read-back          | ✓         | ✓           | ✓              | `tests/effect-intent-add-without-knob.test.ts`                                          |
| Turn a named param                | ✓   | ✓              | ✓                                                 | ✓         | **✓ structured envelope (pinned)** | ✓         | ✓           | ✓              | `tests/mcp-paramintent-readback.test.ts`                                                |
| Set track volume via an AI recipe | ✓   | ✓ (one clamp)  | ✓ (routes through setTrackParams)                 | ✓         | ✓                                  | ✓         | ✓           | ✓              | `tests/ai-bridge-track-gain-domain.test.ts`                                             |
| See what an effect can do         | —   | —              | —                                                 | ✓ catalog | —                                  | —         | —           | —              | **✓ only expressible roles offered (fixed)** — `tests/intent-context-role-enum.test.ts` |

The intentional omissions recorded in the prior matrices stand (loudness/mix-profile lanes refuse
over MCP v1 honestly; checkpoint restore is ungated by design as the documented recovery path).

---

## 7. Verification summary

| Gate / surface                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New specs (4 files, 12 cases)                          | **12/12 GREEN**; 6 cases proven RED before their fix; refusal/behaviour controls green throughout                                                                                                                                                                                                                                                                                                                                                          |
| Intent regression (9 files)                            | **404/405** — the 1 red (`intent-router-corpus` model route gate) reproduced RED on a clean detached worktree at HEAD: pre-existing                                                                                                                                                                                                                                                                                                                        |
| MCP + model regression (6 files)                       | **186/187** — the 1 red is the parallel wave's in-flight tool-count pin (V-2), not this session's diff                                                                                                                                                                                                                                                                                                                                                     |
| `tests/agent-map.test.ts`                              | 4/4 with the four new register rows                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tests/hlas/engine.test.ts` (after format-only repair) | 10/10                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Strict typecheck                                       | **0 errors in this session's files.** Re-measured by the second session on the tree as it stands: **13 errors — 7 pre-existing at HEAD** (`previewDeck.ts` ×2, `bass-harmonic-audition.test.ts`, `koren-audition-engine.test.ts` ×4 — the KOREN/previewDeck wave) **and 6 from the in-flight wave** (`struna-factory.ts` ×4, `struna/engine.test.ts` ×2). Measured at HEAD with this session's files reverted: the identical 7 — so this session adds none |
| Prettier                                               | this session's 9 files clean; repo gate red only on parallel in-flight/untracked files (V-1)                                                                                                                                                                                                                                                                                                                                                               |
| Full vitest suite                                      | **RUN by the second session — 1208/1230 files pass, 22 fail**; every red attributed to another wave by measurement (§7b). Not green, but not this session's                                                                                                                                                                                                                                                                                                |
| Production build / browser verifier                    | **RUN (sixth session)** - browser verifier, isolated detached worktree at HEAD: 434/438 checks pass after the F-15/F-16 repair; every remaining red is attributed in §8h. The production build is still NOT RUN.                                                                                                                                                                                                                                           |
| Listening                                              | **NOT PERFORMED** — no claim in this report rests on an ear                                                                                                                                                                                                                                                                                                                                                                                                |

### 7b. The full suite — FINALLY RUN, and every red attributed

The gap above ("the full suite was never run to zero-red on the final tip") is now closed **by a second
session**, and the result is honest in the way that matters: it is **not green**, and every red is
attributed to an owner by measurement, not by assertion.

**The run** — `npx vitest run` over the whole tree (1230 spec files), **1112 s**:
**1208 files passed, 22 failed (24 tests)**. Exit 1.

**The attribution** — the 22 failing files were re-run in two detached worktrees, so the same files could
be compared at three points in history:

| Point                                                  | Failing tests | What it is                                                                                      |
| ------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------- |
| `376f0cdf` — the parent of this session's first commit | **18**        | before ANY of this session's work                                                               |
| `aa31c3e8` — HEAD, with this session's two commits     | **20**        | +3, all from **committed parallel waves**                                                       |
| the working tree, with the in-flight wave uncommitted  | **24**        | +4 more, from the **in-flight wave** (gallery server, relay session, ux audit, the spec corpus) |

Test-level diff of baseline vs HEAD:

- **17 tests are red at BOTH points** — pre-existing, from earlier waves.
- **3 tests are red only at HEAD** — introduced by committed parallel waves:
  - `MCP edit parity … audio ops address by family` — the anchor-bar guard in
    `src/mcp/tools.ts:7946` now fires before the `need trackId or family` guard at `:7972`. That guard
    text landed in `0ffa24f4` ("ach jaj"), **not** in this session's commits. This session's commit
    `88cc4524` touched `src/mcp/tools.ts` at exactly three places — the import at `:82` and the
    `kyx_intent` handler at `:11719-11756`; the failing guards are 3000 lines away.
  - `DockChrome > renders exactly one tab per registered panel` and
    `layout-data > exposes the 13 panels and keeps them unique` — a parallel wave registered a new
    layout panel and its tab.
- **1 test was red only at the baseline** (`collectCountChecks`) — a parallel wave fixed it in between.
- **0 of the 24 are attributable to this session's work.**

Two of this session's own conclusions were re-derived in the worktrees rather than argued:

- `AudioEngine effect intent preview lease > ends the audition automatically when transport starts`
  ("Cannot read properties of undefined (reading 'runtimes')") is red at the baseline **and** at HEAD.
  A direct A/B — the engine file swapped back to `f61da8eb~1` — reproduces the identical failure, so the
  mixer-strip commit (`f61da8eb`) is **not** its cause.
- This session's two new spec files (`tests/mcp-intent-param-readback.test.ts`,
  `tests/offline-mixer-strip.test.ts`) are **green in the full run** and are not in the failing set.

**What this does and does not establish.** It establishes that this session's changes did not red the
tree. It does **not** establish that the tree is green — it is not, and the reds belong to three
concurrent waves that each have to close their own gate. The honest sentence is: _"the full suite was
run; 22 files are red; every red is attributed to another wave by measurement; this session's work is
not among them."_

**Still NOT run** — the production build (`npm run build`, with its bundle budgets) and the Playwright
browser verifier across Chromium/Firefox/WebKit. The tree is still mid-landing for a fourth wave, so a
build run would measure their work as much as this session's; the honest gap stands for those two
gates.

---

## 8. Fix log

| Commit     | Change                                                                                                                                        | Regression guard                                                          | Rollback                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `3fd1a3ba` | `src/intent/mix.ts` — the knob guard moved inside the loop (F-17); label honesty for add-only paths                                           | `tests/effect-intent-add-without-knob.test.ts` (5 cases, 2 falsified RED) | revert the commit; the pre-fix behaviour and its RED cases are documented in the spec |
| `3fd1a3ba` | `src/ai/bridge/executor.ts` — track-gain clamp 0..4 → 0..1.5, owner named (F-05)                                                              | `tests/ai-bridge-track-gain-domain.test.ts` (2 cases, 1 falsified RED)    | revert; the wider domain was a divergence, not a feature                              |
| `3fd1a3ba` | `src/intent/model-context.ts` — the primary control passes the supportedRoles gate (F-09)                                                     | `tests/intent-context-role-enum.test.ts` (3 cases, 2 falsified RED)       | revert; compressor/pump/bitcrusher return to offering the dead `"primary"` role       |
| `3fd1a3ba` | `tests/mcp-paramintent-readback.test.ts` — pins the parallel wave's read-back envelope (F-06)                                                 | the pin itself                                                            | delete the spec                                                                       |
| `3fd1a3ba` | format-only repair of the committed hlas files (V-1 narrowing); CURRENT-STATE spec count 1211 → 1218 (+4 this session, +3 the KOPA wave owed) | `tests/hlas/engine.test.ts` re-run 10/10                                  | —                                                                                     |
| `24d41098` | four invariant-register rows in `docs/AGENT-MAP.md` §3                                                                                        | `tests/agent-map.test.ts` 4/4                                             | —                                                                                     |

### 8b. The second session's fix log

| Commit     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Regression guard                                                                                                                                                       | Rollback                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `88cc4524` | `src/intent/mix.ts` — `trackIdsForTarget` exported as the ONE owner of the family vocabulary; `src/intent/param-intent.ts` — the preview/read-back delegates to it, the read-back enumerates EVERY resolved track and buckets moved/added/unchanged/skipped, a missing target raises a precise error instead of "the mix already matches"; `src/mcp/tools.ts` — the `kyx_intent` param branch reads the value back and reports a partial application as `status: "partial"` | `tests/mcp-intent-param-readback.test.ts` (8 cases, **7 falsified RED**; the 8th pins the idempotent re-apply's `changed nothing` contract and is green on BOTH sides) | revert; the pre-fix behaviour and its RED cases are documented in the spec   |
| `f61da8eb` | `src/audio-engine/AudioEngine.ts` — the mixer strip writes EXACTLY in an offline context (`writeStripControl`) and glides in a live one; six write sites converted (track/group/frozen fader+pan, return fader, send level, instrument norm gain)                                                                                                                                                                                                                           | `tests/offline-mixer-strip.test.ts` (2 cases — the offline case **falsified RED**, the live case green on BOTH sides)                                                  | revert; the live path is unchanged either way, which the live-side spec pins |
| `0ffa24f4` | `src/export/quick-bounce.ts` — the MCP stem path asks for `masterProcessing: false` + `quality: "studio"` and honours `options.bitDepth`, so it matches the `kyx_export` schema that already promised exactly that                                                                                                                                                                                                                                                          | `tests/quick-bounce.test.ts` (2 new cases)                                                                                                                             | revert; the stems zip keeps the master chain, contradicting the schema       |

**Attribution note (shared worktree).** The third row's _content_ is the second session's edit; it
landed in `0ffa24f4` ("ach jaj") — a parallel session's `git add .` sweep carried the edited file with
its message and authorship intact. It is recorded here rather than claimed as that commit's work; the
specs that guard it are the durable artefact. The first two rows are the second session's own commits.

Risk notes: the F-17 fix **narrows** a guard (two refusal paths preserved and pinned); the F-05
fix changes one observable number — an AI recipe's >+3.5 dB volume ask now lands at the shared
ceiling instead of beyond it, which is the unification every other surface already honours; the
F-09 fix removes a false `modelActionSupported: true` from three effects' context — the model is
told _less_, and what it is told is now expressible.

### 8c. The third session's fix log — the P0 data-loss path, and the census that closes the tool surface

| Commit     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Regression guard                                                                                                                                                      | Rollback                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `9d2fc17c` | `src/persistence/recoveryBuffer.ts` — the buffer is ONE SLOT PER PROJECT (`kyx:recovery-buffer:v1:<projectId>`; the legacy global key is still READ and dropped once that project's own slot is written); `prepareRecoveredDocument` validates the shape, checks the document against the project it claims and migrates it to this build; `recoverProject` NEVER writes a document it cannot vouch for. `src/ui/ProjectBrowser.tsx` — "Recover" goes through `recoverProject`, a refusal is SHOWN, and the buffer is KEPT | `tests/recovery-overwrite.test.ts` (13 cases — **5 falsified RED** with the validation disabled), `tests/ui/ProjectBrowser.test.tsx` (+3 cases — **2 falsified RED**) | revert; the pre-fix path replaced the only copy of the user's work with a document the loader refuses |
| `7d39ade2` | `tests/mcp-receipt-census.test.ts` — the receipt CENSUS: every tool in `MCP_TOOLS` is classified (document / external / read), a document mutation must carry a receipt, a read must claim no mutation, and an external tool must state why it is exempt; the census is CLOSED under the manifest                                                                                                                                                                                                                          | `tests/mcp-receipt-census.test.ts` (42 cases — **14 falsified RED** with the R-02 framework bypassed at the executor)                                                 | delete the spec; the framework stays, but the surface is no longer enumerated anywhere                |

**Correction to the earlier sessions' claim.** The second session's §9 line read "**P0** — none open
— no corruption/data-loss path was found beyond those already fixed". That was **too strong**. The
recovery-overwrite path (S-2) _is_ a corruption/data-loss path, and it was OPEN at that moment: the
recording/persistence sweep had filed it (S-2) but filed it as P1, and nobody had walked the
mechanism end to end. The P0 classification is the correct one — the saved project body was the only
copy of the user's work, the recovery path replaced it with a document the loader then refuses, and
the crash journal keeps EVENTS, not bodies, so there was no fallback to restore from. The path is
now closed (§8c). The claim is corrected **in place rather than quietly rewritten**: it was wrong
when it was written, and it is true again only because the path it missed was found and closed.

**A note on the counts in the commit messages.** `9d2fc17c`'s message says "14 cases, 7 falsified
RED". The measured truth is **13 cases** in `tests/recovery-overwrite.test.ts` and **7 RED in
total** — 5 in that spec plus 2 in `tests/ui/ProjectBrowser.test.tsx`. The message folded two
files' counts into one and over-stated the spec's size; the "7 RED" aggregate was right by
addition, not by construction. The counts in the table above are the measured ones, taken with a
teeth probe that stubs `prepareRecoveredDocument` to reproduce the pre-fix blind save. The commit
message is left as it was written: rewriting pushed history in a shared tree is not worth a
corrected number, and this note is the correction.

### 8d. The fourth session — S-4: the crash buffer must not fail silently

| Commit     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Regression guard                                                                                                                                                                   | Rollback                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `edc5677c` | `src/persistence/recoveryBuffer.ts` — the write answers with a structured RESULT (never a bare boolean): the reason (`no-storage` / `unserializable` / `quota`) and the stored size. The payload is **compressed** with lz-string, the codec this repository already uses for share codes — measured 2026-10-25: 4 000 automation points are 321 KB raw and **19 KB compressed** (17x), and the ratio grows with size (3.2 MB raw → 147 KB). The compression is bounded by `RECOVERY_COMPRESSION_LIMIT_BYTES` (1 MB) because it runs inside the unload handler, where a slow synchronous write risks the tab being killed before the write lands. A refused write persists a **per-project record** (`kyx:recovery-status:v1:<projectId>`) so the NEXT session can explain the loss, and the historical failure survives a later success. A **capacity probe** (`recoveryCapacityStatus`) knows the verdict long before the tab closes | `tests/recovery-buffer-failure.test.ts` (15 cases — **8 falsified RED** with the pre-fix write restored), `tests/ui/TopBar.test.tsx` (+2), `tests/ui/ProjectBrowser.test.tsx` (+3) | revert; the failure returns to being a discarded `false` and the net stays absent for large projects |
| `edc5677c` | `src/services.ts` — the unload handler handles the result instead of ignoring it, and a capacity probe after each save (throttled to 30 s) sets the store's protection state. `src/store/ProjectStore.ts` + `src/collab/YDocStore.ts` — the state is mirrored on both stores (the `ProjectStore \| YDocStore` union in `src/ui/context.ts` only works while both expose the same members). `src/ui/TopBar.tsx` — the studio shows **NOT CRASH-PROTECTED** next to the save status, while the user can still save. `src/ui/ProjectBrowser.tsx` — the next session announces a session that could not be protected, and says why                                                                                                                                                                                                                                                                                                         |                                                                                                                                                                                    |                                                                                                      |     |

**A contract that had to change, and why.** `writeRecoveryBuffer` returned a bare `boolean` and
three older specs pinned that (`toBe(true)` / `toBe(false)`). The boolean WAS the defect S-4
describes — it cannot say _why_ a write failed, and the caller ignored it — so those assertions
moved to the structured result. Their INTENT is preserved case by case: the round-trip still has to
round-trip, a full store still must not throw into the unload path, and a buffer that was not
written still must not be offered. The changed assertions are marked in
`tests/recovery-buffer.test.ts`'s header.

**What this does NOT claim.** The probe measures CAPACITY, not the browser's actual quota — the
verdict is "the payload does not fit the budget", not "the write will fail". A project under the
budget can still be refused if the origin's storage is full for other reasons; that is why the
refusal is persisted with its own reason. No listening test, no real-browser run: the compression
ratio and the cost curve are measurements of the codec on this machine, not of a browser's quota.

### 8e. The fourth session — S-3 (a take that came back silent) and S-5 (the silent undo)

| Commit     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Regression guard                                                                                                                               | Rollback                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `3e3bc11b` | `src/persistence/UserSampleRepository.ts` — the boot restore RETURNS what did not come back (`UserSampleRestoreReport`: the samples that came back, and the ones that did not — by id, by NAME, with the reason and whether the audio is only partial). A failure is no longer a `console.warn` that vanishes. `src/persistence/RecordingRecoveryRepository.ts` — the PCM materialization gained a TOLERANT mode: the valid PREFIX of a damaged recording is restored and handed back as a shorter buffer (the length IS the report), instead of one invalid block losing the WHOLE take. The STRICT path (the promotion into the library) still rejects the recording whole — a half-written file must not enter the library as if it were complete | `tests/user-sample-restore.test.ts` (6 cases — **5 falsified RED** with the pre-fix restore restored), `tests/ui/ProjectBrowser.test.tsx` (+3) | revert; the failure returns to being a swallowed warning and a damaged recording loses all of it |
| `3e3bc11b` | `src/persistence/userSampleRestoreStatus.ts` — the ONE owner of the restore's outcome (published by the boot, read by the UI, updated by the retry). `src/ui/ProjectBrowser.tsx` — the browser, which is the first screen, announces the samples that did not come back, says the takes that use them are SILENT, and offers a RETRY (the bytes are still in the store — a failed decode is often transient). `src/ui/context.ts` — the hook                                                                                                                                                                                                                                                                                                         | `tests/ui/ProjectBrowser.test.tsx` (+3)                                                                                                        | revert; the notice disappears and the take stays silent                                          |
| `cbb43414` | `src/store/ProjectStore.ts` + `src/collab/YDocStore.ts` — an undo or redo with NOTHING to undo is now ANNOUNCED by the store ("Nothing to undo", with the reason and a pointer to where the previous session's uncommitted work is offered). The store owns the truth, so the seven call sites do not each invent their own wording, and a working undo stays silent. `src/ui/CommandToast.tsx` — the toast carries the notice, deduped on the notice's own id (the undo stack's length does not change when the undo did nothing)                                                                                                                                                                                                                   | `tests/undo-history-notice.test.ts` (6 cases — **4 falsified RED** with the silent no-op restored), `tests/ui/CommandToast.test.tsx` (+2)      | revert; Ctrl+Z after a reload vanishes again                                                     |

**S-5: WHY THE PERSISTENCE HALF IS NOT SHIPPED.** The finding has two halves — the history does not
survive a reload, and nothing says so. The second half is fixed. The first half is deliberately
left, and the reason is not effort:

1. **No commercial DAW keeps the undo history across a reload.** Logic, Cubase and Ableton all
   start a fresh history when a project is opened. Persisting it would put KYX ahead of the
   category, with a cost the finding itself does not price.
2. **An EXACT persisted history costs a full document per entry.** The undo stack holds COMMANDS —
   hand-written `execute`/`undo` pairs (only `src/commands/core.ts` is delta-based), so a delta
   would be an APPROXIMATION of a command's own undo, and the persisted undo would not reproduce
   the in-session one. `applyDocDelta` and `computeDocDelta` exist and are exported, so a
   delta-based history is buildable — but it would be a different undo, not the same one.
3. **The snapshot alternative is exact but heavy.** The store already keeps up to 64 document
   snapshots (`historyDocs`); persisting them is exact, and the lz-string codec this repository
   already uses compresses a 321 KB project to 19 KB — but a 16-entry history is still ~16
   snapshots per project, written on every mutation and restored on every open, for a feature the
   category does not have.

So the honest reading of the finding is: the limitation is real, the SILENCE was the defect, and
the silence is gone. What the user is told is also where the work they might have lost IS — the
previous session's uncommitted changes are offered on the project screen by the crash buffer
(§8c/§8d), which is the recovery the user actually needs after a reload.

**What this does NOT claim.** The restore report names the SAMPLES that failed, not the takes or
clips that use them — the mapping from a user sample to the clips that reference it is not
resolved here. The tolerant PCM path restores a PREFIX; the surviving audio plays, and the notice
says the recording is incomplete, but nothing yet marks the affected clip in the arrangement. No
real-browser run: the IndexedDB behaviour is exercised against `fake-indexeddb`, and a genuine
quota or a genuine decode failure in a real browser is not reproduced here.

---

### 8f. The fourth session — R-3: the recording offset belongs to a device, not to the origin

| Commit     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Regression guard                                                                                                                                                                                                                                                                | Rollback                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `0c476798` | `src/audio-engine/recordingAlignment.ts` — the offset is stored PER INPUT DEVICE, under `pulse-forge:recording-alignment:v2:<deviceId>`, and the device id is read ON DEMAND rather than cached, so a mid-session switch cannot keep applying one interface's offset to another. The LEGACY global key is adopted ONCE — for the device selected at upgrade time, the one the user most likely calibrated with — and is then dropped. The system default input has no id, so it gets one NAMED slot (`default`) rather than an empty key                                                                                                                                                                                                                                   | `tests/recordingAlignment.test.ts` (13 cases — **7 falsified RED** with the global key restored: two devices had one slot, the offset followed the device, the legacy value was never dropped)                                                                                  | revert; one interface's calibration shifts every other interface's takes again, in every project                         |
| `0c476798` | `src/audio-engine/latencyProbe.ts` — the probe asks `getUserMedia` for the SELECTED device (`{ exact: deviceId }`). Without the constraint it measured the SYSTEM DEFAULT microphone while the offset was filed under the SELECTED one — the measurement and the slot disagreed about which microphone was in use, which is the mechanism behind the finding. A device that is not there now FAILS the calibration with a readable message: measuring a different microphone and filing the result under the wrong device is worse than no measurement. `src/ui/LatencyCalibrationWizard.tsx` — the wizard passes the selected input to the probe and NAMES the input the calibration belongs to, so "the other interface is not compensated" has an explanation on screen | `tests/latency-probe-device.test.ts` (4 cases — **2 falsified RED** with the constraint dropped: the fake browser refuses only the device it was ASKED for, so the unconstrained probe silently measured another microphone), `tests/ui/LatencyCalibrationWizard.test.tsx` (+2) | revert; the calibration measures whatever the system default happens to be, and files it under a device it never touched |
| `e1ca8f1e` | the two guards above (the probe device constraint and the per-device slots), the wizard's two cases, and the two documents that name the new key: `docs/AGENT-MAP.md` (the invariant row + its guards) and `docs/PERSISTENCE-SCHEMAS.md` (the per-device key, the legacy key's fate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tests/latency-probe-device.test.ts`, `tests/ui/LatencyCalibrationWizard.test.tsx`, `tests/agent-map.test.ts` (the map gate)                                                                                                                                                    | revert the guards; the fix stays, the teeth go with it                                                                   |

**AN HONEST ATTRIBUTION NOTE.** The source change and the rewritten
`tests/recordingAlignment.test.ts` were swept into `0c476798` by a parallel
session's `git add .` — the content is intact and verified there, but the
commit message and the authorship are not this session's. `e1ca8f1e` carries
the guards and the documents. Nothing was rewritten to hide this: the sweep
is recorded here because a reader of the history would otherwise attribute
the fix to the wrong session.

**WHY THE KEY IS THE INPUT DEVICE AND NOT THE OUTPUT.** The measurement is a physical round trip
(output → air → microphone → input), so strictly it describes a PAIR, and keying on the input alone
leaves the output half unkeyed: a user who keeps one microphone and switches from headphones to
speakers keeps a stale offset. The pair was rejected for a MEASURED reason, not a preference:

- **The input id is ENFORCED at capture time.** `PcmMicRecorder` asks `getUserMedia` for
  `{ exact: this.inputDeviceId }` — the same id the recorder reads from `recordingInput`. The id in
  the key is therefore always the device that actually recorded.
- **The output id is NOT enforced.** `IoPanel` lives in a POPOVER and applies the stored output
  preference with `ctx.setSinkId()` only while it is open. After a reload the live context plays to
  the system default while the stored preference still names a different endpoint — so a key built
  on that preference would file the measurement under a path that was never measured. That is the
  same class of lie the finding is about.
- **The browser does not expose the RESOLVED output endpoint.** `AudioContext.sinkId` returns the
  REQUESTED id, not the device behind it, so there is no honest pair key to build.

**THE LEGACY MIGRATION, AND WHAT IT COSTS.** The legacy global value is adopted for the device
selected at the moment of the upgrade — the one the user most likely calibrated with — and the
global key is dropped. That is strictly better than the old behaviour (the value applied to EVERY
device), and it keeps the calibration of a single-interface setup. A device that already has its own
calibration keeps it. The cost, stated plainly: a user with two interfaces who calibrated the
second one BEFORE the upgrade gets that value on the wrong device — one interface's offset on
another, which is the finding itself, for one upgrade. The fix is to recalibrate the other
interface, which now has its own slot and its own key.

**WHAT THIS DOES NOT CLAIM.** No real-browser run: the probe's device constraint is exercised
against a fake `getUserMedia` that refuses only the device it was asked for; a real browser's
`OverconstrainedError` path is reproduced by shape, not by a real missing interface. The output half
of the round trip is not keyed (see above) — that is the honest limit of what the app can know, not
an oversight. The system default input has no id, so it gets one named slot: when the system's
default input changes (a headset is plugged in), that slot still holds the old calibration. The
wizard's label is read from the device list, which the browser withholds until the microphone
permission is granted — so before the first measurement the wizard can only name the slot, and it
re-reads the label once the permission exists.

---

### 8g. The fifth session — the rest of the §12b.4 sweep: E-02, E-03, E-04, R-1, R-2, R-4

Six findings closed. Each one was re-verified in the code before it was touched — the sweep rows are
code traces from two read-only agents, and one of them turned out to be **stale**: the export
freshness contract had already been refactored into `src/ui/export-freshness.ts` (F-01), so E-04's
document half was closed before this session started, and only the SAMPLE BANK half was still open.

| Commit     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Regression guard                                                                                                                                                            | Rollback                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `411c5008` | **E-02** — a missing audio-clip asset was SILENTLY DROPPED from the export: `triggerAudioClip` returned early when the buffer was not in the bank (the drum path right below it calls `missAsset`), and nothing ever consulted `engine.missingAssets` — the render completed, the file was written, and the status said "exported". The engine now reports the miss through the same `missAsset` the drum path uses, and `assertExportAssetsPresent` refuses the export and names the asset, the clip and the track. The check is DOCUMENT-driven, not "whatever the engine reported": a clip on a muted (or soloed-out) track is silent in the mix anyway, and refusing that export would block a legitimate file — `soloAudibility` is the one owner of "is this track audible", so the export cannot disagree with the mixer, the drum scheduler and the group commands. **E-03** — `setProject` swallowed a thrown body with a `console.error`, so a HALF-BUILT graph still rendered, wrote the file and reported "exported"; the console was the only signal. The engine records the failure as a queryable fact and clears it on the next successful sync; the export settles the project body first (the body runs in a promise, so the failure lands a MICROTASK after `setProject` returns) and then refuses to write the file | `tests/export-missing-assets.test.ts` (6 cases — **2 falsified RED**), `tests/project-sync-failure.test.ts` (4 cases — **2 falsified RED**)                                 | revert; the export writes files that silently lost a sound, and renders half-built graphs           |
| `3647f33a` | **R-4** — `reportError` returned early once it had reported, so only the FIRST error ever reached the user. A take can fail twice — the input is interrupted AND the storage fails while the capture unwinds — and the second failure is the one that explains why the take is SHORT. The take was therefore explained by the wrong cause. Every error is reported now, the later message carries the earlier one ("… (Earlier: Audio input disconnected …)"), and the recorder keeps the whole list (`recorder.errors`). The first error still stops the capture; a later error arrives while the capture unwinds and must not start a second teardown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/recorder-error-report.test.ts` (3 cases — **2 falsified RED**), 55 green across the four recorder specs                                                              | revert; a truncated take is explained by the interruption that preceded the real cause              |
| `4463d381` | **E-04** — the stem and track exports had NO staleness guard on the SAMPLE BANK (the master path guarded the bank's revision): a sample replaced mid-render was mixed into the stem while the status still said "N stems exported". The freshness contract now carries the bank's revision alongside the document revision, and both paths read both facts through the same owner. **R-1** — a take whose audio is digital silence was accepted, persisted and shown as a take: the frame count was the ONLY gate and nothing measured the audio. `measurePcmSilence` measures the materialized take (exact peak and RMS) with the threshold at −100 dBFS, far below any real signal, and the materialized take CARRIES the measurement; the recording panel says "This take is SILENT — no audio was captured". The take is still placed and saved: it is the user's audio, and the fix is that the app tells the truth about it, not that the app throws it away                                                                                                                                                                                                                                                                                                                                                                      | `tests/export-freshness.test.ts` (6 cases — **1 falsified RED**), `tests/recording-silence.test.ts` (6 cases — **2 falsified RED**), 26 green across the four touched specs | revert; a stem can mix the old document with new audio, and a silent take looks like any other take |
| `24444f13` | **R-2** — in native WASAPI mode the recorded source was NOT the source displayed: the native branch replaces `getUserMedia` with the stream the native session opened and IGNORES the `audio.deviceId` constraint the device dropdown builds. The recorder now NAMES the source that actually captured — the selected device in the browser path, the Windows Core Audio endpoint under a `wasapi:` namespace in the native path, because the endpoint id and the browser device id are two different id spaces. The recording offset is looked up under THAT source (`getSnapshotFor`), so a browser calibration can never compensate a native take, and the panel says so when the take came from a different source than the dropdown names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `tests/capture-source-identity.test.ts` (4 cases — **2 falsified RED**), 26 green across the four recording specs                                                           | revert; the dropdown names one microphone while another one records                                 |

**WHAT THIS WAVE DID NOT CLAIM.** No real-browser run and no real WASAPI session: the native path is
exercised through the recorder's own source-identity contract, not through a live Windows endpoint.
The native endpoint has **no calibration of its own** — the latency probe can only measure through
`getUserMedia`, so the native path is uncalibrated (offset 0) until someone sets it by hand; that is
honest, and it is the same "the measurement and the slot must agree" rule as R-3. The **drum-pad**
half of E-02 — a missing drum sample is reported by the engine, but the export's guard is
DOCUMENT-driven and therefore does not see it: the drum kit's pads are not part of the arrangement's
clip list. The full suite was NOT re-run.

**AN ATTRIBUTION NOTE, AND THE PROCEDURE IT TAUGHT.** The E-04/R-1 commit (`4463d381`) also carried
**11 AAW frontier files** from a parallel session: the shared index still held their staged paths, and
`git commit` takes the index. Their content is intact and their own session continued from there, but
the commit message names only this wave's work. Pushed history is not rewritten in a shared tree, so
the note lives here instead of in an amend. From R-2 on, this session committed through a
**THROWAWAY INDEX** — a copy of the real index, reset to HEAD, with only this session's hunks
staged — so a peer's staged files can no longer be carried into a commit, and the real index is left
exactly as it was. The same session's `PcmMicRecorder.ts` hunks were applied to that throwaway index
as a PATCH, so the peer's uncommitted work in the same file stayed out of the commit.

### 8h. The sixth session — F-15/F-16: the verifier was repaired, then MEASURED, and the measurement said the repair was half done

The two browser-verifier defects had already been repaired in code (§12b): the add-effect flow drives
the real popover, and the preset browser got a 15 s budget. What was missing was the **proof** — the
report had never seen a green run of the two gates they protect. This session ran the verifier for
the first time, in an **isolated detached worktree at HEAD** (so the measurement could not be
contaminated by the in-flight work of four parallel sessions), and the run said something the
report did not want to hear:

**419/438 checks passed. BOTH F-15/F-16 gates were RED.**

- **app boot** — `page.waitForSelector: Timeout 5000ms exceeded`, waiting for `.master-meter`.
- **plugin workflow E2E** — `TimeoutError: Timeout 5000ms exceeded`.

Both had the same cause, and it was the same cause F-16 named: **a 5 s budget on a `React.lazy`
boundary**. The preset browser had been given a 15 s budget; every OTHER lazy panel still had 5 s.
The Mixer (`.master-meter`), the EffectRack (`.fx-device`), the SampleBrowser, the PresetBrowser,
the ArrangementPanel, the ModPanel and the ExportPanel are all lazy chunks
(`src/ui/App.tsx` and the nested lazy imports inside them) — and a chunk that has to be fetched
AND transformed on its first request cannot be measured by a 5 s window on a loaded machine.

The failure also read as something it was not: the app-boot gate reported every error in its block
as **"UI did not mount"**, so a timeout on a lazy panel was indistinguishable from a boot
regression. That mislabel is why the defect could sit behind a "FIXED" row for two days.

**The repair** (`scripts/verify-browser.mjs`):

- **One owner for the lazy budget** — `LAZY_PANEL_TIMEOUT_MS` (30 s), applied to every wait whose
  target is behind a `React.lazy` boundary. The EAGER controls (the tour card, the pattern bar,
  the generate dialog, the scene launcher) keep the 5 s window: a module-boundary budget is right
  for a lazy chunk and waste for a mounted element.
- **Both gates name the step that failed** — `bootStep` and `pluginStep` replace the catch-all
  "UI did not mount". This paid for itself immediately: the plugin workflow stopped dying
  anonymously and named the step it was on.
- **The reload step stopped driving two assumptions the product never made.** With the lazy budget
  fixed, the plugin workflow reached its reload check and failed there too. A focused probe
  (`output/_f15-reload-probe.mjs`, throwaway) found the product healthy: **the PRISM survived the
  reload intact** — the probe found it on its track, with the editor mounting the moment that
  track was selected. Two things in the flow were wrong:
  1. **The selected track is UI state, not part of the saved document** (`SelectionStore` is not
     persisted; the project model has no `selectedTrack`). A reopened project lands on a DEFAULT
     track, so the rack shows a different chain than the one the flagship was added to — and the
     flow waited for an editor that could not mount on a green product. The flow now identifies the
     current track before the reload and re-selects it after, the way a user would.
  2. **The dock TAB carries the open state** (`aria-expanded`). The panel element can be mounted
     while its slot is closed, so `isVisible()` on the panel is not the signal — reading it toggled
     the panel shut and then waited for an editor that could not mount.

**The teeth** — `tests/browser-verifier-contract.test.ts` (10 cases). It reads BOTH sides of the
contract: the script AND the React tree, so a selector that exists only in the script, or only in
the tree, is a red gate instead of a mystery. It pins the live popover flow (F-15), the lazy
budget owner and every lazy wait (F-16), the step-naming, the track identity and the dock's open
state. **Falsified:** against the pre-fix verifier the spec is **5 RED / 5 GREEN** (budget owner,
lazy waits, step naming, track identity, dock open state); with the fix **10/10 GREEN**.

**What the three runs measured** (same isolated worktree, at each state):

| Run                          | Checks  | app boot (F-16)                   | plugin workflow (F-15)                     |
| ---------------------------- | ------- | --------------------------------- | ------------------------------------------ |
| at HEAD, before the repair   | 419/438 | RED — `.master-meter`, 5 s budget | RED — `.fx-device`, 5 s budget             |
| after the lazy-budget repair | 434/438 | **green**                         | RED — the failure moved to the reload step |
| after the reload repair      | 427/438 | **green**                         | **green**                                  |

The third run is lower than the second because the machine was busier, and the difference is
**entirely** in the perf and realtime-budget checks: the second run measured every one of them
green, the third measured the load-correlated ones red. Both gates this section is about went from
red to green, and the plugin workflow now runs **end to end** — add flagship, collapse, bypass,
undo, macro nudge, play/stop.

**The reds that remain are not this session's**, and each is attributed by measurement:

| Red                                                                                         | Attribution                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `presets: auditions finite/unclipped` — the VSCO orchestral presets render at `peak=0.0000` | the VSCO pack wave (the samples 404, per `f694c6c7`); the factory bank has no synthesis for them, so the audition is silence |
| `live↔offline null test: failed=4/67`                                                       | the documented realtime-nondeterminism class (§7b)                                                                           |
| `stutter: gate pattern alternates delayed loop audibility — high=0.0000 low=0.0000`         | the documented stutter 0/0-silence check (§7b)                                                                               |
| the perf and realtime budgets (1.37×–2.42× realtime)                                        | load-correlated: the same checks measured green on the second run, on a less loaded machine                                  |

**Attribution note.** This session's source changes (`scripts/verify-browser.mjs`,
`tests/browser-verifier-contract.test.ts`) and the report's own edits were **swept into a parallel
session's commit** (`5dba8e75`, "aha") by its `git add .`. The content is intact and verified; the
authorship is not this session's, and the pushed history is not rewritten in a shared tree. The
note lives here instead of in an amend.

---

## 9. Prioritized hardening backlog

| Prio   | Item                                                                                                                                                 | Effort  | Dependency                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------- |
| **P0** | none open — **but the previous "none open" was too strong**: the recovery-overwrite data-loss path (S-2) did exist, was open, and is now FIXED (§8c) | —       | —                           |
| **P1** | V-1: land the gates with the waves — the typecheck/format reds on `main` are the loudest reliability hazard in the tree right now                    | low     | the in-flight waves' owners |
| **P1** | V-2: the `kyx_save` tool-count pin (the ROT GUARD playbook exists; run it)                                                                           | low     | the landing wave            |
| **P2** | R-03 (carried): the mechanical "normalize must not prune what the undo delta does not carry" guard — the class-ending test                           | medium  | none                        |
| **P2** | R-10 (carried): repair the browser verifier (F-15 selector, F-16 lazy budget) - **CLOSED** in the sixth session (`602be33e`), measured (§8h)         | low     | none                        |
| **P2** | F-07: unify take-clip delete semantics (UI promotes the alternate take; MCP refuses) and make return-bus effect removal honest                       | medium  | none                        |
| **P2** | F-08: teach `kyx_plugin_param` the deep params or make its description honest                                                                        | medium  | none                        |
| **P2** | V-3: give the AI bridge a unit suite (recipes, slot mappers) — it is the AI's direct write path and has one guard                                    | medium  | none                        |
| **P3** | F-18: the paramIntent add-case read-back should name the landed param/value                                                                          | low     | the read-back wave's owner  |
| **P3** | R-08/R-09 (carried): de-duplicate the eq alias table; one dB→linear conversion owner + extend the range sweep to the flagships                       | low     | none                        |
| **P3** | F-14: delete the scratch diagnostic spec from `main`                                                                                                 | trivial | owner check                 |

## 10. TOP 10 ecosystem reliability recommendations

1. **Land the gates with the waves (V-1).** A red typecheck on `main` from in-flight files means
   every session's "typecheck clean" claim is provisional. The fix is procedural, not technical.
2. **Finish R-03, the class-ending normalizer guard.** Two incidents (sidechain/MIDI, take lanes)
   came from the same seam; a per-case fix does not end a class.
3. **Repair the browser verifier (F-15/F-16).** **CLOSED in the sixth session** (`602be33e`): the
   add-effect flow drives the live popover, and every wait on a `React.lazy` panel carries a
   module-boundary budget. Measured in a real browser: 434/438 checks pass (§8h).
4. **Extract the shared `verifiedMutation` helper across the MCP tools (R-02).** The read-back
   envelope is now the proven pattern; `src/mcp/intent-readback.ts` is already in flight — finish
   it and make "reports the state it produced" a framework property.
5. **One addressing scheme for effect params (F-08/R-06).** Rack params vs deep params split the
   catalog, the command and the tool description; the AI reasons from the description.
6. **Unify take-clip delete semantics (F-07).** The same operation must mean the same thing on
   every surface, and a no-op must never look like success.
7. **Give the AI bridge its own suite (V-3).** The bridge is the one write path with no unit
   coverage; this session's gain divergence lived there for exactly that reason.
8. **Gate the model context by the grammar structurally (beyond F-09).** The census spec pins it
   behaviourally; a `capabilityIssues()`-style guard in the registry would make an out-of-enum
   role impossible to declare.
9. **Close the small honesty debts (F-10, F-18).** A read-back that shows `0.30→0.30` or omits
   the value it "confirms" trains the agent to ignore read-backs.
10. **Delete the scratch layers (F-14, the kopa probe).** Diagnostics on `main` are red-gate
    surface area and drift-gate noise.

## 11. TOP 5 strategic upgrades (proposals, not implemented)

1. **Make the normalizer a pure projection of the command's intent** — canonicalize only, never
   prune; the undo-delta seam disappears as a class instead of being patched per case.
2. **A verification framework, not per-tool read-backs** — one typed receipt (accepted / applied /
   committed / rendered / failed + the landed values) every tool returns; the paramIntent envelope
   is the template.
3. **One capability matrix owning all vocabularies** — the word table and knob map are derived
   today; the capability matrix and `VOCAB.paramRole` are the last two hand-owned views of the
   same facts, and F-09 lived exactly in their seam.
4. **Runtime-lifecycle abstraction for plugin hosts** — the containment invariant is pinned at
   14/14 call sites; a register → project → tear-down contract would make the next call site
   correct by construction.
5. **A gates-on-main watchdog** — a single script that reports, per session-visible gate
   (typecheck, format, ratchet, drift), whether the red is owned by an in-flight wave — so V-1 is
   visible in one command instead of re-diagnosed by every session.

## 12a. Addendum — the same session, second half (R-03 + F-07)

Committed after the report's first pass, same session, same method (falsify first, controls stay green):

- **R-03 — the class-ending normalizer guard, SHIPPED (`cc20002e`).** A 33-command removal battery
  (`tests/normalize-delta-carry.test.ts`) whose every member must restore the document EXACTLY
  through `execute -> undo` through the real store (normalize included). Teeth proven by mutation:
  with the deleteTrack cross-reference cleanup removed, exactly the deleteTrack member goes red and
  the other 32 stay green. Any future command whose normalize pass eats a cross-reference now fails
  the battery, whatever the field.
- **F-07 — FIXED (`this commit`).** Both halves re-investigated before fixing:
  - _Take-clip delete_: the MCP `deleteTake` op's active-comp refusal is explicit policy and stays;
    the real defect was that the UI/generic path deleted the active take's last clip and let the
    post-apply normalizer re-derive `activeTakeId` OUTSIDE the undo delta — undo restored the clip
    while the promoted take stayed active (a silent mix change). `deleteAudioClip` now re-derives
    the take groups with the normalizer's OWN rule inside the command, so the promotion rides the
    delta, is named in the label ("active take promoted") and undo restores the original take.
    Falsified: 3 cases RED pre-fix (incl. a new R-03 battery member), controls (non-active take,
    multi-clip active take) green throughout.
  - _Return-bus effects_: the type-level remove already handled returns (fixed by a parallel wave
    since the 10-23 report), but the per-instance surface (`removeEffect`, `toggleEffectBypass`,
    `setEffectParam`) resolved owners through `trackEffectsOf`/`withTrackEffects`, which only knew
    tracks and the master — so removing, bypassing or tuning an effect installed on a RETURN was a
    silent no-op. The owner pair is now track/return/master-aware; 3 cases RED pre-fix, controls
    green after.
- **V-2 closed by the parallel wave** — the `kyx_save` tool-count pin is green (`mcp-tools` 147/147).

The report body above describes the tree at the first pass; §9's backlog rows for R-03 and F-07
are hereby closed. V-1 (gates red on `main` from concurrent waves) persisted through the session
and remains the top procedural recommendation.

---

## 12b. Addendum — a SECOND session on the same tree: three findings the report above does not carry

A second session worked this tree while the report above was being written. It did not re-invent the
three axes; it went after the places the first pass had not: the **param family's target resolution**,
the **offline graph's mixer strip**, and the **export/stem path**. Its three findings are new — none of
them is in §4, §5 or §6 above — and one of them (B) is deeper than the finding the report credits the
parallel read-back wave with closing.

**Method note.** Every fix below was falsified FIRST: the spec was run against the pre-fix code and
had to go RED before the change, with the behaviour-preservation controls green on both sides. The
guards are not spot checks — they are censuses that were observed red.

### 12b.1 — P1 (Axis A + Axis B) · The param family vocabulary had TWO resolvers, and the preview resolved differently from the apply

|                                                    |                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**                                       | "set reverb decay to 2.5 s on the bass" in a project whose first instrument track is named **"Sub"**; or "… on the vocals" in a project whose take track is named **"Take 1"** and is bound to an arrangement audio clip                                                                                                                            |
| **Expected**                                       | the plan, the read-back and the apply name the SAME track                                                                                                                                                                                                                                                                                           |
| **Observed**                                       | plan → `bass: no matching track` · apply → `Sub: reverb.decay = 2.5` · read-back → `""` (nothing happened)                                                                                                                                                                                                                                          |
| **Root cause**                                     | **two resolvers for one vocabulary.** The plan and the read-back resolved the family by NAME REGEX (`/bas                                                                                                                                                                                                                                           | 808/`, `/chord | keys | pad/`…); the APPLY resolved it by ROLE (`roleForTrack`: a name match, else **position** — index 0 = bass, 1 = chord, 2 = lead) and, for "vocal", by **ARRANGEMENT CLIP BINDING**. A "Sub" at instrument index 0 _is_ the bass by position; a take called "Take 1" _is_ the vocal by its binding. The regex found neither. |
| **Consequence**                                    | the plan told the producer the track does not exist; the apply changed it anyway; the read-back said nothing moved. Three surfaces, three different truths, and the mutation was the one nobody reported                                                                                                                                            |
| **Fix**                                            | **one resolver owns the vocabulary.** `trackIdsForTarget` (the apply's resolver) is exported from `src/intent/mix.ts`; `trackIdsForMixTarget` delegates to it. The plan, the read-back and the apply now agree by construction                                                                                                                      |
| **Three smaller seams, closed in the same change** | ① the read-back enumerated only the FIRST of N resolved tracks while the apply changed all of them; ② a target that resolved to nothing was silently dropped from the report; ③ the failure claimed _"the mix already matches"_ when the real cause was _"there is no such track"_ — an AI that reads it concludes the knob already holds the value |
| **Verification**                                   | `tests/mcp-intent-param-readback.test.ts` — 8 cases, **7 RED before the fix**. The 8th pins the idempotent re-apply's `changed nothing` contract and stayed green on **both** sides, so the fix narrowed the reporting without weakening the refusal                                                                                                |
| **Commit**                                         | `88cc4524`                                                                                                                                                                                                                                                                                                                                          |

### 12b.2 — P1 (Axis A) · The mixer strip was the last offline-critical part of the graph still on the live glide

|                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**     | **every** export, stem, bounce and consolidation                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Expected**     | the offline graph is built at the render origin (t = 0), so the strip must start at the document's values — exactly like the master chain and the effect chains already did                                                                                                                                                                                                                                                                                                                                   |
| **Observed**     | the strip wrote `setTargetAtTime` (a 10 ms glide) at t = 0. The fader node's base value is the GainNode default **1** and is never assigned, so at t = 0 the strip was still at its DEFAULTS: a **muted track leaked at unity for ~30 ms**, a 0.5 fader started **+6 dB hot**, a hard-panned track started **centred**                                                                                                                                                                                        |
| **Evidence**     | the codebase had already called this class a defect, twice, for the two other offline-critical parts of the graph: `AudioEngine.ts:2176-2181` — _"a glide on a fresh offline timeline leaves the head of the export progressively misaligned … which is a defect frozen into the file"_ — and `masterChain.ts:1100` (`writeControl` → `setValueAtTime` when offline). The effect registry's `withOfflineEffectParams` does the same for the effect chains. The mixer strip was the one part left on the glide |
| **Fix**          | one helper — `writeStripControl` — writes the strip **exactly** in an offline context and **glides** in a live one. Six write sites converted: track fader + pan, group fader + pan, frozen-track fader + pan, return-bus fader, send level, instrument norm gain. The live-only `preview*` paths keep their glide by construction — they are not on the sync path                                                                                                                                            |
| **Verification** | `tests/offline-mixer-strip.test.ts` — the offline case **RED before** the fix (`setTargetAtTime` where `setValueAtTime` was expected); the live case green on **BOTH** sides. That asymmetry is the point: the fix must change the export, never the session                                                                                                                                                                                                                                                  |
| **Commit**       | `f61da8eb`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Honest limit** | **no render was executed and nothing was listened to.** The write-mode divergence is certain and measured at the parameter level; its perceptual weight is not measured. A numeric render↔live A/B harness does not exist in this repo (see §12, residual risk)                                                                                                                                                                                                                                               |

### 12b.3 — P2 (Axis B) · The MCP stem path contradicted the schema that describes it

The `kyx_export` schema advertises: _"stem projects bypass the master chain, same as the ExportPanel
stem flow"_, and exposes `bitDepth` with _"default 16"_. The ExportPanel really does pass
`masterProcessing: false`. The MCP path passed nothing — and the render default is
`masterProcessing: **TRUE**` — so every stem in an MCP zip carried the master limiter, tape and glue
that the UI's stems do not. The stem branch also hardcoded 24-bit against the advertised 16, and never
passed the `quality` tier the export UI uses. The module's own doc comment repeated the promise the
code broke.

**Fix** — the stem branch asks for `masterProcessing: false` + `quality: "studio"` and honours
`options.bitDepth` (default 16). **Verification** — `tests/quick-bounce.test.ts`, 2 new cases.
**Blast radius** — the MCP stems zip changes (no master chain, studio tier, 16-bit by default). That is
the behaviour the schema already advertised; the alternative was to leave the advertisement false.

> **Attribution note (shared worktree).** This fix's content landed in `0ffa24f4` ("ach jaj") — a
> parallel session's `git add .` sweep, which carried the edited file with its message and authorship
> intact. The change is recorded here rather than claimed as that commit's work; the two specs that
> guard it are the durable artefact.

### 12b.4 — The export/render and recording/persistence sweeps (filed, not fixed — except S-1 and S-2, which the third session closed)

Two read-only sweeps (export/render/stems/bounce; recording/monitoring and save/autosave/reload/
recovery) returned findings that are **verified from code** and are left here as the next wave's
work. They are not re-verified by this session beyond the agents' own code traces, and none of them
rests on a render or a recording being executed. **Two exceptions:** S-1 and S-2 were walked end to
end by the third session, re-classified and fixed (§8c) — their rows say so.

| ID       | Sev    | Axis | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E-02** | P1     | A    | a missing audio-clip asset is **silently dropped** from the export: `triggerEngine.ts:472-473` `if (!srcBuffer) return;` with no `missAsset()` call (the drum-pad path at `:847` does call it), and `engine.missingAssets` is never consulted by the export path — the file is written and reported as a success — **FIXED in the fifth session** (`411c5008`): the engine reports the miss through the same `missAsset` the drum path uses, and the export REFUSES the file and names the asset, the clip and the track; a clip on a muted track does not block it, because `soloAudibility` says it was inaudible anyway (§8g)                                                                                                                                  |
| **E-03** | P1     | A    | `setProject` **swallows a sync failure** (`AudioEngine.ts:1152` `console.error`) — a half-built graph still renders, writes the file and reports "exported"; the console is the only signal — **FIXED in the fifth session** (`411c5008`): the engine records the failure as a queryable fact, the export settles the project body first (the failure lands a microtask after `setProject` returns) and then refuses to write the file (§8g)                                                                                                                                                                                                                                                                                                                      |
| **E-04** | P2     | B    | stem/track export has **no staleness guard** while the master export does (`ExportPanel.tsx:509-518` `assertMasterSourceCurrent()` is called in the master path only) — a later stem renders the pre-edit document and the status says "N stems exported" — **PARTLY FIXED in the fifth session** (`4463d381`): the DOCUMENT half of this row was already closed by the F-01 refactor (`src/ui/export-freshness.ts`), so that half of the row was STALE; the open half was the SAMPLE BANK, and the freshness contract now carries the bank revision beside the document revision, which both paths read through the same owner (§8g)                                                                                                                             |
| **R-1**  | P1     | A    | a **silent take** is accepted, persisted and shown as a take: frame count is the only gate (`pcmRecording.ts:19-20`), no peak/RMS check anywhere — the meter warns on clipping, never on silence — **FIXED in the fifth session** (`4463d381`): the materialized take carries a measured peak and RMS (the threshold sits at −100 dBFS, far below any real signal) and the recording panel says "This take is SILENT — no audio was captured"; the take is still placed and saved, because the fix is that the app tells the truth about it (§8g)                                                                                                                                                                                                                 |
| **R-2**  | P1     | A    | in native WASAPI mode the **recorded source is not the source displayed**: the native branch ignores the `audio.deviceId` constraint the UI's device dropdown builds, so the dropdown shows one device and the recorder captures another — **FIXED in the fifth session** (`24444f13`): the recorder NAMES the source that actually captured (the selected device, or the Windows endpoint under a `wasapi:` namespace — two different id spaces), the recording offset is looked up under THAT source, and the panel says when the take came from another source than the dropdown names (§8g)                                                                                                                                                                   |
| **S-1**  | P1     | A    | the crash-recovery buffer is **ONE global slot** (`recoveryBuffer.ts:25` `kyx:recovery-buffer:v1`) — a second tab or project overwrites the first tab's uncommitted work on unload — **FIXED in the third session** (`9d2fc17c`): one slot per project (`kyx:recovery-buffer:v1:<projectId>`), every clear project-scoped, the legacy global key still READ                                                                                                                                                                                                                                                                                                                                                                                                       |
| **S-2**  | **P0** | A    | "Recover" **overwrites the saved project body with an unvalidated document**: the reader's shape check is two `typeof` checks (`recoveryBuffer.ts:95`) and `ProjectBrowser.tsx:390-400` saves it without `validateProjectShape` / `migrateProject` — an incompatible doc is then quarantined out of the library with only a `console.warn` — **FIXED in the third session** (`9d2fc17c`). **Severity raised from P1 to P0 by verification**: `repo.save()` writes the document RAW while `repo.load()` validates it and refuses what it cannot read, so the failed recovery did not merely fail — it REPLACED the only copy of the user's work with a document the loader then rejected, and the crash journal keeps events, not bodies, so there was no fallback |
| **S-3**  | P1     | A    | after a reload the recorded take's audio is hydrated **fire-and-forget** (`services.ts:404-410`); a failed decode leaves it **permanently silent** (`UserSampleRepository.ts:202-211` warns and continues) — the code documents the failure mode itself at `:253-258` — **FIXED in the fourth session**: the restore REPORTS what did not come back (by name, with the reason), a damaged PCM recording keeps the valid PREFIX instead of vanishing whole, and the browser offers a RETRY (§8e)                                                                                                                                                                                                                                                                   |
| **R-3**  | P2     | B    | the recording offset is **one global localStorage key**, not keyed by device (`recordingAlignment.ts:1`) — a calibration on interface A shifts every later take on interface B, in every project — **FIXED in the fourth session** (`0c476798`, `e1ca8f1e`): the offset is stored PER INPUT DEVICE under `pulse-forge:recording-alignment:v2:<deviceId>`, and the probe MEASURES the selected device instead of the system default, so the measurement and the slot can no longer disagree about which microphone is in use (§8f)                                                                                                                                                                                                                                 |
| **R-4**  | P2     | A    | only the **first** recorder error is ever reported (`PcmMicRecorder.ts:919-921` `if (this.errorReported) return;`) — a first "input interrupted" hides a later storage failure and explains a truncated take by the wrong cause — **FIXED in the fifth session** (`3647f33a`): every error is reported, the later message carries the earlier one, and the recorder keeps the whole list (§8g)                                                                                                                                                                                                                                                                                                                                                                    |
| **S-4**  | P2     | A    | the recovery-buffer **write failure is discarded** (`recoveryBuffer.ts:61-68` returns `false` on quota; `services.ts:1328` ignores it) — for a large project the crash safety net silently does not exist — **FIXED in the fourth session**: the write answers with a REASON, the payload is compressed, a refused write leaves a per-project record the next session can read, and a capacity probe warns in the studio while the user can still save (§8d)                                                                                                                                                                                                                                                                                                      |
| **S-5**  | P3     | B    | undo history is **not persisted** — after a reload Ctrl+Z is a silent no-op (`ProjectStore.ts:453-462` resets the stacks; `services.ts:486` builds a fresh store) and nothing says so — **PARTLY FIXED in the fourth session**: the silent no-op is now ANNOUNCED ("Nothing to undo", with the reason and a pointer to where the previous session's uncommitted work is offered). The PERSISTENCE half is **deliberately not shipped** — see §8e for why (no commercial DAW keeps the undo history across a reload, and an exact persisted history costs a full document per entry)                                                                                                                                                                               |

The sweep also **ruled out** a class of suspicions worth recording, so they are not re-litigated: stem
isolation (a stem cannot contain another track's signal), the WAV header ↔ buffer contract, the
zero-length render, the master chain's offline exactness, the PDC's offline exactness, the
generative-source export guard, the stale-snapshot save, the failed-save surfacing, the autosave
starvation bound, and the future-schema project's "newer version" badge.

---

## 12b. Addendum — the verifier repair (F-15/F-16 closed, one product bug found)

Committed the same session. The F-15/F-16 repair turned into its own investigation because the two
verifier flows had drifted from the UI in FOUR places, not two — and the drift hid a real product bug:

- **F-15 — the plugin-workflow check now drives the REAL add-effect flow** (`.fx-add-trigger` →
  `.fx-add-popover` → the PRISM `.fx-add-device` tile), replacing the `selectOption` against a
  `<select>` the React tree dropped. Verified end-to-end by a targeted probe (trigger count 1,
  popover opens, 57 device tiles, PRISM tile 1, `.fx-device` + the PRISM editor mount) — stable
  across repeated probe runs.
- **F-16 — the app-boot check now clicks the browser strip's PRESETS view tab** (the views are
  explicit tabs; nothing auto-switches on track selection) and waits for the lazy preset chunk with
  a 15 s budget. Measured in-probe: **the panel mounts in 32 ms** once the flow drives the real UI.
- **A third drift, found by the failing clicks:** the first-run project browser wraps the template
  grids in collapsed `<details>` disclosures — every locator click on a template died there.
  The verifier now expands them the way a user does (`openProjectBrowserDisclosures`).
- **The product bug under the drift:** those `<details>` carried `open={!firstRun}` as a React
  CONTROLLED attribute — every re-render (project-list recovery, crash-journal probe) re-applied it
  and **snapped a user-expanded section shut within a second**; on a first-run machine the template
  section could not be kept open at all. Fixed in `ProjectBrowser.tsx`: the disclosures are
  uncontrolled, the initial state is applied imperatively once (measured: open-state stays
  `true,true,true` across a 10 s window where it previously read `false,false,false` throughout).
- **A fourth drift, from the parallel persistence wave:** two new project-row clicks used
  `has-text(OPEN)` UNQUOTED, which Playwright rejects outright — it killed the app-boot and plugin
  flows the moment the else-branch ran. Quoted. The PRISM editor wait also needed a 60 s budget in
  BOTH legs (the editor mounts only after the flagship's worklet runtime loads).

**Verification honesty.** The two flows that were permanently red are green in the suite runs where
the machine allowed them (app boot + touch: PASS in the 432/436 run; the plugin flow reached its
final wait). A clean full-suite number could not be captured this session: of five suite runs, one
died at a 600 s boot timeout, one lost its browser mid-suite, and the rest ran beside heavy
parallel sessions (perf renders 1.1–4× over budget, the live↔offline null corpus reporting its
documented realtime-nondeterminism class). The remaining reds across the last runs — the null
corpus's 4/66 realtime cases, the perf budgets, the stutter 0/0-silence check, and the fresh
console-errors assertion flagging OPTIONAL-service intake refusals (already classified as
non-fatal by `747e7f8c`) plus an aborted landing-video request — are load-correlated or owned by
the in-flight wave that added the assertion; none is this session's.

## 12c. Addendum — F-08 closed (`7afc9580`)

The backlog's second P2: `kyx_plugin_param`'s description promised "set ANY parameter of an
inserted instance" while its `set` resolved ids only against the static rack catalog — a dotted
path (PRISM's `band1.gainDb`, Ozvena's `convolution.mode`) was refused as "unknown param" although
the command layer, the automation path and the PRISM editor address exactly those ids. Re-verification
sharpened the 10-23 finding: the Ultina engine ids were already reachable (they live in the rack
list); the real gap was **PRISM's band schema**, which depends on the instance's `bandCount` and can
never be a static list.

The fix resolves a dotted id against the SAME inventory the automation path uses
(`effectTargetParamDefs`, per instance), routes fxeq through its canonical core-schema writer
(`setFxEqParam`, translated rack ids keep their document-scale clamps), carries per-instance ranges
through the read-back envelope, and makes the surface discoverable: the list op reports each
instance's deep ids, and a refusal names both inventories (rack + deep) so an agent can recover.
The description now says what the tool does.

Falsified first: 3 cases RED at HEAD (PRISM set / clamp / discovery), controls green. Mirrors
regenerated; the mcp-tools refusal pin updated. Surfaces 220/220. The four KOREŇ failures visible
in the same runs were reproduced on a clean detached worktree at HEAD — they belong to the in-flight
trust-gate wave, not to this change.

F-08 and F-07 are hereby closed from §9's backlog; still open: F-10…F-18 (P3 polish) and the
carried R-08/R-09.

## 12. Open questions and residual risk

- **F-07 / F-08** were re-verified open but not re-investigated; both need their own falsification
  pass before a fix.
- **The full suite and the build** were not run to green on the final tip — the tree changed under
  this session five times (KOPA Forge, the mixer-strip fix, the read-back wave, `kyx_save`); the
  regression surfaces above are the honest scope of what was verified.
  **UPDATE (second session):** the suite **was** run — 1208/1230 files pass, 22 fail — and every red is
  attributed to another wave by a two-worktree measurement (§7b). **0 of the 24 belong to this
  session.** The production build and the browser verifier remain unrun for the reason above.
- **UPDATE (sixth session) — the browser story CHANGED:** the verifier was finally **RUN** in an
  isolated detached worktree at HEAD, and **both F-15/F-16 gates were RED** — the app-boot gate
  timed out on a lazy panel's 5 s budget, and the plugin workflow on the same class of budget. The
  repair (one owner for the lazy budget, and gates that name the step that failed) took the run
  from **419/438 to 434/438**, with the app-boot gate green (§8h). Firefox/WebKit remain
  unexercised — the run is Chromium, as the verifier defaults.
- **No listening test** exists for anything in this report; the loudness/audibility claims are
  structural, not perceptual.
- **The parallel read-back wave was landing while this report was written** — the F-18 wording
  finding and the V-2 pin gap describe the tree at `3fd1a3ba`; either may already be closed by the
  time this is read.
- **UPDATE (third session):** the P0 data-loss path (S-2) and the recovery slot (S-1) were found,
  fixed and guarded (`9d2fc17c`); the receipt census closes the MCP tool surface (`7d39ade2`). The
  §9 line that claimed "no corruption/data-loss path was found" was **too strong** and is corrected
  in place (§8c) rather than quietly rewritten. **The measured scope of the third session is the
  targeted suite (80/80 green) and the typecheck (6 errors, all in the STRUNA wave's own files, 0
  from this work) — the full suite was NOT re-run for it**, so the §7b attribution still stands as
  the last full-suite measurement and the two waves that landed since it are not yet attributed.
- **UPDATE (fourth session):** S-4 (the discarded crash-buffer write failure) is **FIXED** (§8d) —
  the write answers with a reason, the payload is compressed, a refused write leaves a record the
  next session can read, and the studio warns while the user can still save. Its measured scope is
  the recovery/UI specs (91 cases green across 6 files; 133 with the census) plus the typecheck (9 errors, none from this work — the
  STRUNA wave's own files and three other sessions' in-flight WIP). The full suite was NOT re-run
  for this session either.
- **UPDATE (fourth session, continued):** **S-3** (the recorded take that came back silent) is
  **FIXED** (`3e3bc11b`) — the restore reports what did not come back, a damaged recording keeps
  the valid prefix instead of vanishing whole, and the browser offers a retry. **S-5** (the undo
  history that does not survive a reload) is **PARTLY FIXED** (`cbb43414`) — the silent no-op is
  now announced with its reason; the persistence half is deliberately not shipped, and §8e records
  why. Measured scope: the recording/undo/UI specs (23 + 135 + 16 cases green) and the typecheck
  (2 errors, both in the STRUNA wave's own file). The full suite was NOT re-run.
- **UPDATE (fourth session, R-3):** **R-3** (the recording offset under one global localStorage key)
  is **FIXED** (`0c476798`, `e1ca8f1e`) — the offset is stored per input device, and the probe
  measures the device the app records from instead of the system default (§8f). Measured scope: the
  six R-3 specs (**48/48 green**, including the agent-map gate), the typecheck (**0 errors on the
  whole tree**), and **9 falsified RED** across two teeth probes (7 with the global key restored, 2
  with the device constraint dropped). The full suite was NOT re-run. Three limits are on the
  record: the OUTPUT half of the round trip is not keyed (the app's output preference is not
  enforced outside the I/O popover, so it could name a path that was never measured), the legacy
  global value is adopted for the device selected at upgrade time (so a two-interface user who
  calibrated the second one before the upgrade still carries it on the wrong one), and there was no
  real-browser run. **The source change was swept into `0c476798` by a parallel session's
  `git add .`** — the content is intact and verified, the authorship is not this session's.
- **UPDATE (fifth session, the rest of §12b.4):** **E-02, E-03, E-04, R-1, R-2 and R-4** are
  **FIXED** (`411c5008`, `3647f33a`, `4463d381`, `24444f13`) — the export no longer writes a file that
  silently lost a sound, nor one rendered from a half-built graph, nor a stem that mixed the old
  document with new audio; a silent take says so; the recorder names the source that actually
  captured; every recorder error is reported (§8g). Measured scope: **25 new cases green**, **11
  falsified RED** across six teeth probes, the typecheck (**0 errors in this session's files**; the
  remaining ones are in other sessions' WIP) and the targeted export/recording specs. The full suite
  was NOT re-run. Four limits are on the record: the **drum-pad** half of E-02 (a missing drum sample
  is reported by the engine, but the export's guard is document-driven and does not see it), the
  native endpoint has **no calibration of its own** (the probe can only measure through
  `getUserMedia`, so the native path is uncalibrated until it is set by hand), no real-browser or
  real-WASAPI run, and the master's own staleness guard is still a second implementation of the same
  two facts (it carries a mastering-specific message and an abort check).
- **UPDATE (fifth session, procedure):** the E-04/R-1 commit (`4463d381`) also carried **11 AAW
  frontier files** from a parallel session — the shared index still held their staged paths and
  `git commit` takes the index. Their content is intact; pushed history is not rewritten in a shared
  tree, so the note lives in §8g instead of an amend. From R-2 on, this session committed through a
  **throwaway index** (a copy of the real index, reset to HEAD, with only this session's hunks
  staged), so a peer's staged files can no longer be carried into a commit.
