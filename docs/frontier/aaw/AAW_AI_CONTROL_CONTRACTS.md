# AAW_AI_CONTROL_CONTRACTS

**Status:** typed contracts for an AI-Assisted Audio Workstation control plane
**Date:** 2026-10-25
**Companions:** `AAW_REFERENCE_ARCHITECTURE.md`, `AAW_SECURITY_AND_REALTIME_SAFETY.md`, `AAW_DECISION_LOG.md`

> **This document is a TARGET-STATE specification.** The names below — `ActionPlan`,
> `CommandGateway`, `PreviewArtifact`, `Scope`, `Transaction`, `Receipt`, the rules R-1…R-6, and the
> capability ids in §7 — are **proposals, not existing code**: a search of `src/` finds no
> `CommandGateway`, no `ActionPlan` and no `densityFrom`. Where a field points at an implementation,
> it says so explicitly. _Corrected 2026-10-26: this was not stated anywhere, and the rule table
> read like a description of the shipped codebase._

---

## 0. Purpose and the six rules these contracts enforce

These are the types that sit between "a language model" and "a DAW that a person's work lives in".
They are deliberately narrow: a **model emits a plan**, the plan is **validated against a
registry**, the registry entry declares its **risk**, the **permission lattice** decides whether a
human must approve, the **command gateway** applies it as **one undo unit**, and the **verifier**
checks the outcome against what was promised.

### The six rules

| #       | Rule                                                                                         | Enforced by                                                                                                                           |
| ------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **R-1** | A model never writes project state. It emits a typed plan; the command gateway owns mutation | _target state:_ `ActionPlan` has no write primitive; `CommandGateway.apply` is the only mutator (neither type exists in `src/` today) |
| **R-2** | Nothing is applied that was not previewed. Preview and commit are the same plan instance     | `PreviewArtifact.planId` is re-validated at commit                                                                                    |
| **R-3** | No operation touches a target outside its declared scope                                     | `Scope` + verifier's protected-content hash comparison                                                                                |
| **R-4** | Every applied change is exactly one undo unit and carries a receipt                          | `Transaction` + `Receipt`                                                                                                             |
| **R-5** | The system may abstain, and abstention is a first-class successful outcome                   | `ActionPlan.outcome: "plan" \| "alternatives" \| "abstain"`                                                                           |
| **R-6** | The real-time audio path never depends on inference, network, or unbounded work              | `CapabilityDescriptor.realtimeSafe` + `riskClass` + the engine audit                                                                  |

### Versioning

Every contract carries a `contractVersion` (`"aaw.x.y"`). Rules:

- **Additive** changes (new optional fields, new enum members behind a `capabilities` flag) bump `y`.
- **Breaking** changes (removed/renamed fields, changed semantics) bump `x`.
- A consumer **must** reject a plan whose `contractVersion` it does not understand — it must never
  "best-effort" a plan it cannot fully validate. Silent partial application is a worse failure than
  refusal.
- Contract versions are **independent of product versions**. A `.kyx` project written by KYX 2.1
  must be openable by KYX 3.0 with its stored plans still interpretable, or the plan must be
  explicitly marked `expired`.

---

## 1. The Brief — what the user asked for, normalized

The brief is the **only** thing the planner is allowed to interpret, and it is always user-editable.

