/**
 * FXEQ real-time performance gate (load-calibrated).
 *
 * The audio rendering thread gets ~2.67 ms per 128-sample block at 48 kHz.
 * A single fxeq instance with every module active (4× oversampled
 * saturation, M/S, dynamic EQ, delay, reverb, limiter) must stay far below
 * that — and the gate must survive CI machines of wildly different speed
 * AND concurrent load (other workers, parallel agents), which inflates
 * absolute wall-clock times several-fold.
 *
 * Design: cost is asserted as a RATIO against a passthrough calibration run
 * measured back-to-back in the same process (identical outer path:
 * sanitize → DC-block → crossover). The heavy/passthrough ratio measured
 * 7.5–13.6 across runs and machine loads, while absolute times swung 3×.
 * Budgets sit ~1.6× above the worst observed ratio, so a genuine DSP
 * regression (reintroduced per-block allocation, per-block coefficient
 * redesign) breaches the gate even though wall-clock noise cannot.
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";
import { FXEQ_PRESETS } from "../src/effects/fxeq-core/core/presets";

const SR = 48000;
const BLOCK = 128;
const WARMUP_BLOCKS = 500;
const MEASURE_BLOCKS = 1000;
const TIMED_RUNS = 3; // best-of runs — transient spikes must not flake the gate

/** Measured heavy/passthrough ratio 7.5–13.6 (see header). Gate at ~1.6× the worst. */
const BUDGET_MEDIAN_RATIO = 22;
const BUDGET_P95_RATIO = 25;
/** Preset load vs passthrough block: measured worst ≈ 2.3–16×, budget above the band. */
const BUDGET_LOAD_RATIO = 35;
/**
 * Morphing vs idle blocks of the same processor. 2026-09-05 recalibration
 * (Q3): the probe targets EVERY schema id, so the per-block routed-entry
 * count grew ~15% when the band-EQ surface landed — measured 1.45–1.65× at
 * the old schema size, 1.84–2.21× after (the spread is machine load; idle
 * cost itself swings 2× between runs). Budget 2.4× still discriminates the
 * pathology this gate exists for — the old per-block applyAllParams() path
 * (full schema walk + crossover stage rebuild) measured ~2.4× at HALF the
 * current schema size and would exceed 4× today.
 */
const BUDGET_MORPH_RATIO = 2.4;

type Proc = ReturnType<typeof createFxEqProcessor>;

function deterministicChannels(): Float32Array[] {
  // Broadband noise — exercises the nonlinear oversampled paths harder
  // than a pure tone. Preallocated + reused so the timed loops allocate
  // nothing.
  let seed = 0x9e3779b9;
  const noise = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 0x100000000) * 2 - 1;
  };
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    l[i] = noise() * 0.8;
    r[i] = noise() * 0.8;
  }
  return [l, r];
}

