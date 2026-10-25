# NEXT-GENERATION CAPABILITY REVIEW REPORT

**Product:** KYX / Pulse Forge  
**Review date:** 2026-10-25  
**Evidence baseline:** committed HEAD 631714c522315ebd16c745b80ca4225419e3f3c3 (short 631714c5)  
**Mission:** Read-only strategic engineering review  
**Scope:** The shared worktree contained unrelated staged, unstaged, and untracked work. Shipped-capability claims use committed HEAD only; in-flight changes are excluded. This review creates only this report. No production code, assets, schemas, feature flags, or packages were changed. No tests, builds, runtime sessions, or listening tests were executed for this review.

## Executive summary

KYX is a substantial browser-first DAW with a command-backed project model, a shared live/offline engine path, built-in instruments and effects, recording and recovery facilities, editable automation, project-aware sound discovery, deterministic Intent routing, optional local/ONNX assistance, and a comparatively mature MCP plan/apply/read-back surface.

The strongest strategic opportunity is not another isolated AI feature. It is to make existing creative operations **previewable, composable, and verifiable before committing**. The clearest proof already exists: mix ideas can be planned without mutation, rendered before and after, level-matched for listening, applied as one undo step, and checked with render summaries and a human A/B verdict. Intent candidates also have a real audition/apply path. KYX can extend this product contract to sound-kit selection, region processing, automation, and multi-tool assistant plans.

The main reliability boundary is important: an MCP batch can group mutations into one undo frame, but it is not a transaction. Earlier successful edits survive a later failure; “atomic” currently means stop on the first failure. The most valuable foundation is a side-effect-free **prepare → validate → review → commit → read back** contract for composed operations. This unlocks more capable AI and faster workflows without putting an LLM, network call, or unverified plan in the audio thread.

The sound inventory already has functional breadth and a documented technically consistent core. Its documented differentiator gap is source and performance identity: genuinely recorded KYX material, human articulation, phrase-scale loops, and a coherent sound fingerprint. That is a product investment, not another normalization pass.

## 1. Review method and confidence

### Confidence labels

- **Confirmed** — a committed implementation path exists and is reachable from product or agent-facing code. This is code-level confirmation, not a claim that this review executed it.
- **Partial** — a real path exists, with a documented boundary, missing workflow contract, or qualification still open.
- **Hypothesis** — a proposal combines existing building blocks, but the end-to-end experience or contract does not exist yet.
- **Absent** — no shipped path was found in the committed baseline. Roadmap plans and experimental code do not count as shipped.

### Evidence limits

I inspected source and repository records. I did not render or listen to sample combinations, run the application, execute tests, qualify physical audio hardware, inspect every sample by ear, or exercise an MCP client against a running build. Sound-library technical findings below are attributed to the dated inventory document, not presented as new measurements.

Repository paths are relative to repository root and refer to the evidence baseline unless stated otherwise.

## 2. Evidence-backed architecture and capability map

