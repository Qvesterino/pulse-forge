# CAMPAIGN_STATE — CROSS-PLATFORM READINESS CAMPAIGN

**Objective:** make Pulse Forge's product behavior explicit enough that a
future Android / iOS / desktop implementation can *reuse* behavior and
architectural contracts instead of reverse-engineering them. This campaign
does **not** translate code to Kotlin/Swift — it prepares the ground
(contracts, state models, persistence clarity, golden behaviors, parity
tests).

**Started:** 2026-09-21 · **Source prompt:** user-issued
"CROSS-PLATFORM READINESS CAMPAIGN" (13 sequential goals).
**Full audit detail:** `docs/PORTABILITY_MAP.md` · **Session records:**
`AGENT_WORK_LOG.md` (append per goal, match existing entry style).

---

## Execution contract (recap)

Do not merely report problems: investigate → root-cause → smallest safe fix →
implement when evidence suffices → validate → inspect regressions → update
this file → continue. Prefer architecture-preserving changes. Each goal runs
as its own session. Before every goal: read this file, inspect previous work,
continue from existing evidence.

## Goal ledger

| # | Goal | Status | Evidence |
|---|---|---|---|
| 01 | Portability readiness audit | **DONE** (2026-09-21) | `docs/PORTABILITY_MAP.md`, work log GOAL 01, fixes in `src/export/download.ts` (+4 call sites), `src/intent/audition.ts` |
| 02 | Domain logic extraction | pending | extraction queue already drafted — PORTABILITY_MAP §5 items 7–8 |
| 03 | Platform contract definition | pending | seam inventory ready — PORTABILITY_MAP §3 |
| 04 | State machine formalization | pending | |
| 05 | Persistence & schema evolution | pending | single choke point confirmed (`persistence/db.ts`, SCHEMA_VERSION 1, DB_VERSION 12); YDocAdapter = 2nd serialization path (drift risk) |
| 06 | Golden behavior & parity tests | pending | existing goldens inventoried (ultina/fxeq/ozvena/morph vectors, golden-render, intent-pipeline) |
| 07 | Error boundaries & fault containment | pending | worker breaker/timeout pattern + jsdom guards already mapped |
| 08 | Risk-based test coverage expansion | pending | |
| 09 | Determinism & reproducibility audit | pending | known targets: `shared/velocityFx.ts` bare Math.random, wall-clock ids in `commands.ts:4012/2925` |
| 10 | Mobile readiness audit | pending | |
| 11 | Platform capability matrix (`PLATFORM_CAPABILITY_MATRIX.md`) | pending | feed from PORTABILITY_MAP |
| 12 | Migration readiness review (`CROSS_PLATFORM_READINESS_REPORT.md`) | pending | |
| 13 | Porting slice plan | pending | blocked by 12 |

## Highest-risk portability dependencies (GOAL 01 verdict)

Ranked, with contract-owner goals — full reasoning in
`docs/PORTABILITY_MAP.md` §5:

1. Root-absolute asset serving (worklets + models) → GOAL 03 asset-resolver contract.
2. Persistence decodes audio via throwaway OfflineAudioContext (3 repos) → GOAL 03 audio-decode contract.
3. Audio I/O: mic/MIDI/second-live-contexts (video export, intent audition) → GOAL 03/04.
4. Worker-everything + sync main-thread fallbacks → GOAL 11 matrix.
5. PWA/offline model bound to Vite plugins → GOAL 11 matrix.
6. Collab ws/wss endpoints derived from `location` → GOAL 03 network contract.
7. Export encoders pull React via `packCode.ts` → ui imports → GOAL 02 extraction.
8. Instrument/effect DEFINITIONS entangled with audio RUNTIME registries → GOAL 02 extraction (largest payoff).

## Environment cautions (read every session)

- **A concurrent agent session edits this repo live** (as of 2026-09-21:
  morph-dynamics listening-room tooling + symbolic-melodic model retrain,
  uncommitted). Never `git add -A` / `git checkout .` — commit **explicit
  paths only**. Their past commits have reverted in-flight work: re-verify
  your files survived after they commit.
- AudioEngine + modulation worklets are their active refactor zone — gather
  engine-area evidence by reading, avoid engine edits unless the goal demands it.
- Pre-commit hook is **disabled** — run `npm run typecheck` +
  `npm run format:check` (and targeted tests) manually before committing.
- If full typecheck fails in files you did not touch, use filtered tsc on
  your files and note it in the work log.
- Known test-environment quirk: full suite runs under jsdom; "pure" modules
  in the map don't need it, but vitest gives it to them anyway.

## Gate commands

```bash
npm run typecheck        # strict tsc --noEmit
npm run test             # full vitest suite
npm run format:check     # prettier
npm run build            # production + bundle budgets
```
