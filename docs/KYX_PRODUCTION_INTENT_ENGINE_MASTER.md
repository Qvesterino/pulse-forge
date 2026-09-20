# KYX Production Intent Engine — Master Architecture & Product Vision

**Status:** Living design document  
**Scope:** KYX / browser-first + downloadable build  
**Purpose:** Unify the current Intent Engine, proposed semantic production control, local ONNX intelligence, audio understanding, plugin control, reference-aware sound shaping, and long-term agent architecture into one coherent system.

---

## 1. Product Thesis

KYX should not become “a DAW with a chatbot.” The stronger direction is a **production environment that understands user intent and translates it into safe, structured musical and sonic decisions**.

The core idea:

```text
Human language
    ↓
Semantic intent
    ↓
Project + audio context
    ↓
Validated production proposal
    ↓
KYX command system
    ↓
Native instruments / effects / arrangement
```

The model is not the audio engineer. **KYX is the audio engineer.** Models interpret language, classify sound, rank options, or propose actions. KYX owns the actual production semantics, safety rules, parameter mappings, undo, validation, preview and commit.

This architecture preserves long-term control. Models can be replaced without rebuilding the DAW.

---

## 2. What Already Exists in KYX

The current Intent Engine already provides a strong foundation:

- `IntentInput → IntentSpec → GenerationPlan → GenerationProvider → GenerationResult`
- deterministic generation and seeded sub-streams
- hard musical invariants
- deterministic repair and fallback
- candidate generation and quality scoring
- an ONNX ranker
- provenance and content hashes
- command-based project mutation
- undo/redo
- project-wide serializable state
- native instruments, effects and mixer state inside one application

The critical existing architectural rule should remain unchanged:

> Models generate proposals. They never mutate the project directly.

The new Production Intent system should extend this principle beyond composition into mixing, sound design and arrangement.

---

## 3. Target System

The long-term KYX intelligence stack should understand three things:

1. **What the user wants.**
2. **What the project currently sounds like and contains.**
3. **Which safe KYX operations can move the project toward the requested result.**

```text
                         USER
                          │
                          ▼
                Natural-language input
                          │
              ┌───────────┴────────────┐
              ▼                        ▼
      Deterministic parser      Text semantic encoder
              │                        │
              └───────────┬────────────┘
                          ▼
                 Semantic Intent Graph
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
       Project state   Audio metrics   Audio embedding
             │            │            │
             └────────────┼────────────┘
                          ▼
                 Production Planner
                          │
                          ▼
                 Action Proposals
                          │
                          ▼
        Validation / constraints / invariants
                          │
                          ▼
                    Preview Diff
                          │
                    User Commit
                          │
                          ▼
                  KYX Commands
                          │
                          ▼
                  ProjectDocument
```

---

## 4. Three Classes of Intent

### 4.1 Exact Intents

These should be handled deterministically whenever possible. A language model is unnecessary for commands with explicit values.

Examples:

```text
“Set tempo to 142”
“Change the key to D minor”
“Mute the bass”
“Pan the hats 20% right”
“Lower drums by 2 dB”
“Transpose the lead up one octave”
```

Target operations include tempo, key, gain, pan, mute, solo, transpose, preset selection, pattern length and explicit parameter changes.

The parser should prefer exact extraction first, because it is cheap, predictable and testable.

### 4.2 Musical Intents

These affect composition and arrangement.

Examples:

```text
“Make the drums busier”
“Simplify the melody”
“Add a fill before the drop”
“Make the chorus more energetic”
“Create a variation of this pattern”
“Build into the next section”
```

These should reuse the existing Intent Engine, generative pipeline, arrangement tools and musical invariants.

### 4.3 Production Intents

These describe sonic goals rather than exact parameters.

Examples:

```text
“Make the bass punchier”
“Make the mix darker”
“Push the pads further back”
“Make the synth wider”
“Reduce harshness”
“Give the drums more glue”
“Make the vocal more present”
```

These require a semantic production layer that translates a human concept into safe DSP actions.

---

## 5. Semantic Production Vocabulary

KYX should maintain a controlled semantic vocabulary instead of exposing hundreds of low-level parameters directly to a model.

Suggested initial vocabulary:

- punch
- warmth
- brightness
- darkness
- width
- depth
- presence
- clarity
- weight
- air
- density
- aggression
- smoothness
- tightness
- space
- movement
- grit
- cleanliness
- glue
- softness
- impact
- openness

Each semantic concept should be defined as a **goal**, not as one fixed preset.

Example:

```text
PUNCH
possible mechanisms:
- transient enhancement
- envelope shaping
- compressor attack/release adjustment
- saturation
- sustain reduction
- low-mid cleanup

WIDTH
possible mechanisms:
- stereo width
- chorus/doubler
- M/S processing
- reverb early reflections
- selective side enhancement
```

