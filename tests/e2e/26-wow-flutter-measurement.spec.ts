import { expect, test, type Page } from "playwright/test";

/**
 * WOW & FLUTTER — measured behaviour in a real browser (2026-10-12).
 *
 * The effect's whole product claim is that its depth control reads in CENTS
 * and delivers that pitch deviation. No unit test can check that against the
 * shipped bundle, so this spec renders the REAL worklet in Chromium and
 * measures it.
 *
 * ── Why this measures DELAY, not pitch ──────────────────────────────────────
 * The first version of this spec counted zero crossings per window on a 440 Hz
 * sine and reported the deviations from those. That instrument is too coarse for
 * the thing it is claiming:
 *
 *   - a 60 ms window holds ~26 crossings, so frequency quantises in ~4% steps
 *     (~66 cents). "The effect does a little" and "the effect does nothing" are
 *     indistinguishable readings;
 *   - a small, slightly noisy envelope reads as a fast sign-flipping series, so
 *     a requested 1 Hz wobble came out as 1.91 Hz;
 *   - quadrature demodulation is finer but the analytic signal of a real sine
 *     carries a DC term of -j*A/4 and a counter-rotating term at 2*f0; what
 *     leaks through a finite window rotates at 2*f0. Calibrated on a pure 440 Hz
 *     sine through NOTHING, it reported 13.8 cents at 880 Hz.
 *
 * The effect modulates a delay, so measure the delay. Feed isolated impulses:
 * the read is a LINEAR interpolation between two ring samples, so an impulse of
 * amplitude 1 at fractional position f lands as exactly [1-f, f] — the two
 * samples sum to 1, which makes the amplitude CENTROID recover f with no
 * interpolation bias at all. Pitch then follows analytically from the read
 * position r(t) = t - D(t):
 *
 *     frequency ratio = dr/dt = 1 - dD/dt        (dD/dt is dimensionless)
 *
 * Every threshold below is set from a measurement, and the measurement includes
 * a calibration row: the same probe through a pass-through must read 0.00 cents,
 * otherwise nothing else in this file means anything.
 *
 * Claims checked here:
 *   - depth 0 / drift 0 is TRANSPARENT: exactly zero deviation, constant delay
 *   - depth N delivers N cents, at the requested rate
 *   - drift adds a bounded slow wander, not a pitch catastrophe
 *   - the worst corner never wraps the read pointer
 *   - both channels stay bit-identical (in-phase stereo)
 */

const SR = 44100;
const WORKLET_URL = "/core-worklet.js";
const IMPULSE_HZ = 200;

interface Reading {
  /** Deviation amplitude in cents (rms * sqrt(2) — see the note on the peak). */
  amplitude: number;
  p95: number;
  rateHz: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  impulses: number;
  leftRightDelta: number;
}

/** Analyzer source, injected into the page. Mirrors the logic in
 *  tests/wow-flutter.test.ts, which runs the same measurement headlessly. */
