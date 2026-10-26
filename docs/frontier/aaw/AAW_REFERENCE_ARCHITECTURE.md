# AAW_REFERENCE_ARCHITECTURE

**Status:** proposed reference architecture for an AI-Assisted Audio Workstation (AAW), with explicit critique of the brief's candidate stack
**Date:** 2026-10-25
**Applies to:** KYX (`D:\pulse-forge`) and ZYVO (`D:\VocalForge_DAW`)
**Companions:** `AAW_AI_CONTROL_CONTRACTS.md`, `AAW_SECURITY_AND_REALTIME_SAFETY.md`, `AAW_DECISION_LOG.md`

---

## 1. Relationship to what already exists — the one rule that shapes everything

KYX already owns a **product contract for AI-assisted production**: `docs/AI-PRODUCER-CONTRACT.md`
(2026-10-01). It already specifies the brief structure, the propose→audition→apply loop, the ten
control-and-safety requirements, three separated memory scopes, provider neutrality, no-model
fallback, and acceptance gates. ZYVO has its own AI control matrix and a "DIRECTOR" agent surface.

**Therefore this document does not propose a new architecture beside those. It proposes three things:**

1. **A critique** of the brief's candidate stack, and where it is wrong (below).
2. **A refinement** that keeps every existing seam in place and adds the four the brief's stack
   omits: _perception as a cached substrate_, _a formal permission lattice_, _a model-adapter
   boundary_, and _verification as a pre-commit gate rather than a post-commit step_.
3. **A shared control-plane seam** that KYX and ZYVO can both sit on **without** collapsing into one
   product and without either depending on the other's UI internals.

> **Standing rule:** every statement about the current codebase in this document is sourced either
> from `docs/AI-PRODUCER-CONTRACT.md` §11 ("current foundation" mapping) or from `AGENTS.md`.
> Items marked _(doc claim)_ are the contract's word, not yet code-verified — the repo audit in
> `AAW_STATE_OF_THE_ART_2026.md` §7 is what upgrades them. No architecture in this document is
> allowed to _require_ a fact that is still only a doc claim.

---

## 2. The candidate stack, and nine things wrong with it

The brief proposes:

```
Human Creative Intent + UI Selection + Project Context
                    |
          Intent Interpretation
                    |
       Audio/Music Perception Layer
                    |
        Structured Musical World Model
                    |
       Planner / Decision / Policy Layer
                    |
         Typed Capability Registry
                    |
     Simulation / Preview / Risk Check
                    |
         User Approval (by risk)
                    |
    Transactional DAW Command Gateway
                    |
            KYX / ZYVO Engines
                    |
     State + Audio Outcome Verification
                    |
       Undo / Provenance / Feedback
```

This is a **good skeleton and a bad architecture**, for one structural reason: **it is a linear
pipeline, but the system's hardest problems are not sequential — they are concurrent, cached,
revisable, and partially unverifiable.** The specific defects:

