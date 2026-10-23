# Cross-Component Contracts Audit — KYX / Pulse Forge

**Date:** 2026-10-23
**Scope:** the contracts _between_ the major subsystems of the DAW — not the behaviour inside any one of them.
**Tree:** `main` at the start of the wave, shared with several concurrent agent sessions.

---

## 0. What this wave is, and what it is not

The previous wave audited the **editor** — what a gesture does to a document. This wave
audits the **seams**: the agreements two subsystems make with each other, where a rule
is written down twice and the two copies can drift apart.

Seven boundaries were examined:

| #   | Boundary                     | The question it answers                                                |
| --- | ---------------------------- | ---------------------------------------------------------------------- |
| 1   | UI ↔ project state           | Does what the user sees and touches agree with what the document says? |
| 2   | project state ↔ audio engine | Does the engine play what the document describes?                      |
| 3   | audio engine ↔ plugin host   | Does a plugin receive the parameters the model declared?               |
| 4   | track ↔ mixer                | Does the mixer sum and route what the tracks say?                      |
| 5   | timeline ↔ transport         | Does musical time mean the same thing on both sides?                   |
| 6   | persistence ↔ runtime model  | Does a reloaded project mean the same thing as the one that was saved? |
| 7   | worker ↔ main thread         | Does a worker answer the question the main thread asked?               |

For each boundary the audit records, per contract: **inputs, outputs, ownership,
lifecycle, nullability, ordering assumptions, error semantics** — and then asks the
question the wave is really about: _do the two sides agree?_

The hunt is for two shapes of problem:

- **Contract drift** — one rule, two computations, and they disagree on some reachable path.
- **Duplicated definitions** — the same rule written in two modules. Drift is then a
  matter of time, not of luck.

### Method

1. **Map first.** The contracts on each boundary were inventoried, with both sides
   named by `file:line`.
2. **Hunt for duplication.** Every rule that appeared twice was compared field by field,
   value by value — units, defaults, clamps, rounding, order of operations.
3. **Check the guards.** The repository already guards a number of these contracts
   (`docs/AGENT-MAP.md` §3, the invariant register). Those were read and their guard
   specs executed, so that "already protected" is a measurement, not an assumption.
4. **Reproduce, then fix.** Every confirmed defect got a failing test first, a minimal
   fix, a regression suite, and a **revert check** — the fix was undone to prove the new
   test actually fails without it.
5. **Stop when the area is healthy.** A boundary with no confirmed defect is reported as
   verified, with the contracts that were checked named. No work was manufactured.

### Rules this wave worked under

- Intended product behaviour is preserved; a change is only made where a defect is
  demonstrated, and then as small, local and reversible a change as possible.
- No test, type, validation, error handling or assertion was weakened to make a check
  pass.
- No unrelated features, no broad rewrites.
- After every meaningful change, the relevant suites were re-run.

---

## 1. Findings

### 1.1 The boundary map

| Boundary                     | Contracts mapped                                                                                                                                              | Verdict                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| UI ↔ project state           | command dispatch + undo pairing, render-scope memo freshness, doc-delta round-trip, project-name/ID identity, whole-document pinning                          | **1 confirmed defect** (the group-solo state write, §1.2 C1) — the rest verified healthy                                            |
| project state ↔ audio engine | clip window (source ↔ wall), effective BPM, engine→document projection, master vs track chain broadcast, offline/live parity                                  | **2 confirmed defects** (C6 master chain; C3/C4 manifest-driven model selection) — the clip-window contract verified healthy        |
| audio engine ↔ plugin host   | effect registry ↔ worklet loader ↔ processor, parameter ids/ranges/defaults, worklet message protocol, buffer/channel conventions, vendor-core reconciliation | **no confirmed defect on the live path**; 3 latent inconsistencies reported (§2.2)                                                  |
| track ↔ mixer                | gain unit, mute/solo/membership, bus routing, PDC latency, meter tap point, pre-fader taps                                                                    | **1 confirmed defect** (C1 — the audibility rule was implemented twice) — the rest verified healthy                                 |
| timeline ↔ transport         | bar↔tick↔second, the audio clock, the tempo owner, loop range, export tempo                                                                                   | **3 confirmed defects** (C7 scorepack tempo, C8 loop range, C9 scene tempo) — the audio-clock contract verified healthy             |
| persistence ↔ runtime model  | schema version + migration, manifest artifacts, import caps, share-code round-trip, drift gate                                                                | **2 confirmed defects** (C3, C4 — the shipped model manifests) — migration and caps verified healthy                                |
| worker ↔ main thread         | request/response shape, request id, timeout, cancellation, error propagation, payload validation, worker lifetime                                             | **2 confirmed defects** (C2 dropped worker error, C5 inverted success test) — the request-id and timeout contracts verified healthy |

### 1.2 Confirmed defects

Each of these was reproduced with a failing test before the fix and re-proved by
reverting the fix (see §4.3).

---

#### C1 — The group owns the group's solo; a member's own state was rewritten and never released

**Boundary:** track ↔ mixer (and UI ↔ project state)
**The two sides:** `src/commands/tracks.ts` (`addToGroup`) · `src/audio-engine/AudioEngine.ts` (`soloAudibility`) · `src/project-model/groove.ts` (`drumHitsInWindow`)

**The drift.** The audibility rule — _is this track audible?_ — was implemented **twice**:

- the engine's copy (`soloAudibility`) understood groups: a member is audible when it or
  its group is soloed, and silent when its group is muted;
