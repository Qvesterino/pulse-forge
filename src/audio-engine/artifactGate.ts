import { toDb, truePeakOversampled } from "./metering";

/**
 * Artifact gate — the numerical "did this render break?" check that locks the
 * de-click and round-robin work into CI.
 *
 * Pure analysis over Float32Arrays: no AudioContext, so it runs in jsdom unit
 * tests AND in the real-browser verifier against actual renders. The checks
 * are deliberately conservative (they only fail on things a listener would
 * hear as a defect) and every threshold is an explicit, documented constant.
 *
 * What it catches:
 *  - non-finite samples (NaN/Infinity from a broken DSP stage);
 *  - a hard cut at the end of a one-shot (the de-click invariant) — measured
 *    as the amplitude of the last audible sample relative to the peak, which
 *    works whether or not the render has a silent tail;
 *  - isolated discontinuities inside the decay (a `length` p-lock or slice cut
 *    mid-body) via a curvature residual vs the local body, which ignores the
 *    intentional attack, smooth transients and smooth fades;
 *  - DC offset (asymmetric saturation leaking into the tail) via a sliding
 *    window mean — a global mean of a finite AC signal is never zero, so the
 *    naive measurement produced false positives;
 *  - inter-sample peaks (true peak over a ceiling).
 *
 * What it does NOT claim: it is not a perceptual quality judgement. A pass
 * means "no numerical defect", not "this sounds good".
 */

export interface ArtifactGateOptions {
  /**
   * Last-sample amplitude threshold as a fraction of peak — samples below it
   * are treated as the silent tail (default 0.01, i.e. -40 dBFS relative).
   */
  tailThresholdRatio?: number;
  /** Max tolerated `tailStepRatio` for a clean one-shot (default 0.05). */
  maxTailStepRatio?: number;
  /** Absolute DC offset ceiling in dBFS (default -40, opt-in only). */
  maxDcOffsetDb?: number;
  /** Residual magnitude that can count as a click, as a fraction of peak (default 0.02). */
  clickResidualRatio?: number;
  /** How much larger than the local body residual a click must be (default 8). */
  clickProminence?: number;
  /** Samples either side used for the local body residual (default 64). */
  clickWindow?: number;
}

export interface ArtifactReport {
  finite: boolean;
  /** Sample peak (linear). */
  peak: number;
  peakDb: number;
  /** 4×-oversampled true peak (linear). */
  truePeak: number;
  truePeakDb: number;
  /**
   * Sub-audio energy as a fraction of total: the residual of a 2×5 Hz
   * high-pass, i.e. genuinely DC-ish content.
   *
   * DIAGNOSTIC — not part of the default failure set. Percussive one-shots
   * have only a few cycles of their fundamental and a decaying envelope, so
   * ANY sub-audio measurement reads a transient, not an offset. The value is
   * meaningful on sustained material; the browser verifier enforces it there
   * via `dcCeilingDb`. The engine also carries an always-on 12 Hz DC blocker
   * on the master chain, which is the real guarantee.
   */
  dcOffsetRatio: number;
  dcOffsetDb: number;
  /**
   * |amplitude of the last audible sample| / peak. A one-shot that ends on a
   * hard cut reads ~0.5; a properly faded tail reads ≈ the tail threshold.
   */
  tailStepRatio: number;
  /** Indices of isolated discontinuities after the attack. */
  clickIndices: number[];
  /** Largest residual found, as a fraction of peak (diagnostics). */
  maxResidualRatio: number;
  /** Index of the first sample above the noise floor (the intentional attack). */
  attackIndex: number;
}

const DEFAULTS = {
  tailThresholdRatio: 0.01,
  maxTailStepRatio: 0.05,
  maxDcOffsetDb: -40,
  clickResidualRatio: 0.02,
  clickProminence: 8,
  clickWindow: 64,
} as const;

/**
 * Curvature residual at `i`: how far the sample deviates from the linear
 * interpolation of its neighbours. A band-limited signal has a tiny residual;
 * a hard discontinuity (a cut mid-waveform) has a residual on the order of
 * the step itself. Smooth fades and smooth transients are not flagged because
 * their residual stays small relative to the local body.
 */
