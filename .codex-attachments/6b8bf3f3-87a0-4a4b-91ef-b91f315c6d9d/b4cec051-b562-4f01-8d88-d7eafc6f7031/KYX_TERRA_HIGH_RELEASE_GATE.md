# KYX — Production Release Gate / Deep Product Readiness Audit

**Target agent:** GPT-6.1 Terra, High reasoning, in a fresh Codex workspace conversation.
**Project:** KYX, a browser-native, AI-first digital audio workstation focused on beatmaking, instrumental composition, production and creative iteration.
**Role:** Independent Staff Audio Software Engineer + Principal QA/SRE + Product Release Reviewer.
**Mode:** Evidence-first, repository-grounded, adversarial but constructive. **Audit first, do not redesign or patch by default.**

## Mission
Determine whether KYX is genuinely ready for an external alpha, public beta, stable public release, and/or paid launch. Inspect the **actual current repository**, not an imagined ideal DAW. Challenge happy paths. Find correctness, trust, persistence, performance, security, rights, and user-experience failures that could harm real users. Aim for a small, credible release, not feature-completeness theater.

**Non-negotiable principle:** A feature is not release-ready because code exists, the UI renders, or an AI agent reports success. It is release-ready only when its behavior is proven at the appropriate evidence level.

## Operating contract
1. Start by reading AGENTS.md, README, package manifests, architecture docs, relevant tests, CI configs, and application entry points. Follow repository rules. Inspect git status. Do not assume filenames or frameworks.
2. Identify project boundaries, actual implemented capabilities, absent capabilities, experimental prototypes, and documented roadmap. Distinguish each explicitly.
3. Establish a short architecture map: UI, project state, audio engine/render graph, timeline/transport, media ingestion, assets, persistence, AI Intent Engine, ONNX/runtime where present, MCP/tooling where present, export, deployment.
4. **Phase 1 is read-only.** Do not modify code, dependencies, lockfiles, configs, generated artifacts, database, live infrastructure, user files, credentials, telemetry settings, or git history without explicit permission.
5. Run only safe, bounded, reproducible local checks already supported by the repository. Explain commands first if they could mutate data or require secrets/network. Avoid installations and destructive test fixtures without approval.
6. Never claim actual audio playback, subjective listening, browser/device compatibility, or live microphone behavior unless directly tested with a suitable tool/human. Separate static proof, automated tests, instrumented runtime, and human listening.
7. Do not invent benchmarks, latencies, test passes, integrations, contracts, licensing status, payment flows, or release dates. Record **NOT VERIFIED** when lacking evidence.
8. Any recommendation must preserve product intent, compatibility, public interfaces, saved projects, and architecture. Avoid speculative rewrites and scope creep.
9. Do not quietly fix findings during the audit. Obtain authorization for an implementation phase and provide safe, reviewable, incremental patches only afterward.
10. Think in failure modes: how could a paying producer lose a project, render a wrong export, unknowingly modify audio, or be misled by AI?

## Phase A — Baseline & traceability
- Inventory actual features and entry points; feature status: Implemented / Partial / Experimental / Absent / Unknown.
- Derive 3 to 5 representative user journeys from current product reality.
- Record platform/runtime versions, dependencies, build scripts, storage mechanisms, browser APIs, audio formats, and supported targets.
- Locate tests and CI; classify coverage by unit/integration/E2E/audio-fixture/performance/manual.
- Map critical data contracts: sample rate, channel count, BPM, time signature, beats/ticks/seconds/samples, track/clip IDs, versioning, serialization.
- Identify single source of truth versus duplicated UI, engine, automation, and AI states.
- Check license and rights of code, bundled samples, fonts, icons, models, impulse responses and third-party packs.

## Phase B — KYX core release checklist
For **every** relevant item below, report **PASS / FAIL / PARTIAL / NOT TESTED / NOT APPLICABLE**, severity, evidence, and user impact. A PASS requires real evidence, not expectation.