| #   | Defect                                                           | Why it is a defect, concretely                                                                                                                                                                                                                               | Fix in §3                                                                                                                    |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| D-1 | **Perception is a stage**                                        | Perception of a 3-minute mix at 48 kHz takes seconds-to-minutes. If it is a stage, every proposal pays it again. Analysis must be a **cached, addressable substrate** keyed by project revision, not a call in a chain                                       | Layer 2 becomes a store, not a stage                                                                                         |
| D-2 | **"Structured Musical World Model" is a second source of truth** | The project model already _is_ the structured musical world (schema v38, PPQ 480, scenes, markers, automation). A separate world-model store creates drift, two undo paths, and a place where an LLM's belief about the project can diverge from the project | The world model becomes a **derived projection** of the project graph + perception artifacts. It is read-only and disposable |
| D-3 | **Verification is downstream of the engines**                    | Placed after the engines, verification can only _report_ a bad commit. The contract's "apply exactly what was auditioned" and "no hidden scope expansion" require verification **before** the commit, as a gate                                              | Layer 10 becomes a **pre-commit gate** plus a post-commit audit                                                              |
| D-4 | **"User Approval (by risk)" has no lattice**                     | "By risk" is the whole safety model and it is stated in one line. Without an enumerated risk taxonomy with deterministic rules, every implementation will invent its own thresholds                                                                          | `AAW_AI_CONTROL_CONTRACTS.md` §4 defines 5 risk classes and the mapping                                                      |
| D-5 | **No model-adapter boundary**                                    | The stack names no seam between "a model" and "the system". Without it, the first model choice becomes the architecture, and the vendor-replacement cost is unbounded                                                                                        | Layer 0: a versioned `ModelProvider` interface (see `AAW_AUDIO_MODEL_LANDSCAPE.md` §6)                                       |
| D-6 | **No concurrency / staleness story**                             | The contract requires "reject stale proposals if the project changed while it was running". A linear diagram has no place for that                                                                                                                           | Layer 8 carries a `projectRevision` precondition; stale plans are rejected, not merged                                       |
| D-7 | **No abstention path**                                           | Every arrow implies the system always produces a plan. The most important AAW behaviour is often "I don't know" / "here are two readings"                                                                                                                    | The brief layer produces `abstain` and `alternatives` as first-class outputs                                                 |
| D-8 | **"Feedback" as the last box is a trap**                         | A feedback loop that learns from user actions silently converts _every_ click into a taste label — exactly what `AI-PRODUCER-CONTRACT.md` §4.6 forbids ("merely applying or previewing something is not automatically a taste label")                        | Feedback is a **separate, opt-in ledger** with explicit signal types, and never a training set by default                    |
| D-9 | **No failure containment**                                       | If perception, planning, preview or verification fails, the diagram offers no "degrade to deterministic" path, though the contract demands "failure is contained"                                                                                            | Every layer has a defined deterministic fallback and a defined _no-write_ failure mode                                       |

A tenth, softer defect: the stack has **no explicit representation of the user's attention**. An AAW
that interrupts, or that proposes three near-identical variants, is worse than no AAW. The
contract's "make rejection cheap" and "ask one concise question when a wrong guess would affect a
protected part" are _attention budgets_, and they belong in the architecture, not in a UI guideline.

---

## 3. The revised reference architecture

```text
┌─ L0  MODEL ADAPTER LAYER ───────────────────────────────────────────────┐
│  versioned providers: asr | tts | plan | rank | embed | critic           │
│  each: id, artifactDigest, capabilities, languages, maxInputSeconds,    │
│         realtimeFactor (measured), licence record, fallback chain       │
│  Rule: a MODEL is an implementor of an interface, never a dependency.    │
└──────────────────────────────────────────────────────────────────────────┘
        │ (model proposes)                    │ (deterministic fallback always exists)
        ▼                                     ▼
┌─ L1  BRIEF LAYER ───────────────────────────────────────────────────────┐
│  normalized brief: required | preserve | prefer | avoid | target |      │
│  evidence | uncertainty | alternatives                                    │
│  Deterministic parse first; the model may *propose* a brief, the schema  │
│  decides.  Output is editable by the user, always.                      │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ L2  PERCEPTION SUBSTRATE (cache, not stage) ───────────────────────────┐
│  key = (projectRevision, artifactId, algoVersion, paramsHash)            │
│  artifacts: onset/beat grid · F0/voicing · chroma+chords · LUFS/R128 ·  │
│             spectral balance · structure map · clip boundaries            │
│  producers: deterministic DSP/MIR first; learned models only where an     │
│             experiment proves they beat the baseline on a held-out slice  │
│  MUST be reproducible: same key ⇒ same bytes (golden vectors)            │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ L3  PROJECT GRAPH  ← THE SINGLE SOURCE OF TRUTH ──────────────────────┐
│  schema v38 document · tracks/roles · clips · notes · automation ·       │
│  scenes/sections · markers · templates · musical time (PPQ 480) index    │
│  Every claim about the project resolves here or not at all.              │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ L4  PLANNER ───────────────────────────────────────────────────────────┐
│  emits a typed ActionPlan (never prose-as-command)                       │
│  may abstain · may emit alternatives · must cite the brief clause it     │
│  satisfies · must declare its own scope                                  │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ L5  CAPABILITY REGISTRY ───────────────────────────────────────────────┐
│  typed tools: id · version · inputs(schema) · outputs(schema) ·         │
│  preconditions · postconditions · sideEffects · riskClass · costClass ·  │
│  realtimeSafe · undoUnit · supersedes                                    │
│  The registry is versioned and independently testable — it is a          │
│  product artifact, not an internal helper.                               │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ L6  SIMULATION / PREVIEW ENGINE ───────────────────────────────────────┐
│  renders the plan OFFLINE (OfflineAudioContext / offline renderer),     │
│  leaving the live graph untouched; emits a PreviewArtifact               │
│  (audio ref + diff + metrics + warnings + expiry)                       │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ L7  PERMISSION LATTICE ────────────────────────────────────────────────�┐
│  deterministic rules: riskClass × targetScope × destructive? ×          │
│  reversibility × userPreflight ⇒ AUTO | CONFIRM | FORBID               │
│  plus staleness check (projectRevision) and budget checks                │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ L8  TRANSACTIONAL COMMAND GATEWAY ─────────────────────────────────────┐
│  validates preconditions · executes through src/commands/ · ONE undo    │
│  unit · rejects stale revisions · no arbitrary state writes             │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ L9  ENGINES ───────────────────────────────────────────────────────────┐
│  KYX / ZYVO: hard real-time DSP (AudioWorklet, native) + ONE shared      │
│  engine for live and offline (only the event driver differs)            │
│  INVARIANT: no LLM inference, no network, no unbounded allocation,      │
│             no blocking work inside an audio callback.                   │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ L10  VERIFIER (pre-commit gate + post-commit audit) ───────────────────┐
│  state diff vs declared scope · protected-content hashes unchanged ·    │
│  audible-outcome metrics · invariant checks · preview↔commit equality   │
│  FAIL ⇒ no write (pre-commit) or auto-rollback + receipt (post-commit)  │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ L11  PROVENANCE + UNDO + (opt-in) PREFERENCE LEDGER ───────────────────┐
│  receipt: who/what/when/provider@version/seed/diff/measurements/undoId  │
│  ledger signals are explicit and typed; NOT a training set by default   │
└──────────────────────────────────────────────────────────────────────────┘

     CROSS-CUTTING: capability discovery · consent-gated telemetry ·
                   model-download manager (integrity, licence, size, cancel)
```