| Area                             | Status and code evidence                                                                                                                                                                                                                                                                                                                                       | User / agent access                                                                                      | Reversible, persistent, testable                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project/session state            | **Confirmed.** Plain document and schema in src/project-model/types.ts and schema.ts; commands in src/commands/; ProjectStore in src/store/ProjectStore.ts normalizes after command execution.                                                                                                                                                                 | Core UI / MCP reads and structured edits                                                                 | Document edits are undoable and persisted. Command, schema, persistence tests exist.                                                                |
| Tracks, clips, buses, routing    | **Confirmed.** Project model, arrangement/routing commands, MCP kyx_tracks, kyx_clips, kyx_routing.                                                                                                                                                                                                                                                            | Arrangement, sequencer, mixer / bounded tool operations                                                  | Most document mutations undo/persist. Cross-reference invariants have tests.                                                                        |
| Transport and scheduling         | **Confirmed.** src/transport/Transport.ts, src/scheduler/Scheduler.ts, src/audio-engine/automationBridge.ts.                                                                                                                                                                                                                                                   | User transport/editors / runtime control and readback                                                    | Runtime position is transient; tempo/arrangement persist. Scheduler contracts are testable.                                                         |
| Editing and undo/redo            | **Confirmed.** UI → commands → ProjectStore undo frames; batch can use host undo-frame hooks.                                                                                                                                                                                                                                                                  | Editors / kyx_undo and structured tools                                                                  | Reversible through command history; persistent through project saves.                                                                               |
| Recording and takes              | **Partial.** Browser recording, take handling, recovery repositories, and desktop Windows audio bridges exist. docs/WEB-STUDIO-SUPPORT-MATRIX.md separates software verification from physical-device qualification; browser/device/release gaps remain open.                                                                                                  | User recording / agent can inspect and operate some take functions, not replace physical input setup     | Captured audio persists and recovery exists; hardware claims require a named configuration record.                                                  |
| Save, reopen, autosave, recovery | **Confirmed, platform-qualified.** src/persistence/ProjectRepository.ts, save-lifecycle.ts, recoveryBuffer.ts, RecordingRecoveryRepository.ts, and src/services.ts.                                                                                                                                                                                            | User / named MCP checkpoints and readback                                                                | Persistent; checkpoint restore is one undo step. Recovery ownership has test coverage.                                                              |
| Live engine and DSP boundary     | **Confirmed.** src/audio-engine/AudioEngine.ts, src/audio-worklets/, loader.ts, scheduler.                                                                                                                                                                                                                                                                     | Playback/effects/instruments / agents request document edits and offline analysis, not arbitrary DSP     | Project settings persist; runtime DSP state does not. Worklet and graph contracts are testable. No model/network call belongs in realtime callback. |
| Offline render, bounce, export   | **Confirmed.** src/rendering/renderer.ts creates OfflineAudioContext and a fresh AudioEngine, with cancellation/diagnostics and PCM bounds. src/export/ contains encoders. External live generative tracks are guarded against silent export without capture.                                                                                                  | Render/bounce/export / kyx_export, render summary, mix diagnosis                                         | Accepted project edits are undoable and saved. Offline parity is an explicit contract.                                                              |
| Built-in instruments/effects     | **Confirmed.** src/instruments/registry.ts, src/effects/registry.ts and metadata; src/project-model/targets.ts derives legal automation parameter targets.                                                                                                                                                                                                     | UI / catalog and parameter MCP tools                                                                     | Parameter changes are undoable and saved. Registry/parameter tests exist.                                                                           |
| Third-party plugin processing    | **Partial / absent for audio processing.** CLAP discovery and VST3 Wave 1 are structural/metadata scans, not project-graph audio processing. docs/adr/0035-vst3-hosting-policy.md leaves offline render-through and realtime hosting as gated future waves.                                                                                                    | Scan visibility only / no plugin DSP control                                                             | No hosted plugin state path to persist. Scanning is not hosting.                                                                                    |
| Automation and modulation        | **Confirmed editing/playback; Partial natural language.** src/project-model/targets.ts validates track gain/pan and effect/instrument parameters; src/commands/automation.ts, automationClips.ts, and automationBridge.ts connect edits to playback. src/intent/studio-words.ts only parses a gain ramp; MCP kyx_automation takes structured targets/points.   | Automation UI / structured MCP and narrow Intent                                                         | Persistent, undoable. Target and scheduler paths are testable.                                                                                      |
| Sound/preset discovery           | **Confirmed.** src/ui/SampleBrowser.tsx, BrowserStrip.tsx, PresetBrowser.tsx, src/sample-library/projectFit.ts, kit pools/presets, preset normalization. Sound/loop/preset discovery is unified and project-aware; loop audition syncs to tempo; preset preview can run on selected track and stops on safety events.                                          | Browser/preview / indirect project tools; no full agent-side sound-audition planner found                | Preview is runtime-only; applying a sound is a separate document action. UI tests exist.                                                            |
| Intent/local model               | **Confirmed constrained intent; Partial creative planning.** Deterministic parser/planner and canonical command adapters in src/intent/. src/intent/model-ollama.ts validates a bounded model action before canonical execution and can be disabled. Creative-task Ollama is isolated behind evaluation code and is not established as production coauthoring. | Intent UI; local model when available / a subset of actions through MCP                                  | Constrained edits can be undone; model is outside audio thread. Validation/fallback paths exist.                                                    |
| ONNX ranking/symbolic priors     | **Partial, optional.** src/ai/ranking/ranker-client.ts, src/ai/symbolic/prior-client.ts, src/intent/model-loader.ts use timeout/circuit breaker and deterministic fallback. They rank/select; they are not free-form DAW controllers.                                                                                                                          | Some Intent/recommendation UI / indirect only                                                            | Model does not own project state; fallback and eval tests exist but were not run here.                                                              |
| MCP and agent safety             | **Confirmed with transaction boundary.** src/mcp/tools.ts, agentTrust.ts, flags.ts, bridge.ts and host adapters expose risk classes, audit receipts, checkpoints, readback, destructive gates. Static source census at baseline has 39 tool definitions; schema coverage is mixed and some receipt schemas are broad.                                          | User enables connected agent / yes when host integration and policy permit                               | Commands/store remain mutation path; checkpoints/undo/audit exist. Batch’s one undo frame is not rollback.                                          |
| Collaboration                    | **Partial.** src/collab/ has Yjs document/session, transport sync and bandmate wiring, loaded lazily. Evidence does not establish qualified networked audio collaboration or project-scoped multi-project agent ownership.                                                                                                                                     | Collaboration surfaces exist with boundaries / current MCP bridge is one active renderer/project context | Collaboration sync has its own state model; not equivalent to multi-project agent safety.                                                           |
| Reference analysis               | **Confirmed analysis-to-command seam; Partial interpretation.** src/reference/ provides analysis descriptors and pure ReferenceMap-to-Command helpers in apply.ts. Detected and user-confirmed tempo/key remain distinct; swing is not fabricated.                                                                                                             | Reference Map UI / no general MCP analysis workflow confirmed                                            | Applied values are undoable project commands. Relevant tests exist.                                                                                 |
| External project conversion      | **Absent.** docs/DAW-TRANSFER-EXPORT-GUIDE.md covers audio/MIDI transfer; support matrix leaves source qualification open. Native FLP/CPR/PTX conversion is not shipped.                                                                                                                                                                                       | File/audio/MIDI transfer / limited import-export tools                                                   | Imported assets persist; no native project round-trip contract.                                                                                     |
| External MIDI expression         | **Partial.** Internal editing is richer than current Standard MIDI expression interchange; support matrix and ADR 0049 constrain interchange. Do not assume general MPE/time-varying expression.                                                                                                                                                               | Piano Roll/MIDI transfer / structured notes where exposed                                                | Note edits undo/persist; unsupported interchange may be lossy.                                                                                      |
| Generative audio provider        | **Absent in service wiring.** src/services.ts registers an unavailable MRT2 provider with a not-installed reason. Runtime infrastructure is not an active production provider.                                                                                                                                                                                 | No active MRT2 generation / none                                                                         | Do not build on an unavailable provider.                                                                                                            |
| Feature flags/experiments        | **Partial.** Model, ranker, symbolic prior and destructive MCP access have flags/kill switches. A flag is not release qualification. Creative-task provider remains experimental.                                                                                                                                                                              | Some settings visible; some internal / agent risk policy                                                 | Can disable; persisted project state remains separate.                                                                                              |