The planner chooses among mechanisms based on track role, current state, available processors and project context.

---

## 6. Semantic Intent Contract

A production request should compile into a structured contract.

Example:

```json
{
  "version": 1,
  "targets": ["bass"],
  "goals": [
    {
      "type": "punch",
      "amount": 0.72
    },
    {
      "type": "darkness",
      "amount": 0.35
    }
  ],
  "preserve": ["sub_energy"],
  "scope": "selected_track",
  "confidence": 0.91
}
```

The language layer should not emit raw DSP values unless the user explicitly asks for them.

---

## 7. Text Understanding Layer

The current deterministic parser remains valuable for explicit commands. For fuzzy semantic language, add a local text embedding model.

### Proposed role

```text
“harder bass”
“more punchy low end”
“make the bass hit stronger”
```

should land near the same semantic concept.

A multilingual sentence encoder can embed user text, then KYX can compare it against embeddings for supported semantic intents.

### Candidate class

A small MiniLM-style multilingual sentence encoder exported to ONNX is a good fit because:

- it is far smaller than a generative LLM
- inference is fast
- embeddings are deterministic
- multilingual support can cover English and Slovak
- the output can be validated against a controlled ontology

The model does not need to know KYX parameters. It only needs to map language toward supported semantic concepts.

---

## 8. Audio Understanding Layer

Text understanding alone is insufficient for production decisions. KYX should also understand what the current track sounds like.

### 8.1 Deterministic DSP Features

These are cheap, interpretable and should remain first-class:

- peak
- RMS
- LUFS
- true peak
- crest factor
- dynamic range
- spectral centroid
- spectral slope
- low / low-mid / mid / high-mid / high energy
- transient density
- transient-to-sustain ratio
- stereo width
- correlation
- phase indicators
- spectral masking indicators

These features answer measurable questions such as “is the signal already compressed?” or “is upper-mid energy excessive?”

### 8.2 Audio Semantic Embeddings

A CLAP-style audio/text model can add semantic context.

Potential use:

```text
current audio embedding
       ↕
text embedding: “punchy bass”
```

or:

```text
current mix embedding
       ↕
reference-track embedding
```

The embedding model should not directly set parameters. It provides evidence to the planner or ranker.

---

## 9. Multi-Model Architecture

The system should use specialized small models rather than one giant model.

```text
TEXT MODEL
What does the user mean?

AUDIO MODEL
What does the sound resemble?

DECISION / RANKER MODEL
Which valid production proposal best fits the goal?

DETERMINISTIC DSP LAYER
How does KYX safely execute the proposal?
```

### Suggested responsibilities

**Text encoder**
- semantic intent matching
- paraphrase handling
- multilingual interpretation

**Audio encoder**
- semantic audio similarity
- reference matching
- timbral context

**Small decision model / ranker**
- rank candidate actions
- combine intent, DSP features and project role
- choose among safe pre-defined production plans

**Existing deterministic systems**
- parsing exact values
- invariants
- clamps
- project commands
- undo
- preview
- fallback

---

## 10. Browser and Downloadable Runtime Strategy

KYX is browser-first and now also downloadable. The intelligence stack should preserve browser compatibility instead of requiring a heavyweight external local LLM.

### Browser-first runtime

```text
ONNX Runtime Web
├─ WASM for lightweight models
└─ WebGPU for heavier encoders where available
```

Models should be lazy-loaded.

Suggested runtime policy:

```text
Built-in parser / current ranker
→ always available

Text semantic encoder
→ lazy-load on first fuzzy language request

Audio semantic encoder
→ lazy-load only when semantic audio analysis or reference matching is requested
```

If WebGPU is unavailable, KYX should degrade gracefully rather than disabling the Intent Engine entirely.

---

## 11. Plugin / Effect Control Layer

One of KYX’s strongest structural advantages is that its processors are native and share one application state instead of existing as arbitrary third-party VST black boxes.

The production layer should operate through semantic parameter metadata.

Example:

```text
parameter: transientAmount
semantic roles:
- punch
- attack
- impact

audio domain:
- dynamics
- transient
```

The planner should ask for semantic actions such as:

```text
increasePunch(track=bass, amount=0.4)
reduceHarshness(track=lead, amount=0.3)
moveBackward(track=pads, amount=0.6)
```

A deterministic mapper converts those operations into actual KYX effect parameters.

---

## 12. Relationship-Aware Production

The system becomes substantially more powerful when it reasons across tracks rather than processing them independently.

Example relationship graph:

```text
VOCAL
priority: front
center ownership: high
yield sources: synth, guitars

KICK
transient priority: high

BASS
sub ownership: high
yield to kick: transient only

PADS
depth: rear
width: wide
yield to vocal: spectral
```

This can drive:

- level relationships
- spectral unmasking
- transient priority
- low-end ownership
- stereo overlap control
- depth
- FX send balance
- section-aware automation

