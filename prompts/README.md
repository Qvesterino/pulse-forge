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
├── DAW_EDIT_TOOLS_INTERACTION_AUDIT.md        standalone report
├── 00_CORE/                                    1 file  — the shared contract
├── 01_COMMON/                                 12 files — portable, cross-DAW audits
├── 03_PULSE_FORGE/                             8 files — KYX-specific audits
├── 04_SCHEDULED/                               5 files — recurring / phased execution
├── daw_qa_reliability_vault/                  26 files — per-subsystem audit suite
└── New folder/                                 0 files — empty local artifact, safe to delete
```

There is **no `02_` directory.** The numbering skips from `01_COMMON` to
`03_PULSE_FORGE`; no prompt directory is missing a sibling.

`prompts/_built/` is generated and gitignored — see §3.

---

## 2. How the contract is shared

`01_COMMON`, `03_PULSE_FORGE` and `04_SCHEDULED` (25 prompts) all used to embed a
byte-identical ~2 240-character operating contract. Changing one rule meant
editing 25 files, and missing a file silently forked the rules.

The library now separates the two concerns:

| File | Contains | Edit when |
| --- | --- | --- |
| `00_CORE/MASTER_DAW_HARDENING_PROMPT.md` | the contract: Purpose, the 8-step operating loop, the 10 non-negotiable rules, the required completion report | the rules themselves change |
| `<DIR>/<NAME>.md` | a **fragment**: title, a pointer to the contract, and the audit-specific mission | the audit's scope changes |

A fragment is ~1 200 bytes instead of ~3 100. Nothing else lives in it.

```bash
npm run prompts:check    # verify every fragment still matches the contract shape
npm run prompts:sync    # rewrite drifted fragments
npm run prompts:build   # emit standalone copies into prompts/_built/
```

`prompts:build` accepts a path filter, e.g.
`npm run prompts:build -- 01_COMMON/01_CRITICAL_PATH_AUDIT.md`.

Audits are copy-pasteable on their own, so `prompts/_built/<DIR>/<NAME>.md` is
the standalone artifact: contract + mission, ready to hand to an agent. That
directory is generated, gitignored, and never edited by hand.

`prompts:check` is a verification, not a test — it exits non-zero when a fragment
drifts. The 24 built prompts are byte-equivalent in content to the pre-refactor
files (blank-line placement at the contract boundary differs).

### Two templates, two families

| | Family A — `00_CORE` + `01_COMMON` + `03_PULSE_FORGE` + `04_SCHEDULED` | Family B — `daw_qa_reliability_vault` |
| --- | --- | --- |
| Length | ~1 200 B fragment (+ 2 240 B contract on build) | 1 400–2 400 B self-contained |
| Scope style | prose, general | explicit `Stress:` / `Look for:` lists |
| Loop | explicit 8-step | reproduce → fix → verify → sweep |
| Target | KYX and portable DAWs | any browser/hybrid DAW |
| Run order | orchestrator-driven (`04_SCHEDULED/05`) | fixed order in its own `00-README.md` |

Family B uses a different template with no shared contract. The sync script
deliberately ignores it.

---

## 3. Generated output

`prompts/_built/` mirrors the fragment tree, one file per prompt, each expanded
to the full standalone text. It is in `.gitignore`. Rebuild it at any time with
`npm run prompts:build`; rebuild one prompt by passing its path.

The build always clears `_built/` first, so a deleted or renamed prompt cannot
linger in the output.

---

## 4. `00_CORE/`

| File | Purpose |
| --- | --- |
| `MASTER_DAW_HARDENING_PROMPT.md` | The shared operating contract: purpose, 8-step loop, 10 non-negotiable rules, required completion report. Every Family-A fragment inherits this. |

---

## 5. `01_COMMON/` — portable cross-DAW audits (12)

Not KYX-specific. These apply to any browser or hybrid DAW.

| # | File | Scope |
| --- | --- | --- |
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

## 6. `03_PULSE_FORGE/` — KYX-specific audits (8)

The only prompts that assume the KYX architecture (Scheduler, Transport,
AudioEngine, AudioWorklet boundary, sample-bank model).

| # | File | Scope |
| --- | --- | --- |
| 01 | `01_AUDIO_SCHEDULER_PRECISION_AUDIT.md` | Sample-critical events must not depend on UI frame rate or `setTimeout` precision |
| 02 | `02_BROWSER_AUDIO_LIFECYCLE_AUDIT.md` | AudioContext and browser lifecycle from first load through repeated long sessions |
| 03 | `03_SEQUENCER_INTEGRITY_AUDIT.md` | Note and pattern semantics under aggressive editing |
| 04 | `04_WEB_AUDIO_GRAPH_LIFECYCLE_AUDIT.md` | Creation, connection, disconnection, reuse, disposal of every AudioNode and AudioWorkletNode |
| 05 | `05_BEAT_ENGINE_STRESS_AUDIT.md` | Beat engine under increasingly dense realistic projects |
| 06 | `06_BROWSER_COMPATIBILITY_HARDENING.md` | Against the claimed support matrix (Chromium, Edge, Firefox, Safari) |
| 07 | `07_OFFLINE_RENDER_EXPORT_ACCURACY_AUDIT.md` | Whether exported audio is semantically equivalent to intended live playback |
| 08 | `08_PRODUCT_FEATURE_AUDIT.md` | The KYX-specific bets: intent pipeline, generative runtime, collab/Y.Doc, pack & share codes, groove/artist data, route-level apps and the desktop shell |

---

## 7. `04_SCHEDULED/` — recurring and phased execution (5)

| # | File | Cadence | Scope |
| --- | --- | --- | --- |
| 01 | `01_NIGHTLY_REGRESSION_HUNTER.md` | nightly | Autonomous pass hunting real defects rather than producing a large report |
| 02 | `02_LONG_SESSION_SOAK_RUN.md` | scheduled | Repeatable stress loop approximating a long DAW session |
| 03 | `03_WEEKLY_DEPENDENCY_DRIFT_AUDIT.md` | weekly | Dependency drift since the previous stable state |
| 04 | `04_RELIABILITY_RATCHET.md` | per-run | The codebase must leave the run at least as reliable as it entered |
| 05 | `05_MASTER_ORCHESTRATOR.md` | per-campaign | Runs the other audits as **10 ordered phases**, each naming its prompt |

### Orchestrator phase order

`05_MASTER_ORCHESTRATOR.md` defines the order and requires
`AUDIT → REPRODUCE → FIX → VERIFY → REGRESSION TEST → STABLE CHECKPOINT → NEXT DOMAIN`,
refusing to advance while a phase has failing validation. Every phase names the
prompt that drives it, so a newly added prompt must be added to that list in the
same commit or it will never run.

| Phase | Prompt(s) |
| --- | --- |
| 1. Critical path | `01_COMMON/01` |
| 2. Project/data integrity | `01_COMMON/03` |
| 3. Recovery | `01_COMMON/02` |
| 4. Undo/redo | `01_COMMON/04` |
| 5. State/contracts | `01_COMMON/06` then `01_COMMON/05` |
| 6. Audio-specific engine audit | `03_PULSE_FORGE/01`–`07` |
| 7. Product-specific audits | `03_PULSE_FORGE/08` |
| 8. Performance/resource leaks | `01_COMMON/08` |
| 9. Security/dependencies/dead code | `01_COMMON/10`, `09`, `11` |
| 10. Final reliability sweep | `01_COMMON/12` |

---

## 8. `daw_qa_reliability_vault/` — per-subsystem suite (26)

Self-contained; use its own `00-README.md` for the run order.

| # | File | Focus |
| --- | --- | --- |
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

## 9. Coverage overlap between the two families

Both families cover the same reliability areas at different granularity. This is
the mapping, so you pick the right prompt instead of running both by accident.

| `01_COMMON` | vault equivalent(s) |
| --- | --- |
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

## 10. Which prompt to use

- **Hardening KYX audio specifically** → `03_PULSE_FORGE`
- **Auditing a KYX feature bet (intent, generative, collab, pack/share)** → `03_PULSE_FORGE/08`
- **Auditing a non-audio subsystem of KYX** → `01_COMMON`
- **Auditing a different browser DAW** → `daw_qa_reliability_vault`
- **Running a multi-session hardening campaign** → `04_SCHEDULED/05_MASTER_ORCHESTRATOR.md`
- **Checking whether anything regressed overnight** → `04_SCHEDULED/01_NIGHTLY_REGRESSION_HUNTER.md`

---

## 11. Housekeeping

- Editing the operating rules means editing `00_CORE/MASTER_DAW_HARDENING_PROMPT.md`
  **only**. Fragments reference it; they do not copy it. Run `npm run prompts:check`
  to confirm nothing drifted.
- Adding a prompt means adding it to the orchestrator phase list in the same
  commit, otherwise no phase will ever invoke it.
- `New folder/` is empty and untracked (git does not track empty directories).
  It is a leftover local artifact and can be deleted.
- Prompt files are documentation, not code. They are not type-checked, linted, or
  covered by any test suite. The only durable check is that the file lists above
  match what is on disk.