const ANALYZER = `
function analyseDelay(left, sr, impulseSamples, seedDelaySamples, trainStart, trainCount) {
  const n = left.length;
  const centroid = (from, to) => {
    // Integer bounds are load-bearing: seedDelaySamples is fractional, and a
    // non-integer loop start makes every array read undefined.
    let imax = -1, best = 0;
    const lo = Math.max(0, Math.ceil(from)), hi = Math.min(n - 1, Math.floor(to));
    for (let i = lo; i <= hi; i++) {
      const v = Math.abs(left[i]);
      if (v > best) { best = v; imax = i; }
    }
    if (imax < 0 || best < 0.5) return NaN;
    let num = 0, den = 0;
    for (let i = imax - 1; i <= imax + 2; i++) {
      const v = left[i];
      if (v > 0) { num += i * v; den += v; }
    }
    return den > 0 ? num / den : NaN;
  };

  const deltas = [];
  let prevD = seedDelaySamples;
  const SEARCH = Math.floor(impulseSamples / 2) - 6;
  for (let k = 0; k < trainCount; k++) {
    const w = trainStart + k * impulseSamples;
    if (w >= n - 4) break;
    const seed = w + prevD;
    const c = centroid(seed - SEARCH, seed + SEARCH);
    if (!Number.isFinite(c)) continue;
    prevD = c - w;
    deltas.push(prevD);
  }
  if (deltas.length < 8) return null;

  const hop = impulseSamples / sr;
  const cents = [];
  for (let i = 1; i < deltas.length; i++) {
    const ratio = 1 - (deltas[i] - deltas[i - 1]) / hop / sr;
    if (ratio > 0) cents.push(1200 * Math.log2(ratio));
  }
  const rms = Math.sqrt(cents.reduce((a, c) => a + c * c, 0) / cents.length);
  const abs = cents.map(Math.abs).sort((a, b) => a - b);
  let crossings = 0;
  for (let i = 1; i < cents.length; i++) {
    if ((cents[i - 1] <= 0 && cents[i] > 0) || (cents[i - 1] >= 0 && cents[i] < 0)) crossings++;
  }
  return {
    // A sinusoidal deviation of amplitude A has rms A/sqrt(2). rms is the robust
    // estimator: the single-sample peak over-read by ~1.9x on a lightly sampled
    // quasi-sine, while rms tracked the request to within 1%.
    amplitude: rms * Math.SQRT2,
    p95: abs[Math.floor(abs.length * 0.95)],
    rateHz: crossings / 2 / (((cents.length + 1) * impulseSamples) / sr),
    minDelaySeconds: Math.min.apply(null, deltas) / sr,
    maxDelaySeconds: Math.max.apply(null, deltas) / sr,
    impulses: deltas.length,
  };
}
`;

async function measure(page: Page, params: Record<string, number>, seconds: number, bypass = false): Promise<Reading> {
  return page.evaluate(
    async ({ params, seconds, sr, url, impulseSamples, analyzerSrc, bypass }) => {
      const analyse = new Function(`${analyzerSrc}; return analyseDelay;`)();
      const frames = Math.ceil(seconds * sr);
      const impulseSamples2 = impulseSamples;
      const trainStart = Math.floor(0.3 * sr);
      const seedAt = trainStart - 10 * impulseSamples2;

      const build = async (f: number) => {
        const ctx = new OfflineAudioContext(2, f, sr);
        if (!bypass) await ctx.audioWorklet.addModule(url);
        const node = bypass
          ? null
          : new AudioWorkletNode(ctx, "wowflutter-processor", {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              outputChannelCount: [2],
              channelCount: 2,
              channelInterpretation: "speakers",
              processorOptions: { seed: 12345 },
            });
        if (node)
          for (const [k, v] of Object.entries(params)) {
            const p = node.parameters.get(k);
            if (p) p.value = v;
          }
        return { ctx, node };
      };

      // --- seed render: ONE impulse, nothing else, so its delay is unambiguous.
      const seedFrames = seedAt + Math.floor(0.1 * sr);
      const sg = await build(seedFrames);
      const sbuf = sg.ctx.createBuffer(2, seedFrames, sr);
      sbuf.getChannelData(0)[seedAt] = 1;
      sbuf.getChannelData(1)[seedAt] = 1;
      const ssrc = sg.ctx.createBufferSource();
      ssrc.buffer = sbuf;
      if (sg.node) ssrc.connect(sg.node).connect(sg.ctx.destination);
      else ssrc.connect(sg.ctx.destination);
      ssrc.start(0);
      const seedOut = await sg.ctx.startRendering();
      const seedL = seedOut.getChannelData(0);
      let at = -1;
      for (let i = seedAt; i < seedFrames; i++) {
        if (Math.abs(seedL[i]) > 0.5) {
          at = i;
          break;
        }
      }
      if (at < 0) throw new Error("seed impulse never came out — the effect dropped it");
      let sn = 0;
      let sd = 0;
      for (let i = at - 1; i <= at + 2; i++) {
        const v = seedL[i];
        if (v > 0) {
          sn += i * v;
          sd += v;
        }
      }
      const seedDelay = sn / sd - seedAt;

      // --- train render
      const lastWrite = frames - Math.ceil(0.08 * sr);
      const trainCount = Math.max(0, Math.floor((lastWrite - trainStart) / impulseSamples2));
      const g = await build(frames);
      const buf = g.ctx.createBuffer(2, frames, sr);
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      for (let k = 0; k < trainCount; k++) {
        const w = trainStart + k * impulseSamples2;
        L[w] = 1;
        R[w] = 1;
      }
      const src = g.ctx.createBufferSource();
      src.buffer = buf;
      if (g.node) src.connect(g.node).connect(g.ctx.destination);
      else src.connect(g.ctx.destination);
      src.start(0);
      const out = await g.ctx.startRendering();
      const left = out.getChannelData(0);
      const right = out.getChannelData(1);

      const r = analyse(left, sr, impulseSamples2, seedDelay, trainStart, trainCount);
      if (!r) throw new Error("delay tracking lost the impulse train");
      let diff = 0;
      for (let i = 0; i < frames; i++) diff += Math.abs(left[i] - right[i]);
      return { ...r, leftRightDelta: diff / frames, written: trainCount };
    },
    {
      params,
      seconds,
      sr: SR,
      url: WORKLET_URL,
      impulseSamples: Math.round(SR / IMPULSE_HZ),
      analyzerSrc: ANALYZER,
      bypass,
    },
  );
}