### 3.1 Why the changes matter (the three that carry most of the value)

**L2 as a cache is the difference between a demo and a product.** A "more tension before the chorus"
proposal needs: the beat grid (to know where the chorus is), the section map (to know where "before"
is), the energy profile (to know what "more tension" would change), and the chord/scale context.
Recomputing that per prompt is minutes of CPU. Caching it by `(projectRevision, algoVersion)` makes
the second proposal in the same project instant, and — more importantly — makes the result
**reproducible**: the same project at the same revision with the same analysis version yields the
same perception bytes, which is what makes the verifier's claims checkable.

**L3 refusing to be a second truth removes the worst class of AAW failure.** The classic agentic-DAW
bug is a planner that believes the project is one bar longer than it is, and applies an edit to a
position that does not exist. If the world model is a _projection_ of the project graph, that class
of bug is structurally impossible: the projection cannot outlive or contradict its source.

**L10 moving before the commit converts "verify" from a report into a gate.** The contract's
"apply exactly what was auditioned" and "no hidden scope expansion" are only enforceable if the
verifier can say **no** before the write. Post-commit verification can only offer a rollback; that
is a worse product and a worse story.

### 3.2 Layer-by-layer contracts (summary; full typed schemas in `AAW_AI_CONTROL_CONTRACTS.md`)

| Layer              | Owns                                                                                       | Must never                                          |
| ------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| L0 Model adapter   | provider selection, artifact integrity, licensing record, measured latency, fallback chain | let a provider's vocabulary leak into product types |
| L1 Brief           | normalization, clause typing, uncertainty, alternatives                                    | mutate the project                                  |
| L2 Perception      | analysis artifacts, cache keys, algorithm versions                                         | write to the project; learn from user data          |
| L3 Project graph   | the truth                                                                                  | hold derived/derived-from-model state               |
| L4 Planner         | typed ActionPlan, scope declaration, abstention                                            | emit anything the registry cannot validate          |
| L5 Registry        | tool contracts, risk classes, versions                                                     | grow an unbounded tool surface                      |
| L6 Preview         | offline render, diff, metrics, expiry                                                      | touch the live audio graph                          |
| L7 Permission      | risk → AUTO/CONFIRM/FORBID, staleness, budgets                                             | be overridden by a model                            |
| L8 Command gateway | transaction, one undo unit, precondition checks                                            | accept free-form writes                             |
| L9 Engines         | deterministic DSP, playback, render                                                        | run inference or network I/O in an audio callback   |
| L10 Verifier       | state diff, protected hashes, outcome metrics                                              | write to the project                                |
| L11 Provenance     | receipts, undo, opt-in ledger                                                              | silently become a training set                      |

