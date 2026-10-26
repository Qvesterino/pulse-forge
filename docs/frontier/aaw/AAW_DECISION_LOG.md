# AAW_DECISION_LOG

**Status:** ADR-style decisions, unresolved questions, and evidence gaps for the KYX / ZYVO frontier program
**Date:** 2026-10-25
**Status key:** **Accepted** · **Proposed** (needs a decision) · **Open** (deliberately undecided) · **Rejected**

> Every decision here cites the evidence that produced it. A decision without a citation is a
> preference, and preferences belong in the roadmap, not in a decision log.

---

## D-01 — The AAW's centre of gravity is trust infrastructure, not models

**Status: Accepted** · **Date: 2026-10-25** · **Scope: both products**

**Context.** The brief assumes an AAW is defined by AI capability. The verified audits show the
opportunity is elsewhere: KYX already owns a reversible command layer, frame-grouped undo, a
39-tool MCP surface with a real dry-run sandbox, live/offline render parity, a hard real-time
boundary and typed effect metadata. ZYVO already owns 283 typed commands, a draft-only external MCP
surface, a fail-closed show preflight and a clean worklet boundary. What is missing on both sides
is **consent, scope enforcement and perception**.

**Decision.** The program's definition of an AI-Assisted Audio Workstation is:

> Perception (deterministic first) → a **typed, scoped, reversible** proposal → a **deterministic
> permission decision** → a **transactional apply** → an **independent verification** → a
> **receipt**. The model is one interchangeable implementor inside that loop, and the loop works
> without it.

**Consequence.** Wave 0 (capability metadata + permission lattice + scope verifier) is **blocking**:
no new AI capability ships before it. The category-defining demos are _situated_ (selection-aware,
two-variant, instantly switchable, numerically diffed), not conversational.

**Evidence.** `AAW_STATE_OF_THE_ART_2026.md` §1 (verified substrate, both repos); §7.4 (ZYVO's consent
posture is stronger than KYX's); `AAW_ROADMAP_2026_2029.md` §2.3 (the top of the ranking is
trust/measurement infrastructure, not AI features).

**Reverses if.** E-10 shows the assisted path is not faster than manual editing on any task.

---

## D-02 — The pinned intent model carries a revenue-triggered licence cliff

**Status: Accepted — DOCUMENTED AND DEFERRED (2026-10-25)** · **Revisit: 2028-10-25, or immediately
before any entity crosses USD 10M annual revenue**

**Context.** The LFM Open License v1.0 §5(a) conditions the commercial-use grant on the using legal
entity not exceeding **USD 10,000,000 annual revenue**, and §5(b) states that commercial use above
the Threshold "**is not licensed**". KYX ships and pins `LiquidAI/LFM2.5-1.2B-Instruct` under that
licence. The audio sibling `LiquidAI/LFM2.5-Audio-1.5B` is under the same licence.

**Decision (Daniel, 2026-10-25).** **Document and defer.** The working assumption is that the
shipping entity stays **below USD 10M annual revenue for the next two years**. No Apache/MIT
fallback backbone is built now.

**What deferral does and does not buy.**

- **Buys:** zero engineering cost, and the decision stays reversible while it is still cheap.
- **Does NOT buy:** immunity. The cliff is a property of the _licence_, not of the plan. If the
  entity crosses the threshold, the shipped intent model becomes unusable, and replacing it is a
  **licensed migration, not a weight swap** — the model is the pinned, fine-tuned centre of the
  product.
- **Therefore the deferral is bounded, and the bound is written down:** the risk is recorded here,
  the pack ships its licence file **vendored** (the licence terminates automatically on breach —
  §11 — so a runtime fetch would itself be a compliance failure), and the re-review date is set.

**The cheap hedge that stays available.** The provider interface
(`AAW_AUDIO_MODEL_LANDSCAPE.md` §6) already carries `version` + `artifactDigest`, so swapping the
backbone is an adapter change, not a rewrite. `P-8` in the roadmap stays defined and unscheduled —
**if** the trigger fires, it is a bounded project, not a rebuild.

**Evidence.** `https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct/raw/main/LICENSE` (grade **A**);
repo pin in `docs/IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md:614`.

**Revisit trigger (any one is sufficient):** (a) the entity's annual revenue approaches USD 10M;
(b) a distribution decision is made that ships the weights; (c) the licence text changes upstream;
(d) 2028-10-25, regardless.