### High-impact code paths

1. **User edit to audio:** UI → command in src/commands/ → ProjectStore.applyCommand → normalize/undo → AudioEngine projection. ProjectStore is document authority.
2. **Automation to sound:** AutomationTarget → target metadata/validation → command points/clips → automationBridge/scheduler → audio parameter.
3. **Mix assistant:** kyx_mix_idea → pure planMixIdea → optional before/after render in src/mcp/mix-preview.ts → level-matched preview → explicit one-undo apply → render summary and human kyx_blind_ab verdict.
4. **Agent mutation:** MCP risk/checkpoint gate → executor → same command/store path → receipt/readback. Safer and inspectable, but kyx_batch can partially commit.
5. **Sound audition:** project-fit ranking → sample/preset preview on live transport or isolated preview → separate command to apply.
6. **Offline render:** request → fresh offline context/engine → bounded render → diagnostics/export. It prevents live engine state leaking into export and keeps models outside DSP execution.

## 3. Latent integration opportunities

The product already has reusable primitives: commands as the state boundary; offline render as a truth path; a shared parameter catalog; audition without commit; human comparison; MCP receipts/checkpoints; and deterministic fallback.

| Existing combination                                                             | Already true                                                                 | Missing contract                                                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Effect registry + automation metadata + scheduler                                | Effect/instrument parameters can be automated and played.                    | Resolve natural language to exact target/instance/units and section-bounded curve, then preview/apply. |
| Project-aware sound discovery + tempo-synced loop preview + live preset audition | Sounds rank in project context; presets can audition against a beat.         | Whole-kit audition plus “why this fits,” without document mutation.                                    |
| Offline render + selected arrangement range + bounce                             | Range renders/consolidation exist.                                           | Aligned temporary A/B before print, with tails/latency and cleanup rules.                              |
| Mix plan + preview + one-undo apply + blind trial                                | Real plan/listen/apply/verify loop exists for mix ideas.                     | Generalize safely to other creative operations.                                                        |
| MCP batch + receipts + undo frame                                                | Calls group into one undo entry where supported; child results are reported. | Full preflight and rollback; current stop-on-first-failure can leave prior edits committed.            |
| Checkpoints + undo + persistence                                                 | Restore and recent snapshots exist.                                          | Named creative alternatives with audio comparison and provenance.                                      |
| Reference Map + project tempo/key/markers                                        | Analysis can become validated project commands.                              | Reviewable, provenance-aware arrangement/automation suggestions.                                       |
| Blind A/B + local style observations                                             | Human trials and preference signals exist separately.                        | Opt-in measured ranking that preserves diversity and does not change the mix.                          |

Do not create a second command system, sound catalog, mixer, or undo history. Extend the existing contracts.

## 4. Professional workflow audit

### Create session → import/record → edit → mix → save/reopen → export

**Observed path:** template/project browser and repository → audio/MIDI transfer or recording → arrangement/command editing → mixer/effects/automation → autosave/snapshot/recovery → offline render/export.

**Friction:** audio/MIDI transfer is not native project conversion; source-DAW export qualification is open; physical recording qualification is configuration-specific. Import must not imply that mixer settings, plugins, automation, or proprietary metadata transferred.

**Musician outcome:** a transfer passport and verified import summary show what arrived, what is missing, and what needs manual rebuilding.

### Iterate on a vocal chain

**Observed path:** built-in effects/parameter metadata → track chain → parameter controls/automation → mix plan/preview/apply → undo and render summary.

**Friction:** third-party plugin processing is not shipped; natural-language automation is only a gain ramp despite broader target metadata; no general versioned chain A/B lineage was found.

**Musician outcome:** hear a chain idea before committing, preserve the original take/print, and compare matched versions with an exact parameter diff.

### Ask AI to make several edits

**Observed path:** MCP state/catalog → kyx_mix_idea or kyx_batch → canonical executor → receipts → undo/checkpoint and render summary.

**Friction:** kyx_batch lacks aggregate dry-run and rollback. atomic:true stops at first failure but earlier successful edits remain. Output schemas/receipts vary in specificity.

**Musician outcome:** validate all targets and ranges, preview the combined result, then apply once or cancel with no project change. Reject stale revision before mutation.

### Compare alternatives and recover

Mix preview, blind A/B, checkpoint restore, undo, autosave and recording recovery already cover useful pieces. The gap is a general, provenance-aware variant flow and consistent project-scoped recovery/readback across operations. A musician should compare a few matched variants, choose one, and discard the rest without contaminating the session.

