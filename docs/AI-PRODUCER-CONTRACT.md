# KYX AI Producer Contract

> **Status:** product contract / north star — acceptance criteria, not a claim that every capability ships today.  
> **Date:** 2026-10-01  
> **Related:** `docs/IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md`, `INTENT_ENGINE.md`, `docs/LOCAL-INTENT-MODEL.md`, `docs/ROADMAP-FULL-DAW.md`, ADR 0014.

## 1. Product definition

**KYX is a serious beatmaking and music-production DAW with an AI Producer built into the workflow.** A user can describe a musical goal in ordinary language, including an incomplete or imprecise description. KYX uses the request and the current project to propose musically useful, audible, editable next steps. The user remains the author and decides what becomes part of the project.

The ambition is to compete with established DAWs such as FL Studio on the quality and completeness of the beatmaking workflow, while making musical progress more accessible to people who do not yet know the technical vocabulary. The comparison is a product bar, not a claim of feature parity. AI does not excuse gaps in sequencing, instruments, sampling, arrangement, mixing, editing, recording, export, reliability or performance.

> **The AI Producer is not a prompt button that replaces the DAW. It is a context-aware musical collaborator that can understand, suggest, audition and carry out bounded work through the DAW.**

## 2. The promise to the creator

For any supported task, KYX must:

1. **Understand the goal in context.** Interpret the words together with the selected track/section, project tempo and key, existing musical material, current arrangement and any explicitly supplied audio reference.
2. **Separate instructions by strength.** Treat requirements and protected material as hard constraints; treat mood, energy and sonic character as preferences unless the creator says otherwise.
3. **Be honest about uncertainty.** Distinguish what the creator said, what the project proves, what KYX inferred and what remains unknown.
4. **Make useful music, not just valid data.** Candidates must satisfy musical and technical gates and be auditionable in the real project context.
5. **Keep the creator in control.** Show the intended scope, allow preview and comparison, and apply only an accepted proposal.
6. **Preserve a professional DAW workflow.** Every accepted result remains a normal, editable KYX project—not a black-box render that traps the creator.
7. **Work without the large model.** Projects must open, play, edit, save and export when the optional local language model is absent, disabled, downloading, unsupported or failing.

## 3. Who we serve

### The emerging beatmaker

They may not know BPM, chord names, swing, sidechain or arrangement terminology. They should still be able to say “make this feel more confident, but not happier” and get understandable, listenable directions—not be forced to learn a prompt syntax before making music.

### The vocalist or solo artist

They may have a voice memo, a recorded/imported vocal or only an idea. KYX should help them establish a complementary instrumental, find a workable tempo/key when evidence permits, shape sections around the vocal and export a usable result without requiring a studio, paid model account or years of production experience. It must never claim that a vocal was analyzed if it was not.

### The experienced producer

They want speed without surrendering taste. KYX should handle tedious interpretation and bounded variations, respect track/role locks, expose the exact changes, and stay out of the way when they prefer direct editing.

**One product, different depth:** beginner-friendly explanations and guided choices must coexist with direct controls, precise values, auditioning and reversible edits for experts.

### 3.1 Two focused DAWs, one producer philosophy

KYX and its sibling vocal-production DAW **ZYVO** should be complementary specialists, not two halves of one overloaded interface:

- **KYX owns beatmaking and instrumentals:** groove, drums, bass, harmony, melodic roles, sound selection, instrumental arrangement and beat-focused production.
- **ZYVO owns vocal-centered production:** recording and managing vocal takes, comping, vocal editing and the specialized vocal-production workflow defined by that product.
- **Both share the producer promise:** understand intent, respect protected material, propose bounded edits, audition results, preserve authorship and apply changes reversibly.

KYX may use a vocal the creator supplies as musical context—for example, to leave phrasing space or shape an instrumental around a hook—but it does not need to absorb ZYVO's entire vocal-recording and vocal-engineering surface to be an excellent beatmaking DAW. Each product should keep its own focused workflow and support claims.

### 3.2 Portable creative context across products

The creator's **Producer Brief** should be portable between Qvester products even when their projects and specialized workflows are different. This is a target interoperability contract, not a claim that cross-app handoff already ships.