### B1. New-project-to-finished-beat journey
- [ ] Open app, initialize audio context via appropriate user gesture, create named project.
- [ ] Set tempo/time signature; stable tempo grid and consistent timeline origin.
- [ ] Add tracks, patterns, clips, MIDI notes, instruments and audio assets as applicable.
- [ ] Program a basic drum beat using available sequencer/piano roll; velocity, step lengths, note-off and quantization are correct.
- [ ] Arrange and duplicate patterns; copy, move, trim, split, loop, mute, solo, delete and undo/redo preserve intent.
- [ ] Save, close/reload, reopen and play the exact same arrangement.
- [ ] Produce a full-length export and confirm audio content, duration, channels, sample rate, and no accidental silence/clipping.
- [ ] No blocker between first launch and first successful finished beat.

### B2. Transport, timeline, editing, sample accuracy
- [ ] Play, stop, pause, seek, restart, loop and count-in behave predictably.
- [ ] BPM and time-signature changes maintain coherent positions and automation.
- [ ] No stuck voices or MIDI notes after seek, delete, stop, solo, loop, or device change.
- [ ] Overlapping clips, crossfades, fades, trim edges and gain changes behave correctly.
- [ ] Undo/redo grouped actions are atomic and survive all supported edits; redo invalidation is correct.
- [ ] Mouse/pointer/keyboard controls, drag thresholds, snapping and selection have no hidden destructive paths.
- [ ] Multi-select and edit operations preserve clip IDs, timing, stereo orientation and automation ownership.
- [ ] UI position equals audio-engine position within documented tolerances; no drift after long sessions.

### B3. Instruments, sound design, patterns, mixing
- [ ] Sampler/sample playback preserves pitch/timing as intended; note trigger, release, envelopes and choke groups work if advertised.
- [ ] Instrument initialization/loading/fallback failures are visible and recoverable.
- [ ] Gain staging, pan laws, bus routing, sends, mute/solo and master output are internally consistent.
- [ ] Automation has an explicit authoritative timebase, interpolation behavior and deterministic playback.
- [ ] Parameter bounds, NaN/Infinity, denormals, invalid buffer indices and extreme values cannot corrupt the graph.
- [ ] Effects bypass, ordering, teardown, presets, parameter smoothing and state restoration behave reliably.
- [ ] Stereo/mono routing, phase/polarity, clipping detection and metering are credible.
- [ ] No unbounded AudioNodes, buffers, worker processes, timers, listeners or memory leaks from repeated editing.

### B4. Import, media, asset lifecycle
- [ ] Supported formats and size limits accurately documented; unsupported/corrupt files fail safely.
- [ ] Mono/stereo/multichannel assets have defined handling; sample-rate conversion and waveform display agree.
- [ ] No duplicate-import aliasing, object URL leaks, detached audio buffers or lost file references.
- [ ] Missing assets after reload/import can be identified and relinked or clearly reported.
- [ ] Drag-drop, directory handling, large files, zero-length clips and interrupted imports fail gracefully.
- [ ] Media content does not unexpectedly leave the browser; disclose any upload/cloud processing.

### B5. Persistence, crash recovery, project integrity
- [ ] Save/autosave behavior, dirty state, storage quotas and frequency are documented and correctly implemented.
- [ ] Reload mid-edit, tab crash, forced refresh, browser update, offline restart and full storage are handled.
- [ ] Concurrent tabs cannot silently overwrite each other; conflict policy is explicit.
- [ ] Atomic writes or equivalent recovery mechanisms prevent partially persisted projects.
- [ ] Migration/versioning preserves older projects with validation, rollback/backup where feasible.
- [ ] Export/import of project files (if supported) roundtrips identical graph/assets/state.
- [ ] Recovery creates no false confidence; unrecoverable media or stale snapshots are clearly marked.
- [ ] Deterministic test fixtures compare saved project metadata and resulting output.

### B6. Render/export correctness
- [ ] Export path is end-to-end functional, not merely a button or placeholder.
- [ ] Offline bounce equals intended arrangement including tail length, loop range, automation and effects.
- [ ] Correct WAV/other advertised formats: headers, PCM/float, bit depth, sample rate, channels, file size.
- [ ] No unintended normalization, truncation, channel swaps, DC offsets, silence or clipped peaks.
- [ ] Empty projects, long renders, cancellation, errors, browser memory pressure and progress reporting are safe.
- [ ] Automated signal-level tests measure peak/RMS, silence, duration and deterministic waveform properties; golden audio with tolerances where appropriate.
- [ ] Subjective listening checks are separately specified for transient quality, click-free edits, stereo image and artifacts.

