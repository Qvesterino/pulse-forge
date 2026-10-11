/**
 * REZONANS — formant band detection (v2, ADR 0041).
 *
 * The cepstral estimator already produces the vocal-tract envelope every frame.
 * This module turns that envelope into the three numbers the v2 warp needs:
 * where F1, F2 and F3 actually are, and therefore where the band boundaries
 * fall.
 *
 * WHY PEAK-PICK AND NOT LPC
 *
 * All-pole LPC is the textbook formant estimator and is more accurate on noisy
 * frames. It is rejected here for three reasons. It needs an all-pole solve per
 * frame added to the hot path; its accuracy advantage does not matter when the
 * result is only ever a WARP TARGET, not a measurement anyone reads; and —
 * decisively — it would give the panel a different envelope than the DSP
 * actually warps. A panel drawing an envelope the device is not using is an
 * instrument that lies to the user, which ADR 0040 decision 19 forbids. The
 * cepstral envelope is the same array the warp samples, so what the panel draws
 * is what the device does.
 *
 * WHY ABSOLUTE BANDS
 *
 * The search windows are fixed Hz, not scaled by f0. Scaling them would make one
 * patch behave differently for a bass and a soprano, which is a surprise the
 * user cannot predict. The target is an adult vocal tract; a very high female or
 * falsetto voice may find F3 outside the window, and F3 is optional for exactly
 * that reason (see `FALLBACK`).
 */

import { clamp } from "./harmony.js";

export const FORMANT_BAND_COUNT = 3;

/**
 * Search windows in absolute Hz. Deliberately overlapping at the seams (F2
 * starts below F1's top) so a formant sitting on a boundary is still found by
 * one band or the other rather than by neither.
 */
const BAND_HZ: readonly (readonly [number, number])[] = [
  [200, 1000],
  [700, 2500],
  [2200, 3500],
];

/**
 * Centres used when a band finds nothing. A formant tracker that returns a
 * noise peak is worse than one that returns a neutral default: a wrong centre
 * moves the band edge and warps the wrong part of the spectrum, while a default
 * at least keeps the warp where the previous good frame left it.
 */
const FALLBACK_HZ: readonly number[] = [500, 1500, 2600];

/**
 * A candidate peak must stand this far above its own band's low percentile.
 * 3 dB in natural-log units.
 */
const PEAK_MARGIN = 3 * Math.LN10 * 0.05;

/**
 * Which percentile of the search window counts as the noise floor.
 *
 * The MEDIAN was the first choice and it is wrong whenever a formant is wide
 * relative to its window: an F3 spanning 873 Hz fills most of the 2200-3500 Hz
 * window, so the median sits up on the formant itself and the measured margin
 * collapsed to 0.8 dB — a real, correctly located F3 rejected as noise. The
 * 10th percentile stays on the spectral tilt even when the bump owns the
 * window, and measured against it the same wide F3 clears by 2.3 dB.
 */
const FLOOR_PERCENTILE = 0.1;

/** Frames of history the temporal median runs over (odd, >= 1). */
const MEDIAN_FRAMES = 3;

/**
 * One-pole coefficient toward the smoothed centre, PER FRAME.
 *
 * Deliberately a constant rather than derived from the sample rate. The frame
 * rate follows the analysis window (N/4 samples per hop), so a rate-derived
 * coefficient would silently change the smoothing time constant every time the
 * quality setting moved — the control would mean something different in Economy
 * and Fine. This is stated in frames, which is the unit the detector actually
 * lives in.
 *
 * 0.35 tracks an articulator that is genuinely moving within ~3 frames while
 * still rejecting per-frame peak jitter after the median. Deriving it from a
 * wall-clock time constant instead produced a coefficient of ~0.0005 and a
 * detector that never moved.
 */
const SMOOTH_PER_FRAME = 0.35;

export class FormantBands {
  private sampleRate = 48000;
  private n = 0;
  private half = 0;

  /** Ring of recent raw detections, [FORMANT_BAND_COUNT][MEDIAN_FRAMES]. */
  private history = new Float64Array(FORMANT_BAND_COUNT * MEDIAN_FRAMES);
  private historyPos = 0;
  private historyFilled = 0;
  private medianScratch = new Float64Array(MEDIAN_FRAMES);
  /**
   * Separate scratch for the per-band median inside `pickPeak`. That one spans
   * a whole search window (hundreds of bins), so it must NOT share the
   * three-element temporal buffer — a typed array silently discards writes past
   * its end, which would turn the noise-floor reference into stale zeros and
   * make every peak look infinitely clear of the floor.
   */
  private peakScratch = new Float64Array(0);

  /** Smoothed centre per band in Hz; `-1` when that band found nothing. */
  private centers = new Float64Array(FORMANT_BAND_COUNT);
  /** Log-smoothed positions, so interpolation reads as a ratio. */
  private centersLog = new Float64Array(FORMANT_BAND_COUNT);