A versioned, model-neutral handoff may carry the user's approved creative context: intent, tempo/key when known, section map, role labels, hard requirements, preserve/avoid instructions, provenance and explicit uncertainty. KYX could hand an instrumental plan or user-selected stems to ZYVO; ZYVO could hand back vocal-derived timing or arrangement needs for a KYX revision.

- Transfer only what the user selected; do not silently package full projects, raw vocals, lyrics or private media.
- Keep audio and project transfer explicit, inspectable and integrity-checked; descriptive metadata alone must not pretend to contain the audio.
- Preserve the distinction between measured facts, user instructions and model inference through the handoff.
- Keep the contract versioned and provider-neutral so neither product depends on LFM, a particular project schema or the other's UI internals.

The goal is portability of **creative intent and approved production context**, not a monolithic application or an opaque shared session that either DAW cannot edit independently.

## 4. The producer workflow

The canonical loop is:

```text
creator's words, gestures and project context
        ↓
interpreted brief: required / preserve / prefer / avoid / uncertain
        ↓
bounded plan and meaningfully different candidates
        ↓
hard gates + real-project audition + honest diagnostics
        ↓
creator chooses, refines, rejects or asks a follow-up
        ↓
exact auditioned proposal applied as normal undoable DAW edits
        ↓
continue from the updated musical context
```

### 4.1 Understand before acting

The interpreted brief must be able to represent, at minimum:

- **Required:** explicit constraints such as tempo, length, key, section, target role, “no vocals”, and required elements.
- **Preserve:** content or settings that must not change, such as “leave the kick and 808 alone”.
- **Prefer:** soft creative directions such as dark, spacious, punchy, restrained, more melodic or less busy.
- **Avoid:** explicitly unwanted outcomes, sounds, roles or changes.
- **Target:** the tracks, roles, patterns, clips, bars or song sections the operation may affect.
- **Evidence and origin:** whether a statement came from the user, project inspection, audio analysis or model inference.
- **Uncertainty:** alternatives or missing facts whose resolution could materially change the music.

The UI should summarize the interpretation in plain language and make important pieces editable. A user should be able to correct “preserve bass” or change the target section without rewriting the whole brief.

The existing `brief-contract`, normalized/versioned `IntentSpec`, plan, candidate gates and command system are the implementation foundation. The product contract does not require a new parallel prompt pipeline.

### 4.2 Ask only when the answer matters

KYX should not interrupt for every missing detail. If a safe, reversible proposal can cover the ambiguity, show contrasting interpretations. Ask one concise question when a wrong guess would affect a protected part, cause a materially different arrangement or waste a long generation/render.

For example, “more space” can mean fewer layers, more stereo width, more reverb or more space between phrases. KYX should expose the likely choices or ask which dimension the creator means; it must not silently equate all of them.

### 4.3 Propose, audition and refine

- Generate a small set of candidates that differ in an audible, explainable way—not three near-duplicates.
- Audition through the same project-aware audio path the creator will hear, including relevant tracks, routing and effects.
- Show which requested constraints each candidate satisfies, which are unverifiable and any repairs/fallbacks that occurred.
- Support follow-ups such as “take B, make the hook bigger, but keep the bass and drums”. Carry the session context forward and change only the requested scope.
- Make rejection cheap. “No, less busy” is useful feedback, not an error or a reason to discard the project context.

### 4.4 AI belongs inside the DAW, not only in a chat panel

Natural-language conversation is one entry point, not the whole product. AI Producer actions should be available in the context where the work happens:

- Selecting bars can ask for a fill, variation, transition, drop-out or vocal-space pass on only that range.
- Selecting a track/role can request a replacement or variation while explicitly preserving other roles.
- Selecting a section can ask for more contrast, a stronger hook or a less busy verse.
- Selecting an audio reference can inspect it and propose an instrumental direction, with the analyzed evidence and limits visible.

Each contextual action must show its target and proposed diff before apply. Quick actions may expose common tasks, but must not hide the full brief or remove direct DAW editing. The creator must be able to get the same controlled result from UI actions without knowing prompt tricks.

Longer local-model work must run outside the audio callback, leave playback and direct editing responsive, expose progress/cancel where practical and reject stale proposals if the project changed while it was running.

### 4.5 Optional, transparent Producer DNA

