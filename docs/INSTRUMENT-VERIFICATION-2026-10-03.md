# Instrument Verification — 2026-10-03

Deep audit of the 22 registered instrument kinds: does every one of them build a
voice that can actually reach its output, does the runtime survive its lifecycle,
and are the "dead parameter" numbers in the 2026-09-27 report real defects?

Scope of this pass, chosen over the intent engine and the plug-in suite because
instruments carry **3× the dead-parameter density** (6.6 average vs 2.3 for
effects) and had already produced one catastrophic shipped defect (the Clavinet,
silent for its whole life, fixed 2026-09-30).

---

## 1. Verdict

| Question                                                                  | Answer                                                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Do all 22 instruments build a live signal path to their output?           | **Yes — 22/22**, verified by graph reachability and falsified against the Clavinet defect                |
| Does any instrument write to `ctx.destination` and bypass the track bus?  | **No — 0/22**                                                                                            |
| Does any runtime throw on a full parameter sweep / poly notes / teardown? | **No — 0/22**                                                                                            |
| Are the 2026-09-27 `deadParams` findings real?                            | **55 of 69 mod-matrix entries are a measurement artifact** (proven by execution). 14 remain unconfirmed. |

No new product defect was found in this pass. Two harness defects were found and
fixed, and one metric in the existing report was shown to be unsound.

---

## 2. Method: a spec-accurate Web Audio graph mock

The Clavinet defect — a complete voice chain terminated at `amp` with no edge to
the instrument output — is invisible to source scanning. `tests/instrument-voice-reachability.test.ts`
pinned it with a regex, which is why it took three failed "broader regex"
attempts before this pass replaced pattern matching with real graph reachability.

`tests/helpers/graphAudioContext.ts` models the edges Web Audio actually creates.
Three properties are load-bearing, and getting any of them wrong hides or
fabricates exactly the defects this test exists to find:

1. **`connect()` registers the edge on both endpoints** and returns the
   _destination_, per spec. See §4 — this was wrong in the first draft.
2. **`disconnect()` severs outgoing edges only.** The argument-less form clears
   this node's outputs; inbound edges belong to the previous node. A mock that
   clears both makes the engine's rebuild-everything patterns look correct.
3. **Audio edges and control edges are different things.** `osc.connect(osc.detune)`
   is a modulation route, not a signal path. LFO → depthGain → `bandpass.frequency`
   is two hops, so reachability must walk forward to find it.

Sources are then classified into six buckets, and only three are defects:

| Bucket             | Meaning                                                                     | Defect? |
| ------------------ | --------------------------------------------------------------------------- | ------- |
| `audible`          | reaches `runtime.output` on a live-gain path                                | no      |
| `modulators`       | drives a param of a node on the audio path (LFO)                            | no      |
| `crossfadeMembers` | muted, but a live sibling feeds the same downstream node                    | no      |
| `silentReferences` | reaches `ctx.destination` at gain 0, bypassing the output                   | no      |
| `silentVoices`     | reaches the output through a provably-static zero gain, no live sibling     | **yes** |
| `leaks`            | reaches `ctx.destination` with live gain, skipping track gain/pan/mute/solo | **yes** |
| `dead`             | built, started, reaches nothing                                             | **yes** |

### Why gain is only read from static params

`ParamStub` tracks an `automated` flag. A voice envelope schedules
`0.0001 → peak → 0.0001`, so reading `gain.value` after `noteOn` returns the last
automation _target_ — `0.0001`, silence, for every voice in the registry. Any
mute verdict drawn from an automated param would flag all 22 instruments. The
classifier therefore concludes only from params set once and never scheduled, and
treats an automated gain as "cannot tell" rather than "silent".

---

## 3. Per-instrument classification (all 22)

| Instrument                  | audible | modulators | crossfade | clock | verdict                |
| --------------------------- | ------- | ---------- | --------- | ----- | ---------------------- |
| `808` 808 Synth             | 3       | 0          | 0         | 0     | OK                     |
| `sampler` Sampler           | 1       | 0          | 0         | 0     | OK                     |
| `analog` Analog Synth       | 4       | 2          | 0         | 0     | OK                     |
| `bass` Bass Synth           | 3       | 1          | 0         | 0     | OK                     |
| `texture` Texture Synth     | 3       | 3          | 0         | 0     | OK                     |
| `wavetable` Wavetable Synth | 3       | 0          | 2         | 0     | OK                     |
| `granular` Granular Synth   | 6       | 0          | 0         | 0     | OK                     |
| `keys` Keys                 | 2       | 6          | 0         | 0     | OK                     |
| `organ` Organ               | 3       | 2          | 0         | 1     | OK                     |
| `strings` Strings           | 3       | 4          | 0         | 1     | OK                     |
| `bell` Bell                 | 3       | 1          | 0         | 1     | OK                     |
| `reese` Reese               | 3       | 3          | 0         | 1     | OK                     |
| `clav` Clavinet             | 5       | 2          | 0         | 1     | OK (regression pinned) |
| `acid` Acid 303             | 1       | 1          | 0         | 1     | OK                     |
| `brass` Synth Brass         | 3       | 3          | 0         | 1     | OK                     |
| `fm` FM                     | 1       | 1          | 0         | 0     | OK                     |
| `pluck` Pluck Synth         | 1       | 0          | 0         | 1     | OK                     |
| `flute` Flute               | 3       | 1          | 0         | 1     | OK                     |
| `logdrum` Log Drum          | 3       | 0          | 0         | 0     | OK                     |
| `spectral` Spectral Pad     | 6       | 0          | 0         | 0     | OK                     |
| `vocalchop` Vocal Chop      | 1       | 0          | 0         | 0     | OK                     |
| `drumsynth` Drum Synth      | 2       | 0          | 0         | 1     | OK                     |