## 5. Prioritization rubric

- Musician value, ecosystem leverage, architecture fit, differentiation, maintainability: Low / Medium / High.
- Reliability risk, implementation cost, validation difficulty: Low / Medium / High, where lower is preferred.
- Rank favors daily utility and proven building blocks, then discounts risk/cost/validation. Ambiguous state ownership, unsafe rollback, or untestable audio quality blocks a high rank.
- Musician value and novelty use ordinal 1–5 scores: value 1 is rare/niche, 3 helps a defined workflow, 5 improves a repeated core task; novelty 1 is conventional convenience, 3 is differentiated system composition, 5 is a defensible KYX-specific creative workflow. These are product judgments, not user research.

## 6. Opportunity portfolio

### H1 — high-leverage near-term

#### 1. Audition a full candidate kit in the current beat

- **Story:** “Let me hear this kit on my pattern before replacing my current sounds.”
- **Evidence/building blocks:** src/project-model/kit-presets.ts, src/sample-library/kit-pools.ts, SampleBrowser project-fit ranking, PresetBrowser live preview and project/transport stop guards.
- **Missing/dataflow:** disposable runtime/project overlay for all kit layers → selected 1/2/4 bars → preview → apply existing kit command or dismiss. Project model remains authority; preview is transient.
- **AI/MCP:** AI unnecessary; deterministic role/mood/genre/tempo/key metadata. Agent may request a plan later, but human should listen.
- **Safety/undo/persistence:** preload layers; no scheduler/model work; preview changes neither project nor undo. Apply is one normal command/undo. Failed decode leaves current kit intact.
- **Validation/observability:** hash/undo unchanged, Escape/Stop/track-change/project-edit stop, missing-asset behavior; listen in dense/sparse beats and mono; bounded bars/candidate count and cache.
- **Risk/cost:** M; preview routing or sample latency may differ from live. Reuse authoritative kit-apply path.
- **Scores:** value 5/5 (repeated high-impact choice); novelty 3/5 (whole kit audition in the producer’s own beat). Rubric: value/leverage/fit/maintainability High; risk/cost/validation Medium.

#### 2. Preview selected-range render before bounce/consolidation

- **Story:** “Let me hear a printed section against the original before it replaces or covers anything.”
- **Evidence:** src/rendering/renderer.ts, ArrangementPanel bounceZoneToClip/consolidation, src/mcp/mix-preview.ts.
- **Missing/dataflow:** selection → bounded temporary PCM render → aligned source/print A/B → explicit apply creates existing print/clip command; cancel drops buffer. Project stays unchanged until apply.
- **AI/MCP:** not needed; MCP preview only if a human can hear its UI lane.
- **Safety/undo/persistence:** offline render, cancel on stale selection/revision, one undo; staged media cleaned if command commit fails. Accepted asset persists.
- **Validation/observability:** transient alignment/latency/tails/sends, mono and headphones listening, cancellation cleanup, memory caps, export parity. Show range/render settings/tail policy.
- **Risk/cost:** M; tail truncation/double playback/stale revision. Reuse render and preview code.
- **Scores:** value 4/5 (frequent safer print workflow); novelty 2/5 (conventional but uses KYX’s renderer). Rubric: value/leverage/fit/maintainability High; risk/cost Medium; validation High.

#### 3. Target-aware automation planning from natural language

- **Story:** “Automate the vocal filter cutoff over the last four bars and let me inspect it before it plays.”
- **Evidence:** src/project-model/targets.ts has valid effect/instrument ranges; automation commands and src/audio-engine/automationBridge.ts schedule them; MCP kyx_automation has structured targets; src/intent/studio-words.ts currently parses gain ramp only.
- **Missing/dataflow:** typed proposal with exact track/effect/parameter, units, time range, endpoints, and curve → registry validation → visible lane preview → one command. Project owns final curve.
- **AI/MCP:** deterministic grammar first. Model may map ambiguous language into typed proposal after evaluation; never needed for execution. MCP and UI share the target catalog.
- **Safety/undo/persistence:** planner off RT; scheduler sees validated numeric points only; reject ambiguous/missing/stale IDs and unsupported units. One persistent undoable command; explicit apply.
- **Validation/observability:** corpus for target/unit/ambiguity; property checks ranges; UI/Intent/MCP parity; dense automation scheduler tests and human curve audition. Receipt reports resolved target, units, values and span.
- **Risk/cost:** M; wrong instance/unit is the main risk. Existing target metadata avoids a new schema if current curve type suffices.
- **Scores:** value 5/5 (exposes existing expressive depth); novelty 3/5 (composition of mature parts). Rubric: value/leverage/fit/maintainability High; risk/cost/validation Medium.

#### 4. DAW transfer passport and import verification