KYX may learn a local, user-controlled preference profile to make suggestions feel more like this producer. It must be opt-in, inspectable, editable, resettable and exportable. It should distinguish an explicit favorite, a deliberate A/B preference, an accepted-but-only-closest candidate and a rejection with a stated reason; merely applying or previewing something is not automatically a taste label.

Preference memory must be contextual (genre, role, task and project where relevant), must not silently train on raw project audio, vocals or lyrics, and must not transfer to ZYVO or another device without an explicit user action. Turning it off must leave the core DAW and deterministic Intent Engine fully usable.

### 4.6 Three separate kinds of producer memory

“Memory” is not one undifferentiated transcript or hidden profile. KYX must keep these scopes separate because they answer different questions and have different persistence and consent rules:

1. **Session context — what are we working on right now?** Recent prompts, candidate references (“the second one”), audition state and follow-up context may live in a bounded in-memory session. It is temporary and may be forgotten on reload; it must not silently become a durable training or taste signal.
2. **Project Producer Brief — what should this project sound like or preserve?** A project may store a small, versioned set of structured, allowlisted musical facts and explicit corrections, with source/confidence metadata. Saving and clearing it are deliberate, undoable project actions. It is project-local and may travel only with an explicitly saved/shared/exported project. It is not a raw prompt archive: raw prompts, conversation transcripts, chain-of-thought, audio, vocals and lyrics are not part of this brief.
3. **Producer DNA — what kinds of results does this creator tend to prefer?** This is a separate, optional local profile based on sufficiently clear user signals such as an explicit favorite or deliberate A/B choice. It is a soft preference, never a project instruction or hard constraint. Previewing, generating, or applying a candidate alone does not teach taste.

The active request has priority over remembered soft preferences. A saved project constraint that conflicts with a new request must be shown as a conflict and resolved explicitly; KYX must not silently choose. Producer DNA may rank only candidates that have already passed the active brief and safety gates. Each layer needs its own inspect/clear controls and tests proving that project switches, session resets and DNA opt-out do not leak or erase another layer.

## 5. Musical quality contract

Technical validity is necessary and is not the same as musical quality. KYX must not call a beat “professional”, “radio-ready” or “high quality” solely because it passes schema checks, a ranker score, loudness measurements or a synthetic test.

Candidate evaluation must distinguish at least:

- **Brief compliance:** required, protected and avoided elements.
- **Musical validity:** playable notes, coherent timing, phrase/section structure, role compatibility and absence of unintended silence or malformed content.
- **Style and intent fit:** groove, energy, density, sound choices and arrangement support the brief without reducing a genre to a keyword stereotype.
- **Audible quality:** balance, clipping, masking, dynamics and meaningful contrast, assessed with measurements where appropriate and listening where artistic judgment is required.
- **Candidate usefulness:** perceptible diversity and a clear reason to prefer one direction over another.

Audio metrics are evidence for specific properties, not a substitute for human judgment. Listening evaluations must be blind where feasible, include representative genres and skill levels, and compare against the deterministic baseline. A model trained on heuristic labels must not be described as having learned producer taste.

## 6. Control, safety and authorship

These are hard product requirements:

1. **No direct model writes to the project.** A model produces a typed proposal. Validation, musical gates and normal KYX commands own the mutation path.
2. **No hidden scope expansion.** An operation affects only its declared targets. Protected or unrelated content remains content-identical; tests should verify this with stable hashes where applicable.
3. **No silent destructive action.** Replacing, deleting, overwriting, flattening, freezing or exporting over user content requires an explicit, understandable action and appropriate confirmation.
4. **Preview is not commit.** Generating, ranking or auditioning candidates does not modify the saved project.
5. **Apply exactly what was auditioned.** The selected candidate must not be regenerated or changed between preview and apply. A stale proposal must be rejected or refreshed if its source project changed.
6. **One clear undo unit per accepted proposal.** Undo restores the prior project state; redo restores the accepted proposal. The user can continue with ordinary DAW editing afterward.
7. **Visible provenance.** Keep enough local metadata to identify the request, provider/model version, seed or reproducibility inputs, diagnostics and accepted proposal where appropriate. Do not store hidden chain-of-thought; provide concise, user-relevant reasons and evidence instead.
8. **No fabricated capability or evidence.** If KYX did not hear a clip, inspect a track, load a model or complete an operation, it must say so.
9. **Privacy by default.** Project data and audio stay local. Any future remote inference or upload requires a separate, explicit user action and a clear description of what will leave the device.
10. **Failure is contained.** Invalid model output, timeout, missing weights, unsupported hardware or worker/sidecar failure must not corrupt a project, block ordinary DAW use or enter an audio callback.

