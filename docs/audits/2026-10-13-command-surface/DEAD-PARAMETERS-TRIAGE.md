# Dead parameters — what the 2026-09-27 audit actually measured

**Date:** 2026-10-14 · **Repo:** KYX · **Class:** audit-instrument repair (not a product defect list)
**Status:** 5 of 5 dynamics effects re-measured in real Chromium. **The headline finding is that most
"dead parameters" were never dead — the instrument could not excite them.**

---

## 1. The claim under test

`docs/PLUGIN-AUDIT-2026-09-27.md` reports 28 effects with parameters whose sweep delta is ≤ 2 %, and
**72 parameters whose render is BIT-IDENTICAL at min and max** (`delta === 0`). The report reads as
"these knobs do nothing". The repair task was: wire them up.

Before changing a single product line, the claim was measured directly.

## 2. Measured result: the wiring is fine

`scripts/probe-worklet-param-wiring.mjs` renders the gate worklet in real Chromium, same signal, two
stimuli, three parameter-write styles:

| gate param | continuous tone | burst stimulus |
| ---------- | --------------- | -------------- |
| threshold  | 0 %             | **40.9 %**     |
| hold       | 0 %             | **11.0 %**     |
| range      | 0 %             | **20.4 %**     |
| mix        | 0 %             | **32.7 %**     |
| attack     | 0 %             | **0.5 %**      |
| hysteresis | 0 %             | **1.6 %**      |
| release    | 0 %             | **40.9 %**     |

Seven of the eight parameters the audit calls dead are wired, working, and move the render by up to
41 %. The registry applies them (`createWorkletRuntime` → `safeApplyAudioParam`), the worklet declares
all eight, and `process()` reads all eight.

**The audit's test tone cannot close a gate.** It is a continuous sine+saw with one 250 ms kick at the
start; after that it never falls below any threshold, so the device never engages and every
threshold/range/hold/release parameter is correctly _inert for that signal_.

### The hypothesis I had to abandon

The first suspicion was that `setValueAtTime(value, ctx.currentTime)` lands at `t = 0` in an
`OfflineAudioContext` (where `currentTime` is 0 until rendering) and loses to the descriptor defaults.
**Falsified by measurement:** direct `.value` assignment and `setValueAtTime` at `currentTime` produced
_identical_ deltas for every parameter. The write path is fine.

### The measurement that was wrong twice

My own probe was wrong before the product was. `dyn = block-RMS hi/lo` is blind to gate _timing_ — a
burst signal already has a huge hi/lo ratio, so an open gate and a closed one score the same. And the
first burst had a 220 ms gap, too short for the shipped 20 ms hold + 80 ms release to pull the
one-pole envelope below a −36 dB threshold: a _correctly open_ gate read as inert. Only a 1.7 s gap
with a gap-depth metric showed the gate closing (−69.94 dB → −102.38 dB).

This is recorded because it is the trap the whole dead-parameter column sits in: **a metric that
cannot see the thing it names reports "dead" just as confidently as a broken wire.**

## 3. Repair: a second stimulus, not a second guess

`src/plugin-audit-checks.ts` now sweeps level-over-time effects against a burst stimulus as well as the
tone, takes the best delta, and records WHICH stimulus won (`ParamAudit.stimulus`). The metrics are
untouched, and because the best-of-two can only turn a false negative into a true positive, the change
cannot invent a pass.

The harness already knew this failure mode — it documents it for the vocoder: _"without a modulator
feed … every sidechain ducking knob is legitimately inert"_ (`buildModulatorBuffer`). That fix was
applied to the modulator input and never to the main sweep signal.

### Measured, after (`KYX_AUDIT_ONLY=gate,compressor,limiter,duckDelay,transient`)

| effect     | dead before | dead after | what the remainder is                                                                    |
| ---------- | ----------- | ---------- | ---------------------------------------------------------------------------------------- |
| gate       | 7           | **2**      | attack, lookahead — both change _timing_, which no RMS/side/centroid/dyn metric measures |
| compressor | 1           | 2          | scHpf + scBandHz — **companion-gated** (see below)                                       |
| limiter    | 4           | 4          | not excited: the stimulus peaks at −9 dBFS, its threshold sits above that                |
| duckDelay  | 2           | 2          | needs a tail-length metric, not a level metric                                           |
| transient  | 0           | 0          | —                                                                                        |

**The compressor count going UP is the proof the fix works in both directions:** `scBandHz` was masked
by the old stimulus, and the new one exposed it.

## 4. Triage classes — what a "dead parameter" actually means here

1. **Stimulus-inadequate (fixed).** Dynamics family against a tone that never crosses its threshold.
2. **Companion-gated (correct by design).** `scBandHz` only enters the circuit when `scMode = 1`
   (`compressor-processor.js:64`); the shipped default is `0`, so sweeping `scBandHz` alone cannot
   change a sample. Same shape as an EQ band's frequency while its gain is 0 dB, and `scHpf`'s band
   range is degenerate in the mode it runs in. **No code change — the sweep must engage the companion.**
3. **Metric-blind.** Timing-only parameters (`attack`, `lookahead`) and texture parameters: the four
   metrics are level/spectrum aggregates and cannot see _when_.
4. **Not excited by this stimulus.** Limiter (needs a hot signal), duckDelay (needs a tail metric).

## 5. A second, separate artefact — found, not yet repaired

Four bar-synced effects produce output identical to dry in the isolated factory sweep
(`bypassDelta === 0`) while **processing normally in the host render**:

| effect         | sweep `bypassDelta` | `hostDelta` (host render)       |
| -------------- | ------------------- | ------------------------------- |
| beatMangler    | 0                   | 0.489                           |
| reverseSwell   | 0                   | 4.1e-9 (`hostProcesses: false`) |
| tapeStop       | 0                   | 0.373                           |
| granularFreeze | 0                   | 0.509                           |

The sweep calls `rt.onTransportStarted?.(0, 0)` once and renders; the host path advances the transport.
A longer signal does not help (`signalSecondsFor` already gives these 4.4 s). This is a different cause
from §3 — a clock that never ticks, not a signal that never engages — and it is **NOT VERIFIED** which
side is at fault. It is recorded rather than guessed at.

## 6. What this does not do

- **No product code was changed.** Nothing here was broken; the instrument was.
- The 2026-09-27 report is **not** rewritten. Its dead-parameter column is stale and should be
  re-measured, but overwriting history with a rerun that changes the instrument would hide which
  verdicts moved for which reason.
- `limiter`, `duckDelay` and the bar-synced family remain **NOT VERIFIED**. A rerun needs stimuli and
  metrics designed for them, and each needs its own measurement rather than another general pass.

## 7. Reproduce

```
node scripts/probe-worklet-param-wiring.mjs                     # the two-stimulus probe
KYX_AUDIT_ONLY=gate,compressor,limiter,duckDelay,transient \
  node scripts/verify-plugin-audit.mjs                           # the re-measured audit
# evidence: docs/plugin-audit-2026-09-27-gate_compressor_limiter_duckDelay_transient.report.json
```
