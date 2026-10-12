/**
 * WOW & FLUTTER measurement probe (diagnostic, not a gate).
 *
 * ── Why impulse centroids and not pitch tracking ────────────────────────────
 * Two earlier attempts measured pitch from the rendered sine and both were
 * unreliable:
 *
 *  1. Per-window zero crossings (the original e2e method) quantise to about
 *     1/(cycles-per-window): a 60 ms window at 440 Hz holds ~26 crossings, so
 *     frequency snaps in ~4% steps (~66 cents). It cannot tell "the effect does
 *     nothing" from "the effect does a little", and a small noisy envelope
 *     reads as a fast sign-flipping series — which is how a requested 1 Hz
 *     wobble came out as 1.91 Hz.
 *  2. Quadrature demodulation + phase differentiation is far finer, but the
 *     analytic signal of a real sine carries a DC term of exactly -j*A/4 and a
 *     counter-rotating term at 2*f0. A finite window suppresses the 2*f0 term
 *     only to the window's own sidelobe level, and what leaks rotates at 2*f0.
 *     Measured on a pure 440 Hz sine with NO effect at all: 13.8 cents peak,
 *     sign changes at 880 Hz. The instrument was louder than the signal.
 *
 * This probe measures the delay D(t) directly instead, which is the quantity
 * the effect actually claims to control. Feed a train of isolated impulses, and
 * each one reappears at write_time - D(t). Because the read is a LINEAR
 * interpolation between two ring samples, an impulse of amplitude 1 at
 * fractional position f lands as exactly [1-f, f] — so the amplitude centroid
 * of that pair recovers f with no interpolation bias at all. The amplitude sum
 * is 1 either way, which is what makes the centroid exact rather than a fit.
 *
 * Pitch follows analytically: a read position r(t) = t - D(t) maps input time to
 * output time, so f_out = f_in / (1 + D'), and the deviation in cents is
 *   1200 * log2( 1 / (1 + dD/dt / D) ).
 * No filter, no unwrap, no window-length argument to defend.
 *
 * The probe also prints the mean delay, so the BASE delay is checked against
 * BASE_DELAY_SECONDS rather than taken on trust.
 *
 * Usage: node scripts/probe-wow-flutter.mjs [baseUrl]
 */
import { chromium } from "playwright";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:4173";
const SR = 44100;
const IMPULSE_HZ = 200; // spacing 220 samples — well above any modulation rate
const BASE_HZ = 440; // only used for the optional sine cross-check

const CASES = [
  // --- calibration: a perfect pass-through must measure EXACTLY 0 cents and a
  // constant delay. If the instrument reads noise here, no other row means
  // anything.
  { name: "CALIBRATION (no effect)", seconds: 4, bypass: true, params: {} },
  {
    name: "depth0/drift0 (transparent)",
    seconds: 4,
    params: { wowDepth: 0, flutterDepth: 0, drift: 0, wowRate: 0.5, mix: 1 },
  },
  {
    name: "depth0/drift1 (drift only)",
    seconds: 4,
    params: { wowDepth: 0, flutterDepth: 0, drift: 1, wowRate: 0.5, mix: 1 },
  },
  {
    name: "depth10/drift0 @0.5Hz",
    seconds: 6,
    params: { wowDepth: 10, flutterDepth: 0, drift: 0, wowRate: 0.5, mix: 1 },
  },
  {
    name: "depth30/drift0 @0.5Hz",
    seconds: 6,
    params: { wowDepth: 30, flutterDepth: 0, drift: 0, wowRate: 0.5, mix: 1 },
  },
  { name: "depth25/drift0 @1Hz", seconds: 8, params: { wowDepth: 25, flutterDepth: 0, drift: 0, wowRate: 1, mix: 1 } },
  {
    name: "flutter10/drift0 @11Hz",
    seconds: 6,
    params: { wowDepth: 0, flutterDepth: 10, drift: 0, flutterRate: 11, mix: 1 },
  },
  { name: "extreme corner", seconds: 6, params: { wowRate: 0.05, wowDepth: 60, flutterDepth: 20, drift: 1, mix: 1 } },
];