- **Story:** “Tell me what will survive the move and what KYX actually received.”
- **Evidence:** docs/DAW-TRANSFER-EXPORT-GUIDE.md, support matrix, transfer import/MIDI code, scripts/verify-daw-transfer.mjs and transfer tests.
- **Missing/dataflow:** inspect exported folder read-only → manifest media, offsets, tempo/key where present, sample rate, MIDI, naming and omissions → user confirms → normal import commands.
- **AI/MCP:** deterministic inspection suffices; MCP may summarize but cannot infer proprietary state or run source-app automation.
- **Safety/undo/persistence:** decode off RT; obey import/decompression caps; stage files then attach only after validation; failed import leaves project unchanged. Persist manifest/receipt and hashes.
- **Validation/observability:** fixtures from explicitly supported FL Studio/Cubase/Pro Tools versions; missing media, rates, offsets, MIDI, stereo, tempo/key disagreement. Report limits; do not claim project equivalence.
- **Risk/cost:** M; source formats drift. Maintain versioned support matrix.
- **Scores:** value 4/5 (reduces adoption uncertainty); novelty 2/5 (trustworthy evidence is the distinction). Rubric: fit/value High; leverage Medium; risk/cost/validation Medium to High.

### H2 — ecosystem-level composition

#### 5. Prepare/validate/review/commit for MCP plans

- **Story:** “Make these edits only if every target and value is valid; otherwise leave my song untouched.”
- **Evidence:** src/mcp/tools.ts, agentTrust.ts, mix-idea.ts (pure plan), mix-preview.ts (render before apply), ProjectStore undo frames. Current batch is sequential; atomic:true stops on first failure but prior mutations remain.
- **Missing/dataflow:** immutable plan → validate all IDs/ranges/risks/revision/assets → show diff/preview → revalidate revision → apply one combined command → actual readback.
- **AI/MCP:** MCP carries typed plan; AI optional author only. Deterministic validation and canonical commands are authoritative.
- **Safety/undo/persistence:** no inference/network in RT. First version document-only, excluding export/render side effects and filesystem/providers. One undo; preserve destructive approval/checkpoint; audit plan ID/revision/diff/outcome. If rollback cannot be proven, don’t call it atomic.
- **Validation/observability:** fail each command position, stale revision, denied permission, bad range, duplicate ID, replay; project hash and undo unchanged on refusal. Large-project budget and UX review.
- **Risk/cost:** L, high integrity risk; version tool contract and preserve old semantics until proven.
- **Scores:** value 5/5 (prevents partial assistant edits); novelty 4/5 (verifiable cross-system changes). Rubric: value/leverage/differentiation High; fit Medium; risk/cost/validation High; maintainability Medium.

#### 6. Reusable built-in effect-chain recipes with provenance

- **Story:** “Save the vocal chain I approved and apply it to another vocal with a clear compatibility diff.”
- **Evidence:** effect registry/parameter metadata, presets, project commands, checkpoints, persistence. Third-party processing is absent.
- **Missing/dataflow:** versioned recipe records effect IDs/order/params/role and KYX registry version → dry-run diff on destination → explicit apply to one track.
- **AI/MCP:** AI optional for role matching; deterministic compatibility validation and same command path; MCP can inspect/apply with approval.
- **Safety/undo/persistence:** build full validated command before graph projection; unknown effect/param aborts, never partial applies. One undo; recipes persist with provenance; built-in only initially.
- **Validation/observability:** migrations, unknown effects, clamp behavior, routing/order, live/offline parity and undo; report mapped/clamped/refused fields.
- **Risk/cost:** M; registries change. Stable IDs and refusal/migration policy required; no VST recipe claims.
- **Scores:** value 4/5 (less repetitive setup); novelty 3/5 (useful preset/command composition). Rubric: value/fit/maintainability High; leverage/risk/cost/validation Medium.

#### 7. Creative alternatives with shared provenance

- **Story:** “Keep the original, compare darker and wider versions fairly, then apply one.”
- **Evidence:** kyx_checkpoint, mix-preview.ts, kyx_blind_ab, ProjectStore undo.
- **Missing/dataflow:** named session variants over a base revision → modify one declared dimension (chain, kit, arrangement) → matched render → user chooses → apply selected delta only if base revision matches.
- **AI/MCP:** AI can suggest bounded alternatives; human judges; deterministic variant bookkeeping/readback.
- **Safety/undo/persistence:** variant is a separate preview document, not hidden live edit. Commit one command; discard leaves original unchanged. Begin session-scoped and opt-in; retain base/revision/provenance.
- **Validation/observability:** unchanged base hash during preview, no leaked media, matched loudness/range, deterministic rerender, stale-base conflict, listening study.
- **Risk/cost:** M; unfair comparison from loudness, random seeds or duration. Reuse current preview/checkpoint, avoid new VCS subsystem.
- **Scores:** value 4/5 (safer experimentation); novelty 3/5 (extends preview beyond mix). Rubric: value/leverage High; fit/risk/cost Medium; validation High.

### H3 — next-generation bets

#### 8. Constrained local creative planner with deterministic execution

- **Story:** “Make a restrained 16-bar lift: widen the lead, add filter movement, leave kick and vocal alone.”
- **Evidence:** bounded Ollama Intent, typed creative-task contract/eval code, deterministic actions, mix plan/preview, local style observation, ONNX ranking. Creative-task Ollama remains experimental/eval-only; generative provider is unavailable.
- **Missing/dataflow:** local model emits typed proposal → deterministic resolver checks project objects, parameters, permissions and constraints → preview → human reviews exact changes/audio → canonical command applies.
- **AI/MCP:** local LFM only for language-to-plan after evaluation; not required for execution. MCP delivers plan and receipt.
- **Safety/undo/persistence:** async and outside callback; timeout/circuit breaker/fallback. No mutation before approval. One command or refusal; bounded local log includes model/schema/plan/refusal; kill switch; no implicit training upload.
- **Validation:** held-out producer tasks, exact target/parameter accuracy, abstention and unsafe edit rate, stale revision, reference-hardware latency, failure injection, human utility vs deterministic-only.
- **Risk/cost:** L and conditional; first read-only plan, then preview-only, then approved commit.
- **Scores:** value 5/5 only if held-out reliability passes; novelty 4/5. Current maturity Partial. Rubric: value/leverage/differentiation High; fit Medium; risk/cost/validation High.