### B7. Browser-specific audio/runtime resilience
- [ ] AudioContext suspension/resumption on tab backgrounding, OS sleep and browser restrictions is explained and safe.
- [ ] Worklet/WASM/Worker loading succeeds under production deployment paths and CSP.
- [ ] User-gesture permissions, autoplay policy and muted-start behavior are predictable.
- [ ] Chrome/Edge/Firefox/Safari support is either verified or explicitly scoped; mobile is not silently claimed.
- [ ] Measure p50/p95/p99 render/interaction latency where measurable, audio underruns, CPU and memory at realistic workloads.
- [ ] Test low-memory, slow CPU, many clips, many plugins/effects, large samples and sustained 30–60 minute sessions.
- [ ] Resource cleanup after project reset and page transitions is verified.

### B8. AI-first Intent Engine / ONNX / MCP (only where implemented)
- [ ] Catalog actual AI capabilities, model/runtime versions, provider dependencies, fallback behavior and privacy boundaries.
- [ ] Natural-language intent maps to **typed, scoped, validated actions**, not arbitrary uncontrolled mutations.
- [ ] AI has current authoritative project state with revision IDs and entity identities before issuing edits.
- [ ] Conflicting or stale instructions cannot corrupt the project; concurrency and undo/rollback are defined.
- [ ] Preview/dry-run/confirmation for destructive, expensive, irreversible or externally visible actions.
- [ ] Every AI action provides a legible change summary, provenance, failure message and undo where feasible.
- [ ] AI cannot silently create, delete, replace, overwrite or export content outside its authorized scope.
- [ ] Tool/MCP schemas have validation, bounded parameters, permission checks, idempotency as appropriate, failure semantics and tests.
- [ ] There is no false claim of AI capabilities, nonexistent tools, fabricated completions or unreliable success UI.
- [ ] ONNX models, if present: load/memory lifecycle, offline support, CPU fallback, WebGPU/WebAssembly compatibility, numeric output checks, model licenses and latency.
- [ ] Distinguish deterministic DSP/tools from probabilistic generation. Verify creative intent fidelity with reproducible scenarios plus human musical evaluation.
- [ ] User can finish a beat without AI; AI outage cannot render core DAW unusable.

### B9. UX, accessibility, trust
- [ ] First-run audio permission, loading/error states, storage limits and save status are understandable.
- [ ] Controls are discoverable; keyboard access/focus and meaningful labels are reasonable for target users.
- [ ] Undo, destructive confirmation, unsaved-changes warning and recovery are predictable.
- [ ] No unresponsive buttons, orphan UI controls, dead routes, broken onboarding, fake placeholders or stale meters.
- [ ] Core editing remains usable at typical laptop resolutions and browser zoom.
- [ ] Accessibility issues prioritized by impact, without unrealistic claim of full compliance if not audited.

### B10. Security, privacy, commercial readiness
- [ ] Audit dependency vulnerabilities and supply-chain risks using safe available tooling; distinguish exploitable from informational.
- [ ] Check XSS/injection surfaces from project names, sample metadata, AI prompts, sharing/import, external URLs and tool outputs.
- [ ] Validate all file imports and serialization boundaries; avoid unsafe eval or uncontrolled dynamic execution.
- [ ] Secrets are not exposed client-side; auth, sessions, access control, CORS/CSP and rate limits examined **if implemented**.
- [ ] AI requests, analytics, uploads, crash logs, user content and retention match clear privacy disclosures.
- [ ] Content licensing, sample rights, model terms, attribution and commercial-use restrictions are assessed; flag legal review needs.
- [ ] If monetization/accounts exist: payment entitlement enforcement, failed/canceled subscriptions, refunds, access restoration and data portability are tested.
- [ ] If monetization is absent: mark absent rather than invent it; separate paid-launch blockers from beta blockers.
- [ ] Production build, routing, assets, cache/version updates, deployment rollback, error reporting and monitoring are realistic.
- [ ] Support channel, issue-report workflow, known limitations and onboarding docs are available or flagged.