test.describe("wow & flutter", () => {
  test("CALIBRATION — the probe reads zero on a pass-through", async ({ page }) => {
    await page.goto("/", { waitUntil: "commit" });
    // Without this row every other number in this file is uninterpretable: a
    // broken probe is indistinguishable from a broken effect.
    const read = await measure(page, {}, 3, true);
    console.log(`[wow] CALIBRATION passthrough = ${read.amplitude.toFixed(3)} cents`);
    expect(read.amplitude).toBeLessThan(0.01);
    expect(read.maxDelaySeconds).toBeLessThan(1e-6);
  });

  test("depth 0 is transparent — no wobble leaks in", async ({ page }) => {
    await page.goto("/", { waitUntil: "commit" });
    const read = await measure(page, { wowDepth: 0, flutterDepth: 0, drift: 0, wowRate: 0.5, mix: 1 }, 3);
    console.log(
      `[wow] depth=0 amplitude = ${read.amplitude.toFixed(3)} cents, delay = ${(read.minDelaySeconds * 1000).toFixed(3)} ms`,
    );
    // With every depth at zero the delay must be a constant: the wobble terms
    // are all off, so dD/dt is identically zero.
    expect(read.amplitude).toBeLessThan(0.01);
    expect(read.maxDelaySeconds - read.minDelaySeconds).toBeLessThan(1e-6);
    // In-phase modulation: the two channels must stay identical.
    expect(read.leftRightDelta).toBeLessThan(1e-9);
  });

  test("depth is measured in cents and reaches the requested depth", async ({ page }) => {
    await page.goto("/", { waitUntil: "commit" });
    for (const depth of [10, 30]) {
      const read = await measure(page, { wowDepth: depth, flutterDepth: 0, drift: 0, wowRate: 0.5, mix: 1 }, 6);
      console.log(
        `[wow] requested ${depth} c -> measured ${read.amplitude.toFixed(2)} c at ${read.rateHz.toFixed(2)} Hz`,
      );
      expect(read.impulses).toBeGreaterThan(200);
      // Measured 9.86 for 10 and 29.69 for 30. The band is set from that, with
      // margin for the browser's own rendering — NOT from the knob.
      expect(read.amplitude).toBeGreaterThan(depth * 0.8);
      expect(read.amplitude).toBeLessThan(depth * 1.2);
      expect(read.rateHz).toBeGreaterThan(0.4);
      expect(read.rateHz).toBeLessThan(0.7);
    }
  });

  test("the wobble runs at the requested rate", async ({ page }) => {
    await page.goto("/", { waitUntil: "commit" });
    for (const [rate, lo, hi] of [
      [1, 0.9, 1.1],
      [2, 1.85, 2.15],
    ] as const) {
      const read = await measure(page, { wowDepth: 25, flutterDepth: 0, drift: 0, wowRate: rate, mix: 1 }, 8);
      console.log(`[wow] requested ${rate} Hz -> measured ${read.rateHz.toFixed(3)} Hz`);
      expect(read.rateHz).toBeGreaterThan(lo);
      expect(read.rateHz).toBeLessThan(hi);
      expect(read.amplitude).toBeGreaterThan(22);
      expect(read.amplitude).toBeLessThan(28);
    }
  });

  test("flutter reaches its own depth at its own rate", async ({ page }) => {
    await page.goto("/", { waitUntil: "commit" });
    const read = await measure(page, { wowDepth: 0, flutterDepth: 10, drift: 0, flutterRate: 11, mix: 1 }, 6);
    console.log(`[wow] flutter 10 c -> ${read.amplitude.toFixed(2)} c at ${read.rateHz.toFixed(2)} Hz`);
    expect(read.amplitude).toBeGreaterThan(8);
    expect(read.amplitude).toBeLessThan(12);
    expect(read.rateHz).toBeGreaterThan(10);
    expect(read.rateHz).toBeLessThan(12);
  });

  test("drift is a bounded slow wander, not a pitch catastrophe", async ({ page }) => {
    await page.goto("/", { waitUntil: "commit" });
    const off = await measure(page, { wowDepth: 0, flutterDepth: 0, drift: 0, mix: 1 }, 6);
    const on = await measure(page, { wowDepth: 0, flutterDepth: 0, drift: 1, mix: 1 }, 6);
    console.log(
      `[wow] drift=0 ${off.amplitude.toFixed(2)} c (delay ${(off.minDelaySeconds * 1000).toFixed(2)} ms) -> ` +
        `drift=1 ${on.amplitude.toFixed(2)} c (delay ${(on.minDelaySeconds * 1000).toFixed(2)}..${(on.maxDelaySeconds * 1000).toFixed(2)} ms)`,
    );
    // Drift must be audible as a wander...
    expect(on.amplitude).toBeGreaterThan(0.2);
    // ...and bounded. It used to be 35% of the whole 56 ms ring, which swung the
    // delay by 19.6 ms and measured at 650 cents.
    expect(on.amplitude).toBeLessThan(8);
    expect(on.maxDelaySeconds - on.minDelaySeconds).toBeLessThan(0.002);
    // And it must be a SLOW wander, so the envelope rate stays low.
    expect(on.rateHz).toBeLessThan(4);
  });

  test("extreme corner: the read pointer never wraps ahead of the write", async ({ page }) => {
    await page.goto("/", { waitUntil: "commit" });
    // Slowest rate with the deepest depth is where a naive implementation asks
    // the delay for more swing than the ring has and wraps the read pointer to
    // the far end of the buffer.
    const read = await measure(
      page,
      { wowRate: 0.05, wowDepth: 60, flutterRate: 60, flutterDepth: 20, drift: 1, mix: 1 },
      8,
    );
    console.log(
      `[wow] extreme corner delay = ${(read.minDelaySeconds * 1000).toFixed(2)}..${(read.maxDelaySeconds * 1000).toFixed(2)} ms, dLR = ${read.leftRightDelta.toExponential(1)}`,
    );
    // If the read wrapped, the delay would land near the far side of the ring
    // (DELAY_SECONDS = 60 ms) and the two channels would disagree.
    expect(read.minDelaySeconds).toBeGreaterThan(0);
    expect(read.maxDelaySeconds).toBeLessThan(0.03);
    expect(read.leftRightDelta).toBeLessThan(1e-9);
    // Every impulse survives: a wrap drops or doubles events.
    expect(read.impulses).toBeGreaterThan(200);
  });
});