#### 9. Learn sound preference from explicit listening trials

- **Story:** “Use my repeated preference for dry, dark kits to rank relevant options, but keep all sounds available and explain why.”
- **Evidence:** blind A/B human trials, src/intent/reaction-* local preference signals, deterministic sound metadata/project fit.
- **Missing/dataflow:** opt-in linkage of trial features to local profile → interpretable secondary ranking → always retain neutral/all-results view and explanation.
- **AI/MCP:** no LLM needed; MCP cannot infer/change taste profile without explicit permission.
- **Safety/undo/persistence:** outside audio path; separate local state, pause/reset/export/delete; never changes project sound or mix. No upload without opt-in.
- **Validation:** offline blinded study, diversity and cold start, erase/privacy tests, prove improvement over metadata-only ranking.
- **Risk/cost:** M; feedback can create a filter bubble. Keep all candidates and deterministic fallback.
- **Scores:** value 3/5 (cold start limits it); novelty 4/5 (explicit A/B improving discovery). Rubric: value/leverage/fit Medium; risk/cost Medium; validation High; differentiation High.

#### 10. KYX Sound Seed from a user’s source

- **Story:** “Turn one recording into a related kick layer, bass texture, tonal hit and transition, retaining the original and letting me reject derivatives.”
- **Evidence:** user sample import, sampler/granular/wavetable/texture instruments, analysis, render/export, preview. docs/SOUND-LIBRARY-INVENTORY-2026-10-17.md documents 155 factory slots / 146 curated WAVs and source/performance identity gaps.
- **Missing/dataflow:** user source → read-only analysis → a few deterministic recipes → offline render → audition in beat → explicit selection into user sample repository, with source/derivative lineage.
- **AI/MCP:** DSP/heuristics first, AI optional; model proposes recipes outside RT; MCP cannot record/publish on its own.
- **Safety/undo/persistence:** bound duration/size; check peaks/DC/mono low end/silence/format; stage derivative assets and attach only on acceptance; rejected buffers cleaned. Store source hash, recipe/DSP version and render settings. User controls recording/contribution rights.
- **Validation:** blinded listening, family coherence, recognizability, repeatability, sample quality gate, caps, deletion and consent/rights review before shared factory contribution.
- **Risk/cost:** L; subjective output/asset proliferation. Begin with one source type and three bounded recipes.
- **Scores:** value 4/5 (identity leverage for creators); novelty 5/5 (personal source becomes a traceable KYX family). Rubric: differentiation High; value/leverage/fit Medium-High; risk/cost/validation High.

## 7. Top 10 ranked recommendations

Rank is based on the rubric and evidence, not certainty of funding.

| Rank | Capability                                  | Horizon | Value | Novelty | Rationale                                                                               |
| ---: | ------------------------------------------- | ------- | ----: | ------: | --------------------------------------------------------------------------------------- |
|    1 | Full-kit audition in current beat           | H1      |     5 |       3 | Repeated choice; project-fit, kit data and live audition provide a credible base.       |
|    2 | Target-aware automation planner             | H1      |     5 |       3 | Expressive payoff from existing target catalog; narrow Intent grammar is a known gap.   |
|    3 | MCP prepare/validate/review/commit          | H2      |     5 |       4 | Highest agent integrity payoff; gated on no-partial-mutation proof.                     |
|    4 | Selected-range render preview before bounce | H1      |     4 |       2 | Strong render/undo reuse; needs alignment and tail validation.                          |
|    5 | Transfer passport and import verification   | H1      |     4 |       2 | Reduces migration uncertainty; real source fixtures are the cost.                       |
|    6 | Built-in effect-chain recipes               | H2      |     4 |       3 | Saves setup; needs version/compatibility rules.                                         |
|    7 | Creative alternatives with provenance       | H2      |     4 |       3 | Extends preview/checkpoint/A-B; stale-base and fairness need proof.                     |
|    8 | KYX Sound Seed                              | H3      |     4 |       5 | Identity potential; subjective quality and rights need gates.                           |
|    9 | Preference-informed discovery               | H3      |     3 |       4 | Useful after opt-in data; protect diversity/privacy.                                    |
|   10 | Constrained local creative planner          | H3      |    5* |       4 | Conditional; current creative-task path is experimental and needs strongest evaluation. |

*Value 5 is conditional on held-out workflow reliability; current status is Partial.

## 8. Top five ambitious, technically credible ideas