---

## 4. Alternatives considered, and why they lose

### Alt-1 — "Thin agent over today's MCP tools" (no new layers)

_Shape:_ keep the current MCP surface, add a planner in front, reuse the existing tool set.

**Why rejected as the target architecture:** it inherits the current tool surface's weakness —
whatever is not already exposed as a tool cannot be part of an AI workflow, and the AAW's
differentiated capabilities (perception artifacts, preview, verification) are precisely the things
an MCP tool list does not express. It is, however, **the correct first increment** (§6, Wave 0) and
the correct _fallback_ if the budget collapses.

### Alt-2 — "Conversation-first" (chat as the primary interface, tools hidden)

_Shape:_ a chat panel is the product; the DAW becomes a viewer.

**Why rejected:** it contradicts the contract's §4.4 ("AI belongs inside the DAW, not only in a chat
panel") and it is the failure mode the whole category is at risk of — a chatbot that produces
impressive demos and cannot make a beat. It also destroys the attention budget: chat invites
nudging, and the cheapest way to reduce perceived quality of an agentic DAW is to make it talk.

### Alt-3 — "Agent writes project state directly" (no command gateway)

_Shape:_ the model emits a patched project document; the engine loads it.

**Why rejected, unconditionally:** it destroys undo granularity (one undo unit for an arbitrary
diff), it destroys scope protection (no way to assert "protected content unchanged"), it makes
previews impossible to guarantee equal to commits, and it turns every schema nuance into an
LLM-accuracy problem instead of a validation problem. The contract already forbids it (§6.1).

### Alt-4 — "World model / learned latent project state"

_Shape:_ a trained embedding of the project that the planner reasons over directly.

