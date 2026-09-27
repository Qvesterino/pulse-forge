# Audit Prompts

Audit and hardening prompt library for the KYX / Pulse Forge codebase and, where
marked, for other browser-based DAWs.

These are **operating instructions for an agent or engineer**, not documentation
about how the product works. They describe *how to audit*, not *what to build*.
For product architecture see `ARCHITECTURE.md`; for what ships today see
`docs/CURRENT-STATE.md`; for the coding-agent contract see `AGENTS.md`.

---

## 1. Layout

```
prompts/
├── README.md                                  ← this file
├── DAW_EDIT_TOOLS_INTERACTION_AUDIT.md        373 lines, standalone report
├── 00_CORE/                                    1 file  — shared master prompt
├── 01_COMMON/                                  12 files — portable, cross-DAW audits
├── 03_PULSE_FORGE/                              7 files — KYX-specific audio audits
├── 04_SCHEDULED/                                5 files — recurring / phased execution
├── daw_qa_reliability_vault/                   26 files — per-subsystem audit suite
└── New folder/                                  0 files — empty local artifact, safe to delete
```

There is **no `02_` directory.** The numbering skips from `01_COMMON` to
`03_PULSE_FORGE`; no prompt directory is missing a sibling.

---

## 2. Two prompt families, two templates

The library holds two distinct systems. They are **not** interchangeable and do
not share a template.

### Family A — `00_CORE` + `01_COMMON` + `03_PULSE_FORGE` + `04_SCHEDULED`

Every file in these four directories carries the **same ~2 240-character
boilerplate**, verified byte-identical apart from the H1 title and the trailing
mission section:

- `## Purpose` — production-grade hardening, reliability over novelty
- `## Operating mode` — the same 8-step loop: inspect → identify → reproduce →
  fix smallest → add regression coverage → run checks → re-inspect → repeat
- `## Non-negotiable rules` — 10 rules (no speculative refactoring, no renaming
  public contracts, never silently discard user data, never weaken validation,
  prefer deterministic fixes over timing sleeps, …)
- `## Required output at completion` — defects, tests, commands, risks, files
- then one scoping section, named differently per directory:
  - `01_COMMON` → `## Audit-specific mission`
  - `03_PULSE_FORGE` → `## Pulse Forge mission`
  - `04_SCHEDULED` → `## Scheduled mission`

The source of truth for the boilerplate is `00_CORE/MASTER_DAW_HARDENING_PROMPT.md`.
The other 24 files embed a copy of it.

### Family B — `daw_qa_reliability_vault/`

A separate, **self-contained** template. Each audit is short (37–52 lines) and
uses its own shape:

- a title and a one-line intent
- `Stress:` — a concrete list of scenarios to exercise
- `Look for:` — a concrete list of failure shapes to hunt
- `## Global Rules` — 8 rules, including *"Do not manufacture work. If the audited
  area is healthy, verify it, report that no high-value action was found, and
  stop."*
- `## Completion Report` — findings, fixes, tests added, verification, remaining
  risks

The vault has its own `00-README.md` with a recommended run order (audit 25, the
chaos test, must run **last**).

### Practical difference

| | Family A | Family B (vault) |
|---|---|---|
| Length | ~3 000 chars each | 1 400–2 400 chars each |
| Scope style | prose, general | explicit `Stress:` / `Look for:` lists |
| Reset loop | explicit 8-step | "reproduce → fix → verify → sweep" |
| Target | KYX and portable DAWs | any browser/hybrid DAW |
| Run order | orchestrator-driven | fixed order in `00-README.md` |

---

## 3. `00_CORE/`

| File | Purpose |
|---|---|
| `MASTER_DAW_HARDENING_PROMPT.md` | The shared operating contract: purpose, 8-step loop, 10 non-negotiable rules, required completion report. This is the template embedded in the other 24 Family-A files. |

---

## 4. `01_COMMON/` — portable cross-DAW audits (12)

Not KYX-specific. These apply to any browser or hybrid DAW.