```ts
type BriefClauseKind =
  | "required" // hard constraint: tempo, key, length, "no vocals", required elements
  | "preserve" // must not change: "leave the kick and 808 alone"
  | "prefer" // soft direction: dark, spacious, punchy, "more tension"
  | "avoid" // explicitly unwanted
  | "target" // what the operation may affect
  | "uncertain"; // materially ambiguous; resolution could change the music

interface BriefClause {
  id: string; // stable within the brief, referenced by plans
  kind: BriefClauseKind;
  /** canonical, machine-checkable form, e.g. { tempo: { op: "eq", value: 92 } } */
  claim: unknown;
  /** the words the user actually used — kept for display and for provenance */
  verbatim: string;
  /** where this clause came from */
  origin:
    | { source: "user"; at: string } // the user typed it
    | { source: "project"; fact: string } // the project proves it
    | { source: "analysis"; artifactId: string } // a perception artifact
    | { source: "model"; modelId: string; version: string }
    | { source: "default"; ruleId: string }; // a product default
  /** 0..1 — for model-origin clauses this is the model's own confidence, and it is shown */
  confidence?: number;
  /** clauses that would be violated if this one were satisfied */
  conflictsWith?: string[];
}

interface Brief {
  contractVersion: "aaw.1.0";
  id: string; // brief id, for receipts
  createdAt: string; // ISO-8601
  /** revision of the project this brief was written against */
  projectRevision: number;
  clauses: BriefClause[];
  /** the user may have narrowed the scope; the planner must honour it */
  selectedScope?: Scope;
  /** the user's own words for the whole request, retained for provenance */
  utterance: string;
  /** free-form alternatives the user was shown and did not pick (kept for the receipt) */
  rejectedAlternatives?: string[];
}
```