---

## D-03 — Which LFM checkpoint does the desktop path point at?

**Status: Open — a small inconsistency, deliberately not silently patched** · **Date: 2026-10-25**

**Context.** `docs/LOCAL-INTENT-MODEL.md:113-114` documents the Ollama default as
`hf.co/LiquidAI/LFM2-**1.2B**-GGUF:Q4_K_M` (730 MB) — the **LFM2** checkpoint — while the roadmap and
the SFT base pin **LFM2.5**-1.2B-Instruct. Both checkpoints exist. The documented smoke test on the
LFM2 base reports **schema-legal 8/8 but expected-kind 3/8** (`docs/LOCAL-INTENT-MODEL.md:119-121`),
i.e. the base model guesses — which is what the SFT fine-tune fixes.

**Options.**

- (a) Point the default at **LFM2.5**-1.2B-GGUF so the desktop default matches the training base and
  the roadmap naming. Cost: a behaviour change for every desktop user.
- (b) Keep **LFM2** as the default and correct the docs to say so, treating LFM2.5 as the _training_
  base only. Cost: two base models in the story.
- (c) Make the default **configurable with an explicit warning** when the loaded base does not match
  the adapter's training base.

**Recommendation.** (c), then (a). The real defect is that the product can load an adapter whose base
does not match the model it was trained on, and say nothing.

**Why it is not patched here.** Changing the default shipped model is a product decision with user-visible
consequences, and this program is in **research mode** (no code edits). It is recorded as an ADR
candidate instead.

---

## D-04 — Is the capability registry a published, versioned artifact?

**Status: Open** · **Date: 2026-10-25**

**Context.** KYX already has `docs/mcp-manifest.json` (39 tools, matching `src/mcp/tools.ts:1597`) and
ZYVO has a generated MCP catalog (61 tools) plus `MCP_AI_CONTROL_MATRIX.md`. Both are already
_descriptions of a capability surface_ — but neither carries the fields an agent needs to reason
safely: `version`, `sideEffects`, `realtimeSafe`, `latencyClass`, `riskClass`, `undoUnit`.

**Options.** (a) Keep the registry internal, extended with the missing fields. (b) Publish it as a
versioned public artifact (like an MCP manifest, plus the AAW-specific fields).

**Recommendation.** (b), **after** (a). The internal version is what every capability needs; the
public version is what makes the category defensible and what lets third parties build on the
surface. (a) is a prerequisite, not an alternative.

**Consequence if (b).** A published contract is a compatibility promise — it needs a deprecation
policy and a version history from day one.

---

## D-05 — Copyleft MIR components run behind an IPC boundary, not linked

**Status: Proposed** · **Date: 2026-10-25**

**Context.** `MTG/essentia` is **AGPL-3.0**; `aubio/aubio` is **GPL-3.0**;
`sonic-visualiser/sonic-annotator` is **GPL-2.0**. Permissive alternatives exist (madmom BSD-2,
librosa ISC, basic-pitch Apache-2.0). Essentia's _model_ licences are separately unverified
(`NOASSERTION`).

**Decision proposed.** Any AGPL/GPL component is shipped as an **unmodified binary or sidecar
service** behind a process boundary, never linked into the product. The repo already does exactly
this for a neighbouring problem — the native audio engine is a separate C++ module — so the pattern
is not new.

**Consequence.** One extra process; a packaging obligation; and a rule that any new MIR dependency
is reviewed for licence **before** it is added.

**Evidence.** `https://github.com/MTG/essentia` (grade **A**), `https://github.com/aubio/aubio` (**A**),
`https://github.com/CPJKU/madmom` (**A**).

---

## D-06 — Autonomy can only be raised by the user, never by the model

**Status: Accepted** · **Date: 2026-10-25**

**Context.** The brief asks how autonomy should be governed. ZYVO already demonstrates the right
posture externally: autonomy is **not forwarded** across the MCP boundary
(`agentVoiceManager.ts:5638-5648`); acceptance is a UI click. But ZYVO's _in-app_ agent **can**
auto-apply channel gain/pan/send/tempo in `"command"` autonomy mode with no live-show guard (H4),
and KYX lets **21 of 39** tools mutate with no per-call approval.