function residualAt(channel: Float32Array, i: number): number {
  if (i <= 0 || i >= channel.length - 1) return 0;
  const predicted = (channel[i - 1] + channel[i + 1]) * 0.5;
  return Math.abs(channel[i] - predicted);
}

/** Median of the residuals in [from, to) — the local "normal" curvature. */
function medianResidual(channel: Float32Array, from: number, to: number): number {
  const scratch: number[] = [];
  for (let i = Math.max(1, from); i < Math.min(channel.length - 1, to); i++) {
    scratch.push(residualAt(channel, i));
  }
  if (scratch.length === 0) return 0;
  scratch.sort((a, b) => a - b);
  return scratch[scratch.length >> 1];
}

/**
 * Analyze a rendered buffer (or a synthesized signal) for numerical defects.
 * Multi-channel input is scanned per channel; indices in the report are into
 * the FIRST channel for click positions and the global peak.
 */
export function analyzeArtifacts(channels: readonly Float32Array[], options: ArtifactGateOptions = {}): ArtifactReport {
  const cfg = { ...DEFAULTS, ...options };
  let finite = true;
  let peak = 0;
  let sum = 0;
  let count = 0;

  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i];
      count += 1;
      if (!Number.isFinite(v)) {
        finite = false;
        continue;
      }
      sum += v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }

  // DC: sub-audio residual of a 2×5 Hz high-pass. Diagnostic only — a
  // percussive one-shot has too few cycles and a decaying envelope for ANY
  // sub-audio measurement to mean "offset" (see `dcOffsetRatio`).
  let dcRatio = 0;
  const hpAlpha = 1 / (1 + 44100 / (2 * Math.PI * 5));
  for (const channel of channels) {
    if (channel.length === 0) continue;
    let lpA = 0;
    let lpB = 0;
    let lowEnergy = 0;
    let totalEnergy = 0;
    for (let i = 0; i < channel.length; i++) {
      const v = Number.isFinite(channel[i]) ? channel[i] : 0;
      // Two cascaded one-poles at 5 Hz: the residual tracks a slow drift.
      lpA += hpAlpha * (v - lpA);
      lpB += hpAlpha * (lpA - lpB);
      lowEnergy += lpB * lpB;
      totalEnergy += v * v;
    }
    if (totalEnergy > 1e-12) dcRatio = Math.max(dcRatio, Math.sqrt(lowEnergy / totalEnergy));
  }
  const dcOffsetRatio = dcRatio;

  const primary = channels[0];
  const tailFloor = peak * cfg.tailThresholdRatio;
  // Attack guard: everything before the first audible sample is silence (the
  // onset itself is intentional, so it must not read as a click). Using the
  // PEAK as the guard was wrong — the peak can sit after a real defect (a
  // splice early in a decay), which hid exactly the clicks this checks for.
  let attackIndex = 0;
  for (let i = 0; i < primary.length; i++) {
    const v = primary[i];
    if (Number.isFinite(v) && Math.abs(v) > tailFloor) {
      attackIndex = i;
      break;
    }
  }

  // Tail: the last sample above the tail threshold. A one-shot that faded
  // correctly ends near the threshold; a hard cut ends wherever the waveform
  // happened to be.
  let lastAudible = -1;
  for (let i = primary.length - 1; i >= 0; i--) {
    const v = primary[i];
    if (Number.isFinite(v) && Math.abs(v) > tailFloor) {
      lastAudible = i;
      break;
    }
  }
  const tailStepRatio = peak > 0 && lastAudible >= 0 ? Math.abs(primary[lastAudible]) / peak : 0;

  // Isolated discontinuities AFTER the attack. The attack itself is an
  // intentional instantaneous onset (a kick starts at full amplitude).
  const clickIndices: number[] = [];
  let maxResidualRatio = 0;
  if (finite && peak > 0) {
    const window = Math.max(4, Math.round(cfg.clickWindow));
    const absoluteFloor = peak * cfg.clickResidualRatio;
    for (let i = Math.max(attackIndex, 1); i < primary.length - 1; i++) {
      const r = residualAt(primary, i);
      if (r <= absoluteFloor) continue;
      const rNorm = r / peak;
      if (rNorm > maxResidualRatio) maxResidualRatio = rNorm;
      const localBody = medianResidual(primary, i - window, i + window);
      if (r > localBody * cfg.clickProminence) clickIndices.push(i);
    }
  }

  const truePeak = channels.length > 0 ? truePeakOversampled(channels) : 0;
  return {
    finite,
    peak,
    peakDb: toDb(peak),
    truePeak,
    truePeakDb: toDb(truePeak),
    dcOffsetRatio,
    dcOffsetDb: toDb(dcOffsetRatio),
    tailStepRatio,
    clickIndices,
    maxResidualRatio,
    attackIndex,
  };
}