**Non-negotiable:** `origin: "model"` clauses are **visible to the user with their confidence**, and
a clause with `confidence` below the product's floor is **not** silently promoted to `required`.
`AI-PRODUCER-CONTRACT.md` §4.1 already demands exactly this ("distinguish what the creator said,
what the project proves, what KYX inferred and what remains unknown").

---

## 2. The ActionPlan — what the planner proposes

A plan is **data**, never prose, never a script, never a diff of the project document.

```ts
type PlanOutcome =
  | { outcome: "plan"; steps: PlanStep[] }
  | { outcome: "alternatives"; options: PlanOption[]; reason: string }
  | { outcome: "abstain"; reason: string; missing: string[]; suggestion?: string };

interface PlanOption {
  id: string;
  label: string; // short, user-facing, e.g. "Less busy, same groove"
  steps: PlanStep[];
  /** why a user would prefer this one */
  rationale: string;
  /** what this option does NOT do — stated, not implied */
  tradeoff?: string;
}

interface PlanStep {
  /** the capability id from the registry — nothing else may be called */
  capability: string;
  /** capability version this step was authored against */
  capabilityVersion: string;
  /** typed arguments, validated against the capability's input schema */
  args: Record<string, unknown>;
  /** declared blast radius — the verifier enforces this against the actual diff */
  scope: Scope;
  /** brief clauses this step is intended to satisfy */
  satisfies: string[]; // BriefClause ids
  /** expected audible effect, in user language */
  expectation: string;
  /** if this step fails, what happens (skip / abort plan / fall back) */
  onFailure: "skip" | "abort" | "fallback";
  fallback?: PlanStep;
  /** estimated cost, used for the latency/attention budget */
  cost: { renderSeconds?: number; cpuSeconds?: number; memoryMB?: number };
}

interface ActionPlan {
  contractVersion: "aaw.1.0";
  planId: string;
  createdAt: string;
  /** the project revision this plan was computed against — checked at commit */
  projectRevision: number;
  briefId: string;
  /** provider that authored it, for provenance and for re-running */
  provider: { id: string; version: string; artifactDigest: string; seed?: number };
  /** the plan's own declared total scope */
  scope: Scope;
  result: PlanOutcome;
  /** diagnostics surfaced to the user, including what was UNVERIFIABLE */
  diagnostics: Diagnostic[];
  /** hard limit the plan may not exceed, checked before preview */
  budget?: { maxRenderSeconds?: number; maxSteps?: number };
}
```

### Scope — the blast radius, declared before anything happens

```ts
interface Scope {
  /** musical-time coordinates; the product's own time base, never seconds-as-float */
  regions: TimeRegion[];
  /** project object ids the plan may touch */
  objectIds: string[];
  /** roles the plan may touch, e.g. ["drums"] — product vocabulary, so adapter-specific */
  roles?: string[];
  /** explicitly protected object ids — inherited from the brief's `preserve` clauses */
  protectedObjectIds: string[];
  /** "everything except" — the negative space, which is where scope bugs hide */
  excludes?: TimeRegion[];
}

interface TimeRegion {
  /** the product's musical coordinate: ticks (KYX: PPQ 480) or the product's native grid */
  start: number;
  end: number;
  /** which timeline this refers to (scene, take, section) */
  contextId: string;
}
```

> **Why musical time and not seconds.** The brief's own golden scenario C ("make the hook bigger and
> more aggressive, but don't change the kick, 808 or chords") is a _musical_ constraint. A
> seconds-based scope would let a tempo change silently move the protected object out of the plan's
> declared region between preview and commit. Time in ticks is invariant under tempo.

---

## 3. The Capability Registry — typed tools

The registry is the AAW's real foundation. It is **metadata over capabilities that already exist**,
which is why it can be built first (Wave 0) with no model involved.

```ts
interface CapabilityDescriptor {
  id: string; // e.g. "fx.setParam", "arrangement.quantize"
  version: string; // semver of the contract, not of the DSP
  title: string;
  description: string;

  inputs: JSONSchema; // typed, closed (additionalProperties: false)
  outputs: JSONSchema;

  /** typed, checkable; failing one aborts the step before any mutation */
  preconditions: Precondition[];
  /** what must be true after the step; checked by the verifier */
  postconditions: Postcondition[];

  /** what this capability changes, classified */
  sideEffects: {
    mutatesProject: boolean;
    mutatesAudio: boolean; // affects rendered audio
    destructive: boolean; // deletes/overwrites/flattens/freezes user content
    reversible: boolean; // fully covered by one undo unit
    affectsTransport: boolean; // touches playhead/loop/tempo
    affectsExport: boolean; // touches bounce/stem/export configuration
  };

  /** the permission class — see §4 */
  riskClass: "R0" | "R1" | "R2" | "R3" | "R4";

  /** may this ever run inside an audio callback?  MUST be false for all model-backed work */
  realtimeSafe: boolean;

  /** does one invocation of this capability equal one undo unit? */
  undoUnit: boolean;

  /** replacement/supersession chain — keeps the registry versionable without breaking callers */
  supersedes?: string[];
  deprecated?: boolean;

  /** where the implementation lives, for auditability (not for the model to see) */
  implementation: { module: string; exported: string };
}
```

### Precondition / Postcondition — machine-checkable, not prose

```ts
type Precondition =
  | { kind: "projectRevisionEquals"; revision: number }
  | { kind: "objectExists"; objectId: string }
  | { kind: "objectNotProtected"; objectId: string }
  | { kind: "paramWithinRange"; objectId: string; param: string; min: number; max: number }
  | { kind: "clipEmpty"; clipId: string }
  | { kind: "transportStopped" }
  | { kind: "pluginHealthy"; pluginId: string }
  | { kind: "analysisFresh"; artifactId: string; maxAgeRevisions: number };

type Postcondition =
  | { kind: "protectedContentUnchanged"; hashes: Record<string, string> }
  | { kind: "scopeRespected"; scope: Scope }
  | { kind: "paramEquals"; objectId: string; param: string; value: number }
  | { kind: "undoUnitCreated" }
  | { kind: "noAudioCallbackViolation" };
```

`protectedContentUnchanged` with **stable content hashes** is the mechanization of the contract's
"No hidden scope expansion" requirement (§6.2). It is not a slogan: the verifier computes hashes of
protected objects before and after, and compares.

---

## 4. The Permission Lattice — deterministic, not negotiable by a model

The brief's "User Approval (by risk)" is the safety model, so it gets a real specification.

### Risk classes

| Class  | Meaning                                                                                      | Examples                                                                                     | Default                                                                                     |
| ------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **R0** | Read-only; no state change                                                                   | read project state, list capabilities, inspect analysis artifacts                            | auto                                                                                        |
| **R1** | Reversible, non-destructive, local to the declared scope; single undo unit                   | change a parameter value, nudge a clip, swap a sample in one slot                            | auto (with undo + receipt)                                                                  |
| **R2** | Reversible but **audibly significant** or touching multiple objects                          | regenerate a pattern, re-arrange a section, apply an EQ move across a role                   | **confirm** (with preview)                                                                  |
| **R3** | Destructive-but-recoverable or touches user content irreversibly if the undo history is lost | delete a region, overwrite a recording, flatten a track, remove takes                        | **confirm + explicit scope listing + backup checkpoint**                                    |
| **R4** | Irreversible, external, or affects export/other systems                                      | overwrite an exported file, delete a project, upload audio off-device, change project format | **forbidden by default**; requires an explicit, separate user action outside the agent flow |

### The decision function

```ts
type PermissionDecision = "auto" | "confirm" | "forbid";

function decide(
  step: PlanStep,
  descriptor: CapabilityDescriptor,
  ctx: {
    scope: Scope;
    userRequestedExplicitly: boolean; // did the user name this action verbatim?
    preflight: PreviewArtifact | null;
    projectRevisionCurrent: boolean;
    autonomyPolicy: AutonomyPolicy;
  },
): PermissionDecision;
```

Deterministic rules, in order:

1. `descriptor.riskClass === "R4"` → **forbid** (R4 is never reachable through the agent flow).
2. `!ctx.projectRevisionCurrent` → **forbid** (stale plan; offer re-plan).
3. `descriptor.realtimeSafe === false && step is scheduled into the audio path` → **forbid**.
4. `ctx.preflight === null && descriptor.riskClass !== "R0"` → **confirm** (nothing is applied
   without a preview — R-1/R-2 of the contract).
5. `ctx.userRequestedExplicitly && descriptor.riskClass === "R3"` → **confirm** (never auto, even
   when explicitly requested: the user asked for the _outcome_, not for the destruction).
6. `descriptor.riskClass === "R3"` → **confirm** + checkpoint + explicit scope list.
7. `descriptor.riskClass === "R2"` → **confirm**.
8. `ctx.autonomyPolicy` may **raise** autonomy for R1 steps the user has opted into
   (`autoApproveClasses`); it may **never** lower the requirements for R2–R4, and it is **never
   consulted by or overridable by a model**.
9. Otherwise → **auto**.

**Explicitly:** an autonomy setting is a _user-side_ policy object, versioned and inspectable. A
model cannot request it, and it does not survive a project switch without re-prompting.

---

## 5. Preview, Transaction, Verification, Receipt

### PreviewArtifact — what "you heard" actually is

```ts
interface PreviewArtifact {
  contractVersion: "aaw.1.0";
  planId: string;
  projectRevision: number;
  createdAt: string;
  /** the audio that was rendered — stored by reference, never re-generated */
  audio: { kind: "offline-render"; ref: string; durationSeconds: number; sampleRate: number };
  /** the structural diff the preview would apply */
  diff: StructuralDiff;
  /** measured outcomes — evidence, not adjectives */
  metrics: Metric[];
  /** things that could not be verified, stated plainly */
  unverified: string[];
  /** warnings that should reach the user before they approve */
  warnings: string[];
  /** the preview is valid only for this revision */
  expiresWithProjectRevision: number;
}
```

**Contract:** the preview's audio is rendered by the **same engine** as the live path (only the
event driver differs) — the repo's existing invariant. A preview rendered by a different engine is
not a preview.