The important shift is from **processing tracks** to **managing relationships between tracks**.

---

## 13. Section-Aware Intent

Production intent should be able to vary across song sections.

Example:

```text
VERSE
vocal = front
pads = rear
bass = narrow

CHORUS
width ↑
drum impact ↑
harmonic density ↑
reverb size ↑

BREAKDOWN
pads ↑
drums ↓
space ↑
```

A request such as:

> “Make the chorus feel bigger than the verse.”

should compile into multiple coordinated proposals rather than one plugin parameter change.

This is where composition, arrangement, mixing and sound design converge.

---

## 14. Reference-Based Sound Intent

Requests such as “make this sound more like artist X” are too ambiguous to map directly and should not become hard-coded artist presets.

A stronger workflow is:

```text
Reference audio
    ↓
DSP metrics + audio embedding
    ↓
Target sonic profile
    ↓
Difference from current section / mix
    ↓
Safe production proposals
```

The user can still describe a direction verbally, but when precision matters, reference audio is a better source of sonic evidence.

The system should target measurable/semantic properties, not identity imitation.

Examples of target properties:

- brightness
- density
- transient profile
- stereo width
- dynamic range
- low-end balance
- ambience
- texture
- spectral balance

---

## 15. Candidate Proposal and Ranking Loop

A semantic goal should not deterministically map to one rigid preset. The planner can generate multiple safe candidate plans.

Example:

```text
Goal: “Make bass punchier”

Candidate A
- transient +12%
- mild saturation

Candidate B
- slower compressor attack
- sustain trim

Candidate C
- low-mid cleanup
- transient +7%
```

Each proposal can be evaluated using:

- semantic target fit
- current audio metrics
- preservation constraints
- clipping/headroom risk
- role/context fit
- optional audio embedding similarity

A small ONNX ranker can choose among candidates, following the same philosophy as the existing pattern ranker.

---

## 16. Preview → Commit Contract

Every intelligent operation should follow one path:

```text
User request
   ↓
Intent interpretation
   ↓
Proposal generation
   ↓
Validation
   ↓
Preview / diff
   ↓
Commit
   ↓
ONE undoable command group
```

Never:

```text
model → direct AudioNode mutation
```

Never regenerate a different proposal at commit time.

Preview and Apply must refer to the same proposal and provenance.

---

## 17. Safety and Control Invariants

The following rules should be permanent:

1. Models never mutate `ProjectDocument` directly.
2. Models never access raw AudioNodes as an authority layer.
3. Every change is schema-validated.
4. Every parameter is range-checked and clamped where appropriate.
5. Project invariants override model output.
6. Heavy inference never runs in the audio callback.
7. Missing or failed models fall back deterministically.
8. Every committed intelligent change is undoable.
9. Preview and commit use the same proposal.
10. Model/model-version participation is recorded in provenance.
11. Exact commands prefer deterministic parsing over neural inference.
12. Unsupported fuzzy requests should fail clearly rather than invent arbitrary actions.

---

## 18. Example End-to-End Flows

### 18.1 Exact control

User:

> “Set tempo to 138 BPM and key to D minor.”

```text
exact parser
→ setTempo(138)
→ setKey(D minor)
→ preview
→ commit
```

### 18.2 Production intent

User:

> “Make the bass punchier and darker.”

```text
text semantic layer
→ target=bass
→ punch=0.8
→ darkness=0.6

current bass analysis
→ low crest factor
→ strong sub energy
→ elevated upper-mid energy

planner
→ preserve sub
→ increase transient emphasis
→ mild harmonic drive
→ reduce upper mids slightly

validation
→ headroom check
→ parameter bounds

preview
→ commit
```

### 18.3 Multi-target request

User:

> “Make the drums punchier, bass warmer and synth wider.”

```text
[drums → punch]
[bass → warmth]
[synth → width]
        ↓
three semantic plans
        ↓
relationship conflict check
        ↓
preview as one grouped change
```

### 18.4 Arrangement + production

User:

> “Make the chorus bigger than the verse.”

Possible plan:

```text
chorus drum energy ↑
chorus lead presence ↑
chorus width ↑
chorus reverb / ambience ↑
chorus harmonic density ↑
retain verse contrast
```

This is not one effect change. It is a coordinated production operation.

---

## 19. Suggested Data Contracts

### ProductionIntent

```ts
interface ProductionIntent {
  version: 1;
  targets: IntentTarget[];
  goals: ProductionGoal[];
  preserve?: PreserveConstraint[];
  section?: SectionSelector;
  confidence: number;
  sourceText: string;
}
```

### ProductionGoal

