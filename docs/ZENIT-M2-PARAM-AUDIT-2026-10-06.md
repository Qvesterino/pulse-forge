# ZENIT + M2 PARAM AUDIT — 2026-10-06

**Scope:** the five mastering surfaces added since the last full param audit
(2026-09-26/27, 47 effects): **ZENIT** composite (9 macros over 6 stages),
**APEKS** maximizer (6 params), **ŠÍRKA** imager (6), **PRÚD** dynamic EQ
(11) + the `prud` worklet. Method: `docs/NEW-EFFECT-CHECKLIST.md` — the five
death modes, the five registration surfaces, and per-param min/max
responsiveness with a measured metric.

## Verdict table

| Check                                                                               | Result                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration (union, META, EFFECT_ORDER, CORE_EFFECT_ORDER, loader, shipped bundle) | ✅ all five surfaces present; `public/core-worklet.js` registers apeks/sirka/prud                                                               |
| Death mode 1 (blanket disconnect)                                                   | ✅ ZENIT serial chain relinks stage outputs→inputs explicitly; bypass stages pass 1:1                                                           |
| Death mode 3 (dual-scale unregistered)                                              | ✅ no scale bridges needed — every param is single-domain; ZENIT width 0..2 verified against the utility runtime (clamps at 2, not the def's 1) |
| Death mode 4 (per-sample constant per block)                                        | ✅ APEKS/PRÚD coefficients applied per sample; ŠÍRKA one-poles correct                                                                          |
| Death mode 5 (port messages offline)                                                | ✅ all three M2 nodes are AudioParam-only — no port messages exist to lose                                                                      |
| Automation                                                                          | ✅ params ride `setParameterAt` (16th-grid path); no `getAudioParam` needed                                                                     |

## Fixed

### 1. APEKS `release` was a dead knob (inverted one-pole coefficient)

`gr += (grTarget - gr) * relCoef` with `relCoef = exp(-1/(sr·release)) ≈ 1`
moved GR to its target in ONE sample regardless of the knob — probe showed
byte-identical GR trajectories at release 0.05 vs 0.5. Fixed to the correct
blend form `1 - exp(...)`, bundle rebuilt (`build:core-worklets`). This was
the only REAL dead param the browser audit's 12 flags pointed at.

### 2. ZENIT ceiling↔limit state coupling

`apply("ceiling")` moved the limiter ceiling without re-deriving the LIMIT
macro's threshold, so "LIMIT 0 = limiter idle at the ceiling" broke the
moment CEILING moved after LIMIT (and load order depended on the stored
params object's iteration order). Fixed: limit value tracked; ceiling moves
re-derive the threshold; load-order-independent pins added.

### 3. Missing `.d.ts` trio → CI typecheck red on main

The M2 wave committed `tests/m2-dsp.test.ts` importing the three processor
`.js` files without the adjacent `.d.ts` stubs the house pattern requires
(`chorus-processor.d.ts` et al.) — `tsc --noEmit` failed on main since the
M2 landing. Stubs added; typecheck green.

## Design question for the owner (NOT changed)

**APEKS `preserve` audibility window.** The transient share
(`grTransient = gr + preserve·(1−gr)`) only differs from the sustain share
while the fast/slow envelopes disagree, and the ceiling guard clamps exactly
the loud-tip region where `(1−gr)` is large. Across six probe excitation
families (bursts, pad+clicks, sub-ceiling transients, several drive/ceiling
operating points) the best measurable min-vs-max delta was **~6e-4** —
alive, but ~20–40 dB weaker than a 0–100 % panel range implies. Two levers
an owner might consider: a small fast-envelope attack tau (currently
instant, so `r` is only nonzero on rising samples), or letting preserved
tips sit above the ceiling pre-guard. Left as-is — redesigning a fresh
algorithm is an owner decision, not an audit fix.

## Browser-audit "DEAD" flags — 11 of 12 were harness artifacts

`KYX_AUDIT_ONLY=zenit,apeks,sirka,prud` ran the per-param sweep
(`plugin-audit-2026-09-27-zenit_apeks_sirka_prud.report.json`). The generic
steady test signal + single-param sweeps from neutral defaults flagged 12
params dead; targeted excitations proved 11 alive:

| Flag                                         | Why the harness missed it                                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| ŠÍRKA lowFreq/highFreq/mix                   | default widths are 1 = mathematically neutral pass — split points only matter once widths ≠ 1 (user drags WIDTH first)                        |
| APEKS release                                | real bug (fixed above)                                                                                                                        |
| APEKS preserve                               | narrow window (design question above)                                                                                                         |
| PRÚD thresh1/amount1/thresh2/amount2/release | ducking a narrow band of broadband material is inherently sub-threshold on the generic signal; two-tone in-band excitations show large deltas |
| ZENIT limit                                  | 0.0149 delta — by design the clipper catches what the limiter would; mapping verified at write level                                          |

## Pins

`tests/zenit-m2-param-audit.test.ts` (12 specs): all 9 ZENIT macros at BOTH
extremes → exact stage writes; ceiling↔limit coupling incl. load-order
independence; def↔processor `parameterDescriptors` range equality (catches
future name/range drift = death mode #3 in the making); per-param aliveness
for all 23 M2 params with designed excitations; catalog contract for all 32
param defs. 26/26 green across the three families; typecheck EXIT 0.
