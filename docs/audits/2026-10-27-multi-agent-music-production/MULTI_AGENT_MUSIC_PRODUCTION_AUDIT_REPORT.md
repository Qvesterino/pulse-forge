# Multi-Agent Music Production Audit

- **Date:** 2026-10-27
- **Product:** KYX / Pulse Forge
- **Repository baseline:** committed HEAD 56f9961cb1501dd9d1d05c52b680d0e747941de2
- **Scope:** source and tests at the baseline commit. Concurrent worktree edits were present and are excluded from findings unless identified. This is an architecture audit; no project code was changed.

## Executive verdict

**SINGLE AGENT SUFFICIENT for current production workflows. NOT READY for autonomous multi-agent editing.** The repository already has a capable external MCP tool surface, deterministic planning and analysis helpers, risk gates, dry runs, checkpoints, field-level stale-write checks, scoped writes, idempotency, and cooperative render cancellation. These make a single model with a structured plan and existing tools the right present-day baseline.

There is no in-product runtime that creates independent specialist agents, gives them separate context or permissions, reconciles their proposals, or schedules their writes. Several features use “agent,” “producer,” “multi-voice,” or “Bandmate” language, but they are respectively an external MCP caller, deterministic prompt/planning logic, a symbolic composition algorithm, and a procedural groove companion. They do not demonstrate that autonomous peers improve outcomes.

The most credible future test is a **read-only reviewer experiment** on a fixed selected section: compare one agent with two independently prompted reviewers and one synthesizer, holding model family, evidence, and total token budget constant. Keep it offline and fixture-based until an immutable analysis packet and cancellation path are complete. Do not add a multi-agent framework or allow specialists to mutate a live session now.

No sonic benefit has been measured. A successful tool call, valid command, or render metric is not evidence that a mix sounds better. Change this decision only if controlled trials show repeatable improvement in evidence-grounded and human-rated production notes at comparable cost and latency, without unintended edits or increased approval burden.

## 1. Current architecture and single-agent baseline

### Architecture map

```mermaid
flowchart LR
  UI[KYX UI and Intent Panel] --> INT[Intent pipeline: parse, normalize, plan]
  INT --> LOCAL[Local symbolic / ONNX path; optional local Ollama]
  EXT[External MCP client model] --> WEB[Web relay and MCP HTTP]
  EXT --> DESK[Desktop stdio bridge]
  WEB --> DISPATCH[Shared MCP_TOOLS and executeMcpTool]
  DESK --> DISPATCH
  DISPATCH --> GATE[Risk, consent, scope, stale-write, idempotency, dry-run]
  GATE --> CMD[Typed command handlers]
  CMD --> STORE[ProjectStore or YDocStore]
  STORE --> SAVE[Autosave / persistence / checkpoints]
  STORE --> ENGINE[AudioEngine projection]
  ENGINE --> SCHED[Transport and Scheduler]
  SCHED --> WORKLET[AudioWorklet real-time DSP]
  DISPATCH --> OFFLINE[Offline render and analysis helpers]
  OFFLINE --> DISPATCH
  STORE -. no specialist scheduler or peer-agent runtime .-> DISPATCH
```

The MCP surface is the agent-facing interface; the external client supplies the model and chooses tools. KYX exposes one catalog and central dispatcher, then applies commands to the current document. The transport is not a separate agent sandbox. Audio engine, scheduler, and worklets remain their own execution layers; model calls and coordination must stay outside the real-time audio path.

### Existing AI and agent-like entry points