/** Runs in the page. Returns delay samples + the derived pitch deviation. */
const ANALYZER = `
function analyseDelay(left, sr, impulseSamples, seedDelaySamples, trainStart, trainCount, skipSamples) {
  const n = left.length;
  const centroid = (from, to) => {
    // Integer bounds are load-bearing. prevD is fractional, so a raw "i = lo"
    // makes every index fractional and every array read undefined — that bug
    // made the whole train unfindable while the lead impulse still worked.
    let imax = -1, best = 0;
    const lo = Math.max(0, Math.ceil(from)), hi = Math.min(n - 1, Math.floor(to));
    for (let i = lo; i <= hi; i++) {
      const v = Math.abs(left[i]);
      if (v > best) { best = v; imax = i; }
    }
    if (imax < 0 || best < 0.5) return NaN;
    // Amplitude centroid over the interpolation neighbourhood. For a linear
    // interpolant of a unit impulse this recovers the exact fractional offset
    // (measured: the 0.925/0.075 pair sums to 1 and the centroid lands on
    // +0.075), whereas a parabolic peak fit is biased by the triangle shape.
    let num = 0, den = 0;
    for (let i = imax - 1; i <= imax + 2; i++) {
      const v = left[i];
      if (v > 0) { num += i * v; den += v; }
    }
    return den > 0 ? num / den : NaN;
  };

  // A delay line DELAYS. An impulse written at w reappears at w + D, not at
  // w - D. Measured raw from the render at depth 0 / drift 0: written at 2205,
  // observed at 2813.075, so D = 608.075 samples = baseSamples + swing/2,
  // which is exactly what the source predicts. The first version of this probe
  // searched BACKWARDS and so measured a whole multiple of the impulse spacing.

  // --- absolute reference comes from a SEPARATE one-impulse render, handed in
  // as seedDelaySamples. In a single render the seed's search window would also
  // contain the train's first ~13 output impulses, whose interpolated peaks
  // differ, so a "find the biggest peak" search locks onto an arbitrary one
  // (it reported 68.9 ms where the truth is 13.8 ms). A render whose buffer
  // holds exactly one impulse has no ambiguity at all.
  const deltas = [];
  let prevD = seedDelaySamples;

  const SEARCH = Math.floor(impulseSamples / 2) - 6; // stays clear of neighbours
  for (let k = 0; k < trainCount; k++) {
    const w = trainStart + k * impulseSamples;
    if (w >= n - 4) break;
    const seed = w + prevD;
    const c = centroid(seed - SEARCH, seed + SEARCH);
    if (!Number.isFinite(c)) continue;
    prevD = c - w;
    if (w < skipSamples) continue;
    deltas.push(prevD);
  }
  if (deltas.length < 8)
    return {
      deltas,
      cents: [],
      rateHz: NaN,
      peak: NaN,
      rms: NaN,
      meanAbs: NaN,
      amplitude: NaN,
      p95: NaN,
      n: deltas.length,
      leadDelaySamples: seedDelaySamples,
    };

  // Pitch follows from the read position alone. The output at time t is the
  // input at r(t) = t - D(t), so for an input tone of frequency f0 the output
  // phase is 2*pi*f0*r(t) and the instantaneous output/input frequency ratio is
  // exactly dr/dt = 1 - dD/dt, with dD/dt DIMENSIONLESS (D and t in seconds).
  //
  // It is tempting to write the textbook dD/dt / D instead. That is the
  // granular/resampling formula and it is wrong here: it divides a samples-per-
  // second figure by a sample count, which has units 1/s, not a frequency ratio.
  // That mistake reported 1.45 cents where the time-domain answer is 0.02.
  const hop = impulseSamples / sr; // seconds between impulses
  const cents = [];
  for (let i = 1; i < deltas.length; i++) {
    const dDdt = (deltas[i] - deltas[i - 1]) / hop / sr; // dimensionless dD/dt
    const ratio = 1 - dDdt;
    if (!(ratio > 0)) continue;
    cents.push(1200 * Math.log2(ratio));
  }

  let peak = 0, sum = 0, sumSq = 0;
  for (const c of cents) { peak = Math.max(peak, Math.abs(c)); sum += c; sumSq += c * c; }
  const rms = Math.sqrt(sumSq / cents.length);

  // Robust amplitude estimate. A sinusoidal deviation of amplitude A has
  // rms = A/sqrt(2), and rms is what actually matched the request to within
  // ~1% (depth 10 -> 6.97 vs 7.07 predicted). The PEAK over-read by ~1.9x:
  // it is a single-sample estimator over a lightly sampled quasi-sine, so one
  // mis-assigned impulse spike doubles it while the rms is unaffected. Depth is
  // therefore judged on rms, and peak is kept only as a diagnostic.
  const amplitude = rms * Math.SQRT2;
  const sorted = cents.map(Math.abs).sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? NaN;

  let crossings = 0;
  for (let i = 1; i < cents.length; i++) if ((cents[i - 1] <= 0 && cents[i] > 0) || (cents[i - 1] >= 0 && cents[i] < 0)) crossings++;
  const spanSec = (cents.length * impulseSamples) / sr;
  const rateHz = crossings / 2 / spanSec;

  return {
    deltas,
    cents,
    peak,
    rms,
    amplitude,
    p95,
    meanAbs: Math.abs(sum / cents.length),
    rateHz,
    meanDelay: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    minDelay: Math.min.apply(null, deltas),
    maxDelay: Math.max.apply(null, deltas),
    leadDelaySamples: seedDelaySamples,
    n: deltas.length,
  };
}
`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log(`  [page error] ${m.text()}`);
});
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
await page.goto(`${BASE_URL}/`, { waitUntil: "commit" });

