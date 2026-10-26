# ADR 0068 — A bypass is a parameter write, not a chain rebuild

Date: 2026-10-26 · Status: Accepted (shipped) · Scope: audio engine, effect chain
Supersedes: ADR 0006 §"structural changes (add/remove/reorder/bypass) rebuild runtimes"

## Context

The performance-cliff audit (`docs/PERFORMANCE_CLIFF_DETECTOR_REPORT.md`, finding **C-5**) found that
**toggling one effect's bypass tore down that track's entire effect chain**.

The mechanism was three lines of code working together:

1. `fxSignature()` **filtered bypassed effects OUT of the signature**:
   `effects.filter((e) => !e.bypassed).map(...)`.
2. The signature is the engine's "is this the same chain?" question. A bypassed effect left the
   signature, so the signature **changed** — the chain's _shape_ changed.
3. A changed signature runs `rebuildFxChain()`, which **disposes every runtime on the track and
   re-instantiates it from the factory**.

The consequence was not one effect being muted. It was that **every effect on that track lost its
state** — a delay's tail, a reverb's decay, an envelope follower's phase — and the audio graph was
churned under playback. A user toggling one insert on a busy track paid for a full rack rebuild.

Two properties made this worse than it had to be, and both were load-bearing elsewhere:

- The chain's **shape** depended on a _user-facing mute flag_. A flag that means "don't hear this"
  was expressed as "this element does not exist".
- The **bypass toggle was the only parameter change in the product that rebuilt the graph**. Every
  other parameter tweak went through `setParameter` — a write, not a rebuild.

## Decision

**A bypassed effect stays in the chain, in the signature and in the graph. The bypass is a wet/dry
crossfade — two gain writes — and the toggle never rebuilds anything.**

1. **The signature describes the chain's SHAPE, and the shape does not depend on the mute flag.**
   `fxSignature()` no longer filters bypassed effects out. It answers "are these the same effects, in
   the same order, with the same sidechain feeds?" — and a bypassed effect is the same effect.
2. **Every effect is instantiated, bypassed or not.** `rebuildFxChain()` no longer skips a bypassed
   effect. Its runtime runs, its parameters keep syncing (an un-bypass must find the values the user
   left behind), and its state survives the toggle.
3. **The bypass is a crossfade with ONE extra node per effect.** The wet side is the effect's own
   output, muted while bypassed; the dry side is a parallel `GainNode` (`dryGain`), open while
   bypassed. Exactly one of the two is open, so the chain hears the effect **or** hears through it —
   never both, never silence.
4. **The dry branch is fed from the same sources as the wet branch** — the previous stage's wet
   output _and_ its dry output. It therefore never passes through an effect's own input stage: a
   bypassed effect is bypassed by the **wiring**, not by the effect's front end. An effect with a
   non-transparent input stage (a highpass, a level gate) cannot colour the dry signal.
5. **The wet side's gain is folded into the output-trim AudioParam** (`trim × wet`). ADR 0048's
   per-effect node budget leaves **exactly one** spare node per effect (the measured EQ chain is 8
   nodes: 6 biquads + the output trim + the PDC delay; the limit is 9), so a second wet-side gain
   node would break the census gate. The engine owns both factors and always writes the product, so
   nothing fights over the parameter.
6. **Both sides move with the SAME time constant (15 ms).** The sum of the two stays flat through
   the transition, so the toggle is a blend and not a dip. The old path crossfaded the _whole_
   chain over 20 ms — a full rebuild for a mute.
7. **A bypassed effect contributes NO latency.** The dry path carries the signal _past_ it, so the
   effect's own DSP latency is not on the chain. Counting it would delay every other track against a
   latency the signal never incurred.
8. **A bypassed effect reports NO telemetry.** Its meters and gain reduction return `null`, not
   zeros and not a reading: the runtime is alive and analysing, but its telemetry is not the chain's
   signal (`docs/AGENT-KIT.md`). A muted insert is not a degraded insert either — it is not reported
   as one, live or offline.
9. **The offline render builds the SAME chain** (invariant 3: one shared engine for live and
   offline). A bypassed effect is instantiated in the export too, muted by the same wiring.