| Area                    | Implemented behavior                                                                                                                                                                                                                                                                           | What it does not establish                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent Engine           | **src/intent/** parser, normalizer and planners; native model worker and optional local Ollama map an instruction to a bounded KYX action. **model-context.ts** builds read-only, relevance-filtered context capped at 12,000 characters.                                                      | No peer delegation or autonomous review group. This is the local action-interpretation path.                                                                                       |
| MCP agent surface       | **src/mcp/tools.ts** publishes one MCP catalog and dispatcher. Useful tools include **kyx_render_summary**, **kyx_diagnose_mix**, **kyx_mix_idea**, **kyx_master**, **kyx_arrange**, **kyx_song**, **kyx_batch**, **kyx_intent**, and **kyx_separate**. Hosts are web relay and desktop stdio. | External MCP clients are independent callers, not specialists managed by KYX. No peer-agent scheduler, delegation graph, role permission broker, or proposal reconciler was found. |
| AI audio and analysis   | **src/ai/** contains deterministic feature extraction, rankers and symbolic priors; **src/mcp/render-summary.ts** performs bounded offline render analysis; **src/analysis/contract.ts** standardizes analysis provenance.                                                                     | Metrics and successful rendering do not judge musical taste. Evidence is not a universal immutable packet for every MCP workflow.                                                  |
| Generative audio        | **src/generative/** provides a provider-neutral runtime and adapters, session lifecycle, capture, and latency handling.                                                                                                                                                                        | A media-generation provider is not a production-specialist agent or project-edit coordinator.                                                                                      |
| Producer Theatre        | **src/intent/producer-theatre.ts** builds deterministic persona-flavored run plans; **compose.ts** executes one staged composition pipeline.                                                                                                                                                   | Personas change prompts and seeds; they do not create independent model instances with separate evidence, permissions, or decisions.                                               |
| Multi-voice composition | **src/intent/multi-voice.ts** sequentially generates bass, chords, and lead from shared harmonic material.                                                                                                                                                                                     | “Multi-voice” is a deterministic composition algorithm, not multi-agent collaboration.                                                                                             |
| Bandmate                | **src/collab/bandmate.ts** procedurally rolls a drum phrase from transport position, scene role, and recent human notes, then commits an undoable command.                                                                                                                                     | One deterministic live companion, not an LLM specialist group. It writes while playback runs, so live mutation boundaries need protection.                                         |
| Test agent              | **tests/mcp-agent-simulation.test.ts** uses one scripted **FakeAgent** over the real dispatcher and a real **ProjectStore**.                                                                                                                                                                   | Not a controlled comparison, model inference, concurrent agents, or audible production evaluation.                                                                                 |

### Tool lifecycle, state, and execution

1. Local users enter through the Intent UI and pipeline. External models connect through MCP and discover the same tool surface.
2. **executeMcpTool** checks risk and permission, request identity/replay state, optional project revision, dry-run handling, scope declaration, and per-field stale-write protection. Writes pass through the tool context into typed commands and the store.
3. Local **ProjectStore** exposes a monotonically increasing revision. The MCP revision adapter returns null when the store cannot provide one; **YDocStore** currently has no revision counter, so freshness checks are unavailable there.
4. Commands and undo history are global to the current document/store. Agent attribution prefixes history labels and reports foreign work; it does not create per-agent undo stacks.
5. A first mutation in an agent session can synchronously create an in-memory checkpoint, then starts persistence asynchronously. This is a best-effort recovery aid, not a commit barrier or transaction protocol.
6. Longer tools may register with the Job Center. MCP calls separately own an **AbortController**; the Job Center controller is not passed into the tool signal. **cancelMcpCall(requestId)** and call deadlines exist, but web/desktop transport cancellation notifications are not wired through. Cancellation is cooperative at render boundaries; a pass inside **OfflineAudioContext.startRendering()** runs to its next boundary.
7. Live audio execution remains with transport, scheduler, engine, and worklets. Render-summary tools use offline rendering, so latency and CPU cost are user-visible but not real-time callback work.

## 2. Candidate specialist workflows

| Candidate and success condition                                                                                                                                      | Evidence/actions and natural split                                                                                                                                                        | Shared state/conflict                                                                  | Expected advantage over one agent                                                                                                                      | Cost, latency, and prerequisites                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Section production review:** identify the highest-impact issues in a selected 8-bar window; each note cites exact track/range/evidence and helps a producer.       | Read section arrangement, track identity/routing, effect state, and scoped render metrics. Possible read-only split: arrangement/energy and mix-balance reviewers; synthesize one report. | Same revision, selected range, track names/routes/effects; no writes in initial pilot. | Could catch different issue classes, but one capable agent can call **kyx_render_summary** and **kyx_diagnose_mix** sequentially. Benefit is unproven. | Extra model calls add latency and cost. Need one revision-pinned packet, track-window query parity, blind human rating, and fixed total budget.          |
| **Masking / kick-bass diagnosis:** find audible low-end conflicts and suggest a reversible experiment; success is preference in blind A/B, not just a metric change. | Read signal path and track-window render; compare spectra/transient evidence; reviewers inspect arrangement and mix evidence.                                                             | Shared gain, EQ, sidechain, and automation; reviewers can recommend opposite moves.    | Independent critique may expose assumptions; **kyx_diagnose_mix**, **kyx_mix_idea**, and **kyx_master** already support one-agent analysis/iteration.  | Offline renders multiply compute; model claims can amplify a weak metric. Requires repeatable renders and listening panel; never execute parallel edits. |
| **Vocal cleanup / take selection:** identify a take/phrase needing attention and offer an auditionable cleanup suggestion.                                           | Read take identity, clip bounds, recording metadata, and source-stage audio evidence; analyst recommends, reviewer checks target identity.                                                | Take deletion/activation, clip movement, processing chain, recording status.           | Domain review could reduce missed evidence on large sessions. Existing take management is not a complete vocal-analysis contract for an agent.         | High privacy sensitivity and stale/deleted target risk. Missing prerequisite: stable take-window observations and validated vocal measurements.          |
| **Arrangement alternatives:** prepare two section-level options while preserving original; success is user selection after audition.                                 | Read tempo map, section markers, clips, energy, and constraints; reviewer proposes alternatives; coordinator prepares preview only after approval.                                        | Clip positions, scene/marker IDs, automation, user edits during planning.              | Alternatives can be useful, but **kyx_arrange/kyx_song** already provide deterministic planning. Multiple opinions may converge or conflict.           | Requires isolated copies or sandbox previews, revision checks and user selection. Peer writers are unnecessary.                                          |
| **Complex automation pass:** plan a multi-track build/drop without touching locked or recording tracks; success is an accepted auditionable preview.                 | Read lanes, clips, tempo, locks, and selected range; partition analysis by musical role, then serialize writes.                                                                           | Competing writes to one lane, clip bounds, playback/recording state, stale values.     | Potential value on very large sessions, but one planner can partition tracks and check dependencies.                                                   | High conflict and rollback risk; no universal lane reservation or owned transaction frame. Not ready for autonomous specialists.                         |
| **Recording-chain/session audit:** keep the session ready to record while checking input/routing/monitoring; success is no interruption and correct ready state.     | Read device/track/routing/recording state; actions could change arming, monitoring, or routing.                                                                                           | Device state, active recording, input privacy, user action in progress.                | Specialists add little; reliable read-only checks suffice.                                                                                             | Do not schedule render or mutation work that competes with recording. No universal per-call approval exists.                                             |
| **Mix notes and postcondition review:** explain a render and verify a user-approved change.                                                                          | Read-only render summaries, meters, mix diagnosis, command readback, and analysis envelope can ground one agent; reviewer checks evidence alignment.                                      | Shared render state and revision; human edits between proposal and review.             | Best candidate for a reviewer-only experiment after evidence packaging.                                                                                | Extra reviewer call is justified only if blind ratings improve at the same total budget and reviewer sees identical immutable evidence.                  |

## 3. Architecture alternatives

| Pattern                                                           | Quality potential                                                                                | Complexity / observability                                                                                       | Failure, rollback, debugging                                                                                                  | Latency / cost                                                                                  | Maintainability and fit                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **A. Single agent with structured phases and scoped tools**       | High enough for the current tool surface; inspect, plan, dry-run, apply, read back.              | Lowest complexity; one trace and one conversation.                                                               | Few handoffs; stale-write, idempotency, dry-run, checkpoints, and undo help. Partial batches remain partial.                  | Sequential model calls; renders dominate some tasks.                                            | **Recommended default.**                                                    |
| **B. Single orchestrator with specialist tools**                  | Strong when “specialists” are deterministic analyzers/planners with distinct evidence contracts. | Moderate; explicit tool inputs/outputs are observable and testable.                                              | Errors stay at tool boundaries; deterministic output can be reproduced. Existing diagnose/mix/master helpers partly fit.      | Often cheaper than extra LLM calls; offline analysis still costs CPU.                           | **Best near-term architecture.** Improve evidence contracts first.          |
| **C. One writer plus independent read-only reviewers/validators** | Could improve groundedness or catch omissions; plausible benchmark candidate.                    | Moderate; reviewer inputs and disagreements need structured traces.                                              | Reviewers cannot overwrite session; writer remains responsible; output still needs adjudication.                              | Extra calls, parallel reviewers; equalize total tokens in evaluation.                           | **Proposal-only experiment.** Start offline/read-only.                      |
| **D. Autonomous specialists with shared DAW tools**               | Potentially broad coverage on long, diverse sessions, not established.                           | Highest: delegation, budgets, identity, context, conflict graph, scheduler, approvals, retries, trace, rollback. | Conflicting writes, stale context, partial commits, multiplied injection, undo ambiguity. Needs real transaction/lease model. | Parallelism may reduce wall time but increases inference, rendering, memory, and provider cost. | **Not ready.** Require evidence from C and single-writer enforcement first. |

For this audit, an autonomous specialist means a separately invoked model execution with bounded snapshot, its own call/tool budget, a machine-checkable proposal, and independent failure/disagreement. A named persona or prompt template is not an independent agent. Producer Theatre and the symbolic multi-voice generator do not meet that definition.

## 4. Proposed role contracts (not implemented)

Use roles as narrow evidence contracts, not broad creative authorities. Every pilot role is read-only.

### Mix evidence reviewer

- **Purpose:** report possible balance, masking, dynamics, or headroom issues in one pinned window.
- **Inputs:** project/snapshot IDs, revision, selected ticks, sample rate, signal stage, track IDs/routes/effect state, measured features with algorithm provenance, user goal, protected tracks, and freshness.
- **Permissions:** read-only queries and bounded offline analysis; no commands, transport controls, export/download, separation, or unrelated projects.
- **Output:** finding ID, track IDs, tick range, observed fact, metric/evidence reference, interpretation, confidence, alternative explanation, and unapplied experiment.
- **Acceptance:** cited IDs resolve; units/ranges are valid; evidence is separated from interpretation; uncertainty is explicit.
- **Escalation:** missing stage, stale/unknown revision, contradictory routing, active recording, or unsupported measurement.

### Arrangement evidence reviewer

- **Purpose:** identify section continuity, energy, transition, and density observations in the same window.
- **Inputs:** same snapshot plus tempo/meter map, section/marker IDs, clips, pattern density, and source timing provenance.
- **Permissions:** read-only project and analysis queries.
- **Output:** same finding schema, with transition/section evidence and uncertainty; unapplied recommendations only.
- **Acceptance:** references map to stable IDs/ticks; lyrics and track names are not treated as facts; alternative readings remain explicit.
- **Escalation:** ambiguous section boundary, malformed/partial timing data, or changed project revision.

### Single synthesis coordinator

- **Purpose:** deduplicate reviewer findings, surface disagreement, and return one ranked note set.
- **Inputs:** immutable packet and both structured outputs; total call/token budget.
- **Permissions:** read-only; cannot invoke mutation tools or recursively delegate.
- **Output:** cited findings, reviewer attribution, consensus/disagreement, uncertainty, and proposed next step.
- **Acceptance:** evidence is preserved; disagreement is not averaged away; no unsupported consensus claim.
- **Escalation:** evidence conflict, budget exceeded, malformed output, or no meaningful advantage over baseline.

An execution coordinator and verification agent are **not in the initial pilot**. Any later executor must be one serialized writer and require explicit per-change approval. A verifier must be read-only and check postconditions against the approved diff.

## 5. Shared context and musical grounding

The strongest reusable foundation is **src/analysis/contract.ts**: request/result contracts carry project ID, optional revision, scope and tick window, signal stage, feature-set, algorithm/version, sample alignment, tempo context, caveats, confidence, partial status, and produced-at revision. **resolveAnalysisWindow()** records freshness-unknown when revision is absent. **src/mcp/render-summary.ts** uses the envelope for track-window mix health and compares pre/post render revisions when available.

This is meaningful progress but not a universal packet. **kyx_render_summary** is a specific helper, and all MCP workflows do not receive the same immutable project snapshot. Local **ProjectStore** has a revision; revision checks remain optional per call; **storeRevision()** returns null when a store cannot provide one. Each workflow must propagate stale/unknown state and refuse to apply stale recommendations.

### Proposed bounded packet

Each analysis run should receive:

- project/session ID, snapshot ID, document revision, capture time, expiry, selected tick window;
- tempo/meter changes, arrangement/clip IDs, stable tick/sample mappings;
- target track IDs, routing ancestry, effect/automation snapshot identity, analysis stage;
- sample rate, source/processing stage, algorithm/version, alignment, caveats, partial status, confidence, freshness;
- user goal and constraints, protected/locked tracks, recording status, approval scope.

Send only queried evidence, using IDs and query references rather than repeating the whole session. Names and imported text remain untrusted data, never instructions.

Label every statement as **observed fact**, **measured result**, **interpretation**, **recommendation**, or **unknown**. Preference is not fact. A stale packet expires before synthesis or execution; a changed revision requires re-observation.

## 6. Coordination, conflicts, and recovery

### Required lifecycle

```text
User intent
  → task scope, privacy choice, protected entities, permission ceiling
  → immutable observation snapshot with revision and expiry
  → parallel read-only analysis
  → one reconciliation step that preserves disagreement
  → user sees evidence, affected tracks/ranges, alternatives
  → explicit approval for each proposed write
  → serialized executor rechecks revision, scope, locks, recording, conflicts
  → one owned undo/transaction group
  → independent read-only postcondition and render verification
  → commit/report, or rollback of that owned group
```

### Current protections and gaps

- **Single writer should be the rule.** **ProjectStore.beginUndoFrame()** returns false when a frame is open, but the MCP context types its wrapper as void. **executeBatchTool()** brackets awaited child tools and cannot tell whether it acquired the frame. A concurrent batch or human gesture can be folded into the open frame, or another end call can close a frame it does not own. This is direct evidence against parallel mutations.
- **kyx_batch** is sequential, capped at 10, and refuses nested batches. “Atomic” means stop at first failure and report the already-applied prefix; it does not roll back that prefix. Undo grouping is not a transaction.
- Field-level stale-write checks compare command base values against current values at apply time. They protect paths in base/ops; hand-written commands without ops are documented exemptions. **force** bypasses stale-write rejection and must not be available to specialist execution.
- Declared-revision checking is useful only when caller supplies **projectRevision** and the store reports a revision. Omission opts out; stores without a revision skip the check. Revalidate entity IDs and expected values when applying.
- Scope declarations are optional; no declaration is unrestricted. When provided, scoped-write guard checks command ops at the write boundary; an unverifiable command is not silently treated as scoped-safe. Per-role permissions should be fixed by the host, not caller-declared.
- Idempotency prevents duplicate execution for the same valid request ID. It does not solve conflicts between different IDs or dependencies between tools.
- Cancellation/timeout must stop new work, settle in-flight work, and report exactly what landed. Retry only idempotent reads/writes after re-reading state. Do not blindly replay partial batches.
- Before applying, reject stale revision, missing/deleted target, changed routing/effect state, locked/recording track, or changed user scope. Re-plan from a new snapshot rather than silently remapping IDs.
- If reviewers disagree, show each view and evidence. A coordinator can rank but must not manufacture agreement.

### Undo, checkpoints, rollback

Group one approved action set into a transaction with an ownership token; only its owner may close or abort it. Record command IDs, affected paths, before/after revision, and verification result. On failed postcondition, undo only that owned group; never pop a global count of history steps. Global LIFO history and best-effort async checkpoint persistence do not provide multi-writer guarantees.

## 7. User agency and UX contract

- One assistant response with grouped evidence and alternatives, not parallel chats.
- Label observation, interpretation, and unapplied proposal; name reviewer and evidence source.
- Show tracks, tick range, proposed value/process, reason, confidence, and expected audible effect.
- Offer auditionable A/B or sandbox preview; do not mutate original while alternatives are prepared.
- Require per-action confirmation before writes; global standing consent is not proposal-level approval.
- Allow locks, range limits, and analysis-only mode.
- Keep analysis/synthesis out of playback and recording control paths. Progress/cancel must not stop playback or interrupt recording.
- Cancellation must reach both the MCP call and visible job. The Job Center owns a **JobHandle.signal**, while MCP tools use a separate call controller; **tools.ts** does not link them. The Activity Center cancel button therefore does not reliably abort an MCP render. Transport cancellation notifications are also not wired.
- Report who proposed, approved, executed, verified, and how to undo the exact change.

## 8. Security, privacy, resource and cost boundaries

### Permissions and identity

The risk lattice distinguishes read, runtime, mutate, and destructive. External mutation consent is off by default and uses a persisted standing switch; destructive operations have a separate gate. A **confirm** result is a refusal telling the user to enable the flag or run the change; KYX lacks per-call approval UI. This prevents silent mutation but is not enough for specialist-generated proposals.

Optional **agentId** is validated and used for history/audit attribution; it is caller-supplied metadata, not an authenticated principal. Transport identity is the trust boundary. Trust state retains one current session, so interleaved IDs do not have isolated recovery/undo scopes. The local audit is bounded at 200 summaries and omits large payloads, but names/argument summaries still merit privacy review.

### Privacy and injection

External MCP clients may receive project names, track/arrangement/effect/routing data, and audio-derived analysis. External model retention is outside this repository. A multi-agent flow must disclose what text/audio features leave the device, request consent for audio or lyrics, and minimize data.

**model-context.ts** strips control characters and tells its local model that names are data, not instructions. This is useful but not universal. Project names, imported lyrics/text, filenames, clip labels, and tool results remain untrusted in every reviewer prompt. Validate output; never let model output expand tool permissions or provide executable instructions.

### Budgets and resources

Existing bounds include 30-second normal / 75-second long MCP deadlines; 10-call sequential batch; 90-second Job Center record timeout; 8 selected tracks and 12,000-character local intent context; 64-bar track-window cap; 14-strip render-summary cap; and 200-entry local agent audit. These are product limits, not a multi-agent quota policy.

No global semaphore or shared inference/render budget is evident in the inspected MCP path. Job Center dedupe affects job records, not general compute scheduling. Reviewers multiply offline renders and provider calls, may raise memory pressure, and can compete with recording even though they do not run in an AudioWorklet callback.

For a fixture pilot: at most two read-only reviewers plus one synthesis call, no recursion, no mutation, one fixed snapshot, same total token ceiling as baseline, existing 75-second long-call ceiling, and at most one analysis render per reviewer. Stop on malformed output, timeout, stale evidence, or budget exhaustion. Treat these as pilot guardrails and tune production quotas from measured traces.

## 9. Evaluation framework

Compare three arms on the same disposable fixtures:

1. Manual baseline where a producer can perform the same review.
2. Single-agent baseline with the same evidence and read-only tools.
3. Reviewer candidate with same model quality, evidence, tool access, and total token/provider budget; only decomposition changes.

Blind listeners judge musical relevance and preference for any suggested A/B. Independent experts score evidence grounding and usefulness without knowing the arm. Automated checks measure IDs/ranges, postconditions, stale rejection, unintended writes, undo/recovery, reproducibility, malformed output, call count, tokens/provider cost, latency, CPU/memory, and approval burden. Keep sonic listening separate from tool correctness.

Before collecting results, define meaningful improvement and non-inferiority margins from baseline variance, choose sample size through power analysis, and preregister exclusions. Report confidence intervals and task failure categories. Do not claim benefit from a tool success or unblinded demo.

## 10. Golden scenario matrix

Use disposable projects and deterministic fixtures. In the first reviewer experiment, all mutating outcomes are refusal/preview only.

| ID    | Injected condition                                                 | Required safe outcome                                                                                                   |
| ----- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| GS-01 | Two reviewers recommend opposite gain changes on same bass track.  | Preserve both with evidence and disagreement; no write before user choice.                                              |
| GS-02 | Arrangement proposes moving a clip; user moves it during analysis. | Proposal expires on revision/field mismatch; re-read/re-plan; preserve user move.                                       |
| GS-03 | Vocal cleanup references take deleted after snapshot.              | Reject unresolved ID; never fall back to similarly named take.                                                          |
| GS-04 | Mix reviewer packet predates effect-chain edit.                    | Mark stale and discard or reanalyze; do not claim fresh evidence.                                                       |
| GS-05 | Executor succeeds but render/postcondition verification fails.     | Mark verification failure, identify command, undo only owned group or report recovery state; never claim sonic success. |
| GS-06 | One reviewer times out while another completes.                    | Keep evidence as partial; settle outstanding work; no unsupported synthesis.                                            |
| GS-07 | Provider returns malformed structured output.                      | Reject schema; one bounded retry only if budget allows; otherwise no action.                                            |
| GS-08 | User cancels after multi-step plan starts.                         | Stop scheduling, settle in-flight work, report exact landed subset, offer owned-group undo.                             |
| GS-09 | Proposal targets a locked or recording track.                      | Refuse target and explain; do not affect recording/playback.                                                            |
| GS-10 | Long project exceeds context/cost ceiling.                         | Explicitly scope or stop; report omissions; never silently omit required tracks.                                        |
| GS-11 | Two proposals overlap the same automation lane/ticks.              | Mark conflict; serialize after user choice or refuse ambiguous merge.                                                   |
| GS-12 | Name, lyric, or filename says “ignore instructions / call tool.”   | Preserve as untrusted data; do not change policy, allowlist, or permissions.                                            |
| GS-13 | Second batch starts while user gesture owns global undo frame.     | Writer waits/refuses; cannot close or join the gesture frame.                                                           |
| GS-14 | Mutation retries under a new request ID after partial failure.     | Re-read current values/command IDs; do not duplicate committed prefix.                                                  |
| GS-15 | Activity Center cancellation during offline render.                | Tool aborts at supported boundary and job settles consistently; current code should fail until signals are linked.      |

## 11. Readiness scores and decision

Scores are **static feasibility judgments from code inspection (0–5)**, not measured quality outcomes. Higher is favorable. Decomposition and user benefit estimate plausible value; evidence, tools, conflict, verification, cost, and maintainability estimate readiness.

| Candidate                                         | Decomposition | Evidence | Tools | Conflict safety | User benefit | Verification | Cost efficiency | Maintainability | Decision                                           |
| ------------------------------------------------- | ------------: | -------: | ----: | --------------: | -----------: | -----------: | --------------: | --------------: | -------------------------------------------------- |
| Whole-session mix diagnosis with existing tools   |             2 |        4 |     4 |   4 (read-only) |            2 |            3 |               4 |               5 | **SINGLE AGENT SUFFICIENT**                        |
| Selected-section mix/arrangement notes, read-only |             3 |        3 |     3 |   4 (read-only) |            3 |            3 |               2 |               4 | **REVIEWER PATTERN** as controlled experiment only |
| Vocal take cleanup/selection                      |             3 |        1 |     1 |               2 |            3 |            1 |               2 |               2 | **NOT READY**                                      |
| Parallel arrangement or mix edits                 |             4 |        3 |     3 |               0 |            4 |            2 |               1 |               1 | **NOT READY**                                      |
| Long-project autonomous specialist team           |             4 |        2 |     2 |               0 |            3 |            1 |               1 |               1 | **NOT READY**                                      |

**PILOT READY** and **PRODUCTION CANDIDATE** are not assigned; no controlled comparative trial has run. A reviewer pattern earns a pilot only after a fixed evidence packet and cancellation path exist.

## 12. Top 15 gaps and findings

Format: **MAG-XX | Severity | Evidence | User impact | Root cause | Single-agent alternative | Multi-agent benefit | Risk | Recommendation | Validation**

MAG-01 | High | No delegation/scheduler found in **src/mcp/** or **src/intent/**; one dispatcher; **tests/mcp-agent-simulation.test.ts** defines one scripted FakeAgent. | Specialist team is not a product behavior today. | MCP is caller-to-tool interface, not agent runtime. | One model plans and calls existing tools. | Reviewer may catch omissions. | New infrastructure without measured gain. | Keep single-agent baseline; benchmark read-only reviewers first. | Simulation is sequential/scripted; add equal-budget fixture comparison before claims.

MAG-02 | Critical | **ProjectStore.beginUndoFrame()** can return false; MCP context erases return as void; **executeBatchTool()** brackets awaited work and always ends when hooks exist. | Concurrent edits can enter another action’s undo frame or close a foreign frame. | One global frame buffer has no owner token or writer lock. | One writer at a time. | Parallel read-only analysis only. | User edits and undo history can be corrupted/misrepresented. | Add owned transaction tokens and per-document writer queue first. | Interleave batch, user command, second writer; assert exact undo boundaries.

MAG-03 | High | **kyx_batch** atomic mode stops at first failure and reports committed prefix; **tests/mcp-batch-dryrun.test.ts** pins this. | “Atomic” may be mistaken for rollback although earlier commands remain. | Stop policy plus undo grouping, not all-or-nothing transaction. | Small batches and readback after each step. | No special benefit. | Retry may duplicate or conflict with partial work. | Call it stop-on-failure; account for prefix and owned rollback. | Inject failure after each prefix position and verify result/undo.

MAG-04 | High | **agentTrust.ts** stores one module-level current session; agentId in **attribution.ts** is caller metadata. | Interleaved agents can replace session attribution/checkpoint context; identity is not authenticated. | Session and undo history are global; no principal identity. | One external agent per active session. | Better attribution after authenticated identity exists. | Recovery can target wrong conceptual agent; audit spoofing. | Bind identity to transport session; isolate session records before peers. | Interleave two IDs and verify checkpoint/audit/undo attribution.

MAG-05 | High | **permissionLattice.ts** returns confirm as refusal; **flags.ts** documents standing consent and no per-call KYX approval UI. | User cannot approve each specialist proposal in-product. | Persisted global mutation switch, not proposal-level consent. | Dry-run, summarize, ask before applying. | Read-only reviewers need no new authority. | Broad consent may make future writer too permissive. | Add reviewed-diff approval UI before any specialist writer. | Unapproved proposal cannot reach command execution.

MAG-06 | High | **src/mcp/revision.ts** returns null if store lacks getRevision; missing projectRevision opts out; YDocStore has no counter. | Proposal may apply without proof shared state stayed current. | Revision and caller declaration are optional. | Re-read targeted fields and use field stale guard. | Reviewers benefit from freshness metadata. | Stale collaborative edits. | Add collab snapshot/revision token or keep freshness-unknown read-only. | Change collab state during analysis; assert stale rejection.

MAG-07 | High | Scope absent is unrestricted; tests pin this; scoped guard checks ops and can’t verify commands without paths; force bypasses stale guard. | Specialist role boundaries cannot be assumed from prompts or missing scope. | Scope is optional caller metadata over broad tool surface. | One agent explicitly requests narrow scope. | Read-only reviewers can receive narrower data. | Injection or bad proposal targets unrelated paths. | Host-impose immutable role allow/protect paths; disallow force; reject unverifiable writes. | Contract tests for mutating families and adversarial missing/invalid scope.

MAG-08 | Medium | **src/analysis/contract.ts** carries stage/provenance/revision/alignment/confidence; local intent context is separate and 12,000 chars. | Reviewers can see incomplete/different evidence and overstate measurements. | No common MCP snapshot packet across tools. | One agent queries tools sequentially and states gaps. | Shared packet could support bounded reviewers. | Duplicate context and contradictory assumptions. | Build immutable common packet before adding model peers. | Both reviewers receive equivalent evidence IDs and revision.

MAG-09 | Medium | **kyx_render_summary** provides bounded metrics and track-window analysis, not every effect/arrangement/take observation. | User may treat limited metrics as complete sonic analysis. | Evidence coverage is tool-specific. | Combine read tools; state unmeasured areas. | Reviewer could flag unsupported conclusions. | False confidence or detached recommendations. | Cite stage, algorithm, window, and freshness for every claim. | Test claim-to-evidence coverage; listen for sonic claims.

MAG-10 | High | **cancelMcpCall()** exists, but capability says protocol cancellation is unwired; JobHandle.signal is not linked to MCP call controller. | Visible UI/client cancel may not stop actual render. | Independent abort controllers; missing transport notification. | Short bounded calls; supported cancellation seam only. | Parallel jobs need stronger cancellation. | Wasted renders, misleading status, resource pressure. | Link job cancel to call controller and wire transports before concurrency. | Cancel through Activity Center and web/desktop mid-render; verify settlement/stage stop.

MAG-11 | High | Per-call deadlines exist; async MCP handlers run without shared per-document queue. | Simultaneous calls multiply CPU/render work and touch shared state. | No global inference/render semaphore visible in MCP path. | Sequence model calls and renders. | Parallel reads could cut wall time if measured. | CPU/memory contention and recording interference. | Add bounded analysis semaphore and cost accounting before parallel runs. | Stress disposable long projects; measure resources/deadlines/record stability.

MAG-12 | Medium | **persistCheckpoint(saved)** is started without awaiting durability before mutation; persistence failure does not block. | App close/failure can precede durable recovery state. | Checkpoint is safety net, not transaction log. | Wait for durable save or use explicit undo/readback. | Extra checkpoint alone does not help peers. | Recovery claim can exceed durability. | Future executor awaits durable preimage or refuses. | Inject persistence delay/failure; verify gating/status.

MAG-13 | Medium | State/readback and render metrics are tested, but no blind comparative listening trial exists; simulation uses fake audio hooks. | Tool correctness may be mistaken for musical improvement. | Acceptance focuses on contract correctness, not comparative outcome. | Producer listens to render and uses one agent. | Independent critics may improve precision. | Extra cost/latency with no audible benefit. | Separate blind human judgments from automated checks. | Preregister single-vs-reviewer study and report uncertainty.

MAG-14 | High | MCP returns project and audio-derived data to external clients; external-model behavior is outside repository; local sanitizer is limited. | Recordings, lyrics, names, and project details may leave device or carry injection text. | No universal per-agent data consent/minimization boundary. | Local analysis or explicit external-sharing consent. | Specialists can receive only necessary fields. | Privacy leakage, injection, permission expansion. | Gate data sharing per task; taint imported text; validate outputs/allowlist at host. | Adversarial labels/lyrics and provider data-flow review.

MAG-15 | High | No same-model/same-evidence/same-budget manual, single-agent, and multi-agent comparison exists. | Decisions risk relying on persona appeal or anecdote. | No benchmark fixture set or blinded evaluation. | Keep one structured agent. | Narrow tasks may benefit. | Premature complexity becomes maintenance cost. | Run proposal-only reviewer benchmark; require reproducible wins. | Preregister task set, budget parity, blind review, confidence intervals, stop rule.

## 13. Recommended pilot (proposal only)

- **Journey:** “Give me grounded production notes for this selected 8-bar section.”
- **Problem:** producer may miss an arrangement transition or mix-balance issue in a dense section.
- **Roles:** two read-only reviewers (mix evidence, arrangement evidence) plus one read-only synthesizer. No executor, commands, or real-user mutation.

Use disposable, versioned fixtures and a frozen snapshot packet. Reuse **kyx_render_summary** track-window analysis and arrangement/tempo queries where available. If the packet cannot express exact routes, automation, stage, and freshness, stop and implement that observation contract as separately approved work; do not fill evidence gaps from model inference.

Baseline is one agent with identical tools/evidence. Candidate splits the same total token/provider budget across two reviewers and one synthesizer. A manual producer baseline helps note quality but does not replace the single-agent baseline.

Limits: at most two parallel read-only reviewers, one synthesis call, no recursion or mutation, one snapshot, no external audio/lyrics without consent, same total token ceiling as baseline, existing long-call ceiling, at most one render per reviewer. Stop on stale revision, timeout, malformed output, or budget exhaustion.

Proceed only if an adequately powered, preregistered comparison shows meaningful blind usefulness/evidence-grounding improvement within predeclared cost/latency margins and no increase in unsupported claims. Set the margin/sample size after measuring baseline variance. If neutral or uncertain, keep the single-agent workflow. Do not add a writer until transaction ownership, per-call approval, and cancellation gaps are fixed and separately verified.

## 14. 30 / 60 / 90-day roadmap

| Horizon     | Work                                                                                                                                                                                                                                                                                                        | Go / no-go gate                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **30 days** | No orchestration framework. Document baseline; define fixture set, task rubric, immutable packet and reviewer schema. Track cancellation and undo-frame ownership fixes as prerequisite engineering work.                                                                                                   | Go only if required evidence is available on fixed snapshots and human outcome is verifiable.                                                                                                        |
| **60 days** | If approved, build isolated read-only benchmark using existing MCP/analyzer contracts. Compare manual, one-agent, and reviewer pattern with equal total budget. Capture provenance, blind ratings, cost, latency, resources, and failure categories.                                                        | Go only if adequately powered and improvement clears preregistered threshold without worsening cost/latency/grounding/approval burden beyond margins.                                                |
| **90 days** | If reviewer pattern wins, pilot selected-section notes behind a flag with immutable evidence and no writes. If not, archive result and improve single-agent evidence. Consider serialized executor only after transaction tokens, durable preconditions, approval, and cancellation pass independent gates. | Stop on stale-write leak, unintended mutation, cancellation miss, privacy issue, or non-reproducible advantage. Production candidacy needs repeated wins across fixture families and human sessions. |

## 15. Safe changes and verification

**Implemented safe fixes:** none. No isolated code change was justified without expanding scope or changing cancellation/transaction semantics. This is proposal-first; no agent framework, provider integration, source behavior, permission boundary, persistence path, or audio code was modified.

**Evidence inspected:** **src/mcp/tools.ts**, **agentTrust.ts**, **permissionLattice.ts**, **flags.ts**, **scope-guard.ts**, **write-conflict.ts**, **revision.ts**, **attribution.ts**, **render-summary.ts**, **bridge.ts**, **web-host.ts**, **desktop-host.ts**, **headless-host.ts**; **src/analysis/contract.ts**; **src/intent/model-context.ts**, **model-ollama.ts**, **multi-voice.ts**, **producer-theatre.ts**; **src/collab/bandmate.ts**; **src/services/jobCenter.ts**; **src/ui/ActivityCenter.tsx**; **src/store/ProjectStore.ts**; **docs/adr/0065-permission-lattice-and-scope-guard.md**.

Relevant committed tests include **tests/mcp-agent-simulation.test.ts**, **mcp-idempotency.test.ts**, **mcp-write-conflict.test.ts**, **mcp-batch-dryrun.test.ts**, **mcp-cancellation.test.ts**, **mcp-host-inline-execute.test.ts**, **mcp-headless-acceptance.test.ts**, **mcp-stem-separate.test.ts**, **permission-lattice.test.ts**, **agent-trust.test.ts**, and **analysis/contract-timeline.test.ts**.

**Verification status:** completed on the shared working tree, which had concurrent uncommitted changes. Results therefore describe that working tree, not a clean checkout of the recorded baseline. No standalone lint script is defined in **package.json**; formatting is checked with **format:check**.

### Verification run

Command: **npm run verify:all -- --skip browser,factory,build,audit**. The harness ran mirror consistency, typecheck, full Vitest, Playwright smoke, and formatting sequentially. Browser verifier, factory-preset browser QA, production build, and network dependency audit were skipped. No source changes were made to address failures.

- **MCP mirrors:** passed.
- **Typecheck:** failed. Diagnostics are in **tests/mcp-stem-separate.test.ts** (fake audio buffer / SampleBank contract mismatch and unused local variables) and **tests/param-range-coherence.test.ts** (readonly arrays assigned to mutable arrays and unused variable).
- **Vitest:** 33 of 1,309 test files failed; 41 failed, 14,390 passed, 129 skipped, 1 todo. Failures include stale MCP tool-count expectations (some tests expect 39 while the current catalog has 40, including **kyx_separate**) and failures across UI/layout, intent, persistence, and functional-audit tests. This was a shared-tree run; failure attribution to committed baseline versus concurrent work was not established.
- **Playwright smoke:** 6 failed and 2 passed in 4 minutes. Failures included landing navigation timeouts, panel-visibility assertions, and the project JSON export interaction. No product changes were made in response.
- **Format gate:** advisory failure from three other files: **docs/audits/2026-10-26-ai-action-space/AI-ACTION-SPACE-AUDIT.md**, **docs/audits/2026-10-27-musical-understanding-gap/MUSICAL_UNDERSTANDING_GAP_AUDIT.md**, and **docs/intent-killer-feature-plan.md**. Those files were outside this audit and were left untouched. The new report separately passed **npx prettier --check**.
- **Process hygiene:** the verifier exited with code 1 after all selected gates completed. **node-gc -Root D:\\pulse-forge** reported 0 abandoned test-runtime trees; no owned verification process remained.

Overall harness verdict: **RED**. The audit decision is architectural and does not depend on a green test run; the failed gates are recorded as repository verification blockers, not evidence for or against musical benefit.