Reproduce with `npx vitest run tests/instrument-graph-reachability.test.ts` — the
per-instrument line is printed by the "records the per-instrument classification"
case, so a regression names the instrument and the orphaned node indices.

### The ten silent clocks are infrastructure, not voices

`pluck`, `flute`, `organ`, `strings`, `bell`, `reese`, `acid`, `brass`, `clav` and
`drumsynth` each build a 440 Hz oscillator at gain 0 wired to `ctx.destination`,
documented in-source as _"Clock oscillator for deterministic cleanup"_. Its only
job is to fire `onended` at `stopTime` so the per-note graph is released — and
`setTimeout` does not fire during an `OfflineAudioContext` render, whereas a real
`OscillatorNode` does. It must therefore be connected to be started, and it is
deliberately muted. The test pins the exact set, so a new instrument adding a
clock without justification is a visible change.

### The two wavetable crossfade members

`mkTableOsc` builds two frame sources into one `filter.input` and sets
`gA.gain = (1 - blend) * level`, `gB.gain = blend * level`. At the default MORPH
position one of them is exactly zero while the other carries the note —
structurally identical to a broken voice, distinguishable only by the live
sibling feeding the same node. The classifier resolves this with `hasLiveSibling`
rather than a per-instrument allowlist.

---

## 4. Harness defect found and fixed: `connect()` violated the spec

The first run reported **10 unmutated leaks** — one per instrument with a silent
clock, pointing straight at the "an instrument is bypassing the mixer" finding.
It was entirely false, and the cause is a good illustration of the failure mode
this pass set out to avoid.

In the real Web Audio API, `connect(destination)` **returns the destination
node**, not `this`. The mock returned `this`, so this production line:

```js
clock.connect(clockGain).connect(ctx.destination);
```

produced `clock → clockGain` followed by **`clock → destination`** — a second,
unmuted edge that exists only in the mock. The spec-accurate chaining is
`clockGain → destination`, which the `clockGain` of gain 0 mutes.

Verified directly: with the old mock, `clock.outputs = ['gain', 'destination']`;
after the fix, `clock.outputs = ['gain']` and `clockGain.outputs = ['destination']`.

`disconnect()` was corrected to return `void` at the same time, and connecting to
an `AudioParam` now returns `undefined` per spec. The leak check stayed in the
suite — it is a real invariant, and the next instrument to bypass the track bus
will be caught by it.

---

## 5. The 2026-09-27 `deadParams` metric is partly unsound

`docs/plugin-audit-2026-09-27.report.json` flags 69 mod-matrix parameters as
inert across the instrument set:

| Param                                                    | Instruments flagged |
| -------------------------------------------------------- | ------------------- |
| `modASrc`, `modADst`, `modBSrc`, `modBDst`, `modLfoRate` | 11 each             |
| `modAAmt`                                                | 11                  |
| `modBAmt`                                                | 3                   |

`src/plugin-audit-checks.ts:764` sweeps **one parameter at a time with every
sibling at its default**:

```ts
rendered = await render({ ...defaults, [p.id]: value });
```

For the mod matrix that sweep cannot move anything, and not because the
parameters are unwired. `scheduleVoiceModMatrix` allocates the source buses only
when a slot has a non-zero amount:

```ts
const hasActiveRoute = slotDefs.some((slot) => Number.isFinite(slot.amt) && Math.abs(slot.amt) >= 0.001);
if (!hasActiveRoute && !opts.reuseAmpNode) {
  /* dormant stub: one neutral gain */
}
```

Both amounts default to 0, so a sweep of `modASrc` alone returns the dormant stub
— the LFO that `modLfoRate` would retune is never created, and the handle's own
`setParameter` refuses to wake it for the same reason.

`tests/mod-matrix-dead-param-artifact.test.ts` proves this structurally (node
count, no audio needed):

- an all-defaults voice allocates exactly **1** node (the dormant amp gain);
- sweeping `modASrc` / `modADst` / `modLfoRate` to any value, both directly and
  through `setParameter`, allocates **0** additional nodes;
- a non-zero `modAAmt` **does** build the graph, oscillator included;
- a live `modAAmt` write on a dormant voice **does** wake it.