export interface ArtifactVerdict {
  ok: boolean;
  failures: string[];
}

export interface ArtifactVerdictOptions extends ArtifactGateOptions {
  /**
   * True-peak ceiling the render was expected to respect (the master limiter
   * ceiling); pass a value slightly above it to allow oversampling slack.
   */
  ceilingDb?: number;
  /**
   * Enforce the DC ceiling (dB, energy ratio). OFF by default: the value is
   * only meaningful on sustained material (one-shots cannot measure it).
   * Enable for sustained renders (the browser verifier does).
   */
  dcCeilingDb?: number;
}

/**
 * Evaluate a report against the gate. Returns every failure so a caller can
 * see all defects at once, not just the first.
 */
export function evaluateArtifacts(report: ArtifactReport, options: ArtifactVerdictOptions = {}): ArtifactVerdict {
  const failures: string[] = [];
  if (!report.finite) failures.push("non-finite samples");
  if (report.peak <= 0) failures.push("silent render");
  if (options.dcCeilingDb !== undefined && report.dcOffsetDb > options.dcCeilingDb) {
    failures.push(`DC offset ${report.dcOffsetDb.toFixed(1)} dB above ${options.dcCeilingDb} dB ceiling`);
  }
  if (report.tailStepRatio > (options.maxTailStepRatio ?? DEFAULTS.maxTailStepRatio)) {
    failures.push(`hard tail cut (last sample ${report.tailStepRatio.toFixed(3)} of peak)`);
  }
  if (report.clickIndices.length > 0) {
    failures.push(
      `${report.clickIndices.length} isolated discontinuity(ies) at ${report.clickIndices.slice(0, 4).join(",")}`,
    );
  }
  if (options.ceilingDb !== undefined && report.truePeakDb > options.ceilingDb) {
    failures.push(`true peak ${report.truePeakDb.toFixed(2)} dBTP over ceiling ${options.ceilingDb} dBTP`);
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Log-envelope correlation between two hits — the right metric for "is this
 * the same instrument?".
 *
 * Sample-level Pearson correlation is wrong here: a round-robin variant is a
 * resampled copy (rate 1.018), so by the end of a 150 ms hit the phase has
 * drifted ~180° and sample correlation collapses to ~0.1 even though the two
 * hits are audibly the same drum. The LOG envelope (both hits sampled at the
 * same fraction of their own length, so different lengths compare) is
 * phase-blind, which gives the separation the gate needs:
 *
 *   identical hit            ≈ 1.00
 *   factory RR micro-variant ≈ 0.9998   (same drum, subtly different take)
 *   different frequency      ≈ 0.99
 *   different decay shape    ≈ 0.77     (a genuinely different sample)
 *
 * The gate uses `minVariantSimilarity` (identical is FINE for a single hit —
 * what matters is that a pad's SET spans a spread, see the browser verifier).
 */
export function logEnvelopeCorrelation(a: Float32Array, b: Float32Array, points = 96): number {
  const sample = (channel: Float32Array, fraction: number): number => {
    const center = Math.max(0, Math.min(channel.length - 1, Math.round(channel.length * fraction)));
    const win = 64;
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, center - win); i < Math.min(channel.length, center + win); i++) {
      const v = Number.isFinite(channel[i]) ? channel[i] : 0;
      sum += v * v;
      n += 1;
    }
    const rms = n > 0 ? Math.sqrt(sum / n) : 0;
    return Math.log10(Math.max(1e-7, rms));
  };
  const n = Math.max(4, Math.round(points));
  const av = new Float64Array(n);
  const bv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    av[i] = sample(a, frac);
    bv[i] = sample(b, frac);
  }
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += av[i];
    sb += bv[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = av[i] - ma;
    const y = bv[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 1;
  return Math.max(-1, Math.min(1, num / Math.sqrt(da * db)));
}