function enableEverything(proc: Proc): void {
  for (const def of proc.parameterDefs) {
    // Every creative module on, in every band.
    if (/(sat|dyn|lofi|mod|delay|rev)Enabled$/.test(def.id)) proc.setParameter(def.id, 1);
    // Saturation at max drive + high quality → 4× oversampling path.
    if (/^band\d+\.satDriveDb$/.test(def.id)) proc.setParameter(def.id, 24);
    if (/^band\d+\.quality$/.test(def.id)) proc.setParameter(def.id, 2);
    // Dynamic EQ (band scalar) + M/S encoding on every band.
    if (/^band\d+\.dynEnable$/.test(def.id)) proc.setParameter(def.id, 1);
    if (/^band\d+\.midSide$/.test(def.id)) proc.setParameter(def.id, 1);
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Best-of-N median+p95 block cost in µs. */
function measure(proc: Proc, channels: Float32Array[]): { median: number; p95: number } {
  for (let i = 0; i < WARMUP_BLOCKS; i++) proc.process(channels, BLOCK);
  let median = Infinity;
  let p95 = Infinity;
  for (let run = 0; run < TIMED_RUNS; run++) {
    const perBlockUs: number[] = [];
    for (let i = 0; i < MEASURE_BLOCKS; i++) {
      const t0 = performance.now();
      proc.process(channels, BLOCK);
      perBlockUs.push((performance.now() - t0) * 1000);
    }
    perBlockUs.sort((a, b) => a - b);
    const runMedian = percentile(perBlockUs, 50);
    if (runMedian < median) {
      median = runMedian;
      p95 = percentile(perBlockUs, 95);
    }
  }
  return { median, p95 };
}

describe("fxeq real-time performance gate", () => {
  it("keeps a fully-loaded 6-band instance within the calibrated cost ratio", () => {
    const channels = deterministicChannels();

    // Calibration: identical outer path, no creative modules.
    const passthrough = createFxEqProcessor();
    passthrough.prepare(SR, 2, BLOCK);
    passthrough.loadParameters({ limiterEnabled: 0, globalMix: 0 });
    const pass = measure(passthrough, channels);

    // Fully-loaded instance.
    const heavy = createFxEqProcessor();
    heavy.prepare(SR, 2, BLOCK);
    enableEverything(heavy);
    const full = measure(heavy, channels);

    const medianRatio = full.median / pass.median;
    const p95Ratio = full.p95 / pass.p95;
    console.info(
      `[fxeq-perf] passthrough=${pass.median.toFixed(0)}µs (p95 ${pass.p95.toFixed(0)}) ` +
        `fully-loaded=${full.median.toFixed(0)}µs (p95 ${full.p95.toFixed(0)}) — ` +
        `ratios ${medianRatio.toFixed(1)}/${p95Ratio.toFixed(1)} (budget ${BUDGET_MEDIAN_RATIO}/${BUDGET_P95_RATIO})`,
    );
    expect(
      medianRatio,
      `fully-loaded median is ${medianRatio.toFixed(1)}× passthrough (budget ${BUDGET_MEDIAN_RATIO}×) — audio-thread cost regression`,
    ).toBeLessThan(BUDGET_MEDIAN_RATIO);
    expect(
      p95Ratio,
      `fully-loaded p95 is ${p95Ratio.toFixed(1)}× passthrough (budget ${BUDGET_P95_RATIO}×) — periodic allocation/GC churn`,
    ).toBeLessThan(BUDGET_P95_RATIO);

    // Output must stay sane under sustained full load.
    for (let i = 0; i < BLOCK; i++) {
      expect(Number.isFinite(channels[0][i])).toBe(true);
      expect(Number.isFinite(channels[1][i])).toBe(true);
    }
  });

  it(`loads every factory preset (${FXEQ_PRESETS.length}) within the calibrated budget`, () => {
    // loadParameters runs on the audio rendering thread (worklet message
    // port). Presets that change bandCount rebuild the schema + crossover —
    // the defById index keeps the per-param clamping in the µs range where
    // the O(n²) defs.find scan it replaced added milliseconds. Min-of-5 per
    // preset filters scheduler/GC noise before the ratio is taken.
    const channels = deterministicChannels();
    const passthrough = createFxEqProcessor();
    passthrough.prepare(SR, 2, BLOCK);
    passthrough.loadParameters({ limiterEnabled: 0, globalMix: 0 });
    const pass = measure(passthrough, channels);

    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.process(channels, BLOCK); // warm path

    let worst = 0;
    let worstId = "";
    for (const preset of FXEQ_PRESETS) {
      let best = Infinity;
      for (let attempt = 0; attempt < 5; attempt++) {
        const t0 = performance.now();
        proc.loadParameters(preset.params);
        const us = (performance.now() - t0) * 1000;
        if (us < best) best = us;
      }
      if (best > worst) {
        worst = best;
        worstId = preset.id;
      }
      proc.process(channels, BLOCK);
    }
    const ratio = worst / pass.median;
    console.info(
      `[fxeq-perf] worst loadParameters: ${worstId} ${worst.toFixed(0)}µs = ${ratio.toFixed(1)}× passthrough (budget ${BUDGET_LOAD_RATIO}×)`,
    );
    expect(
      ratio,
      `preset load (${worstId}) took ${worst.toFixed(0)}µs = ${ratio.toFixed(1)}× passthrough on the audio thread`,
    ).toBeLessThan(BUDGET_LOAD_RATIO);
  });

  it("keeps an active full-state morph within the self-calibrated budget", () => {
    // During a morph every block routes the interpolated parameter set. The
    // path is precompiled at startMorph (see fxEqProcessor) — measured
    // overhead ~64 µs/block over idle vs 139 µs/block for the old per-block
    // applyAllParams (full schema walk + crossover stage rebuild every
    // block). Self-calibration: morph blocks vs the SAME processor's idle
    // blocks, best-of-3 medians each. Budget sits between the new ratio
    // (~1.65×) and the old path (~2.4×).
    const channels = deterministicChannels();
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({ limiterEnabled: 0, globalMix: 100 });
    const idle = measure(proc, channels);

    const target: Record<string, number> = {};
    for (const def of proc.parameterDefs) {
      if (def.id === "bandCount") continue;
      target[def.id] = def.minValue + (def.maxValue - def.minValue) * 0.75;
    }
    proc.startMorph(target, 60); // 60 s — far more blocks than we measure
    const morphing = measure(proc, channels);

    const ratio = morphing.median / idle.median;
    console.info(
      `[fxeq-perf] morph: idle=${idle.median.toFixed(0)}µs morphing=${morphing.median.toFixed(0)}µs ` +
        `(${ratio.toFixed(2)}×, budget ${BUDGET_MORPH_RATIO}×)`,
    );
    expect(
      ratio,
      `morphing blocks cost ${ratio.toFixed(2)}× idle (budget ${BUDGET_MORPH_RATIO}×) — per-block schema work is back on the audio thread`,
    ).toBeLessThan(BUDGET_MORPH_RATIO);
  });
});