## 7. Platform contract: Web and downloadable Studio

### KYX Web

- Retains the deterministic, local-first Intent Engine as the complete always-available baseline.
- Does not require or silently download LFM2.5. Browser users can create, edit, save, play and export with the existing deterministic tools.
- Uses the same project semantics, brief concepts, command rules and proposal guarantees as KYX Studio wherever those capabilities are supported.
- Never labels deterministic behavior as LLM-powered.

### KYX Studio / downloadable version

- May expose an explicitly optional, locally running language-model provider, beginning with LFM2.5-1.2B-Instruct if its quality, performance and license gates pass.
- The model interprets and plans; it is not the audio renderer or a replacement for the deterministic music engine, AudioEngine or optional MRT2 performer.
- Model weights are a versioned, integrity-checked, user-controlled model pack. Show its size and runtime requirements before download. Support cancellation, retry, removal and a no-model fallback.
- Keep the provider boundary model-neutral. LFM is the first provider, not a permanent hard-coded assumption; later models must pass the same contract and evaluation suite.
- Do not make project playback, editing or export depend on the model being installed or on the original provider remaining available.

The model distribution decision also requires a license review for the actual KYX business and distribution model. A model being downloadable or technically runnable is not, by itself, permission to redistribute it.

## 8. Full-DAW quality bar

The AI Producer must make the DAW more capable, not hide an incomplete DAW behind a chat window. The product must keep investing in the complete beatmaking loop:

- fast pattern creation and variation;
- reliable step sequencing, piano-roll editing and MIDI workflows;
- usable instruments, kits, sample import/management and sound design;
- arrangement, sections, transitions and automation;
- mixer routing, sends, effects, metering and dependable playback;
- recording and editing workflows appropriate to the declared platform support;
- undo/redo, persistence, project portability and professional export;
- performance, accessibility, clear empty/error/loading states and recoverability.

The AI Producer may make these workflows easier to discover and operate, but must not be the only way to access them. Features in a roadmap are not shipping claims; support statements must match tested platform builds and documented capability matrices.

## 9. Acceptance gates

The contract is not satisfied by a demo prompt or a model loading successfully. Every release claiming AI Producer capability must maintain a versioned evaluation set and report separate results for interpretation, execution, music quality, reliability and usability.

### Required automated gates

- **Hard requirements and protected content:** 100% pass on the release golden set; any violation blocks apply.
- **Typed output:** every accepted provider response validates against a versioned schema; invalid responses reliably fall back or fail visibly without a project write.
- **Determinism:** deterministic provider runs with the same project, intent, seed and engine version yield the same content hash. A model-assisted proposal, once auditioned, is replayed/applied exactly rather than generated again.
- **Scope and preservation:** changes stay inside declared targets; protected and unrelated content remains unchanged in golden cases.
- **Project safety:** preview has no persisted side effects; apply/undo/redo round-trips; stale proposals cannot overwrite newer edits.
- **Fallback:** model absent, offline, timed out or rejected → ordinary deterministic creation and editing still work.
- **Audio path:** preview and export use the project's supported shared engine/rendering path; no generation or inference occurs in a realtime audio callback.
- **Model artifact:** pinned version, integrity hash, license record, memory/latency benchmark and reproducible evaluation report are present before enabling a model by default.

### Required human evaluation

- Blindly compare the AI-assisted workflow with the deterministic baseline using real creator prompts, not only synthetic prompts written from the parser vocabulary.
- Include Slovak and English, novice and experienced beatmakers, vocalist-led briefs, multiple genres, follow-up edits, preservation instructions and ambiguous requests.
- Ask listeners to rate brief fit, musical usefulness, candidate difference and willingness to continue editing—not simply whether they like one isolated sound.
- Record failures and rejected suggestions; do not train on a rejection/selection as “taste” unless the user gave a sufficiently clear preference signal.
- Publish the tested model, hardware, prompt set, sample size and known limitations with the result. Never collapse all dimensions into one opaque “AI quality” score.