### Transaction — one proposal, one undo unit

```ts
interface Transaction {
  contractVersion: "aaw.1.0";
  txId: string;
  planId: string;
  projectRevisionBefore: number;
  projectRevisionAfter: number;
  steps: AppliedStep[];
  undoUnitId: string; // ONE undo unit for the whole proposal
  checkpointRef?: string; // required for R3
  status: "applied" | "rolled-back" | "failed";
  failure?: TypedError;
}
```

### VerificationReport — what the system claims after the fact

```ts
interface VerificationReport {
  contractVersion: "aaw.1.0";
  txId: string;
  planId: string;
  checks: VerificationCheck[];
  verdict: "as-promised" | "deviation" | "failed";
  deviations: Deviation[];
  /** what the user should be told, in one sentence */
  summary: string;
}

interface VerificationCheck {
  kind:
    | "scope-respected"
    | "protected-content-unchanged"
    | "preview-equals-commit"
    | "postcondition"
    | "audible-metric"
    | "undo-unit-integrity";
  passed: boolean;
  /** hard evidence — a hash, a number, a diff. Never "looks good". */
  evidence: string;
  /** if this check could not be run, say so */
  skipped?: boolean;
  skipReason?: string;
}
```

**Rule:** a verification report with `verdict: "as-promised"` must contain at least one check whose
`evidence` is a **hash or a measurement**. "Looks right" is not evidence. If the checks cannot run,
the verdict is `failed`, not `as-promised`.