> **Correction, measured 2026-10-26:** the H4 branch above is **latent, not live** — the
> `autoApplyProposal` dep never reaches the host the app actually uses, so the auto-apply cannot
> fire in ZYVO's app today. The in-app autonomy control is therefore currently without effect. The
> show lock was built **before** that seam, and a pin now forbids auto-apply without it. See
> **D-15**.
>
> **Superseded the same day (T1).** The seam was then wired **on purpose**, with the lock already in
> front of it, so the auto-apply **does** fire in ZYVO's app now — and the pin became a
> **constructor rule** rather than a test. The hazard is no longer latent: it is live **and** guarded.
> See **D-15**.

**Decision.** Autonomy is a **user-side, versioned, per-project policy object**. It can be _raised_
by the user for R1/R2 classes. It can never be raised by a model, never lower the R2–R4 requirements,
and never survive a project switch without re-confirmation. The permission lattice is a
**deterministic rule table**, never model-driven (`AAW_AI_CONTROL_CONTRACTS.md` §4).

**Consequence.** R2 and R3 capabilities always require an explicit user action. This is a
deliberate reduction in apparent "magic" and an increase in trust and reviewability.

---

## D-07 — Are plans stored in the project?

**Status: Open** · **Date: 2026-10-25**

**Context.** Storing the plan makes a proposal **reproducible, reviewable and replayable** — and
makes "what did the AI actually propose, and why" answerable months later. It also grows the
project file and couples the project to a contract version.

**Options.** (a) Ephemeral (the plan lives only in the receipt). (b) Persisted in the project
document, with a contract version and an expiry.

**Recommendation.** (b), with `contractVersion` + `expired` marking, and with the _plan_ stored
rather than the _reasoning_. The contract's "no chain-of-thought" rule (`AI-PRODUCER-CONTRACT.md`
§6.7) applies to storage as much as to display.

---

## D-08 — The perception cache is per-project and revision-keyed

**Status: Accepted** · **Date: 2026-10-25**

**Context.** Perception must be a cache, not a stage (see `AAW_REFERENCE_ARCHITECTURE.md` §3.1).
The cache key is `(projectRevision, artifactId, algoVersion, paramsHash)`.

**Decision.** The cache is **per-project, per-device, revision-keyed, and reproducible**: the same
key must yield the same bytes. Artifacts are cleared with the project and are **never uploaded**.
A shared or cross-project cache would be a privacy leak; a non-reproducible cache would make the
verifier's claims unfalsifiable.

---

## D-09 — No training without a published baseline failure

**Status: Accepted** · **Date: 2026-10-25**

**Context.** The repo's own negative result is the strongest evidence in the program: a creative-task
LoRA over a 32-row synthetic corpus **passed 25/32 schema checks and produced 0 of 24 expected
creative proposals** (`scripts/data/creative-task-sft/README.md`). Format learning is not capability
learning.

**Decision.** The seven-rung decision tree in `AAW_TRAINING_AND_DATA_STRATEGY.md` §2 is binding. A
training project may only begin with a **measured, held-out, reproducible baseline failure**, and
every candidate names its exit **and** kill criteria. The current count of justified training
projects is **zero**.

---

## D-10 — The generation target is ACE-Step 1.5, not the famous models

**Status: Proposed** · **Date: 2026-10-25**

**Context.** MusicGen, AudioGen, YuE2, MMAudio, MERT and Music2Latent are **CC-BY-NC-4.0**; Audio
Flamingo is **NVIDIA OneWay Noncommercial**. `ACE-Step/Ace-Step1.5` is **MIT with an explicit
commercial-use grant**, 2.39 B, **< 4 GB VRAM**, **< 2 s**/song on an A100 (**< 10 s** on a 3090), and
**LoRA-able from 8 songs**.

**Decision proposed.** If and only if the deterministic retrieval baseline exists and is measured
(K-3 first, then K-8), the generation target is **ACE-Step 1.5**, run locally on the assumed
6–16 GB VRAM tier. Its "50+ languages" claim is **not enumerated** — Slovak coverage is unverified
(E-13).

**Open risk.** Its licence is permissive but the _output_ rights, and the provenance obligations for
generated stems shipped inside a user's project, must be checked before it is used in a product.

---

## D-11 — Slovak transcription is Whisper, not LFM2.5-Audio

**Status: Accepted** · **Date: 2026-10-25**

