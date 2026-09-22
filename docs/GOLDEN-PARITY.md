# GOLDEN PARITY — domain reference fixtures

> **Cross-platform readiness campaign — GOAL 06 deliverable** (2026-09-22).
> The fixtures in `tests/domain-goldens/*.json` are the **behavioral parity
> contract**: a future implementation (Kotlin, Swift, …) consumes them and
> proves it reproduces the engine's observable domain behavior — without
> porting the test framework. They complement the DSP golden vectors
> (`tests/{ultina,fxeq,ozvena,morph-dynamics}-*`), which pin audio output.

## Format

Each file is `{ meta, cases }`; every case is strictly
**input → operation → expected** (no host framework, no internals):

```json
{
  "name": "quantizeNotes to 16th grid",
  "operation": "commandSequence",
  "input": { "commands": ["addNote(60@97)", "…", "quantizeNotes(all,grid=120,strength=1)"] },
  "expected": { "notes": { "…": "canonical final state" } }
}
```

## Families

| File                                 | Pins                                                                                                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `param-math.json` (33 cases)         | instrument/effect **defaults tables** (all 14 kinds + 47 effect types), clamp edge/NaN sweeps, `syncRateHz` division table, `midiToFreq` 0–127, `snapToScale`/`isInScale` for three keys, `swingOffsetTicks`, `automation valueAt` curve shapes |
| `transport-time.json`                | Transport timeline math under an injected manual clock: play/advance/seek/pause/resume/setLoop/stop position table (bpm 120)                                                                                                                    |
| `command-transforms.json` (5)        | scripted editing operations on a deterministic doc: step toggles + velocity, note add/move/resize, quantize, groove swing + `drumHitsInWindow`, arrangement clip + **overlap rejection error text** + bpm                                       |
| `serialization.json`                 | share-code **encode** of the canonical doc (deterministic lz-string), **MIDI bytes** (full hex) for a small pattern                                                                                                                             |
| `decode-goldens.json` + decode cases | share-code **decode pins** — captured codes that must keep decoding to the same canonical doc forever (backward compatibility; never regenerate)                                                                                                |
| `scheduler-plan.json`                | headless `Scheduler` window plan: recorded trigger events (track/pad, audio-time, velocity) for a swung pattern driven by a manual clock                                                                                                        |

## Determinism contract

- **ids**: fixtures are built inside `useDeterministicIds()` — sequential
  `prefix-test-NNNN` ids (`src/shared/ids.ts`). Restore semantics are
  nest-safe since GOAL 06 (restore previous state, not "off").
- **time**: every ISO-8601 string is canonicalized to `"<ts>"` — wall-clock
  time never leaks into a fixture.
- **numbers**: rounded to 6 decimals; `-0` normalized to `0`.
- The canonicalizer lives in `tests/domain-goldens/harness.ts`; capture and
  replay share it, so they cannot drift.

## Workflow

```bash
npm run goldens:capture   # regenerate after an INTENTIONAL behavior change
npx vitest run tests/domain-goldens.test.ts   # replay (CI gate)
```

A replay diff = observable domain behavior changed. Either a regression →
fix the engine, or an intentional change → re-capture and **review the
fixture diff like code** (it amends the parity contract).

`decode-goldens.json` is special: the capture script creates it once and
then only PRESERVES it. Extending it (new pinned codes) is allowed;
regenerating existing pins breaks the backward-compatibility contract.

## Consuming from another implementation

1. Implement the operations named in each case (`clampInstrumentParam`,
   `commandSequence`, `transportSequence`, `encodeShareCode`,
   `writeMidiFile`, `schedulerPlan`, …) against your port.
2. Feed `input`, compare your `expected` with the same canonicalization
   rules (6 dp, `-0` → `0`, ISO strings are time — skip them).
3. Track ids only for structure: their VALUES are an artifact of the
   sequential scheme; a port's own id scheme is fine as long as references
   resolve the same way.

GOAL 09 outcome: `shared/velocityFx.ts` is now SEEDABLE (optional `rng`
parameter; default Math.random preserved for creative per-click rolls — the
computed values are baked into their commands, so replay was already
stable). The two wall-clock id sites in `commands.ts` (modulator seed,
sketch stamp) are uniqueness-only by design: stored seeds make their streams
reproducible, so they stay.