**Why rejected for now:** it introduces a second truth with no way to verify it, it has no
measurable advantage over the typed graph for the operations that matter (every proposal reduces to
_specific edits on specific objects_), and it is the most expensive thing in the program to train.
**This is the most tempting rejected idea in the document** — it is also the one with the weakest
falsifiable hypothesis (see `AAW_EXPERIMENT_BACKLOG.md` E-11, "does a learned project embedding
beat the typed graph for edit-target selection?"). If E-11 shows a large, reproducible win, this
becomes a research bet — not a foundation.

### Alt-5 — "Real-time AI in the audio path" (LLM or model-driven DSP live)

_Shape:_ the model reacts to live audio.

**Why rejected:** it violates the hard invariant that an audio callback must never depend on
inference, network, or unbounded work; it makes the product fail on stage (ZYVO) and glitch in the
browser (KYX); and it buys nothing that a bounded envelope follower + rule layer cannot do.
**What survives from it** is a _bounded, offline_ AI decision feeding _bounded, deterministic_
parameters — the "offline AI → safe envelope → DSP" pattern in `ZYVO_FRONTIER_CAPABILITIES.md`.

### Alt-6 — "Two products, two architectures" (KYX and ZYVO each invent their own AI stack)

_Why rejected:_* it doubles the maintenance surface for a one-person team and guarantees the two
products drift apart, while the shared part (brief, plan, plan→commands, verification, receipts)
is genuinely shared. The seam is §7.

---

## 5. Failure modes — detection, containment, user-visible behaviour

| Failure                                                | Detected by                         | Containment                                                              | User sees                                                           |
| ------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Model returns malformed JSON                           | schema validation at L1/L4          | deterministic fallback; no write                                         | "Couldn't interpret that; here's the deterministic route"           |
| Model returns a valid plan with an unknown tool        | L5 registry lookup                  | plan rejected                                                            | "That action doesn't exist in this project"                         |
| Plan targets a protected object                        | L7 risk rules + L10 scope diff      | no write                                                                 | "You asked to protect the bass — this changes it"                   |
| Plan targets a stale revision                          | L8 precondition (`projectRevision`) | no write; re-plan offered                                                | "The project changed while I was working — here's the updated read" |
| Preview render fails                                   | L6                                  | no write                                                                 | "Couldn't render that preview; nothing changed"                     |
| Perception artifact missing / algorithm version bumped | L2 cache miss                       | recompute; if perception unavailable → deterministic-only capability set | "Analysis not available for this pass; limited to direct edits"     |
| Model download corrupt / licence record missing        | L0 integrity check                  | model stays disabled                                                     | "Model pack failed verification"                                    |
| Model times out                                        | L0 timeout                          | deterministic fallback                                                   | "That took too long; try the direct route"                          |
| Verifier finds scope violation                         | L10                                 | no write (pre) / auto-rollback (post)                                    | "Stopped that change — it would have touched X"                     |
| Audio callback sees a heavy operation                  | L9 audit + budget                   | operation was never scheduled there                                      | (nothing — the bug is prevented, not reported)                      |
| Plugin misbehaves / throws                             | L9 fault containment                | plugin bypassed, channel silenced, receipt written                       | "Ozone (or whichever) was disabled on this channel"                 |
| Project save interrupted                               | persistence layer                   | journal recovery                                                         | "Recovered your last autosave"                                      |

---

## 6. Migration: how this becomes real without a rewrite

The architecture above is reachable from today's codebase in four increments. Each increment is
independently shippable and independently valuable.

| Wave  | Change                                                                                                                                                        | Touches                                             | Precondition                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| **0** | **Version the capability registry.** Give every existing command/MCP tool a typed descriptor (inputs, preconditions, risk class, undo unit). No new behaviour | `src/commands/`, MCP manifest                       | none — pure metadata                                  |
| **1** | **Move perception behind a cache.** Wrap existing DSP/MIR (onset, meter, spectrum) as addressable artifacts keyed by revision                                 | `src/audio-engine/`, `src/intent/audio-feedback.ts` | analysis already deterministic _(doc claim — verify)_ |
| **2** | **Make the planner emit typed plans only**, with scope declaration and abstention, and run it against the registry                                            | `src/intent/plan.ts`, `src/intent/providers/`       | Wave 0                                                |
| **3** | **Add the pre-commit verifier** (scope diff + protected hashes) and the permission lattice                                                                    | `src/commands/`, `src/intent/audition.ts`           | Wave 0; a deterministic test fixture suite            |

**Wave 0 is the highest-leverage single step in this entire program**, because it converts the
existing tool surface into the AAW's foundation _without_ adding a single model. It also has a
property that matters for an independent developer: it is testable, it is mechanical, and it makes
every later AI feature cheaper rather than more expensive.

---

## 7. The shared control plane — one core, two products

### 7.1 What is genuinely shared

```
        ┌──────────────────────────────────────────────┐
        │  SHARED AAW CORE (model-agnostic, no UI)      │
        │  • brief schema + normalization               │
        │  • typed ActionPlan + plan→command lowering   │
        │  • capability registry format + risk lattice  │
        │  • preview artifact format + verification     │
        │  • receipt/provenance format                  │
        │  • model provider interface                   │
        └──────────────────────────────────────────────┘
             ▲                              ▲
             │ product adapters             │ product adapters
┌────────────────────────┐     ┌────────────────────────────┐
│ KYX ADAPTER            │     │ ZYVO ADAPTER                │
│ roles: drum/bass/keys  │     │ roles: lead/doubles/room   │
│ musical time: PPQ 480  │     │ musical time: own grid      │
│ units: samples/patterns│     │ units: takes/comping/regions│
│ voice: selection-driven│     │ voice: mic + command + stage │
└────────────────────────┘     └────────────────────────────┘
```

**The rule that keeps the products distinct:** the shared core may define _formats and protocols_;
it may **never** define _musical vocabulary_. "Tension", "role", "section", "preserve" are product
adapters, because a beatmaker's "chorus" and a singer's "verse" are not the same object.

### 7.2 What must NOT be shared

| Not shared                 | Why                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The project schema         | KYX schema v38 and ZYVO's `.vforge` model are different documents with different capabilities. A union schema is a rewrite of both |
| The audio engine           | Different DSP, different I/O, different real-time constraints (browser vs native + ASIO)                                           |
| The plugin/effect registry | Different products, different chains, different license models                                                                     |
| Musical time               | PPQ 480 in KYX; ZYVO's sample/beat grid and take regions are a different coordinate system                                         |
| The UI                     | A beatmaker's arrangement view and a singer's take comping view are not the same surface                                           |

### 7.3 The actual interoperability seam (already partially built)

KYX already exports `.kyxzyvo` (master + stems + the full project JSON + manifest) and ZYVO already
imports it via `packages/project-format/src/kyxTransfer.ts` — tempo, per-scene tempo map,
songStructure (role→section), markers, master mix → instrumental bed, stems → aligned muted
channels — **and editable MIDI**: `convertKyxMidi` turns the embedded source document's patterns into
playable tracks (`packages/project-format/src/kyxTransfer.ts:486-493`), carrying real notes
(`startBeat` / `durationBeats` / `pitch` / `velocity`,
`packages/project-format/src/kyxDocument.ts:576-582`).

> **Correction (2026-10-26).** This section originally stated that "MIDI/patterns/notes are not
> transferred", citing the repo's own plan note. **That was already false when it was written** — the
> ZYVO side has carried the MIDI conversion since 2026-09-26 (`9094664c`). A plan note rots exactly
> like a stale comment does.

**The frontier implication:** a shared _creative-context_ handoff should carry the same class of
payload as the existing contract §3.2 describes — intent, tempo/key, section map, role labels,
hard requirements, preserve/avoid, provenance, explicit uncertainty. Concretely: the `.kyxzyvo`
transfer is the right _vehicle_, and the first increment is **not** the notes (those cross, since
2026-09-26) but the **intent and the provenance** — which today do not: the original KYX JSON
travels as an opaque payload (`src/export/zyvo-transfer.ts:173,423`), preserved but not translated.
That is a concrete, low-risk, high-value increment: **it makes a KYX beat editable in ZYVO rather
than a flattened render**, and it is the substrate any cross-product AAW feature would need.

---

## 8. Open questions this architecture does not answer

| #   | Question                                                                                              | Why it matters                                                                                                   | Where it is decided                   |
| --- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Q-1 | Does the registry become a **published, versioned artifact** (like an MCP manifest) or stay internal? | Determines whether third parties can build on the AAW surface — and therefore whether the category is defensible | `AAW_DECISION_LOG.md` D-04            |
| Q-2 | Is the perception cache **per-project, per-user, or shared**?                                         | Sharing across projects is a privacy problem; per-project is a performance problem                               | `AAW_SECURITY_AND_REALTIME_SAFETY.md` |
| Q-3 | Does the permission lattice allow a user to **raise** (never lower) the autonomy of a feature class?  | Autonomy is the commercial appeal and the trust risk simultaneously                                              | `AAW_DECISION_LOG.md` D-06            |
| Q-4 | What is the **cost of a proposal** (CPU-seconds, RAM, render minutes) and who pays it?                | "More tension" that costs 4 minutes of render is a different product from one that costs 4 seconds               | `AAW_EXPERIMENT_BACKLOG.md`           |
| Q-5 | Is the typed plan **stored in the project** (auditable, replayable) or ephemeral?                     | Storing it makes proposals reproducible and reviewable; it also grows the file                                   | `AAW_DECISION_LOG.md` D-08            |
| Q-6 | How does the permission lattice treat a **user who explicitly asked for a destructive action**?       | "Delete all the silence" is legitimate; the same command from a hallucination is not                             | `AAW_AI_CONTROL_CONTRACTS.md` §4      |
| Q-7 | Does ZYVO's live/show mode get a **stricter lattice** than KYX's studio mode?                         | A wrong live automation move on stage is not the same cost as a wrong studio edit                                | `ZYVO_FRONTIER_CAPABILITIES.md`       |

---

## 9. What this architecture deliberately does not do

- It does not add a chat panel as a product centre.
- It does not let a model write project state, ever.
- It does not put inference in an audio callback, ever.
- It does not learn taste from ordinary editing, ever.
- It does not require a model to be present for the product to be a DAW.
- It does not assume a second source of truth.
- It does not assume the frontier models will still exist, or be licensed the same way, in two years.