**Context.** `openai/whisper-large-v3-turbo` is **MIT** (809 M params) and `openai/whisper-large-v3`
is **Apache-2.0** (1.55 B); both carry verified `sk` and `cs` language tags.
`LiquidAI/LFM2.5-Audio-1.5B` is **English only** (plus a separate JP checkpoint) and is under the
revenue-cliff licence.

**Decision.** Slovak ASR is Whisper-family. LFM2.5-Audio may be evaluated as an English-only
offload (E-01) and as a fine-tune candidate (T-1) **only if** E-02 shows a Whisper gap on sung
Slovak.

---

## D-12 — Live cue prediction is rejected

**Status: Rejected** · **Date: 2026-10-25**

**Context.** The deterministic arrangement already knows the section structure, so the common case
needs no model. The model would only help for deviations (ad-libs, dropped sections) — the rare case
— and a late or wrong cue during a show is a visible, humiliating failure.

**Decision.** Not built. It scored **last (36th) under three of four weightings** and 34th under the
fourth — the most robust rejection in the portfolio. A deterministic cue plus a manual "next
section" control replaces it.

**Revive if.** A measured case appears where the arrangement is genuinely wrong at performance time
**and** a human confirmation step remains in the loop.

---

## D-13 — A learned project representation is rejected pending E-11

**Status: Rejected (provisional)** · **Date: 2026-10-25**

**Context.** Alt-4 in the architecture doc. The typed graph (schema v38, 480 PPQ, scenes, markers,
automation lanes, legal target resolution) is already exact. A learned embedding is a proxy.

**Decision.** Not built. **E-11** (150 edit-target cases, split by project) decides it; the bar is
**≥ 10 points absolute** over graph traversal.

---

## D-14 — Port ZYVO's draft-only consent posture to KYX

**Status: Accepted — IMPLEMENTED (2026-10-25, ADR 0065)** · **Date: 2026-10-25**

**Context.** ZYVO's external MCP path is **draft-only**; autonomy is not forwarded; acceptance is a
UI click. KYX's external MCP path let **21 mutating tools** execute with no per-call approval
(only 7 destructive tools were gated behind `pf:mcp-allow-destructive`).

**Decision.** KYX adopts ZYVO's posture for **external** transports: a mutating call from an
external agent now needs the user's standing consent (`pf:mcp-allow-mutations`, default OFF). The
`local` surface — the human in the app, and the in-app intent flow that already previews and
applies through their own hands — is unchanged.

**What is implemented (ADR 0065).** The permission lattice (`src/mcp/permissionLattice.ts`), the
scope guard (`src/mcp/scope-guard.ts`), and the document revision counter (`ProjectStore`).
**35 unit tests** in `tests/permission-lattice.test.ts`. The MCP chip carries the switch
(`🔒 ZMENY` / `🔓 ZMENY`) next to the existing `MAZANIE` toggle — without it the consent would be
a flag nobody could set, and an external client that may never change the project is a relay that
does nothing.

**Two corrections made during implementation (2026-10-25), recorded rather than edited away.**

1. **The destructive lock is NOT a lattice rule.** The first implementation refused a locked
   destructive call centrally. It broke **64 tests**, because the existing D4 gate is
   **per-operation** (not per-tool), runs **after** argument validation (so a malformed request
   stays `INVALID_ARGUMENTS`, not `POLICY_REFUSED`), and carries the auto-checkpoint side effect.
   The central copy was removed; the lattice now owns only the external consent and the revision
   check.
2. **The consent is read from the MCP CONTEXT, not from `localStorage`.** The persisted flag behind
   the context's back created two truths for one consent and refused calls the host had explicitly
   unlocked. The flag is now the **fallback**; the context answers first.

**What is NOT implemented — the honest gap.** KYX's consent is a **standing** one (a flag), not
ZYVO's **per-call** one (a UI click). The per-call proposal surface does not exist in KYX yet.
The standing consent is strictly stronger than the old behaviour and strictly weaker than
per-call approval. Closing that gap is the next increment of this decision, not a footnote.

**One deliberate deviation from the original rule.** The rule said "external = `web-relay`,
`desktop-stdio`, `qmr`, `headless`". `headless` was **removed** from the gated list: the headless
host (`src/mcp/headless-host.ts`) is an in-process harness — `docs/AGENT-KIT.md` lists it under
"tests, tooling" and ADR 0046 made it the evaluation workhorse — so nothing reaches it from
outside the process, and gating it would make the harness unable to evaluate the thing it exists
to evaluate. Its `allowMutations` defaults to on and a test opts out to exercise the refusal. The
two **shipped** network-reachable surfaces (`web-relay`, `desktop-stdio`) are gated by default.