### Receipt — provenance, and the only thing a preference ledger may learn from

```ts
interface Receipt {
  contractVersion: "aaw.1.0";
  receiptId: string;
  txId: string;
  planId: string;
  briefId: string;
  provider: { id: string; version: string; artifactDigest: string; seed?: number };
  createdAt: string;
  /** what changed, structurally */
  diff: StructuralDiff;
  /** what was measured after the change */
  metrics: Metric[];
  /** human-readable reasons — NOT chain-of-thought */
  reasons: string[];
  /** what was not verified */
  unverified: string[];
  undoUnitId: string;
}
```

**The receipt is the entire legal and epistemic surface of an AI action.** It is local, inspectable,
deletable, and exportable. It contains **no hidden reasoning**, because the contract (§6.7) forbids
storing chain-of-thought — only concise, user-relevant reasons and evidence.

---

## 6. Error taxonomy — typed failure, not a string

```ts
type TypedError =
  | { kind: "provider-unavailable"; providerId: string; recoverable: true }
  | { kind: "provider-timeout"; providerId: string; limitMs: number }
  | { kind: "provider-invalid-output"; providerId: string; violations: string[] }
  | { kind: "contract-version-unsupported"; got: string; supported: string[] }
  | { kind: "unknown-capability"; capability: string; closest?: string[] }
  | { kind: "precondition-failed"; precondition: Precondition }
  | { kind: "scope-violation"; declared: Scope; actual: Scope }
  | { kind: "protected-content-modified"; objectId: string; before: string; after: string }
  | { kind: "stale-plan"; expectedRevision: number; actualRevision: number }
  | { kind: "preview-missing"; planId: string }
  | { kind: "preview-commit-mismatch"; planId: string }
  | { kind: "permission-denied"; riskClass: string; decision: "confirm" | "forbid" }
  | { kind: "budget-exceeded"; requested: number; limit: number }
  | { kind: "analysis-unavailable"; artifactId: string; reason: string }
  | { kind: "engine-fault"; subsystem: string; contained: true }
  | { kind: "abstained"; reason: string; missing: string[] };
```

Two properties matter:

1. **Every error is typed and carries a recovery path.** `recoverable: true` means the deterministic
   fallback can serve the user instead.
2. **`engine-fault` is always `contained: true`.** A DSP/plugin failure is never allowed to become a
   project-state failure. The engine is bypassed or the channel is silenced; the project stays valid.

---

## 7. Worked example A — KYX: "more tension before the chorus"

> User, with the chorus section selected: _"make it tenser before the chorus"_

### 7.1 The brief (normalized, user-editable)