const impulseSamples = Math.round(SR / IMPULSE_HZ);
const trainStart = Math.floor(0.3 * SR);
// The seed impulse sits 5 periods ahead of the train: far enough that its own
// delay (608 samples) leaves it well clear of the train's first output impulse
// (1100 samples later), close enough that a slow drift has barely moved.
const leadWriteSample = trainStart - 5 * impulseSamples;

for (const c of CASES) {
  const trainCount = Math.floor((c.seconds * SR - trainStart) / impulseSamples);
  const res = await page.evaluate(
    async ({ params, seconds, sr, impulseSamples, leadWriteSample, trainStart, trainCount, analyzerSrc, bypass }) => {
      const analyse = new Function(`${analyzerSrc}; return analyseDelay;`)();

      const buildGraph = async (frames) => {
        const ctx = new OfflineAudioContext(2, frames, sr);
        if (!bypass) await ctx.audioWorklet.addModule("/core-worklet.js");
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
          for (const [k, v] of Object.entries(params)) if (node.parameters.has(k)) node.parameters.get(k).value = v;
        return { ctx, node };
      };

      // --- seed render: ONE impulse, nothing else. The first non-zero sample
      // after it IS its output, so the absolute delay is unambiguous. Both
      // renders start at t=0 with the same seed and the same per-sample
      // updates, so the drift trajectory at a given time is identical in both.
      const seedFrames = leadWriteSample + Math.floor(0.1 * sr);
      const seedGraph = await buildGraph(seedFrames);
      const seedBuf = seedGraph.ctx.createBuffer(2, seedFrames, sr);
      seedBuf.getChannelData(0)[leadWriteSample] = 1;
      seedBuf.getChannelData(1)[leadWriteSample] = 1;
      const seedSrc = seedGraph.ctx.createBufferSource();
      seedSrc.buffer = seedBuf;
      if (seedGraph.node) seedSrc.connect(seedGraph.node).connect(seedGraph.ctx.destination);
      else seedSrc.connect(seedGraph.ctx.destination);
      seedSrc.start(0);
      const seedOut = await seedGraph.ctx.startRendering();
      const seedL = seedOut.getChannelData(0);
      let seedFirst = -1;
      for (let i = leadWriteSample; i < seedFrames; i++) {
        if (Math.abs(seedL[i]) > 0.5) {
          seedFirst = i;
          break;
        }
      }
      if (seedFirst < 0)
        return { peak: NaN, rms: NaN, meanAbs: NaN, rateHz: NaN, amplitude: NaN, p95: NaN, n: 0, lrDelta: 0 };
      let sn = 0,
        sd = 0;
      for (let i = seedFirst - 1; i <= seedFirst + 2; i++) {
        const v = seedL[i];
        if (v > 0) {
          sn += i * v;
          sd += v;
        }
      }
      const seedDelaySamples = sd > 0 ? sn / sd - leadWriteSample : NaN;

      // --- train render
      const frames = Math.ceil(seconds * sr);
      const { ctx, node } = await buildGraph(frames);
      const buf = ctx.createBuffer(2, frames, sr);
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      for (let k = 0; k < trainCount; k++) {
        const w = trainStart + k * impulseSamples;
        if (w < frames) {
          L[w] = 1;
          R[w] = 1;
        }
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (node) src.connect(node).connect(ctx.destination);
      else src.connect(ctx.destination);
      src.start(0);

      const out = await ctx.startRendering();
      const left = out.getChannelData(0);
      const right = out.getChannelData(1);

      const r = analyse(left, sr, impulseSamples, seedDelaySamples, trainStart, trainCount, trainStart);

      let diff = 0,
        cnt = 0;
      for (let i = 0; i < frames; i++) {
        diff += Math.abs(left[i] - right[i]);
        cnt++;
      }

      return {
        peak: r.peak,
        rms: r.rms,
        amplitude: r.amplitude,
        p95: r.p95,
        meanAbs: r.meanAbs,
        rateHz: r.rateHz,
        meanDelay: r.meanDelay,
        minDelay: r.minDelay,
        maxDelay: r.maxDelay,
        leadDelaySamples: r.leadDelaySamples,
        n: r.n,
        lrDelta: diff / cnt,
      };
    },
    {
      params: c.params,
      seconds: c.seconds,
      sr: SR,
      impulseSamples,
      leadWriteSample,
      trainStart,
      trainCount,
      analyzerSrc: ANALYZER,
      bypass: !!c.bypass,
    },
  );

  const ok = Number.isFinite(res.rms);
  console.log(
    `${c.name.padEnd(26)} amp=${ok ? res.amplitude.toFixed(2).padStart(7) : "    n/a "}c  ` +
      `rms=${ok ? res.rms.toFixed(2).padStart(7) : "    n/a"}c  ` +
      `p95=${ok ? res.p95.toFixed(2).padStart(7) : "    n/a"}c  ` +
      `peak=${ok ? res.peak.toFixed(1).padStart(7) : "    n/a"}c  ` +
      `rate=${ok ? res.rateHz.toFixed(2).padStart(5) : "  n/a"}Hz  ` +
      `D=${ok ? ((res.meanDelay / SR) * 1000).toFixed(3) : " n/a  "}ms ` +
      `[${ok ? ((res.minDelay / SR) * 1000).toFixed(3) : "-"}..${ok ? ((res.maxDelay / SR) * 1000).toFixed(3) : "-"}]  ` +
      `lead=${Number.isFinite(res.leadDelaySamples) ? ((res.leadDelaySamples / SR) * 1000).toFixed(3) + "ms" : "n/a"}  ` +
      `n=${res.n}  dLR=${res.lrDelta.toExponential(1)}`,
  );
  if (res.dbg && !Number.isFinite(res.peak)) console.log(`      dbg: ${JSON.stringify(res.dbg)}`);
}

await browser.close();