```ts
interface ProductionGoal {
  type:
    | "punch"
    | "warmth"
    | "brightness"
    | "darkness"
    | "width"
    | "depth"
    | "presence"
    | "clarity"
    | "weight"
    | "air"
    | "density"
    | "aggression"
    | "smoothness"
    | "tightness"
    | "space"
    | "movement"
    | "grit"
    | "glue";
  amount: number;
}
```

### ProductionProposal

```ts
interface ProductionProposal {
  id: string;
  intentHash: string;
  actions: ProductionAction[];
  expectedEffects: ExpectedEffect[];
  constraintsChecked: string[];
  provenance: ProposalProvenance;
}
```

### ProductionAction

Prefer semantic actions over arbitrary parameter mutation:

```ts
type ProductionAction =
  | { type: "increase-punch"; trackId: string; amount: number }
  | { type: "set-depth"; trackId: string; amount: number }
  | { type: "reduce-harshness"; trackId: string; amount: number }
  | { type: "increase-width"; trackId: string; amount: number }
  | { type: "set-tempo"; bpm: number }
  | { type: "set-key"; key: MusicalKey };
```

Low-level effect commands should be produced only after semantic planning.

---

## 20. Model Lifecycle

Models should behave like optional processing capabilities, not permanent application dependencies.

```text
App boot
→ no large semantic models loaded

First fuzzy text request
→ lazy-load text encoder

First audio-semantic request
→ lazy-load audio encoder

Idle / memory pressure
→ release model/session if practical
```

The application should expose current intelligence capability:

```text
Basic intent     ✓
Semantic text    ✓
Audio semantics  ✓ / unavailable
Reference match  ✓ / unavailable
```

This is better than pretending all devices have identical AI capability.

---

## 21. Recommended Implementation Phases

### Phase 0 — Stabilize current Intent Engine

- canonical async generation path
- preview == apply
- real ONNX ranker participation
- duplicate generation removal
- race protection
- provenance correctness

### Phase 1 — Production Intent Contract

- define `ProductionIntent`
- exact intent parser
- semantic vocabulary v1
- target resolver
- proposal/preview/commit infrastructure

### Phase 2 — Deterministic Semantic DSP Planner

Support a small, reliable vocabulary first:

```text
punch
warmth
brightness/darkness
width
depth
presence
clarity
aggression
smoothness
```

Map these to existing KYX processors using explicit rules and parameter metadata.

### Phase 3 — Multilingual Text Embeddings

- small ONNX sentence encoder
- SK + EN semantic matching
- fuzzy paraphrase recognition
- confidence thresholds
- deterministic fallback

### Phase 4 — Audio Feature Context

- standardized track analysis vector
- masking/context features
- role-aware decision rules
- relationship graph

### Phase 5 — Audio Semantic Encoder

- CLAP-style embedding
- reference similarity
- semantic audio descriptors
- lazy WebGPU/WASM inference

### Phase 6 — Decision Ranker

- candidate production plans
- feature vector from intent + audio + role + project state
- small ONNX ranking model
- user preference data later

### Phase 7 — Section-Aware / Relationship-Aware Production

- section contrast
- cross-track priority
- mix ownership
- dynamic unmasking
- coordinated automation

---

## 22. What Not to Do

Do not turn the first version into a universal autonomous mix engineer.

Avoid:

- hundreds of fuzzy intents at once
- direct model-to-parameter control
- one giant LLM dependency
- model inference in the audio thread
- invisible irreversible edits
- hard-coded artist presets
- semantic features without confidence thresholds
- retraining a huge model before deterministic mappings work
- coupling the project architecture to one specific ONNX model

A narrow system that reliably understands 30–50 production intents is more valuable than a system that claims 500 and behaves unpredictably.

---

## 23. Long-Term Product Position

The strongest formulation is not:

> “KYX has AI features.”

It is:

> **KYX is an intent-controlled production environment.**

The user describes musical or sonic goals. KYX translates them into structured decisions over composition, arrangement, instruments, mixing and effects while preserving editability, determinism, undo and user control.

The long-term differentiator is not any single model.

It is the combination of:

```text
Semantic Production Layer
+
Native Audio Graph
+
Project Context
+
Small Specialized Models
+
Strict Command Contracts
+
Preview / Undo / Provenance
```

That architecture can survive model churn and expand over years.

---

## 24. North-Star Example

A user should eventually be able to type:

> “Set this to 138 BPM, move it to D minor, make the drums hit harder, warm up the bass, simplify the lead, push the pads further back, and make the chorus feel bigger than the verse.”

KYX should decompose this into exact, musical and production intents, inspect the actual project, generate a coherent proposal, show the intended changes, and apply them as native editable project operations.

That is the north star.

---

## 25. Architecture Principle to Preserve

> **Language proposes intent. KYX owns execution.**

This principle should remain true regardless of whether future intelligence comes from deterministic parsers, ONNX encoders, small neural rankers, local LLMs, external models, or technologies that do not yet exist.