```json
{
  "contractVersion": "aaw.1.0",
  "id": "brief-7f2",
  "createdAt": "2026-10-25T09:14:00Z",
  "projectRevision": 412,
  "utterance": "make it tenser before the chorus",
  "selectedScope": { "contextId": "scene:1", "roles": [] },
  "clauses": [
    {
      "id": "c1",
      "kind": "prefer",
      "claim": { "tension": { "op": "increase", "scope": "pre-chorus" } },
      "verbatim": "more tension before the chorus",
      "origin": { "source": "user", "at": "2026-10-25T09:14:00Z" },
      "confidence": 1.0
    },
    {
      "id": "c2",
      "kind": "required",
      "claim": { "region": { "role": "chorus", "notBefore": true } },
      "verbatim": "before the chorus",
      "origin": { "source": "project", "fact": "scene:1 has role chorus at bar 33" },
      "confidence": 1.0
    },
    {
      "id": "c3",
      "kind": "uncertain",
      "claim": { "dimension": ["density", "harmony", "dynamics", "orchestration"] },
      "verbatim": "tension",
      "origin": { "source": "model", "modelId": "lqm-planner", "version": "0.4.1" },
      "confidence": 0.42
    }
  ]
}
```

`c3` is the ambiguity the contract's golden scenario D demands be surfaced ("more space" ≠ one
thing). The plan below resolves it by **offering alternatives**, not by guessing.

### 7.2 The plan (alternatives, not a decision)

```json
{
  "contractVersion": "aaw.1.0",
  "planId": "plan-3c91",
  "createdAt": "2026-10-25T09:14:04Z",
  "projectRevision": 412,
  "briefId": "brief-7f2",
  "provider": { "id": "lqm-planner", "version": "0.4.1", "artifactDigest": "sha256:…", "seed": 7 },
  "scope": {
    "regions": [{ "contextId": "scene:1", "start": 21440, "end": 30720 }],
    "objectIds": ["clip:drums@scene1.2", "clip:keys@scene1.2"],
    "protectedObjectIds": ["clip:kick@scene1.2", "clip:808@scene1.2"],
    "excludes": [{ "contextId": "scene:1", "start": 30720, "end": 61440 }]
  },
  "result": {
    "outcome": "alternatives",
    "reason": "'Tension' maps to four distinct musical dimensions; the project evidence supports two.",
    "options": [
      {
        "id": "opt-a",
        "label": "More density (keep harmony)",
        "rationale": "The pre-chorus already has a harmonic build; adding rhythmic density raises tension without changing pitch content.",
        "tradeoff": "Busier low end — the 808 tail may mask.",
        "steps": [/* … 2 steps … */]
      },
      {
        "id": "opt-b",
        "label": "More dynamics (keep density)",
        "rationale": "The pre-chorus sits at a similar level to the verse; a filter+level arc creates lift into the chorus.",
        "tradeoff": "Requires automation, which some users dislike.",
        "steps": [/* … 3 steps … */]
      }
    ]
  },
  "diagnostics": [
    { "severity": "info", "text": "Pre-chorus loudness measured at -14.2 LUFS vs chorus -11.8 LUFS." },
    {
      "severity": "warn",
      "text": "Option A may increase masking against the 808 in bars 25–32 (estimated, not measured)."
    }
  ]
}
```

### 7.3 A step, in full

```json
{
  "capability": "arrangement.densityFrom",
  "capabilityVersion": "2.1.0",
  "args": {
    "clipId": "clip:drums@scene1.2",
    "fromBar": 25,
    "toBar": 32,
    "add": ["ghostNote:16th", "snareVar:2"],
    "respectSwing": true,
    "preserveVelocityCurve": true
  },
  "scope": {
    "regions": [{ "contextId": "scene:1", "start": 28800, "end": 30720 }],
    "objectIds": ["clip:drums@scene1.2"],
    "protectedObjectIds": ["clip:kick@scene1.2", "clip:808@scene1.2"]
  },
  "satisfies": ["c1", "c2"],
  "expectation": "The pre-chorus fills in with ghost notes and a snare variation while the kick and 808 stay exactly as they are.",
  "onFailure": "skip",
  "cost": { "renderSeconds": 6, "cpuSeconds": 1.2 }
}
```