1. **Typed local creative planner:** bounded LFM proposals, deterministic editable commands, preview-first, local fallback. Start read-only and evaluate on held-out tasks. No direct model mutation.
2. **KYX Sound Seed:** source recording → deterministic family recipes → project-context audition → opt-in derivatives with provenance. Start with a few DSP recipes and listening validation.
3. **Explicit preference learning:** human A/B choices improve discovery with “why,” full catalog access, local storage and reset/delete. Start as offline opt-in study, not online model training.
4. **Arrangement-aware atmosphere:** deterministic, automatable layer responds to user-approved section/groove/energy cues. Must stay project-owned, A/B-able, render-identical offline, and controlled around kick/bass. Algorithm and listening evidence are absent.
5. **Project-scoped agent capabilities:** explicit project ID, revision/lease and per-project grants for future multi-project agents. Never infer target from focused UI. Start with threat model/read-only prototype; no cross-project mutations until ownership/recovery are proven.

## 9. Dependency graph

- Canonical project IDs + revision semantics → MCP preflight, creative variants, project-scoped agents.
- Target metadata + unit validation → natural-language automation → constrained creative planner.
- Read-only render + audition lane → kit audition, selected-range print A/B, creative alternatives, Sound Seed.
- Immutable plan + complete preflight → MCP review/commit/readback → constrained local planner.
- Stable built-in effect IDs + recipe versioning → portable chain recipes.
- Transfer fixtures + honest import report → transfer passport.
- Explicit local preference/asset provenance → personalized discovery and Sound Seed.

Cross-cutting prerequisites: stale-plan refusal, asset cleanup on cancel/failure, one mutation route, receipts/readback, deterministic fallback, listening/device verification where relevant.

## 10. Cautious roadmap

### Now — prove read-only/runtime-only increments

- Prototype whole-kit audition via project-fit and preset preview. Prove document and undo unchanged.
- Prototype selected-range print audition with latency/tail alignment and temporary-buffer cleanup.
- Add read-only import passport for current audio/MIDI transfer; collect source-version fixtures.
- Inventory target-aware automation coverage and build deterministic parser corpus; do not change schema unless existing curves prove insufficient.

### Next — contracts before more autonomy

- Target-aware automation plan/preview/apply via canonical target catalog, one command, revision checks, units and readback.
- Aggregate MCP preflight for document-only operations; prove validation-before-mutation and failure injection before commit support.
- Define built-in effect-chain recipe version behavior.
- Extend preview/A-B to one bounded action at a time and validate with musicians.

### Later — ecosystem layer

- User-approved creative alternatives with provenance and selected-delta apply.
- Opt-in local preference ranking with reset/delete and diversity metrics.
- Broader transfer support only with maintained fixtures/support labels.
- Expand local creative planning only after evaluation supports real project-scale tasks.

### Research — no promise until feasibility passes

- Sound Seed algorithms and contribution rights.
- Afterimage atmosphere and listening study.
- Multi-project agent identity, leases, and recovery ownership.
- Native project conversion and third-party plugin processing under existing licensing/compatibility/isolation gates.

## 11. Risk register

| Risk                   | Failure mode                                                                         | Guardrail / acceptance boundary                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Realtime audio         | Model/network/render blocks scheduler or sample loading glitches playback.           | No AI/network in callback. Preload; bounded offline/worker rendering; audio thread consumes validated numeric state.                      |
| Project integrity      | Preview leaks into live project or stale plan overwrites user edit.                  | Temporary runtime document, revision preconditions, explicit apply, verify hash and undo unchanged during preview.                        |
| Partial failure / undo | Batch says atomic while earlier operations persist.                                  | Current semantics explicit. New plan validates all first and proves rollback or commits one combined command. Failure injection required. |
| Recovery               | Preview media or wrong-project checkpoint survives; recovery cleared incorrectly.    | Project-scoped IDs, staged cleanup, ownership tests, clear only after same-project durable save/readback.                                 |
| MCP security           | Broad schemas or ambiguous targets produce unreviewed action.                        | Least privilege, operation-level risk, destructive approval, typed args, plan IDs/receipts; model text is not an object ID.               |
| AI agency              | Fluent model claim mistaken for mutation success or it guesses target.               | Model proposes; resolver validates; human reviews; executor reads actual state. Abstain, fallback, kill switch.                           |
| Compatibility          | Recipe references removed effect/unknown parameter or unsupported format is implied. | Stable IDs, versioning, explicit refusal/migration; built-in-only recipes; no native project/plugin claim before gates pass.              |
| Misleading A/B         | Loudness, random variation, tails or latency bias decision.                          | Match range/loudness, same engine/settings, deterministic seeds where possible, disclose gain/tail, human listening.                      |
| Generic sound identity | More assets add near-duplicates and obscure distinctive sounds.                      | Add source/recipes only after real-beat role-distinction test; keep catalog discoverable; no bulk-pack target.                            |
| Performance/memory     | Multiple variants or large renders exhaust resources.                                | Bound bars/channels/buffers/bytes/time; cancel stale work; reuse offline limits; shorten preview on degradation.                          |

## 12. Recommended proof-of-concept experiments

1. **Kit audition integrity**
   - **Pass:** audition three kits on same bars; project hash/undo unchanged; Stop/Escape/track change/edit/failing asset stops cleanly; chosen kit applies in one undo.
   - **Fail:** preview mutates project, misses a safety stop, or uses different routing without disclosure.

2. **Region print A/B**
   - **Pass:** source and print align through transients/sends/latency and declared tail; cancel leaves no assets; apply is one undo and export matches accepted print.
   - **Fail:** phase shift, truncated tails, leaked media, double playback, or stale selection reaches commit.

