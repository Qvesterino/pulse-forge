# ADR 0073 — TSAR: controlled mutations (locks, range, a seed you can re-invoke)

Date: 2026-10-27 · Status: Accepted · Scope: the TSAR patch mutator, the
mutation panel, the mutation audit (a measurement, not a feature)

## Context

The TSAR panel had a deterministic A/B tournament over patch mutations: one
seed produced six variants, the producer compared them blind, and the winner
was applied with one undoable command. That loop worked.

It was, however, a **blind** loop with no control over what the variants were
allowed to do, and — the part that mattered — it could produce variants that
were **numerically different and audibly identical**. The flagship roadmap
names the requirement exactly:

> Varianty sú odlišné aj zvukovo; iba odlišné číselné hodnoty nie sú dôkazom
> kvality.

The measurement in `tests/tsar/mutation-audibility.test.ts` shows what that
means in practice. The default TSAR patch has Source B at level 0, and the
mutator's axis pool contained **eleven** `srcB*` axes. Moving a silent
source's parameters changes the patch's numbers and no sound at all. The
same held for `srcASpread` with one unison, for the filter's Q behind an open
filter, for the stereo width of a centred source, for the noise colour
without noise, and for the LFO when no mod slot uses it.

Measured over 240 variants, **two produced a bit-identical signal** — a
different patch that sounded exactly like the original. The criterion was
violated by the product, not merely unproven.

## Decision

### 1. A parameter GROUP taxonomy, and locks on it

`src/tsar/mutations.ts` now carries `MUTATION_GROUP_PARAMS`: six groups that
are a **partition** of the 76 shipped TSAR parameters.

| Group        | What it holds                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `source`     | the two sources, their engines, levels, pans, spreads, morphs, and the shared `morph`/`sub`/`noise` generators |
| `tuning`     | the pitch anchors: root, coarse, fine, glide, drift                                                            |
| `envelope`   | the two ADSRs and the velocity response                                                                        |
| `filter`     | the two filters: type, cutoff, Q, filter envelope                                                              |
| `modulation` | the mod matrix, the global LFO, the arpeggiator                                                                |
| `character`  | the output stage: tone, drive, width, level                                                                    |

A locked group is **removed from the axis pool**, so its parameters are
bit-identical in every variant — not "restored afterwards", never written at
all. The partition is asserted by a test: every shipped parameter belongs to
exactly one group, and no group names a parameter that does not exist.

### 2. The RANGE decides how much of the patch changes — not how far

The range scales the **breadth** (how many axes a variant may touch), from
one or two axes at the gentlest stop to the full three-to-six at `FULL`. The
**reach** keeps at least half of an axis's weight even at the gentlest stop.

That was not the first design. The first attempt scaled the reach, and the
measurement rejected it: a move scaled to a seventh of its weight changes a
number and not a sound, and the variants collapsed into "inaudible" long
before the reach reached zero. Breadth keeps every individual move
musically meaningful, and `range = 1` reproduces the pre-wave-4 selection and
reach exactly — the control adds capability instead of changing the default.

### 3. The SEED is visible, editable, and the run is kept

The panel shows the **full** seed (the old button showed only its last five
digits, which is not a seed you can re-invoke). The seed can be typed back in,
and every run is recorded with its key — seed + range + locks — so the same
variations can be brought back later, even after the patch has moved on. The
key also travels with the winner's history label, so the project's own
history carries what is needed to re-invoke it.

### 4. The mutator never touches an axis the engine cannot hear

`isMutationAxisLive` decides, from the patch and from the DSP's own rules,
whether an axis can be heard at all. The rules are read off the processor, not
off taste:

- a slot with LEVEL 0 is silent — the processor scales the source by
  `levelA`/`levelB`;
- `srcAMorph`/`srcBMorph` select the **wavetable** frame — the granular engine
  returns before reading them and the sampler's branch ignores them;
- `srcASpread`/`srcBSpread` only detune when UNISON > 1;
- the global `morph` blends A against B, so it needs B to sound at all;
- `noiseColor` only colours noise that is there;
- the stereo **width** works on the side signal, and the side signal is
  proportional to `panR − panL` — a centred source has no side, so the width
  does nothing;
- an **open filter** passes everything, so its Q, its type and its envelope
  amount change no sound (the cutoff's maximum IS the default, so this is the
  common case);
- the LFO reaches the sound only through a mod slot that uses it;
- a glide at or below the engine's own threshold (0.001) is ignored, so a
  mutation that lands there is not applied either
  (`isMutationValueAudible`).