**55 of the 69 entries (11 × 5) are therefore measurement artifacts, not
defects.** The report attributes them to instruments whose mod matrix works
exactly as designed.

The remaining 14 (`modAAmt` × 11, `modBAmt` × 3) are **unconfirmed** and were not
chased in this pass. A contributing factor is visible in the source:
`modDstOptions(false)` returns `{ value: 0, label: "OFF" }`, so on 21 of 22
instruments the default `modADst: 0` is a deliberately inert destination. That
explains part of the `modAAmt` population but demonstrably not all of it, since
only 11 of 21 are flagged. Settling it needs a real-browser render that moves
`modAAmt` **with** a live destination, not a one-at-a-time sweep.

### Recommended fix to the audit harness

A group-aware sweep: for `modAAmt` / `modBAmt`, sweep with the counterpart
destination forced to a live value (3 = AMP) and the source forced off-default,
before calling the parameter inert. Otherwise every future audit re-reports the
same 55 false findings.

---

## 6. Falsification

Every new test was run against deliberately broken code, not just against the
fixed code.

| Test                             | Injected fault                                                       | Result                                                                                                                                              | Restored                                             |
| -------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `instrument-graph-reachability`  | removed `amp.connect(output)` from the Clavinet (`registry.ts:5035`) | 3/7 fail — `clav NO LIVE SOURCE DEAD=[oscillator#3, oscillator#4, oscillator#5, oscillator#7, oscillator#14, oscillator#16, bufferSource#18]`       | `git diff --stat` empty, file byte-identical to HEAD |
| `mod-matrix-dead-param-artifact` | forced `hasActiveRoute = true`                                       | 3/4 fail — `expected [ 'gain', 'constantSource', …(30) ] to deeply equal [ 'gain' ]` and both "must wake" cases `expected 32 to be greater than 32` | `git diff --stat` empty, file byte-identical to HEAD |

The Clavinet falsification is the important one: it names the seven sources that
become orphaned, which is the evidence a maintainer needs to diagnose a silent
instrument without reading 200 lines of factory.

---

## 7. Gates

| Gate                                                          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx tsc --noEmit`                                            | **0 errors in this pass's files.** Repo-wide: **8 errors, all in a concurrent session's uncommitted work** — `src/commands/_internal.ts` (4: `clonePatternForVariation`, `countReferenceCleanups`, `ProductionIntent`, `foldProductionActions` are untracked, a refactor in flight), `src/commands/commands.ts` (1), `tests/mcp-model-misses.test.ts` (1), `tests/pitchcorrect-block-sim.test.ts` (1), `tests/ui/audio-trim-stale-offset.test.tsx` (1) |
| `npx vitest run tests/instrument-graph-reachability.test.ts`  | 7/7 pass, 22 instruments probed                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `npx vitest run tests/mod-matrix-dead-param-artifact.test.ts` | 4/4 pass                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Graph + mix regression suite (4 files)                        | 20/20 pass                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/groupTracks.test.ts`                                   | **20/21 — one failure, not from this pass.** `deleteTrack orphans children when deleting a group` dies with `ReferenceError: countReferenceCleanups is not defined` at `src/commands/_internal.ts:126` — the same concurrent refactor. A `ReferenceError` inside the module under test is a harness failure, not an assertion about the product                                                                                                        |
| `npx prettier --check` on this pass's files                   | `All matched files use Prettier code style!`                                                                                                                                                                                                                                                                                                                                                                                                           |

Not run in this pass: `npm run test:browser` and `npm run build`. The mock has no
time axis and cannot measure DSP, so audibility claims still come from the
real-browser gate; nothing here asserts a rendered peak.

---

## 8. Next targets

1. **`glide` — inert on 7 instruments** (analog's neighbours: bass, 808, organ,
   reese, acid, fm, logdrum, sampler, flute). The largest non-mod-matrix cluster
   and not explained by the artifact above. Likely needs a slide path to be
   audible within the audit's window, which makes it a measurement-method
   question before it is a defect question.
2. **Make the audit sweep group-aware** (§5) so 55 known-false findings leave the
   next report.
3. **Re-measure `spectral`.** The report says `defaultAudible: false`,
   `defaultPeak: 0.00`, 12 dead params; the real-browser gate measures peak 0.126
   and passes. The two disagree and the discrepancy is still unexplained. It is a
   genuine open question, not a settled pass.
4. **Run the graph test against the worklet-backed runtimes.** `wtvoiceNode` and
   `granularNode` are bridges whose voice lives in an AudioWorklet; the mock sees
   only the message port, so those two paths are structurally out of reach here.

---

## Files

| File                                           | Role                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `tests/helpers/graphAudioContext.ts`           | Spec-accurate Web Audio graph mock + six-way source classifier      |
| `tests/instrument-graph-reachability.test.ts`  | Probes all 22 `INSTRUMENT_DEFS`; 4 defect classes + lifecycle sweep |
| `tests/mod-matrix-dead-param-artifact.test.ts` | Proves the mod-matrix "dead params" are a sweep artifact            |