  /** Band boundary positions in BINS, strictly ascending, `[0, e1, e2, half]`. */
  private edgeBins = new Int32Array(FORMANT_BAND_COUNT + 1);
  /** Which band each output bin belongs to, length `half + 1`. */
  private bandOfBin = new Int32Array(0);

  /** One-pole step toward the smoothed centre, per frame. */
  private smoothCoef = SMOOTH_PER_FRAME;

  private primed = false;

  prepare(sampleRate: number, fftSize: number): void {
    this.sampleRate = sampleRate;
    if (this.n === fftSize) return;
    this.n = fftSize;
    this.half = fftSize >> 1;
    this.bandOfBin = new Int32Array(this.half + 1);
    this.peakScratch = new Float64Array(this.half + 1);
    this.reset();
  }

  /**
   * Detect the band centres for one frame.
   *
   * `logEnv` is the real-cepstrum log envelope over `half + 1` bins. Allocation
   * after `prepare()` is zero: every scratch buffer below is owned.
   */
  update(logEnv: Float64Array, half: number): void {
    if (this.n === 0 || half !== this.half) return;
    const binHz = this.sampleRate / this.n;

    // ── 1. per-band peak pick ──────────────────────────────────────────
    const base = this.historyPos * FORMANT_BAND_COUNT;
    for (let b = 0; b < FORMANT_BAND_COUNT; b++) {
      const window = BAND_HZ[b]!;
      const loBin = Math.max(1, Math.round(window[0] / binHz));
      const hiBin = Math.min(half - 2, Math.round(window[1] / binHz));
      this.history[base + b] = loBin < hiBin ? this.pickPeak(logEnv, loBin, hiBin) : -1;
    }

    // ── 2. temporal median ─────────────────────────────────────────────
    // A single mis-picked frame moves the band edge for one hop, which is
    // audible as a tick. The median throws it out at the cost of one frame of
    // response time.
    this.historyPos = (this.historyPos + 1) % MEDIAN_FRAMES;
    if (this.historyFilled < MEDIAN_FRAMES) this.historyFilled++;

    for (let b = 0; b < FORMANT_BAND_COUNT; b++) {
      const count = this.historyFilled;
      for (let i = 0; i < count; i++) {
        const slot = (this.historyPos - 1 - i + MEDIAN_FRAMES * 2) % MEDIAN_FRAMES;
        this.medianScratch[i] = this.history[slot * FORMANT_BAND_COUNT + b]!;
      }
      const med = medianOf(this.medianScratch, count);

      if (med < 0) {
        // Nothing found in this band. Hold the previous smoothed centre so a
        // frame that merely missed its peak does not snap the edge away.
        this.centers[b] = this.historyFilled > 1 ? this.centers[b]! : -1;
        continue;
      }

      // ── 3. one-pole smoothing in log space ───────────────────────────
      // Formant perception is logarithmic, so a fixed-rate filter in Hz is
      // perceptually uneven. Position is smoothed as a ratio instead.
      const lg = Math.log(med);
      const prevLog = this.centersLog[b]!;
      const seed = this.historyFilled < MEDIAN_FRAMES || prevLog <= 0;
      const next = seed ? lg : prevLog + (lg - prevLog) * this.smoothCoef;
      this.centersLog[b] = next;
      this.centers[b] = Math.exp(next);
    }

    // ── 4. band boundaries ─────────────────────────────────────────────
    const c = this.centers;
    const use = (i: number) => (c[i]! > 0 ? c[i]! : FALLBACK_HZ[i]!);
    let e1 = Math.sqrt(use(0) * use(1));
    let e2 = Math.sqrt(use(1) * use(2));

    // Centres can cross when a band misses and falls back to its default. A
    // reversed pair would produce a zero-width band and divide by zero in the
    // warp, so the boundaries are forced strictly between the two centres.
    const f1 = use(0);
    const f2 = use(1);
    const f3 = use(2);
    e1 = clamp(e1, Math.min(f1, f2) * 1.02, Math.max(f1, f2) * 0.98);
    e2 = clamp(e2, Math.min(f2, f3) * 1.02, Math.max(f2, f3) * 0.98);

    let b1 = Math.round(e1 / binHz);
    let b2 = Math.round(e2 / binHz);
    b1 = clamp(b1, 1, half - 2);
    b2 = clamp(b2, b1 + 1, half - 1);
    this.edgeBins[0] = 0;
    this.edgeBins[1] = b1;
    this.edgeBins[2] = b2;
    this.edgeBins[3] = half;

    // Bin → band, so the warp picks its α with one array read per bin.
    for (let k = 0; k <= half; k++) {
      this.bandOfBin[k] = k < b1 ? 0 : k < b2 ? 1 : 2;
    }
    this.primed = true;
  }