### 7.4 The registry entry it must resolve to

```json
{
  "id": "arrangement.densityFrom",
  "version": "2.1.0",
  "title": "Increase rhythmic density in a clip range",
  "inputs": {
    "type": "object",
    "additionalProperties": false,
    "required": ["clipId", "fromBar", "toBar"],
    "properties": {
      "clipId": { "type": "string" },
      "fromBar": { "type": "integer" },
      "toBar": { "type": "integer" },
      "add": { "type": "array" },
      "respectSwing": { "type": "boolean" },
      "preserveVelocityCurve": { "type": "boolean" }
    }
  },
  "preconditions": [
    { "kind": "projectRevisionEquals", "revision": 412 },
    { "kind": "objectExists", "objectId": "clip:drums@scene1.2" },
    { "kind": "analysisFresh", "artifactId": "beatgrid:scene1", "maxAgeRevisions": 1 }
  ],
  "postconditions": [
    { "kind": "scopeRespected", "scope": { "contextId": "scene:1", "start": 28800, "end": 30720 } },
    {
      "kind": "protectedContentUnchanged",
      "hashes": { "clip:kick@scene1.2": "sha256:…", "clip:808@scene1.2": "sha256:…" }
    }
  ],
  "sideEffects": {
    "mutatesProject": true,
    "mutatesAudio": true,
    "destructive": false,
    "reversible": true,
    "affectsTransport": false,
    "affectsExport": false
  },
  "riskClass": "R2",
  "realtimeSafe": false,
  "undoUnit": true,
  "implementation": {
    "status": "NOT IMPLEMENTED — target state",
    "module": "src/commands/",
    "export": "arrangement.densityFrom"
  }
}
```

### 7.5 The flow that follows

1. **L7 decides** → R2 → **confirm**. No apply without the user's OK, and the OK is attached to
   _this_ preview.
2. **L6 renders** the preview offline → `PreviewArtifact` with the audio ref, the structural diff,
   measured metrics (LUFS delta, low-end masking estimate), and `unverified: ["perceived tension"]`
   — because **perceived tension is not measurable**, and saying so is the honest move.
3. **L8 applies** as one undo unit, after re-checking `projectRevision === 412`.
4. **L10 verifies**: scope respected; protected hashes unchanged; preview-equals-commit (same plan
   instance, not a regeneration); postconditions hold.
5. **L11 writes the receipt.** The receipt records that tension was _estimated_, not verified.

### 7.6 What the receipt says when a step is skipped

```json
{
  "kind": "abstained",
  "reason": "Optional ghost-note variant was not applied: no variant exists that fits the current swing grid without shifting the 808 tail.",
  "missing": ["snareVar:2"]
}
```

The proposal is still applied (one step succeeded), the receipt records the partial application, and
the user sees _which_ part did not happen. Silent partial application is the failure mode this
prevents.

---

## 8. Worked example B — ZYVO: "make the lead vocal more intimate"

> User selects the lead vocal region: _"make the lead more intimate"_