- the drum scheduler's copy (`groove.ts`) did not: it read `anyTrackSolo && !track.solo`
  and dropped the track's hits.

The two copies disagreed for every group member, and the gap was bridged by a **state
write**: `addToGroup` wrote `solo: true` onto any member that joined a **soloed** group
("inherit the solo"), so the scheduler's copy would keep its hits.

**The consequence.** The write was never released. `setGroupSolo(group, false)` clears
only the group's own flag, and `removeFromGroup` clears only `groupId` — so the member
kept `solo: true` for good. A soloed track mutes every unsoloed track in the project
(`anySolo`), so:

> join a soloed group → un-solo the group → **the whole project goes silent**, and the
> member's S button stays lit. There was no way back but editing the document by hand.

The comment above the write named the wrong module (`the scheduler gates pattern content
on the track's OWN solo`): `src/scheduler/Scheduler.ts` contains no occurrence of
`solo` at all — the gate lives in `project-model/groove.ts`, one layer down. The premise
of the write was about the scheduler, but the gate was in the model.

**Reachability.** `addToGroup` is a first-class command: the mixer's group routing, the
MCP `kyx_routing` tool and the intent layer all call it. `setGroupSolo` is the group's
S button.

**Fixed by** giving the rule one owner in the model layer and deleting the state write —
§3.1.

---

#### C2 — The worker reported its own failure; the client threw the message away

**Boundary:** worker ↔ main thread
**The two sides:** `src/reference/workers/reference.worker.ts` (posts `REFERENCE_ERROR` /
`TRANSCRIBE_ERROR`) · `src/reference/reference-client.ts` (listened only for `*_RESULT`)

**The drift.** The worker catches its own exceptions and posts the reason
(`reference.worker.ts:106`, `:76`). The client's message handler accepted
`REFERENCE_RESULT` and `TRANSCRIBE_RESULT` only — an error message was **silently
dropped**.

**The consequence.** The promise stayed pending until the 120 s worker timeout fired,
and only then did the client run the deterministic synchronous fallback — two minutes of
nothing, followed by a main-thread freeze on a long buffer. A failure the worker had
already explained cost the user two minutes and a frozen UI.

**Fixed by** settling the promise on the error message, exactly as the `error` event
already did — §3.2.

---

#### C3 — The shipped drums v3 manifest had no route to its validator