### 5. A variant must move something whose effect does not depend on the spectrum

A filter cutoff moved while the filter is open may land in a region that does
not bite. Every other axis changes the sound whatever the source's spectrum
is. A variant that moved **only** spectrum-dependent axes is therefore not
offered at all.

### 6. The audit is a measurement with controls, and it is the proof

`tests/tsar/mutation-audit.ts` renders patches through the **real** processor
(no AudioContext, no worklet host) and measures the difference in the sound,
using the engine test's own relative-difference formula generalised to
stereo. The gate `tests/tsar/mutation-audibility.test.ts` carries its
controls:

| Control                                                    | Measured      | What it proves                            |
| ---------------------------------------------------------- | ------------- | ----------------------------------------- |
| A patch against itself                                     | **exactly 0** | the measure does not invent differences   |
| A patch differing only in a **silent** source's parameters | **exactly 0** | the trap is real, and the measure sees it |
| A patch whose timbre really changed                        | **0.33**      | a real difference is far above zero       |

## Evidence (measured, not asserted)

The sweep: 240 variants per range, 4 ranges, 960 variants in total, each
rendered through the real processor (`scratch/measure-mutation-audit.mts`,
2026-10-27).

| Range           | weakest | 10th percentile | median | identical |
| --------------- | ------- | --------------- | ------ | --------- |
| `FULL` (1)      | 0.0083  | 0.165           | 1.41   | **0**     |
| `BOLD` (0.75)   | 0.0121  | 0.135           | 0.80   | **0**     |
| `MEDIUM` (0.5)  | 0.0011  | 0.038           | 0.68   | **0**     |
| `SUBTLE` (0.25) | 0.0004  | 0.014           | 0.20   | **0**     |

Before the rules of this ADR, **2 of 48** sampled variants rendered
bit-identical to the original. After them, **0 of 960**.

Two honest limits of the measure:

- It is an **energy** difference over the whole render. A slow envelope
  change is under-weighted by it — a variant whose decay moved 21 % can score
  as low as 0.008 even though the change is perceptible. The measure is a
  lower bound on the perceptual difference, not a model of hearing.
- The liveness rules work on **parameters**. An asset-dependent fact — a
  wavetable that happens to hold a single frame, which would make
  `srcAMorph` inert — is invisible to them.

## Consequences

- The producer can freeze any group of parameters and hear that the group did
  not move.
- The producer can choose how much of the patch changes, from one or two axes
  to six.
- The producer can read the seed, write it back, and get the same variations.
- A mutation run is recorded with its key, and the key travels with the
  applied patch.
- **The mutator no longer offers variants that sound like the original.**
- The panel grew three small control rows. It is a panel of controls, not an
  essay: a row of chips, a seed field, and a row of recent runs.

## Bundle cost (measured, isolated)

Both numbers come from the SAME tree built twice — the parent `03d845d0`
and that parent plus this wave's source changes — in one isolated worktree,
so a parallel session's concurrent commits cannot contaminate the delta.

|                  | Before  | After   | Delta                       |
| ---------------- | ------- | ------- | --------------------------- |
| DAW JS sum       | 5801 KB | 5807 KB | **+6 KB** (ceiling 5630 KB) |
| Studio boot path | 2191 KB | 2191 KB | **+0 KB** (ceiling 2200 KB) |
| Shipped JS total | 8304 KB | 8309 KB | +5 KB                       |

The boot path did not move: the mutation panel and the mutator sit behind the
lazy panel chunk, not on the studio's start-up path.

Two facts the budget owner needs, and neither of them is this wave's doing:
the DAW-JS gate was **already red by 171 KB** before this wave (it stood at
5666 KB when wave 3 was measured, and the commits between them added 135 KB),
and the boot path has **only 9 KB of headroom** left. The ceiling was not
raised: the trigger in `scripts/check-bundle-size.mjs` forbids a raise
without a diet, and wave 2's dead-weight audit
(`scripts/audit-dead-weight.mjs`) measured 204 of 204 chunks reachable and 0
modules shipped twice in the main graph — the sum is shipped product.

## What this ADR does NOT change

The TSAR DSP is untouched. The parameter set, the engines and the factory
presets are unchanged. The blind tournament is unchanged — it is still blind,
and the original patch can still be re-heard at any point. Applying a winner
is still ONE `applyInstrumentPatch` command, still one undo step, still
clamped to the parameter ranges.