```json
{
  "contractVersion": "aaw.1.0",
  "planId": "plan-z41",
  "projectRevision": 88,
  "briefId": "brief-z09",
  "provider": { "id": "lqm-planner", "version": "0.4.1", "artifactDigest": "sha256:…" },
  "scope": {
    "regions": [{ "contextId": "take:lead.03", "start": 0, "end": 184320 }],
    "objectIds": ["vocal:lead.03"],
    "protectedObjectIds": ["vocal:lead.01", "vocal:lead.02"]
  },
  "result": {
    "outcome": "alternatives",
    "reason": "'Intimate' is usually distance + density of the low-mid, or distance + less reverb; both are valid and audible.",
    "options": [
      {
        "id": "opt-a",
        "label": "Closer, drier",
        "tradeoff": "Less air; the reverb tail becomes tighter.",
        "steps": [/* … */]
      },
      {
        "id": "opt-b",
        "label": "Closer, with the room kept",
        "tradeoff": "Needs a parallel room send instead of the shared one.",
        "steps": [/* … */]
      }
    ]
  },
  "diagnostics": [
    { "severity": "info", "text": "Lead take 3 has a measured 1.9 kHz presence peak and -18 dB mean low-mid energy." }
  ]
}
```

**The ZYVO-specific rule** (see `ZYVO_FRONTIER_CAPABILITIES.md`): _intimacy_ is a **mix** decision,
not a performance decision. A plan that changes the **performance** (singing style, phrasing, pitch)
must be a **separate, explicitly-labelled capability class** with a higher risk class and a
mandatory listening checkpoint — because the user's voice is the asset, and "improve my take" must
never silently become "change how I sang".

---

## 9. Model provider interface (pointer)

The full interface is specified in `AAW_AUDIO_MODEL_LANDSCAPE.md` §6. The contract-relevant parts:

```ts
interface ModelProvider {
  readonly id: string;
  readonly version: string; // pinned artifact digest
  readonly capabilities: readonly Capability[]; // "asr" | "tts" | "plan" | "rank" | "embed" | "critic"
  readonly languages: readonly string[];
  readonly maxInputSeconds: number; // 0 = unbounded
  readonly realtimeFactor: number | null; // MEASURED, else null ⇒ not admissible for gated features
  plan(brief: Brief, context: PlanContext): Promise<ActionPlan>;
}
```

**Provider conformance checklist** (a provider is admissible only if it passes all):

- [ ] Returns `ActionPlan` that validates against the plan schema, or fails **visibly**.
- [ ] Never returns prose in place of a plan; never returns a partial plan silently.
- [ ] Declares `languages` honestly — a Slovak request must not route to an English-only model.
- [ ] Declares `maxInputSeconds` — a provider that cannot bound its input is refused for long-audio
      features. _(This rule exists because the LFM2.5-Audio official path is measured to degenerate
      on audio beyond ~2 minutes; see `AAW_AUDIO_MODEL_LANDSCAPE.md` §1.6c.)_
- [ ] Reports a **measured** `realtimeFactor` on declared reference hardware.
- [ ] Ships its licence record and artefact digest with the adapter.
- [ ] Has a deterministic fallback for every plan shape it can emit, or is registered as
      "enhancement-only" (never the only route to a capability).
- [ ] Can be **removed** without breaking any user-facing capability (the product is complete
      without it).

---

## 10. Summary — the contract in one page

```
user words + selection
        │  → L1 BRIEF (required/preserve/prefer/avoid/target/evidence/uncertainty, user-editable)
        ▼
      L4 PLANNER → typed ActionPlan (plan | alternatives | abstain) with declared Scope
        │  → L5 REGISTRY lookup (capability + version + pre/postconditions + riskClass)
        ▼
      L7 PERMISSION (R0..R4 → auto | confirm | forbid) + staleness + budget
        │  → L6 PREVIEW (offline render, same engine, diff + metrics + unverified)
        ▼
      L8 COMMAND GATEWAY (one transaction, one undo unit, precondition re-check)
        ▼
      L9 ENGINES (no inference in the audio path, ever)
        ▼
      L10 VERIFIER (scope + protected hashes + preview==commit + postconditions) → gate
        ▼
      L11 RECEIPT (provenance, undo, opt-in preference ledger — never a training set)
```

**The single sentence that replaces every marketing sentence in this program:**
_the AI proposes, the registry disposes, the user approves, the gateway commits, the verifier
checks, and the receipt remembers._
