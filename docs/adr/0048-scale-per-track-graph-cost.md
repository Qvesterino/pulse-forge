# ADR 0048 — Scale: per-track graph cost and the mixer-worklet path

- **Date:** 2026-10-17
- **Status:** accepted (stages 1–2 implemented; stage 3 gated on the budget)
- **Scope:** audio graph construction, metering taps, PDC taps, arrangement DOM, CI budgets

## Context

KYX claims a complete-DAW surface (`docs/ROADMAP-FULL-DAW.md`), so projects
have to survive far more than a demo beat: 100+ tracks with per-track mixer
strips, group buses, sends and instrument FX chains. The engine builds every
strip eagerly when a project opens (`AudioEngine.syncProject`), which is fine
at 8 tracks and unmeasured at 100.

Before changing anything, we measured with a counting `BaseAudioContext`
(the same fake the engine specs use) — see `tests/engine-graph-census.test.ts`,
which is now a permanent gate:

| scenario                   | nodes before | nodes after | notes                                     |
| -------------------------- | ------------ | ----------- | ----------------------------------------- |
| 1 track                    | 86           | 82          | master chain dominates                    |
| 24 tracks                  | 316          | 266         |                                           |
| 100 dry tracks             | 1076         | **874**     | analysers 209 → 109, delays 103 → 1       |
| 100 tracks, 1 core EQ each | 1776         | 1674        | one EQ = 6 biquads + 1 gain + 1 PDC delay |
| per group bus              | 20           | **8**       | the second, silent strip is gone          |

Two of those numbers were _defects_, not just overhead:

1. Every strip eagerly owned a PRE-fader `AnalyserNode` (+ its 2048-point
   buffers) for a per-strip metering toggle most strips never show, and every
   chain — including chains with no effects at all — owned a PDC `DelayNode`
   that could never need compensation.
2. The track loop in `syncProject` lacked the `kind === "group"` guard its
   sibling routing loop has, so every group was built a **second time** in
   `trackNodes`: a fully wired strip nobody feeds, a duplicated FX chain for
   group effects, and — because the metering accessors read `trackNodes`
   first — a silent analyser that made every group strip's POST and PRE meters
   read 0 forever.

The DOM side was measured too (`tests/ui/arrangement-dom-census.test.tsx`):
the arrangement grid is already windowed (`visibleBarIndices` +
`VIEWPORT_OVERSCAN_BARS`); with a measured viewport a 1004-bar project renders
40 grid cells and 408 elements, and 4× the project length changes nothing. The
unmeasured fallback (hidden panel, jsdom) renders every bar — bounded at ~887
elements for 1000 bars — which is why `MAX_ARRANGEMENT_CLIP_BARS` must stay.

What this does _not_ solve is the per-strip constant itself: 8 nodes per track
is 800 nodes at 100 tracks before a single effect or send, and a real browser
pays far more per `createGain`/`connect` than the counting fake does.

## Decision

1. **Lazy taps.** The PRE-fader analyser is allocated on first read
   (`ensurePreAnalyser`); the PDC delay exists only for chains that contain a
   non-bypassed effect. Behaviour on first use is identical (a fresh analyser
   reports zeros, a zero-delay delay node passes audio through).
2. **One strip per owner.** A group id lives in `groupNodes` only; the
   duplicate `trackNodes` strip is not built. All lookups that can receive a
   group id resolve through the group (metering already fell back; the post-FX
   tap accessor now does too).
3. **Budgets as tests, not prose.** `tests/engine-graph-census.test.ts` fails
   when the graph grows past the measured budget per track, per effect and per
   group, and when a group id reappears in `trackNodes`;
   `tests/ui/arrangement-dom-census.test.tsx` fails when the rendered grid
   starts following the project's length or the per-clip DOM cost grows.
4. **Stage 3 (not implemented here): a mixer-worklet path.** Consolidating N
   track chains into one mixer AudioWorklet is the only structural fix for the
   per-strip constant. It is explicitly _not_ part of this change: it rewrites
   the most safety-critical boundary in the codebase (ADR 0004) and must land
   behind its own ADR amendment, with the census gate as the acceptance
   instrument:
   - the worklet must keep the same inputs/outputs (strip input, master out,
     per-send outs) so `useContext(ctx)` stays the only graph path;
   - live/offline parity must be re-proven by the render-parity harness
     (invariant 3), not assumed;
   - PDC, solo/mute, metering taps and sidechain inputs must be expressed
     inside the processor before any wiring is swapped;
   - acceptance: the census gate's numbers must _drop_ by ≥ 5 nodes per track
     with byte-identical render output on the golden projects.

## Consequences

- 100 dry tracks cost 19 % fewer nodes (1076 → 874) and 100 fewer analysers and
  102 fewer delay nodes; each group bus costs 8 instead of 20.
- Group strips' meters now read the audible group tap instead of a silent
  orphan — the first user-visible fix to fall out of the census.
- The fallback path (unmeasured viewport) remains O(bars); the DOM gate pins
  its ceiling, and windowing is pinned for the measured path.
- Adding a per-track node now requires either fitting the budget or updating
  the gate with a measured justification — the same rule the bundle budgets
  already enforce for JS size.