Numerical quality thresholds for model accuracy, latency and listener preference must be set from a measured baseline and declared reference hardware before a model is activated. They must not be weakened merely to make a model pass.

## 10. Golden user scenarios

### A. New beatmaker, vague but useful intention

> “Sprav mi temný beat na pomalý rap, nech nepôsobí smutne.”

**Pass:** KYX interprets this as a creative direction rather than pretending the user specified exact BPM/key. It uses the current project context if one exists, offers a small number of distinct directions, explains any important assumption in plain language, and lets the user audition before applying. It does not require music theory vocabulary.

### B. Vocalist makes an instrumental

> “Mám túto vokálnu slohu. Sprav mi pod ňu 16-taktový beat a nechaj miesto pre hlas.”

**Pass:** KYX uses only audio the user actually supplied or recorded, reports measured tempo/key as estimates with confidence, proposes a complementary instrumental with explicit vocal space, and keeps the vocal untouched. The result is editable and exportable; the user is not required to own external hardware or a cloud-model subscription.

### C. Experienced producer protects core elements

> “V hooku ho sprav väčší a agresívnejší, ale kick, 808 a akordy nemen.”

**Pass:** the brief marks those elements as protected; candidate gates reject violations; candidates change only the declared hook scope; the creator can compare them; apply writes the exact auditioned choice in one undo unit. Tests prove the protected content did not change.

### D. Ambiguous mix direction

> “Daj tomu viac priestoru.”

**Pass:** KYX does not silently alter reverb, stereo width and arrangement density all at once. It asks a focused question or offers clearly labeled, reversible interpretations that can be auditioned.

### E. Model unavailable

**Pass:** KYX Studio reports that its optional model is unavailable and offers the deterministic workflow. Existing projects still open, play, edit and export. No project data is lost and no model download starts without consent.

## 11. Mapping to the current codebase

This contract extends the architecture already in the repository; it does not authorize a parallel DAW or mutation path:

| Responsibility                             | Current foundation                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Parse and route intent                     | `src/intent/text-parser.ts`, `arrangeWords.ts`, `route.ts`                                 |
| Normalize and validate intent              | `src/intent/types.ts`, `normalize.ts`, `schema.ts`, `brief-contract.ts`                    |
| Build reproducible plans and proposals     | `src/intent/plan.ts`, `pipeline.ts`, provider interfaces                                   |
| Generate, gate, repair and rank candidates | `src/ai/generator.ts`, `invariants.ts`, `src/intent/quality.ts`, candidate/ranking modules |
| Audition and compare                       | `src/intent/audition.ts`, `candidate-bank.ts`, relevant UI                                 |
| Apply with undo/redo                       | `src/commands/` and the project model                                                      |
| Separate session/project/taste memory      | `src/intent/session-context.ts`, `src/intent/project-brief.ts`, `src/project-model/producer-brief.ts`, `src/commands/producerBriefCommands.ts`, `src/intent/preference-ledger.ts` |
| Render and evaluate audio                  | `src/audio-engine/`, `src/rendering/`, `src/intent/audio-feedback.ts`                      |
| Optional generative performer              | `src/generative/` and MRT2 provider adapters                                               |
| Local model safety and portability         | `src/ai/` workers/clients, `src/intent/providers/`, desktop model/runtime boundary         |

The current deterministic parser, symbolic generators, rankers and LFM must remain distinguishable providers/capabilities. A small ONNX candidate ranker is not the LFM language model; a language model is not an audio generator; an MRT2 adapter is not proof that a platform can run MRT2 in real time.

## 12. Change control

This document owns the **product behavior and acceptance contract**. `docs/IMPLEMENTATION-ROADMAP-AI-FIRST-PRODUCER.md` owns implementation phases and file-level sequencing. `INTENT_ENGINE.md` owns the detailed intent-system map; `docs/CURRENT-STATE.md` remains the source of truth for shipped counts and status. When implementation or tests contradict this contract, update the implementation or explicitly revise the contract—do not quietly redefine a passing test as product quality.