**Boundary:** persistence ↔ runtime model (and worker ↔ main thread)
**The two sides:** `public/models/symbolic-prior-v3.manifest.json` (`kind: "drums-v3"`,
60 features) · `src/ai/symbolic/prior-client.ts` (`loadManifest`'s kind→validator dispatch)

**The drift.** The dispatch mapped `drums`, `drums-v2`, `melodic-v2`, `melodic-v3` — and
everything else fell through to the **melodic** branch. The kind `drums-v3` had **no
arm of its own**, so the shipped drums v3 manifest was validated as a melodic manifest,
failed the melodic guard (its `kind` is `drums-v3`) and was rejected. `loadManifest`
returned `null`, and the caller degraded silently.

**The consequence.** The 60-feature drums v3 prior — the one the provider prefers —
**never loaded**. The generation source silently fell back to drums v2, and the manifest
was re-fetched on every call (a `null` is not cached).

**Fixed by** giving the routing one owner with an arm per kind — §3.3.

---

#### C4 — The shipped melodic v1 manifest was rejected by the runtime's own guard

**Boundary:** persistence ↔ runtime model
**The two sides:** `public/models/symbolic-melodic-v1.manifest.json` (no `kind` field) ·
`src/ai/symbolic/prior-types.ts` (`isMelodicPriorManifest`, which **requires**
`kind === "melodic"`)

**The drift.** The trainer only started writing `kind` with v2
(`scripts/train-symbolic-melodic.py:607` — _"v2 carries its kind explicitly so the
runtime guard can route it"_). The v1 artifacts therefore have no `kind` — the **drums**
v1 manifest has the same shape, and the drums side got a legacy shim
(`coerceDrumsManifest`: _"accept it absent, but reject a manifest that names a DIFFERENT
kind explicitly"_). **The melodic side never got one.** Every other field of the shipped
manifest validates; only the absent `kind` failed.

**The consequence.** `loadManifest("melodic")` returned `null` and the melodic prior
**never ran**. The provider (`src/intent/providers/symbolic.ts:181-185`) uses the v1
model exactly when there is **no semantic conditioning** — i.e. when the embedding model
is unavailable or the conditioning path is off. So the model that was supposed to cover
the degraded case was the one that could not load, and the generation fell back to the
template melody with no error and no log.

**Fixed by** mirroring the drums shim — §3.3.

---

#### C5 — A successful worker response was read as a failure

**Boundary:** worker ↔ main thread
**The two sides:** `src/ai/symbolic/prior-client.ts:530`

**The drift.** The response check read

```ts
if (!response.ok === false || response.type !== "run" || !response.outputs) {
```

`!response.ok === false` parses as `(!response.ok) === false`, which is **true exactly
when the response succeeded** — so the success path took the failure branch.

**The consequence.** Every run of that lane degraded to the fallback. The worker was
never wrong; the client could not read its own answer.

**Fixed by** writing the condition the way it is meant to read — §3.3.

---

#### C6 — The master chain was not part of the tempo / transport broadcast

**Boundary:** project state ↔ audio engine
**The two sides:** `src/audio-engine/AudioEngine.ts` (`pushSyncBpm`, `transportStarted`)

**The drift.** Both broadcasts swept the **track**, **group** and **return** chains —
the **master** chain (`this.masterFx`) was not in either list. The master chain is a
chain like any other; a comment in `transportStarted` even says so ("Groups and returns
carry tempo-synced / phase-locked FX too… skipping them left bus effects out of phase").

**The consequence.** A tempo-synced effect on the **master** bus (a SYNC delay) kept the
BPM it was built with after a project or scene tempo change — its echoes landed
off-grid. A phase-locked effect on the master bus started out of phase with the
transport for the whole play.

**Fixed by** adding the master chain to both broadcasts — §3.4.

---

#### C7 — The scorepack's JSON contradicted the scorepack's audio

**Boundary:** timeline ↔ transport (export)
**The two sides:** `src/rendering/renderer.ts` (the master WAV is rendered on the
piecewise tempo map) · `src/export/scorepack.ts` (`markers.json`, `automation.json`)

**The drift.** The manifests converted ticks to seconds with the **project** bpm only
(`60 / (doc.bpm * 480)`), while the WAV was rendered on the tempo map — every window at
its **scene's** bpm, the gaps at the project bpm. Two different tempo maps in one
package.

**The consequence.** With a scene-tempo lane in the project, a marker landed at a
**different second** in `markers.json` than at in the audio the user receives. The
delivered data contradicted itself, and a DAW reading the scorepack would cue the wrong
place.

**Fixed by** giving the manifests the render's own tempo map — §3.5.

---

#### C8 — The intent route's default loop range was hardcoded to 4/4

**Boundary:** timeline ↔ transport
**The two sides:** `src/ui/IntentPanel.tsx` (`loopOn` → `t.loopStart + 4 * 4 * PPQ`)

**The drift.** The default loop range — used when the project has no loop yet — computed
four bars as `4 * 4 * PPQ`, i.e. 4/4 **by definition**, in a project whose meter may be
6/8 or 7/8. ADR 0056 makes `ticksPerBar(doc)` the only way a bar index becomes ticks.

**The consequence.** In a 6/8 or 7/8 project the default loop **cut mid-bar**.

**Fixed by** taking the bar length from the document's meter — §3.6.

**And the guard that should have caught it had a hole.** The repository's own guard for
this class (`tests/adr0056-stage2-bar-formula-guard.test.ts`) looks for the _formula_
`PPQ * 4` in either order — but it read the multiplication's **direct children**, so
`4 * 4 * PPQ` (the outer operand is itself a multiplication) was invisible to it. The
guard widened; §3.6.

---

#### C9 — Every document change threw the scene tempo away

**Boundary:** timeline ↔ transport
**The two sides:** `src/services.ts` (`store.onDocChanged` → `transport.setBpm(doc.bpm)`)
· `src/scheduler/Scheduler.ts` (`applyTempo`, guarded by `lastAppliedTempo`)

**The drift.** The scene-tempo lane lets a clip's scene pin a BPM; the **scheduler**
then owns the transport's tempo. The document-change path re-applied the **project** bpm
to the transport on every edit — stomping the scene tempo. The scheduler's change-guard
(`if (this.lastAppliedTempo === bpm) return;`) then saw the _same_ scene tempo as last
time and never re-applied it.

**The consequence.** The scene tempo was lost for the rest of the playback — **after
every edit**. The user changed a note and the song dropped back to the project bpm.

**Fixed by** giving each owner its own responsibility: the scheduler owns the tempo
while a scene tempo is in effect, the document-change path owns the project bpm
otherwise — §3.7.

---

#### C10 — The share route skipped the schema gate the file route enforces

**Boundary:** persistence ↔ runtime model
**The two sides:** `src/export/project-io.ts` (the file import) · `src/export/shareCode.ts`
(the share link) — both read the same document

**The drift.** Two import routes, one rule. The file route has always used
`migrateProject`, which **refuses** a document from a newer build
(`schema.ts:3524`: _"Project schema 39 is newer than supported 38"_) and
**stamps** the version back (`schema.ts:3585`). The share route used
`normalizeProject`, which does neither — it only checked the shape.

**The consequence.** A share link from a newer build **opened in an older client**.
The forked project was persisted with the future `schemaVersion`, and the project
then **vanished from the library on the next boot**: `repo.load` migrates, the
version gate throws, and the project is not listed any more (it only appears
under "incompatible"). A share link from an older build was persisted with its
stale version, so `listIncompatible` later misclassified it.

**Fixed by** giving the share route the same gate — §3.8.

---

### 1.2b The worker-boundary wave (C11–C15)

Daniel named the worker-robustness gaps of §2.3 as the next scope item, so they were
re-audited as findings rather than left as prose. Five defects, all on the worker ↔ main-thread
boundary, all of them confirmed by driving the real code.

#### C11 — The four AI workers did not validate `event.data`, and used it inside their catch block

**Boundary:** worker ↔ main thread · **The two sides:** `src/ai/{ranking,audio,symbolic,semantic}`
workers ↔ their clients

**The drift.** All four took the payload as-is and used it **inside the catch block**:

```ts
const request = event.data;
try { … } catch (error) {
  const response = { type: request.type, requestId: request.requestId, ok: false, error };
}
```

Two defects live in that shape:

1. `event.data === null` → `handle(null)` throws, and then the **catch block throws too**
   (reading `.type` of null). The response is never posted, so the caller waits out its whole
   timeout — 400 ms (ranker score), 500 ms (prior run), 3 s (both loads), 20 s (audio
   classify). The worker is not killed by the throw; it is **deafened**: it never answers, and
   the failure is mis-attributed to the model.
2. `handle()` treats every type it does not know as **"dispose"**. An unknown message type
   therefore **released the loaded model** — the prior worker releases *every* kind's session —
   and the next request answered "model not loaded". The lane then degraded to the heuristic
   fallback with no word.

The repository's own rule (AGENTS.md → defensive parsing) says every worker `onmessage` validates
`event.data`; `src/intent/model-worker.ts` is the reference shape. A sweep of **every** worker
in the repo (19 files) confirmed these four were the only ones missing it — `onset-detector`,
`warp-render`, `pitch-tracker`, `ir-generator`, `ultinaAnalysisWorker`, `model-worker`,
`stt-worker`, `reference.worker`, `vocal/analyzer-worker` and the four mastering workers all
validate.

**Fixed by** an envelope validator per worker, mirroring `model-worker.ts` — §3.9.

#### C12 — Three AI clients registered no worker `error` listener

**Boundary:** worker ↔ main thread · **The two sides:** `ranker-client.ts`, `prior-client.ts`,
`audio-client.ts` ↔ their workers

**The drift.** The clients listened for answers and nothing else. A worker that died — crashed
on a module import, killed under memory pressure, or deafened by C11 — produced **no event at
all**, so the call sat on its timeout and the answer said `"timeout"`: the model's fault, not
the worker's.

The second half was worse: a timeout counted as a failure, but a worker **error** did not (there
was no listener to count it), so the **circuit breaker never opened on a worker that was dead
for the whole session**. Every later request paid the full timeout again — twenty seconds per
audio classification.

The semantic client already had the right shape (`error` + `messageerror` listeners, a `fail()`
that settles the promise, a failure that counts toward the breaker). These three now follow it.

**Fixed by** the semantic client's pattern — §3.10.

#### C13 — The semantic worker answered a filtered batch, and the client passed the short answer on

**Boundary:** worker ↔ main thread · **The two sides:** `semantic-worker.ts` ↔
`semantic-client.ts` ↔ `buildReferenceEmbedding`

**The drift.** The worker filtered its batch before embedding:

```ts
const texts = request.texts.filter((text) => typeof text === "string" && text.trim().length > 0);
```

so a request for three texts (one of them empty) came back as **two** vectors. The client did
not notice — it returned whatever the worker said — and the caller used the short answer as if
it were complete.

The consumer *did* notice: `buildReferenceEmbedding` checks `vectors.length !== texts.length`
and returns null. But that is a **silent loss of the whole reference-informed conditioning**
(labels + feature poles), not a report. The user gets a beat with no reference conditioning and
no explanation.

The contract is simple: **N texts in, N vectors out, in order.** A request that cannot be
answered that way is a failure, not a shorter answer.

**Fixed by** embedding the batch that was asked for, and asserting the count on both sides —
§3.11.

#### C14 — The reference worker posted the ANALYSIS error type in the TRANSCRIPTION lane

**Boundary:** worker ↔ main thread · **The two sides:** `reference.worker.ts` ↔
`reference-client.ts`

**The drift.** The worker catches a transcription failure and posts `{ type: "REFERENCE_ERROR" }`
— the analysis lane's type. The transcription client listens for `TRANSCRIBE_ERROR`, **a type
the protocol union did not even declare**. So the worker's own explanation was ignored by the
lane it was meant for, and the call waited the **full 120 s timeout** before it degraded.

This one is also a finding about the **previous wave's own guard**: C2's regression test
asserted against a hand-written `{ type: "TRANSCRIBE_ERROR" }` message — a shape the worker
never produced — so it guarded the contract instead of the behaviour. The new test drives the
**real worker** and reads what it actually posts.

**Fixed by** giving the transcription lane its own error type — §3.12.

#### C15 — The reference `jobId` was never compared, and it wrapped every 65 seconds

**Boundary:** worker ↔ main thread · **The two sides:** `reference-client.ts` ↔
`reference.worker.ts`

**The drift.** Every worker answer carries the `jobId` of the request it belongs to, and the
client compared **none** of them: the analysis lane accepted a result for any job, and the
progress handler mirrored stages for any job. Worse, the id itself was `Date.now() & 0xffff` —
the low 16 bits of the clock — which **wraps every 65 536 ms**, so two analyses a minute apart
could carry the same id and even a comparison would have been ambiguous.

**Honest scope note.** With one worker per call, a foreign answer was **not reachable today** —
so this is a half-open contract rather than a reachable failure. It is fixed because the
protocol carries a field that nothing honoured, and because the id could repeat.

**Fixed by** a monotonic job id that is compared on every message — §3.12.

#### C16 — The warp client's error path dropped the worker's reason and re-ran the expensive core on the main thread

**Boundary:** worker ↔ main thread · **The two sides:** `warp-render.ts` ↔
`warp-render-client.ts`

**The drift.** The worker catches everything it can and posts the reason back (`{ error }`). The
client read `event.data.channels` and, when that was absent, ran the **synchronous fallback** —
and never looked at `event.data.error`. So:

1. the worker's reason was **dropped** — the caller could not tell a failed worker from a worker
   that never answered;
2. the expensive phase vocoder was **re-run on the main thread** after the worker had already
   failed on that very input. That is exactly what the client's own contract forbids ("this one
   REJECTS on timeout instead of running the sync fallback … running the identical core on the
   main thread would freeze the UI permanently") — the error path quietly did the thing the
   timeout path refuses to do.

**Fixed by** rejecting with the worker's own reason — §3.13.

---

### 1.3 The pattern behind the findings

Four of the ten findings (C1, C3, C4, C5) are the same shape: **one rule, two copies, and
the copies disagree**. Two of them (C3, C4) were invisible because the _unit tests mocked
the client away_ — `tests/symbolic-prior.test.ts` stubs the whole prior client, so the
manifest never reached the guard; and no test ever read the shipped manifest files.

The lesson the wave repeats: **a guard that cannot see the shape of the defect is not a
guard.** C8's guard read only the direct children of a multiplication, and C1's premise
named a module that does not contain the gate it described.

---

## 2. Confirmed but deliberately left unchanged

### 2.1 The parked melodic v3 model

`public/models/symbolic-melodic-v3.manifest.json` has no `kind` and is refused by the
routing — like the v1 artifacts, but for a model that is **not in service**: it was
trained and parked (its pre-registered gate did not pass, and `runMelodicNextV3` has no
caller — `docs/CAMPAIGN_STATE.md`). Wiring it up would be manufacturing work for a
deliberately parked experiment, so the routing keeps refusing it — and a test now says so
explicitly, so the refusal is a decision rather than an accident.

### 2.2 Latent inconsistencies on the plugin-host boundary

Found, not fixed — each is masked today but each is a drift waiting for a caller:

| Finding                                                                                                              | Where                                               | Why it is latent                                                                                  |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Two worklet parameter defaults disagree with the registry (`tapeStop.time` 1.5 vs 1, `pitchShift.semitones` -3 vs 0) | `src/audio-worklets/*` vs `src/effects/registry.ts` | the normalizer overwrites the value on load; the guard sweep checks ranges but not `defaultValue` |
| Two domain crossings are not in `SCALE_BRIDGES` (`limiter.lookaheadMs`, `skrutka.lfoRate`)                           | `src/effects/registry.ts`                           | they are not tempo-scaled, so nothing detects the omission                                        |
| Eight copies of the dB→linear conversion live in eight modules                                                       | `src/`                                              | no single owner; identical today, free to drift                                                   |

### 2.3 Worker-robustness gaps on the worker boundary — RESOLVED in the worker-boundary wave

This section listed four gaps that were real and deliberately left unchanged. Daniel named them
as the next scope item, so they were **fixed** and re-documented as findings:

| Finding (as it was listed here)                                       | Now                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Four workers do not validate `event.data` before using it             | **C11** — fixed (§3.9). The sweep also proved they were the only four of 19        |
| Three clients register no worker `error` listener                      | **C12** — fixed (§3.10)                                                            |
| The semantic worker filters the batch but the client does not assert it | **C13** — fixed (§3.11)                                                            |
| The warp-render error string is dropped; the reference `jobId` is never compared | **C16** and **C15** — fixed (§3.13, §3.12)                            |

The worker-boundary wave added two findings the section had not seen: **C14** (the reference
worker's transcription lane posted the analysis lane's error type — a defect the previous wave's
own guard could not see) and **C15** (the `jobId` was never compared and wrapped every 65 s).

The other sections of this chapter are unchanged.

### 2.4 The AI bridge's volume ceiling exceeds the mixer's

The AI bridge allows +12 dB of make-up gain; the mixer fader tops out at 1.5. Low
reachability (it needs the AI bridge to write a gain outside the fader's range), no
audible defect today — reported, not changed.

### 2.5 Confirmed in this wave, left for the next one

The last boundary sweep (UI ↔ project state, persistence ↔ runtime model) found seven
more drifts. One (C10, above) was fixed here; the other six are recorded with their
reachability so they are not lost. Each needs its own red-test-first cycle, and the
wave did not have the budget to do six of them honestly — half-fixing a boundary is
worse than naming it.

| #   | Boundary                    | The drift                                                                                                                                                                                                                                        | The consequence                                                                                                                                                                                                                                                                                                                                                                         | Status                                                                        |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| D-1 | UI ↔ project state          | The Reference Map panel keeps its own BPM domain (`MIN_BPM 20 / MAX_BPM 400` — `src/ui/ReferenceMapPanel.tsx:86-87`) while the document's domain is `20..300` (`src/project-model/schema.ts:63-65`)                                              | A detected or typed tempo above 300 BPM is clamped in the document but the **marker ticks are computed at the panel's tempo** — the markers land ~27 % off in musical position, and the tempo-mismatch warning stays on with no way to clear it. Reachable with no user input at all: the detector emits a double-time candidate up to 400 BPM (`src/reference/analysis/rhythm.ts:140`) | confirmed                                                                     |
| D-2 | persistence ↔ runtime model | `bpmRange` has **three** legal ranges: `20..300` (`src/intent/normalize.ts:91`), `20..400` (`src/intent/producer-lineage-core.ts:267`) and `40..240`, integers only (`src/intent/project-brief.ts:67`, `src/project-model/producer-brief.ts:71`) | A normalized intent may carry a `bpmRange` the brief store refuses, and the fact is then **silently dropped** from the project brief — the tempo the user confirmed disappears without a word, and the next generation produces a different tempo                                                                                                                                       | confirmed                                                                     |
| D-3 | UI ↔ project state          | The master-gain domain is implemented twice: `clampMasterGain` (`src/project-model/schema.ts:295-298`, non-finite → 1) and an inline clamp in the engine (`src/audio-engine/AudioEngine.ts:3469`, non-finite → _leave the old value_)            | The preview and the commit disagree on a non-finite master gain — the exact class of mismatch the neighbouring comment says it fixed. Only reachable through a hand-edited or collab-merged master config                                                                                                                                                                               | confirmed                                                                     |
| D-4 | persistence ↔ runtime model | `clampUnit` exists three times: `0..1` with non-finite → 0 (`src/project-model/schema.ts:498-501`), `0..1` with **NaN passing through** (`src/intent/producer-session.ts:191-193`) and `0.1..1` (`src/ai/melodic.ts:191-193`)                    | The melodic generator floors a note velocity at 0.1 while every other unit clamp allows 0 — a value the schema's own clamp would accept never reaches the document                                                                                                                                                                                                                      | **suspected** (needs a runtime check on what the generator actually produces) |
| D-6 | persistence ↔ runtime model | `producerBrief` invalidity means "this document is invalid" in `validateProjectShape` (`schema.ts:3625`) and "drop this one field" in `normalizeProducerBriefDomain` (`schema.ts:2528-2534`)                                                     | `repo.load` validates **before** it migrates (`src/persistence/ProjectRepository.ts:67-69`), so a stored record with a malformed brief makes the **whole project** unopenable — even though the normalizer in the same file is prepared to heal exactly that. A collab peer can inject the state (`src/collab/YDocAdapter.ts:115-117` copies the brief as an unchecked cast)            | confirmed                                                                     |
| D-7 | persistence ↔ runtime model | The recovery buffer stores the document as `unknown` and reads it back with only a null check (`src/persistence/recoveryBuffer.ts:51,72-99`); the recovery path casts it and saves it (`src/ui/ProjectBrowser.tsx:390-399`)                      | A corrupt recovery buffer is committed as a project record that the next boot refuses — the recovered work appears to have **vanished**. The trigger is a truncated write rather than a malformed document                                                                                                                                                                              | **suspected** (needs a runtime check on what the buffer can actually hold)    |

---

## 3. Fixes

Every fix is small, local and reversible. No file was rewritten, no behaviour was
redesigned, and no test, type or assertion was weakened.

### 3.1 C1 — one owner for the audibility rule

- **New** `src/project-model/solo-audibility.ts` — the rule, moved out of the engine into
  the layer that owns the document (the engine re-exports it, so every existing import
  site keeps working).
- `src/project-model/groove.ts` — the drum scheduler now reads that rule instead of its
  own copy. The verdict is resolved **once per window**, not per grid step, because this
  is the scheduler's hot path.
- `src/commands/tracks.ts` — `addToGroup` no longer writes `solo` onto the member, and
  its undo no longer has to restore it.

Two behaviours changed, both in the right direction: a member of a **muted** group now
gets no drum hits scheduled (the mixer was silencing them anyway), and a member of a
**soloed** group keeps its hits (the mixer plays them).

### 3.2 C2 — the worker's own error settles the call

`src/reference/reference-client.ts` — the message handler recognises `REFERENCE_ERROR` /
`TRANSCRIBE_ERROR` and settles with the same deterministic fallback the `error` event
uses.

### 3.3 C3, C4, C5 — the prior client's manifest routing and response reading

- `src/ai/symbolic/prior-types.ts` — new `coerceMelodicManifest` (the drums shim's twin)
  and a new `acceptPriorManifest(kind, value)`: **one owner** for the kind→manifest
  routing, with an arm per kind.
- `src/ai/symbolic/prior-client.ts` — `loadManifest` uses that owner; the inverted
  response check is written the way it is meant to read.

### 3.4 C6 — the master chain joins the broadcast

`src/audio-engine/AudioEngine.ts` — `pushSyncBpm` and `transportStarted` now include
`this.masterFx.runtimes`.

### 3.5 C7 — the scorepack's manifests speak the render's tempo

- `src/rendering/renderer.ts` — `collectClipWindows` is exported (it is the renderer's
  own window list; the scorepack needs the same one).
- `src/export/scorepack.ts` — `scorepackTempo(doc)` builds the render's tempo map and
  the manifests use it.

### 3.6 C8 — a meter-aware loop range, and a guard that can see it

- `src/ui/IntentPanel.tsx` — the default loop range is `ticksPerBar(doc) * 4`.
- `tests/adr0056-stage2-bar-formula-guard.test.ts` — the guard now searches a
  multiplication's **whole operand tree** (and stops at a division, so `PPQ / 4` — a
  sixteenth note — is not read as a bar length). Five new guard proofs: the extra
  factor, one violation per expression, the meter-aware form, the sixteenth note, the
  beats-per-bar formula.

### 3.7 C9 — one owner for the transport's tempo

- `src/scheduler/Scheduler.ts` — a read-only `sceneTempo` getter (the tempo in effect).
- `src/services.ts` — the document-change path re-applies the project bpm **only** when
  no scene tempo is in effect.

### 3.8 C10 — one schema gate for both import routes

`src/export/shareCode.ts` — the share route migrates instead of merely normalizing, so it
refuses a document from a newer build and stamps the version back. The migration's throw is
caught by the function's existing try/catch, which already returns `null` for an invalid
token — a link cannot report a reason, and the caller already handles null.

---

## 4. Tests added

| File                                                        | What it pins                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/group-solo-ownership.test.ts`                        | The group owns the group's solo: joining a soloed group writes no member state, un-soloing leaves the project audible, leaving the group leaves no solo, and **the drum scheduler and the mixer read the same rule** (a member of a soloed group gets its hits; a member of a muted group does not) |
| `tests/reference-client-error.test.ts`                      | A worker that reports its own failure settles the caller **now** — the call must not wait for the 120 s timeout — and the worker is terminated                                                                                                                                                      |
| `tests/prior-manifest-routing.test.ts`                      | The runtime accepts the manifests the product **ships** (read from `public/models/`), rejects a manifest of a different kind, and the v1 shim accepts a missing `kind` but never a foreign one; the parked v3 model stays out of service, explicitly                                                |
| `tests/prior-client-response-contract.test.ts`              | A successful worker answer is read as a success, not as a failure                                                                                                                                                                                                                                   |
| `tests/master-chain-broadcast.test.ts`                      | The master chain receives the tempo push and the transport start, exactly like a track chain                                                                                                                                                                                                        |
| `tests/scorepack-tempo-contract.test.ts`                    | The scorepack's tempo map **is** the render's tempo map, and the markers it writes use it                                                                                                                                                                                                           |
| `tests/scene-tempo-survives-edit.test.ts`                   | A document change does not stomp the scene tempo; without a scene tempo the project bpm still follows the document                                                                                                                                                                                  |
| `tests/share-code-schema-gate.test.ts`                      | A share link from a **newer** build does not open, and a link from an **older** build is migrated and stamped with the current schema version — the same gate the file route has always used                                                                                                        |
| `tests/adr0056-stage2-bar-formula-guard.test.ts` (extended) | Five new guard proofs, including the `4 * 4 * PPQ` shape the old guard could not see                                                                                                                                                                                                                |

---

## 5. Verification

### 5.1 The new regression suites

`npx vitest run` over the seven new files plus the extended guard:
**8 files passed, 50 tests passed.**

### 5.2 The related existing suites

The mixer, scheduler, prior/melodic, scorepack/export, tempo and parity suites, run
together with the new ones:

```
npx vitest run <7 new files> tests/adr0056-stage2-bar-formula-guard.test.ts \
  tests/adr0056-stage2-bar-unit.test.ts tests/groupTracks.test.ts tests/mixer-audit.test.ts \
  tests/mixer-audit3.test.ts tests/mixer-batch.test.ts tests/mixer-send-leak.test.ts \
  tests/scheduler.test.ts tests/scheduler-driver.test.ts tests/scheduler-stall.test.ts \
  tests/live-edit-scheduler-window.test.ts tests/state-collab-scheduler-adversarial.test.ts \
  tests/symbolic-prior.test.ts tests/symbolic-melodic.test.ts \
  tests/melodic-embedding-conditioning.test.ts tests/prior-embedding-conditioning.test.ts \
  tests/personal-melodic-flow.test.ts tests/scorepack.test.ts tests/scorepack-stamp.test.ts \
  tests/export-verification.test.ts tests/import-export-robustness.test.ts \
  tests/tempo-lane.test.ts tests/tempo-seam.test.ts tests/tempo-flip-commit.test.ts \
  tests/loop-tempo.test.ts tests/scene-seam-parity.test.ts tests/offline-parity.test.ts \
  tests/fx-tempo-sync.test.ts tests/recording-audit.test.ts
→ Test Files 36 passed (36)
  Tests      368 passed (368)
```

No regression: the mixer, the scheduler, the prior/melodic lanes, the export and the
live/offline parity are all green with the fixes in place.

**The final run, with C10 in place, was the 37-file run (the eight above plus
`tests/share-code-schema-gate.test.ts`):**

```
→ Test Files 35 passed | 2 failed (37)
  Tests      369 passed | 2 failed (371)
```

Both failures are **`Test timed out in 5000ms`**, in
`tests/mixer-audit3.test.ts` and `tests/mixer-send-leak.test.ts` — and **both files
belong to other sessions** (`5e239c67`, `c4badde2`), not to this wave. Re-run **alone**,
with the load of 37 parallel workers removed, they are green:

```
npx vitest run tests/mixer-audit3.test.ts tests/mixer-send-leak.test.ts --testTimeout=30000
→ Test Files 2 passed (2)
  Tests      16 passed (16)
  ✓ hostile out-of-range gain/pan/send values are clamped at the graph write  3458ms
  ✓ removing a send disconnects the modMacroPan → sendGain edge (leak guard)   3477ms
```

Each of those two tests needs about **3.5 s** against vitest's **5 s** default budget, so
they only overrun when the machine is already busy (this tree runs on a host shared with
several other agent sessions). That is a **timeout-budget fragility in a foreign test
file**, not a product defect and not a regression from this wave — it is recorded as risk
9 below rather than patched here, because editing another session's test file to widen a
budget is not this wave's to take.

### 5.3 The revert check (the proof that the tests have teeth)

Every fix was undone and the suites re-run: **17 tests failed across all 8 files**, each
with the defect's own message:

| Fix   | The failure the reverted code produced                                                                                                                                                                                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1    | `the member's own solo state must not be rewritten: expected true to be false` · `the bystander must still be audible: expected false to be true` · `a member that left the group carries no solo: expected true to be false` · `the mixer says audible → the hits must be scheduled: expected 0 to be greater than 0` · `the mixer says silent → no hits may be scheduled: expected 11 to be +0` |
| C2    | `the call must not wait for the 120 s timeout: expected 'still-pending' to be 'settled'` (×2)                                                                                                                                                                                                                                                                                                     |
| C3/C4 | `drums-v3: the runtime rejected the manifest the product ships: expected null not to be null` · `melodic: … expected null not to be null`                                                                                                                                                                                                                                                         |
| C5    | `a successful worker answer must not be read as a failure: expected 'fallback' to be 'model'`                                                                                                                                                                                                                                                                                                     |
| C6    | `the master chain must be told about the tempo change: expected [] to include 'master:sync:140'` · `the master chain must be re-anchored to the transport: expected [] to include 'master:started'`                                                                                                                                                                                               |
| C7    | `expected 66 to be close to 64.57142857142857`                                                                                                                                                                                                                                                                                                                                                    |
| C8    | `the bar-length formula must not be copied anywhere:` (the widened guard caught the reverted `4 * 4 * PPQ`)                                                                                                                                                                                                                                                                                       |
| C9    | `the scene tempo must survive the edit: expected 130 to be 140`                                                                                                                                                                                                                                                                                                                                   |

The fixes were then restored and the suites re-run green.

### 5.4 The full check list

| Check                                                 | Result                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| New + extended suites                                 | **8 files, 50 tests passed** (plus 3 more for C10 → 9 files, 53 tests)                                  |
| New + related existing suites                         | **35 of 37 files green, 369 passed** — the 2 failures are 5 s **timeouts** in foreign mixer files (5.2) |
| `npx tsc --noEmit`                                    | **exit 0** on the final pushed tree (see below)                                                         |
| `npx prettier --check` (every file this wave touched) | **"All matched files use Prettier code style!"**                                                        |
| `npm run build`                                       | **fails on the budget step — not on this wave's code** (see below)                                      |
| `node-gc`                                             | **ABANDONED: none**                                                                                     |

**The build.** `npm run build` runs `tsc --noEmit && vite build && … && check-bundle-size.mjs`.
While this wave ran, **two** things were red on the tree and neither was this wave's. On the
**final pushed tree only one is left**, the budget:

1. the `tsc` step was **red while this wave ran**, and the only error was in a
   concurrent session's in-flight test file (the name moves as that session works — it
   was `tests/scene-clip-edit-matrix.test.ts`, then `tests/mcp-tools.test.ts`, and at
   the last measurement `tests/master-assistant-corrections.test.ts`; all of them
   theirs, none of them touched by this wave). Its owner fixed it in `74dacc7d`, and
   the **final pushed tree typechecks clean (`tsc` exit 0)**;
2. the budget step reports **DAW JS 5563 KB against a 5560 KB budget** — 3 KB over.

The budget overage was **measured for attribution**: the same tree was built with this
wave's source changes reverted, and it produced the **same** number — DAW JS **5563 KB**,
shipped JS **8065 KB**, studio boot path **2095 KB** (against 2096 KB with this wave's
changes). So this wave contributes about **1 KB** of the boot path and **nothing** to the
DAW JS total; the 3 KB overage belongs to the tree, i.e. to other sessions' commits.
It is reported here rather than papered over by raising the budget — a budget raise is a
product decision and needs its own measured justification
(`scripts/check-bundle-size.mjs`).

---

## 6. Remaining risks

1. **The worker-robustness gaps in §2.3** are real and unfixed. They need their own
   failing-test-first cycle; the wave did not have the budget for it, and half-fixing
   them would be worse than leaving them visible.
2. **The plugin-host latent inconsistencies in §2.2** — the two worklet defaults, the two
   missing scale bridges, the eight copies of the dB conversion. Masked today; each is
   a drift waiting for the next caller.
3. **The scene-tempo fix depends on the scheduler's `sceneTempo` getter.** A second
   writer that moves the transport's tempo (the collab transport sync, the MIDI clock)
   can still override the scene tempo; the scheduler does not re-assert it, on purpose
   (a remote tempo must win).
4. **The audibility rule now has one owner, but the mixer still applies it twice** (the
   gain gate and the drum scheduler) — by design, but the _decision_ now lives in one
   place, which is the part that used to drift.
5. **The scorepack's tempo fix is a shared map, not a shared renderer.** The manifests
   and the WAV now use the same map, but the scorepack still renders the master and the
   stems separately (`buildStemProject` produces a different document) — a stem's
   manifest is not part of this contract.
6. **The guard is wider now, and a wider guard is a louder guard.** The first run of the
   widened ADR 0056 guard reported seven candidate violations; six of them turned out to
   be `PPQ / 4`-shaped grid positions and meter-aware formulas, and the rule was
   narrowed accordingly (a division is a barrier). A future bar-length copy written with
   a division in it would still slip past.
7. **The editor E2E suite was not re-run in this wave** — no editor surface changed, and
   the previous wave's E2E result was measured against a different tree. The next E2E run
   should be treated as the first trustworthy one for this tree.
8. **The editor is not proven bug-free.** This wave looked at seven seams, not at the
   whole product, and it stopped at the first confirmed defect per seam. What is left
   behind is a list, not a guarantee.
9. **Two foreign mixer tests sit too close to vitest's 5 s default.** The "hostile
   out-of-range gain/pan/send" clamp test and the "send teardown" leak guard each need
   ~3.5 s; under a busy host they overrun and are reported as failures (two consecutive
   full-suite runs did). Alone they are green (16/16). They belong to other sessions
   (`5e239c67`, `c4badde2`), so this wave recorded the fragility instead of widening
   another session's timeout budget. **Whoever owns those files should give the two
   tests an explicit timeout** — a green/red signal that depends on the host's load is
   not a signal.