## Consequences

- **The toggle is now a write.** The runtime's identity is unchanged across a bypass, the node count
  is unchanged, and the factory does not run again. The gate in
  `tests/fx-bypass-parameter.test.ts` asserts exactly that.
- **An effect's state survives the bypass.** This is the point of the change: a delay's tail and a
  reverb's decay are no longer destroyed by a mute.
- **A bypassed effect keeps running.** Its DSP keeps consuming CPU and memory while it is muted.
  This **reverses a documented property**: the performance audit's README recorded "a bypassed
  effect gets no runtime at all" as a healthy property, and ADR 0006 named bypass a structural
  change. Both are amended by this ADR. The trade is deliberate: a user's mute must not cost the
  rest of the rack its state, and the CPU is bounded by the number of inserts on the track.
- **The export is marginally more expensive** for a project with bypassed inserts — they are
  instantiated and muted rather than omitted. The rendered **audio is identical**.
- **The chain's node count grows by exactly one per effect** (`dryGain`). The census gate's
  measurement (8 → 9 nodes for an EQ chain, limit 9) is the reason the wet side was folded into
  the trim instead of getting a node of its own.
- **The parameter cache grew one key** (`__bypassed`). The cache must record the bypass state even
  when no _parameter_ changed — otherwise every later sync would see a "changed" bypass and re-run
  the fade.
- **The sidechain detector of a bypassed effect stays wired.** The effect is running; it is only
  muted. Un-bypassing it must find a detector that was already tracking the source.

## Alternatives considered

- **Keep the effect out of the chain and rebuild only the bypassed stage.** Rejected: a Web Audio
  graph has no way to splice a single stage out of the middle of a chain — the stage's input and
  output edges both have to be rewired, and the stage's runtime is re-created in the process. The
  state this ADR protects would still be lost.
- **Keep the runtime detached and skip it in the graph (the pre-fix behaviour).** Rejected: a
  detached runtime receives no signal, so its state does not evolve — a delay's tail would not
  decay, a reverb would not drain. Un-bypassing would re-introduce a stale state. The runtime must
  stay _in_ the graph to stay _alive_.
- **A second wet-side gain node (wet gain + trim gain + dry gain).** Rejected: it needs **two**
  spare nodes per effect and ADR 0048's budget has **one**. The wet gain is folded into the output
  trim instead.
- **Crossfade with different time constants per side.** Rejected: the sum of the two would not stay
  flat, so the transition would dip. Both sides move together.
- **Hard-cut the bypass (no fade).** Rejected: an instant gain jump on a live insert is a click, and
  the old path already knew how to avoid that.

## Verification

- `tests/fx-bypass-parameter.test.ts` — the **count gate** (3 assertions). It counts, never
  milliseconds: the runtime instances' **identity** across a toggle, the number of nodes the context
  creates, the number of times an effect **factory** runs, the wet/dry gain values, and the
  compensation delay's write. The latency assertion carries a **positive control** — the same
  effect, live, must show its latency counted — so the gate cannot pass by never counting anything.
- **The gate was verified to have teeth**, in two rounds against the pre-fix behaviour:
  - with the pre-fix signature restored, the runtime-identity and wet/dry assertions fail
    ("the eq factory ran again — the chain was rebuilt", "the dry path must open when the effect is
    bypassed");
  - with the pre-fix latency accounting restored as well, the latency assertion fails
    ("a bypassed effect's latency was counted — the project is misaligned").
- Two pinned contracts were **deliberately changed**, with the reason visible at the pin:
  `tests/fx-meter-state-rebuild.test.ts` (the runtime map no longer shrinks when an effect is
  bypassed) and `tests/e2e/17-mastering-workspace.spec.ts` (a bypassed master insert keeps its
  runtime, live and offline).
- **Outstanding, not verifiable here:** an audible check on a real audio device. This machine has
  no audio output device, so the crossfade's continuity was proven by construction (one time
  constant on both sides, the sum flat by algebra) and by counts, not by ear. The audit's staged
  landing rule (§9) asks for the audible check before the fix reaches users.