**Evidence.** `apps/vocalforge-daw/src/agentVoiceManager.ts:5638-5648` (ZYVO's posture);
`src/mcp/agentTrust.ts:190-193` + `src/mcp/flags.ts` (KYX's old surface);
`docs/adr/0065-permission-lattice-and-scope-guard.md` (the decision, the two corrections and the
remaining gaps).

---

## D-21 — The revision counter lives in the store, not in the document

**Status: Accepted (2026-10-25, ADR 0065)** · **Date: 2026-10-25**

**Context.** F-25's own commit message says it: _"the document has no revision counter and no
conflict signal."_ A permission lattice that can refuse a stale plan needs something to compare
against. Two options: a `revision` field inside the project document (a schema migration), or a
counter in the store.

**Decision.** The counter lives in `ProjectStore` and moves in **one place** — `afterMutation()`,
the single choke point every applied change passes through. A command that changes nothing does
not bump it. The revision is **in memory by design**: a proposal does not survive a reload, so a
counter that reset with the process cannot create a false "fresh" claim. `McpToolContext.getRevision`
is optional, and a transport that cannot report one gets `null` — the lattice then **skips** the
staleness rule rather than inventing a revision.

**Consequence.** The staleness rule is **opt-in**: only a caller that declares a
`projectRevision` can be refused for staleness. Existing callers are unaffected.

**Revisit if.** Plans become persisted in the project document (the open decision on storing
plans) — then the revision should travel with them, and the schema bump becomes worth its
blast radius.

---

## D-22 — E-07 runs on a two-listener panel: directional, not release-gating

**Status: Accepted (2026-10-25)** · **Date: 2026-10-25**

**Context.** E-07 asks whether "more tense" is measurable from the audio. The protocol in
`AAW_EVALUATION_BENCHMARKS.md` wanted ≥ 30 pairs for a directional read and ≥ 100 for a
release-gating claim. Daniel can supply **two listeners** (him + one other).

**Decision.** E-07 runs with **two listeners**. Its output is a **directional read, never a release
gate**, and the protocol says so in the result itself. The kill criterion is unchanged in
_direction_ (a human win rate below 60 % or a feature accuracy below 55 % means the capability
ships without the claim) but the **confidence** is materially lower, and the write-up must state
"n = 2, directional only" in the finding.

**Why this is acceptable.** E-07's job is to **cancel** a feature before it is built, not to
certify it. A two-listener panel that fails to separate tense from non-tense is still evidence
that the claim should not be made. A two-listener panel that DOES separate them is evidence to
_investigate_, not to ship on. The asymmetric cost is acceptable because the downside of the
feature (shipping a "tension meter" that cannot measure tension) is the whole risk.

**What it forbids.** No release decision may cite E-07's result. Suite D's release gate stays
closed until a panel of ≥ 3 (preferably ≥ 5) exists.

---

## D-15 — A show lock is required for the in-app agent

**Status: Accepted — urgent → Implemented (2026-10-26), with a measured correction** · **Date: 2026-10-25**

**Context (H4).** In autonomy mode `"command"`, a proposal whose children are all in
`SAFE_AUTO_APPLY_COMMANDS` — including `SetChannelGain`, `SetChannelPan`, `SetSendLevel`,
`SetClipFade` and `SetTempoMap` — is accepted immediately, with no check for `rehearsal`/`gig` mode.

**Decision.** In `gig` mode: the auto-apply allowlist is **empty**; `SetTempoMap` is never
auto-applied; every audible parameter change becomes a proposal requiring a UI click; and the
permission lattice's R2 class applies to the whole live surface regardless of autonomy.

**Honest caveat.** Whether the Live window's modality already makes this unreachable in the shipped
UI was **not proven at runtime**. The fix is required either way, because the _code path_ has no
guard and the next UI change could expose it.

### Correction, measured 2026-10-26 — the hazard is LATENT, not live

The caveat above has now been closed, and **the answer is not the one the context assumed**. H4 was
**not** shielded by the Live window's modality — it was shielded by a **missing wire**.

Measured, three independent arms:

- The app passes an `autoApplyProposal` dep into `createAgentToolHost`, but the **host object it
  builds does not carry it** — the property appears only in the deps interface, never on the host.
- Both real call sites (the in-app LLM tool loop and the MCP direct-call path) pass
  `host: host.host` — that host, without the dep.
- The only test asserting an auto-applied change builds a **hand-rolled "production-shaped" host**,
  not the app's host.

So the executor's graduated-autonomy branch **cannot fire in the app today**. The original H4
wording overstated it: there is no live path, there is a **latent** one, one wiring step away.

**This does not weaken the decision — it sharpens the sequencing.** A lock written _after_ the
wiring is a lock written under time pressure. So the lock was built **before** the seam, and a
doctrine pin now makes "auto-apply without a lock" a test failure rather than a review comment.

**What is implemented (ZYVO, 2026-10-26).** A host-supplied show lock: while the Live Show is in
its `perform` step (the gig), the agent's auto-apply **and** the agent's undo/redo are refused, and
the refusal is written into the tool audit trail. The lock reads the **existing** dock status
(show → main → main renderer), so it needs no new IPC channel and cannot drift from what the
performer sees. 13 new tests; the pin was falsified (wiring auto-apply without the lock turns the
suite red) and then removed.

**What was NOT implemented at this point.** The auto-apply seam itself was still **not** wired —
deliberately. Turning on an autonomy mode that had never run in the app was a separate product
decision, and it now had a safety precondition in place. The UI's autonomy control was, at that
moment, a control with no effect. _(Superseded the same day — see the next section.)_

### The seam is now wired (2026-10-26, T1) — the hazard is live AND guarded

Daniel's decision: wire the auto-apply. The lock was already in front of it, so the door was opened
**behind a gate** rather than in front of one. The measured "latent" state above is therefore
**superseded — not by an argument, by a commit**: the auto-apply **now fires** in ZYVO's app.

What the wiring added, and what it cost:

- The capability reaches the host. Three conditions must hold at once: the session autonomy mode is
  `"command"`, **every** child command of the proposal is in the allowlist (level/time only), and the
  session budget has room.
- The apply goes through the **same** `AcceptProposal` command the UI accept button uses — the
  staleness check, the validate-all gate, the atomic rollback, the merged undo entry and the audit
  log all run exactly as they do for a human click. There is no second write path into the project.
- **A second dead wire surfaced.** The autonomy budget was a **snapshot**: the executor spends the
  budget by writing to the object it is handed, so the count was thrown away and the session store
  never moved. Wiring the seam alone would have produced an **unlimited** budget wearing the costume
  of a capped one, while the panel showed "10 left" forever. The budget is now a live view of the
  session store.
- **The lock became a constructor rule.** `createAgentToolHost` refuses to build a host that carries
  an auto-apply capability without a show lock. The unsafe combination is unreachable, not merely
  watched for by a test — a test can be deleted, a constructor guard cannot be forgotten.
- The external MCP transport still forwards **no** autonomy: "AN EXTERNAL CLIENT CAN DRAFT. ONLY THE
  USER CAN APPLY." is unchanged.

**What the wave does NOT prove.** The lock was not verified against a live show with a performer — it
is logic over a window state, covered by unit tests, not a stage run and not a listening test. The
end-to-end test uses the real Command Core registry but no real LLM provider. The limit of 10 is a
chosen constant, not a measured boundary. The first time the lock meets a real show, it is logic
that has never run.

**A pin that required a bug — rebased, visibly.** The doctrine pin in
`agentApplyPathSurface.test.ts` required the literal `autonomy: { mode: getAgentAutonomy().mode }` —
which **is** the dead budget. The pin required the bug because the bug is what the line looked like.
Its intent (the in-app path forwards autonomy, and forwards the live store) is unchanged; the
rebasing is recorded in the test itself.

**A pin of my own that did not bite.** The first source pin in this wave asked for the key
(`showLock:`). Removing the lock from the app left the suite **green**, because `showLock: undefined`
contains that key. It now requires the capability (`showLock: () => liveShowLock()`), and the same
probe goes red. Recorded because a pin that cannot fail is a comment.

**Evidence (T1).** `apps/vocalforge-daw/src/agent/agentAutoApply.ts` (the app-side apply),
`apps/vocalforge-daw/src/agent/agentAutonomyState.ts` (the live budget),
`apps/vocalforge-daw/src/agent/agentToolHost.ts` (the constructor rule),
`apps/vocalforge-daw/tests/agentAutoApplyWiring.test.ts` (16 assertions, end to end through the app's
own host and the real registry), `docs/AGENT_CONTROL_MODEL.md` §9.3–§9.4 (the contract),
`AGENT_WORK_LOG.md` 2026-10-26 (the wave, with its measurements).

---

## D-16 — The realtime invariant stands, and it is verified

**Status: Accepted (reaffirmed)** · **Date: 2026-10-25**

**Context.** Both repos have a clean audio path today, and that is worth stating as a fact rather
than an aspiration: KYX — **51** `AudioWorkletProcessor` classes across **50** files, with **no**
`fetch`/`XMLHttpRequest`/`WebSocket` occurrence in `src/audio-worklets/**` or `src/audio-engine/**`;
ZYVO — an allocation-free worklet `process` with every throw caught, and Parakeet inference on its
own thread with its own `IAudioClient`.

**Decision.** No inference, network, blocking allocation or unbounded work enters an audio callback,
in either product, in any mode. AI influences audio only through a **bounded, slewed envelope**
(RT-5).

---

## D-17 — The local ONNX model is a slot-filler, not a planner

**Status: Accepted** · **Date: 2026-10-25**

**Context.** `public/models/intent-model-report.json` describes the shipped browser model as a
_"multi-head slot-filling MLP (BoW trunk + closed-class heads)"_ — 59 heads, 6144-token vocabulary,
2,601,522 B, `valHeadAccuracyMean = 0.9949`, `gatePassed = true`.

**Decision.** Do not describe it as a planner or as "AI understanding". It is a **fast, small,
deterministic-ish parser** for the browser path, and the deterministic router always has the last
word (`src/intent/model-route-gate.ts:144-165`).

**Collateral note (not fixed here — research mode).** `src/intent/model-loader.ts:29-30` calls the
model _"6.69 MiB"_ while the manifest and the file on disk say **2,601,522 B ≈ 2.48 MiB**. A stale
comment about a measurement is a small but real provenance leak; it is listed in the evidence-gap
register rather than silently edited.

---

## D-18 — The shared control plane defines formats and protocols only

**Status: Accepted** · **Date: 2026-10-25**

**Context.** KYX and ZYVO have different schemas, different effect systems, different time bases
(KYX: 480 PPQ; ZYVO: currently **no addressable musical time at all**), different engines and
different plugin models. The existing `.kyxzyvo` seam crosses audio and structure but not
instrument/effect/automation state, and MIDI arrives only as a converted sketch.

**Decision.** The shared core may define the **brief schema, the plan schema, the registry format,
the risk lattice, the preview artifact, the verification report, the receipt, and the provider
interface**. It may **never** define musical vocabulary — "tension", "role", "section" and "preserve"
are product adapters.

**First concrete step.** P-9: carry the **notes/patterns** across `.kyxzyvo`, so a KYX beat arrives
in ZYVO as editable material rather than a flattened render.

---

## D-19 — Evidence grades are mandatory in every claim this program makes

**Status: Accepted** · **Date: 2026-10-25**

**Decision.** Every load-bearing claim carries a grade (**A** primary/official · **B** independent
measurement · **C** secondary · **U** unverified) and a date. "SHIPS" means _implemented and reachable
in source_, never _observed working_ and never _good_. A claim sourced only from a markdown file is
marked **(doc claim)**. Corrections are stated explicitly rather than silently edited — as this
program did for the "ASR benchmarks are unpublished" claim in `AAW_AUDIO_MODEL_LANDSCAPE.md` §1.6.

---

## D-20 — Documentation drift is treated as a defect, not a nuisance

**Status: Open** · **Date: 2026-10-25**

**Context.** The ZYVO re-verification found four of ten load-bearing status claims wrong (transfer
library size, file/LOC counts, WASAPI latency, and a command count stated as 282 in one document
where the code has 283), plus a stale "24 tools" matrix against 61, a stale "no envelope-follower
source" claim, a 37-effects registry described as 17, 17 plugin directories described as 16, and
ASIO described as opt-in when it is on by default with the SDK vendored.

**Decision proposed.** A generated status document, produced by a read-only counting script that
**cannot** write to the document it describes, is the single source for all numbers. `MCP_AI_CONTROL_MATRIX.md`
and similar hand-maintained matrices are either regenerated or explicitly marked as archived
revisions with their date.

**Why it is open.** This touches another product's documentation conventions, which is a decision
for that product's owner.

---

## 3. Unresolved questions (blocking or shaping)

| #    | Question                                                                                                               | Blocks                           | Owner       | Answer by                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------- | ---------------------------------- |
| Q-1  | Which legal entity ships KYX/ZYVO, and what revenue trajectory?                                                        | D-02 (the licence cliff)         | founder     | before the next funding/scale step |
| Q-2  | Which LFM checkpoint does the desktop path default to?                                                                 | D-03                             | product     | next release                       |
| Q-3  | Is the capability registry published?                                                                                  | D-04                             | founder     | Portfolio I exit                   |
| Q-4  | Are plans persisted in the project document?                                                                           | D-07                             | product     | Portfolio II                       |
| Q-5  | What is the AAW's latency budget for a proposal? (H-2 ≤ 2 s vs H-3 ≤ 8 s)                                              | P-4, K-4                         | product     | Portfolio I                        |
| Q-6  | Does ZYVO get an addressable musical-time coordinate system, and does it match KYX's PPQ?                              | Z-2, Z-7, D-18                   | ZYVO owner  | Portfolio II                       |
| Q-7  | Is ZYVO's general modulation matrix in scope for this program?                                                         | singer-as-modulator architecture | ZYVO owner  | Portfolio III                      |
| Q-8  | Does the shared control plane live in one repo or as a versioned spec package?                                         | D-18                             | both owners | Portfolio I                        |
| Q-9  | Is a "research prototype" allowed to ship to users at all, and under what label?                                       | Portfolio III                    | founder     | Portfolio II                       |
| Q-10 | What is the ceiling on model-pack download size for a browser-first product? (2.14 GB ONNX vs a 1,070 KB entry budget) | E-04, P-12                       | product     | Portfolio II                       |

---

## 4. Evidence gaps this program could not close

| #     | Gap                                                                                                                                                                                                                                  | Consequence                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| EG-1  | **No independent (non-vendor) evaluation** of any frontier audio model was found. Every benchmark quoted is vendor-reported                                                                                                          | accuracy claims in this program are provisional; E-01/E-02 supply local measurements |
| EG-2  | **Liquid AI's announced LFM2.5 release date is unverified** (the blog page is JS-rendered); all dates used are HF repository `createdAt` timestamps                                                                                  | dates in this program are repository timestamps, and labelled as such                |
| EG-3  | **Essentia's _model_ licences are `NOASSERTION`**                                                                                                                                                                                    | no Essentia model may be redistributed until confirmed (D-05)                        |
| EG-4  | **`stepfun-ai/Step-Audio-EditX` has no licence tag**; `coqui/XTTS-v2` terms unread (CPML)                                                                                                                                            | both excluded from any commercial path                                               |
| EG-5  | **"Qwen3.5-Omni" does not exist on the Hub** as of 2026-10-25 despite a technical report appearing in search                                                                                                                         | do not plan against it                                                               |
| EG-6  | **No runtime verification** of either product's AI surface was performed (read-only audits; no builds, no test runs, no listening)                                                                                                   | every "SHIPS" is a source-level claim                                                |
| EG-7  | **ZYVO H4 was measured on 2026-10-26, and the seam was then wired on purpose** (T1): the auto-apply now fires in the app, behind the show lock and a live session budget — the lock's first run against a real show is still pending | the hazard is live but guarded; the lock is a constructor rule, not a test (D-15)    |
| EG-8  | **The Wake-word stub, the Parakeet second capture client, and the VST3 JS-thread entry point** were read but not exercised                                                                                                           | H6/H7/H2 severity is inferred, not measured                                          |
| EG-9  | **No measured accuracy exists for ZYVO's vocal analysis** (pitch, onset, key/tempo, reference blueprints)                                                                                                                            | every vocal-analysis claim is unverified; this is a Portfolio I deliverable          |
| EG-10 | **ACE-Step 1.5's language list is not enumerated** — Slovak unknown                                                                                                                                                                  | E-13                                                                                 |
| EG-11 | **Neither product has a measured, reproducible "tension" or "quality" human-labelled dataset**                                                                                                                                       | the flagship emotional claims stay unclaimed until E-07                              |
| EG-12 | **`d1-omni-600M` was 19 days old** at the time of writing; no independent evaluation exists                                                                                                                                          | E-12 is a research probe, not a plan                                                 |