| # | File | Scope |
|---|---|---|
| 01 | `01_CRITICAL_PATH_AUDIT.md` | Highest-value user journeys end to end: project open, edit, playback, save/autosave, import, export, undo/redo, shutdown |
| 02 | `02_RECOVERY_PATH_AUDIT.md` | Every path by which the DAW must recover from interruption or failure |
| 03 | `03_PROJECT_DATA_INTEGRITY_AUDIT.md` | Persistence treated as precious user asset |
| 04 | `04_UNDO_REDO_INTEGRITY_AUDIT.md` | Command history and all destructive/state-changing operations |
| 05 | `05_CROSS_COMPONENT_CONTRACT_AUDIT.md` | Contracts across UI → commands → project model → audio engine → persistence → workers/native → plugins |
| 06 | `06_STATE_INVARIANT_AUDIT.md` | States that should be impossible but are currently representable |
| 07 | `07_IMPORT_EXPORT_ROBUSTNESS.md` | Malformed input, oversized files, strange filenames, cancellation, partial reads/writes |
| 08 | `08_PERFORMANCE_RESOURCE_LEAK_AUDIT.md` | Long-session stability, not short-benchmark speed |
| 09 | `09_DEPENDENCY_HEALTH_AUDIT.md` | Vulnerable / abandoned / duplicated / overly broad dependencies, lockfile consistency |
| 10 | `10_SECURITY_SURFACE_AUDIT.md` | Realistic security boundaries without theoretical threat theater |
| 11 | `11_DEAD_SUSPICIOUS_CODE_AUDIT.md` | Code whose ownership or intent is unclear |
| 12 | `12_FINAL_RELIABILITY_SWEEP.md` | Whole-codebase sweep after targeted hardening has landed |

---

## 5. `03_PULSE_FORGE/` — KYX-specific audio audits (7)

These are the only prompts that assume the KYX architecture (Scheduler, Transport,
AudioEngine, AudioWorklet boundary, sample-bank model).

| # | File | Scope |
|---|---|---|
| 01 | `01_AUDIO_SCHEDULER_PRECISION_AUDIT.md` | Sample-critical events must not depend on UI frame rate or `setTimeout` precision |
| 02 | `02_BROWSER_AUDIO_LIFECYCLE_AUDIT.md` | AudioContext and browser lifecycle from first load through repeated long sessions |
| 03 | `03_SEQUENCER_INTEGRITY_AUDIT.md` | Note and pattern semantics under aggressive editing |
| 04 | `04_WEB_AUDIO_GRAPH_LIFECYCLE_AUDIT.md` | Creation, connection, disconnection, reuse, disposal of every AudioNode and AudioWorkletNode |
| 05 | `05_BEAT_ENGINE_STRESS_AUDIT.md` | Beat engine under increasingly dense realistic projects |
| 06 | `06_BROWSER_COMPATIBILITY_HARDENING.md` | Against the claimed support matrix (Chromium, Edge, Firefox, Safari) |
| 07 | `07_OFFLINE_RENDER_EXPORT_ACCURACY_AUDIT.md` | Whether exported audio is semantically equivalent to intended live playback |

---

## 6. `04_SCHEDULED/` — recurring and phased execution (5)

| # | File | Cadence | Scope |
|---|---|---|---|
| 01 | `01_NIGHTLY_REGRESSION_HUNTER.md` | nightly | Autonomous pass hunting real defects rather than producing a large report |
| 02 | `02_LONG_SESSION_SOAK_RUN.md` | scheduled | Repeatable stress loop approximating a long DAW session |
| 03 | `03_WEEKLY_DEPENDENCY_DRIFT_AUDIT.md` | weekly | Dependency drift since the previous stable state |
| 04 | `04_RELIABILITY_RATCHET.md` | per-run | The codebase must leave the run at least as reliable as it entered |
| 05 | `05_MASTER_ORCHESTRATOR.md` | per-campaign | Runs the other audits as **10 ordered phases** — see below |

### Orchestrator phase order

`05_MASTER_ORCHESTRATOR.md` defines this order and requires
`AUDIT → REPRODUCE → FIX → VERIFY → REGRESSION TEST → STABLE CHECKPOINT → NEXT DOMAIN`,
refusing to advance while a phase has failing validation:

1. Critical path
2. Project / data integrity
3. Recovery
4. Undo/redo
5. State / contracts
6. Audio-specific engine audit
7. Product-specific audits
8. Performance / resource leaks
9. Security / dependencies / dead code
10. Final reliability sweep

Phases 1–5 and 8–10 map cleanly onto `01_COMMON` files. Phase 6 maps onto
`03_PULSE_FORGE`. Phase 7 has no dedicated prompt.

---

## 7. `daw_qa_reliability_vault/` — per-subsystem suite (26)

Self-contained; use its own `00-README.md` for the run order.