  /**
   * Strongest local maximum in `[loBin, hiBin]`, refined by parabolic
   * interpolation on the log envelope. Returns -1 when nothing stands far
   * enough above the band's low percentile to be a formant.
   */
  private pickPeak(logEnv: Float64Array, loBin: number, hiBin: number): number {
    // Band median as the noise floor reference. Using the band's own median
    // rather than a fixed dBFS keeps the threshold meaningful for both a loud
    // close-mic'd vocal and a quiet one.
    //
    // TypedArray.prototype.sort is numeric, in place and allocation-free. An
    // insertion sort here would be O(n^2) over a ~300-bin window, three times
    // per frame, on the audio thread.
    const scratch = this.peakScratch;
    const span = hiBin - loBin + 1;
    if (span > scratch.length || span < 3) return -1;
    for (let i = 0; i < span; i++) scratch[i] = logEnv[loBin + i] ?? -1e9;
    scratch.sort();
    const floor = scratch[Math.min(span - 1, Math.floor(span * FLOOR_PERCENTILE))]!;

    let best = -1e18;
    let bestK = -1;
    for (let k = loBin; k <= hiBin; k++) {
      // Local maximum only: a formant peak must fall away on at least one side,
      // otherwise a monotonic ramp inside the window qualifies as a formant.
      const v = logEnv[k] ?? -1e18;
      if (v <= (logEnv[k - 1] ?? -1e18) || v < (logEnv[k + 1] ?? -1e18)) continue;
      if (v > best) {
        best = v;
        bestK = k;
      }
    }
    if (bestK < 0 || best - floor < PEAK_MARGIN) return -1;

    // Parabolic vertex through the three log-envelope points.
    const y0 = logEnv[bestK - 1] ?? best;
    const y1 = best;
    const y2 = logEnv[bestK + 1] ?? best;
    const denom = y0 - 2 * y1 + y2;
    const shift = Math.abs(denom) > 1e-12 ? clamp((0.5 * (y0 - y2)) / denom, -0.5, 0.5) : 0;
    return (bestK + shift) * (this.sampleRate / this.n);
  }

  /** Smoothed centres in Hz; `-1` for a band that never found anything. */
  get centerHz(): Float64Array {
    return this.centers;
  }

  /** Band boundary positions in bins: `[0, e1, e2, half]`, strictly ascending. */
  get boundaries(): Int32Array {
    return this.edgeBins;
  }

  /** Which band each output bin belongs to (0, 1 or 2). */
  get bandOf(): Int32Array {
    return this.bandOfBin;
  }

  get ready(): boolean {
    return this.primed;
  }

  reset(): void {
    this.history.fill(-1);
    this.historyPos = 0;
    this.historyFilled = 0;
    this.centers.fill(-1);
    this.centersLog.fill(0);
    this.edgeBins.fill(0);
    if (this.bandOfBin.length > 0) {
      this.bandOfBin.fill(2);
      this.edgeBins[0] = 0;
      this.edgeBins[3] = this.half;
    }
    this.primed = false;
  }
}

/** Median of the first `count` entries of `values` (insertion sort, count <= 3). */
function medianOf(values: Float64Array, count: number): number {
  if (count <= 0) return -1e9;
  if (count === 1) return values[0]!;
  // Insertion sort in place: count is 3, so this is cheaper than any allocation
  // or a general sort, and it is deterministic.
  for (let i = 1; i < count; i++) {
    const v = values[i]!;
    let j = i - 1;
    while (j >= 0 && values[j]! > v) {
      values[j + 1] = values[j]!;
      j--;
    }
    values[j + 1] = v;
  }
  return values[count >> 1]!;
}

/**
 * Sample a log envelope onto N log-spaced frequencies for the panel.
 *
 * `out` is filled in place; no allocation. The panel receives the same array the
 * warp samples, so the drawing cannot disagree with the audio.
 */
export function sampleEnvelopeLogSpaced(
  logEnv: Float64Array,
  half: number,
  sampleRate: number,
  fLo: number,
  fHi: number,
  out: Float32Array,
): void {
  const n = out.length;
  if (n === 0 || half <= 0) return;
  const logRatio = Math.log(fHi / fLo);
  for (let i = 0; i < n; i++) {
    const f = fLo * Math.exp((i / (n - 1)) * logRatio);
    const bin = f * ((half * 2) / sampleRate);
    const k = Math.round(bin);
    // Outside the analysed range the envelope is meaningless (the cepstral
    // lifter has no data there), so clamp rather than extrapolate a number the
    // panel would draw as if it were measured.
    const kk = k < 0 ? 0 : k > half ? half : k;
    // logEnv is a natural logarithm; the panel thinks in dB.
    out[i] = (logEnv[kk] ?? 0) * 4.342944819032518;
  }
}