3. **Automation planner**
   - **Pass:** fixed corpus has correct targets/units/ranges/spans; ambiguity abstains; UI/Intent/MCP resolve same metadata; lane is visible, audible, persistent and one undo.
   - **Fail:** wrong target/instance, wrong units, unsupported parameter accepted, or model failure changes audio.

4. **MCP transaction**
   - **Pass:** failure at each position, stale target, or denied permission leaves snapshot/hash and undo unchanged; successful validated commit has matching readback.
   - **Fail:** partial edit reported as atomic/successful or rollback removes user work after plan.

5. **Transfer passport**
   - **Pass:** declared fixtures report imported media, offsets, present tempo/key fields, missing files and unsupported state accurately.
   - **Fail:** silently guesses/drops tempo, offset, media or unsupported field.

6. **Preference ranking**
   - **Pass:** opt-in offline study improves selection/time while preserving diversity; reset erases influence; no project/audio change.
   - **Fail:** upload without consent, invisible narrowing, or no gain over metadata-only baseline.

7. **Local creative planner**
   - **Pass:** held-out tasks make typed plans, abstain safely, pass preflight, and improve completion over deterministic-only without raising unsafe edits.
   - **Fail:** direct model mutation, hidden/non-reproducible edit, fabricated control, or success message without readback.

## 13. Explicit do-not-build-yet list

- Do not advertise LFM as an all-purpose production copilot; creative-task provider is experimental/evaluation-oriented.
- Do not label MCP batch “atomic” by label alone; stop-on-first-failure is not rollback.
- Do not build native FLP/CPR/PTX conversion from export guides or infer proprietary formats without rights, fixtures and support commitment.
- Do not ship realtime VST3/CLAP before offline-host, isolation and parity gates; scanning is not hosting.
- Do not add a giant factory pack, bulk-normalize the documented clean library, or delete nearest neighbors from descriptor similarity alone.
- Do not put model/network calls or unbounded rendering in realtime audio.
- Do not persist preview overrides/variants into the project without explicit apply.
- Do not train on A/B/rejections without opt-in, deletion, and evidence over simple ranking.
- Do not infer hardware qualification from browser software tests.
- Do not add schema complexity for automation/variants until current contracts prove insufficient.

## 14. Evidence gaps and product-owner decisions

### Evidence gaps

- No fresh full-library listening session; existing inventory does not establish which near-neighbors are redundant in dense beats.
- Sound inventory is dated 2026-10-17, with evidence through 2026-10-19; counts and gates are a snapshot.
- No real-project performance measurement for variants, kit-preview latency, or large-arrangement memory.
- MCP counts/schema coverage are static source inspection, not a live client handshake.
- Local LFM evaluation is not evaluation of the proposed multi-step planner.
- Source DAW/version qualification remains open; hardware qualification depends on an approved reference setup.
- Sound Seed algorithms, contribution rights, and consent flow do not exist.

### Decisions for product owner

1. Highest adoption boundary: sound identity, migration, or agent reliability?
2. Are preview variants session-only by default or saveable?
3. Should signature sounds begin with KYX-recorded originals, user-supplied Sound Seed, or both?
4. Is preference learning local and opt-in; may choices ever leave device?
5. Which exact DAW versions and audio hardware define initial support?
6. Which agent actions can prepare automatically, and which always require apply approval?
7. May natural-language automation resolve a unique plugin instance, or must ambiguous targets be selected in UI?

## 15. Source index

- Architecture/state: ARCHITECTURE.md; src/project-model/types.ts, schema.ts, targets.ts; src/commands/; src/store/ProjectStore.ts.
- Audio/runtime: src/audio-engine/AudioEngine.ts; src/audio-engine/automationBridge.ts; src/audio-worklets/; src/scheduler/Scheduler.ts; src/transport/Transport.ts.
- Render/export: src/rendering/renderer.ts; src/rendering/track-renderer.ts; src/export/; src/ui/ArrangementPanel.tsx.
- Persistence/recovery: src/services.ts; src/persistence/ProjectRepository.ts; save-lifecycle.ts; recoveryBuffer.ts; RecordingRecoveryRepository.ts.
- Instruments/effects/presets: src/instruments/registry.ts; src/effects/registry.ts; src/effects/types.ts; src/presets/; src/project-model/kit-presets.ts; src/sample-library/kit-pools.ts.
- Sound discovery: src/ui/SampleBrowser.tsx; BrowserStrip.tsx; PresetBrowser.tsx; src/sample-library/projectFit.ts; docs/SOUND-LIBRARY-INVENTORY-2026-10-17.md.
- Intent/models: src/intent/; model-ollama.ts; creative-task-ollama.ts; creative-task-evaluation-runner.ts; src/ai/ranking/; src/ai/symbolic/.
- MCP: src/mcp/tools.ts; mix-idea.ts; mix-preview.ts; agentTrust.ts; flags.ts; bridge.ts.
- Reference/collaboration: src/reference/; src/collab/.
- Support/policy: docs/WEB-STUDIO-SUPPORT-MATRIX.md; docs/DAW-TRANSFER-EXPORT-GUIDE.md; docs/adr/0005-rust-wasm-dsp-policy.md; docs/adr/0035-vst3-hosting-policy.md; docs/adr/0049-piano-roll-note-event-editor.md.

**Verification statement:** This report is based on static inspection of the committed baseline and existing repository records. It does not claim test, build, runtime, device, or listening results from this mission.