| # | File | Focus |
|---|---|---|
| — | `00-README.md` | Suite purpose, recommended order, operating principle |
| 01 | `01-editing-timeline-audit.md` | Editing & timeline |
| 02 | `02-transport-audit.md` | Transport |
| 03 | `03-audio-scheduling-audit.md` | Audio scheduling |
| 04 | `04-mixer-audit.md` | Mixer |
| 05 | `05-plugins-effects-audit.md` | Plugins & effects |
| 06 | `06-automation-audit.md` | Automation |
| 07 | `07-recording-audit.md` | Recording |
| 08 | `08-project-state-audit.md` | Project state |
| 09 | `09-undo-redo-audit.md` | Undo / redo |
| 10 | `10-import-audit.md` | Import |
| 11 | `11-export-bounce-audit.md` | Export / bounce |
| 12 | `12-audio-engine-audit.md` | Audio engine |
| 13 | `13-async-race-audit.md` | Async & race conditions |
| 14 | `14-browser-lifecycle-audit.md` | Browser lifecycle |
| 15 | `15-performance-audit.md` | Performance |
| 16 | `16-ui-responsiveness-audit.md` | UI responsiveness |
| 17 | `17-keyboard-shortcuts-audit.md` | Keyboard & shortcuts |
| 18 | `18-error-handling-audit.md` | Error handling |
| 19 | `19-recovery-audit.md` | Recovery |
| 20 | `20-memory-resources-audit.md` | Memory & resources |
| 21 | `21-data-integrity-audit.md` | Data integrity |
| 22 | `22-cross-component-contracts-audit.md` | Cross-component contracts |
| 23 | `23-browser-compatibility-audit.md` | Browser compatibility |
| 24 | `24-security-surface-audit.md` | Security surface |
| 25 | `25-real-user-chaos-test.md` | Real-user chaos test — **run last** |

---

## 8. Coverage overlap between the two families

Both families cover the same reliability areas at different granularity. This is
the mapping, so you can pick the right prompt instead of running both by accident.

| `01_COMMON` | vault equivalent(s) |
|---|---|
| `01_CRITICAL_PATH_AUDIT` | `01-editing-timeline-audit` + `02-transport-audit` |
| `02_RECOVERY_PATH_AUDIT` | `19-recovery-audit` |
| `03_PROJECT_DATA_INTEGRITY_AUDIT` | `21-data-integrity-audit` |
| `04_UNDO_REDO_INTEGRITY_AUDIT` | `09-undo-redo-audit` |
| `05_CROSS_COMPONENT_CONTRACT_AUDIT` | `22-cross-component-contracts-audit` |
| `06_STATE_INVARIANT_AUDIT` | `08-project-state-audit` |
| `07_IMPORT_EXPORT_ROBUSTNESS` | `10-import-audit` + `11-export-bounce-audit` |
| `08_PERFORMANCE_RESOURCE_LEAK_AUDIT` | `15-performance-audit` + `20-memory-resources-audit` |
| `09_DEPENDENCY_HEALTH_AUDIT` | *(no vault equivalent)* |
| `10_SECURITY_SURFACE_AUDIT` | `24-security-surface-audit` |
| `11_DEAD_SUSPICIOUS_CODE_AUDIT` | *(no vault equivalent)* |
| `12_FINAL_RELIABILITY_SWEEP` | `25-real-user-chaos-test` |

`03_PULSE_FORGE` overlaps the audio half of the vault
(`03-audio-scheduling-audit`, `12-audio-engine-audit`, `23-browser-compatibility-audit`)
but adds KYX-specific constraints the vault does not state.

**Only `01_COMMON` covers** dependency health and dead-code analysis.

---

## 9. Which prompt to use

- **Hardening KYX audio specifically** → `03_PULSE_FORGE`
- **Auditing a non-audio subsystem of KYX** → `01_COMMON`
- **Auditing a different browser DAW** → `daw_qa_reliability_vault`
- **Running a multi-session hardening campaign** → `04_SCHEDULED/05_MASTER_ORCHESTRATOR.md`
- **Checking whether anything regressed overnight** → `04_SCHEDULED/01_NIGHTLY_REGRESSION_HUNTER.md`

---

## 10. Housekeeping

- `New folder/` is empty and untracked (git does not track empty directories).
  It is a leftover local artifact and can be deleted.
- The Family-A boilerplate is duplicated across 24 files by design, so each
  prompt is copy-pasteable on its own. If you edit the rules, edit
  `00_CORE/MASTER_DAW_HARDENING_PROMPT.md` **and** the 24 copies, or the
  library will drift.
- Prompt files are documentation, not code. They are not type-checked, linted, or
  covered by any test suite. The only durable check is that the file lists
  above match what is on disk.