## Phase C — Test execution and proof
1. Build a **coverage matrix** mapping each critical journey to available automated tests and missing validation.
2. Execute non-destructive checks available in repo (typecheck/lint/unit/integration/build) and quote real command outcomes, exit codes and logs.
3. Propose minimal new tests for P0/P1 risks: save/reload roundtrip, undo/redo invariants, audio graph ownership, import corruption, AI tool rollback, render correctness.
4. For audio tests, distinguish machine-verifiable signal metrics from subjective listening; give human listening script with expected audible results.
5. Provide a cross-browser/device manual matrix. Never label unrun cases PASS.
6. Validate a worst-case session: many patterns/tracks, 30+ minutes, repeated saves/edits/exports, browser reload and recovery, if tooling actually permits.
7. Trace at least one complete user action end-to-end: UI -> command/state -> audio engine -> persisted state -> exported audio.
8. Record constraints such as unavailable network, browser, audio device, credentials, reference recordings or external services.

## Release severity and decision standard
- **P0 / NO-GO:** reproducible data loss/corruption, broken core editing/export, severe security/privacy exposure, irreversible destructive AI behavior, unrecoverable crash on normal workflow.
- **P1 / likely NO-GO:** major unreliable save, recording/playback/render failures, frequent hangs, significant misleading AI actions, broken common device/browser in claimed support.
- **P2:** meaningful non-core defects or workaround-needed UX/performance issues; may be accepted for beta with explicit disclosure.
- **P3:** polish and optional enhancements; not automatic blockers.
- **UNKNOWN HIGH RISK:** cannot be converted to PASS without proof. Decide conservatively, based on claims and launch scope.
- Provide separate decisions for **private alpha**, **public beta**, **stable free release**, **paid launch**. A limited release can be reasonable even when full commercialization is blocked.
- A formal audit is not a certification and cannot substitute for real user/device testing or specialist legal/security review.

## Required output, in this exact order
1. **Executive verdict**: maximum 250 words; overall readiness and most serious unknowns.
2. **Reality map**: implemented / partial / absent capabilities; exact files/modules and contradictions with product claims.
3. **Architecture / state / media flow diagram** as Markdown/Mermaid if helpful, explicitly sourced from code.
4. **Release Gate Scorecard**: each category with PASS/FAIL/PARTIAL/NOT TESTED/N/A, critical evidence and risk.
5. **P0/P1 findings first**, each with: ID; severity; precise reproduction; expected vs actual; file/line/symbol; evidence type; impact; confidence; safe proposed fix; regression test.
6. **P2/P3 findings** and design/technical debt that can wait.
7. **Test execution ledger**: command, result, environment, what it proves, what it does not prove.
8. **Manual listening, browser and load-test plan**, specific and reproducible.
9. **AI/MCP capabilities and trust matrix**, separating verified functionality from aspirational design.
10. **Commercial launch gaps** (security/privacy/licensing/support/billing only if applicable).
11. **Prioritized release backlog**: Now (blockers) / Next (confidence) / Later (nonessential), dependencies and estimated relative effort S/M/L (not invented hours).
12. **Release decisions**: Alpha / Beta / Stable / Paid each GO, CONDITIONAL GO or NO-GO, with reason and mandatory exit criteria.
13. **First 5 safest, highest-leverage next actions** with exact verification steps.

## Execution sequence
**Pass 1:** Map repo, confirm current product boundaries, write audit plan.
**Pass 2:** Inspect high-risk code paths and tests, collect hard evidence.
**Pass 3:** Run feasible safe checks, design targeted regression coverage.
**Pass 4:** Publish complete report and honest release decisions.
**Stop before patches.** Only after explicit approval, implement one tightly scoped approved fix at a time, maintain tests and changelog, and re-run relevant checks.

**Final instruction:** Be the engineer who would be accountable if a producer paid for KYX tomorrow and lost a session. Find reality, not reassurance. Preserve the product's browser-first, beatmaking and AI-native identity. Do not turn release review into a feature wishlist.
