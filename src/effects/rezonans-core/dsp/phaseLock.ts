/**
 * REZONANS — spectral peak picking + identity phase locking.
 *
 * WHY THIS FILE EXISTS: the phase vocoder in `src/audio-engine/phase-vocoder.ts`
 * states outright that it has no transient preservation (line 12). In a pad or
 * a texture that is an acceptable trade. In a VOCAL it is fatal, because the
 * transients in a voice are the consonants — the parts that carry the word.
 * An unlocked PV smears every "s", "t", "k" into a phasey chirp, and no amount
 * of formant quality hides it.
 *
 * Laroche & Dolson's identity phase locking fixes this by treating each
 * spectral PEAK as a single partial: only the peaks carry propagated phase, and
 * every bin in a peak's region of influence inherits that peak's phase. Energy
 * inside a partial's main lobe therefore moves as one rigid object instead of
 * smearing across the lobe, which is what preserves attack shape.
 *
 * Deterministic and allocation-free after `prepare()`; no RNG anywhere.
 */

/** Relative peak threshold against the frame maximum (-46 dB). */
const PEAK_REL_THRESHOLD = 0.005;
/** Absolute floor so a near-silent frame does not promote every bin to a peak. */
const PEAK_ABS_FLOOR = 1e-7;
/**
 * Maximum region-of-influence half-width, in bins.
 *
 * The textbook rule is "half the distance to the neighbouring peak", but on a
 * harmonic vocal that hands every partial the ENTIRE valley up to its
 * neighbour — which suppresses the inter-harmonic floor, drops the output some
 * 10 dB and drags the spectral centroid down by a third. Measured before this
 * cap existed.
 *
 * Capping the influence keeps the lock inside the peak's own main lobe, which
 * is the part that carries the transient shape; the valley is left free to do
 * what it was doing. Widen this in P7 if listening says the transients still
 * smear.
 */
const MAX_INFLUENCE_BINS = 2;

export class PhaseLocker {
  private n = 0;
  private half = 0;
  /** For each bin, the bin index of the peak that owns it (-1 = none). */
  private owner = new Int32Array(0);
  /** Dense list of peak bins for the current frame. */
  private peaks = new Int32Array(0);
  /** Debug/telemetry: how many peaks the last frame produced. */
  private lastPeakCount = 0;

  get peakCountLast(): number {
    return this.lastPeakCount;
  }

  prepare(fftSize: number): void {
    if (this.n === fftSize) return;
    this.n = fftSize;
    this.half = fftSize >> 1;
    this.owner = new Int32Array(this.half + 1);
    this.peaks = new Int32Array(this.half + 1);
    this.lastPeakCount = 0;
  }

  reset(): void {
    this.owner.fill(-1);
    this.lastPeakCount = 0;
  }

  /**
   * Find the peaks of a half-spectrum and assign every bin to its nearest
   * peak (region of influence). Cheap enough to run every frame per voice:
   * one pass to locate, one pass to fill.
   */
  findPeaks(mag: Float64Array, half: number): void {
    this.owner.fill(-1);
    const peaks = this.peaks;
    let count = 0;

    let frameMax = 0;
    for (let k = 0; k <= half; k++) {
      const v = mag[k]!;
      if (v > frameMax) frameMax = v;
    }
    const thresh = Math.max(frameMax * PEAK_REL_THRESHOLD, PEAK_ABS_FLOOR);

    for (let k = 1; k < half; k++) {
      const v = mag[k]!;
      if (v < thresh) continue;
      if (v > mag[k - 1]! && v >= mag[k + 1]!) {
        peaks[count] = k;
        count++;
      }
    }
    // DC and Nyquist can never be interior peaks; if the frame is essentially
    // flat, fall back to every-other-bin ownership so the frame still has a
    // stable phase reference rather than propagating unphaseable values.
    if (count === 0) {
      for (let k = 0; k <= half; k += 4) {
        peaks[count] = k;
        count++;
      }
    }
    this.lastPeakCount = count;

    // Region of influence: each peak owns a window around itself, bounded both by
    // the midpoint to its neighbour AND by MAX_INFLUENCE_BINS.
    const owner = this.owner;
    for (let p = 0; p < count; p++) {
      const peak = peaks[p]!;
      const prev = p > 0 ? peaks[p - 1]! : peak - count;
      const next = p + 1 < count ? peaks[p + 1]! : peak + count;
      const halfLeft = Math.min((peak - prev) >> 1, MAX_INFLUENCE_BINS);
      const halfRight = Math.min((next - peak) >> 1, MAX_INFLUENCE_BINS);
      const lo = Math.max(0, peak - halfLeft);
      const hi = Math.min(half, peak + halfRight);
      for (let k = lo; k <= hi; k++) owner[k] = peak;
    }
  }

  /**
   * Overwrite every non-peak bin's phase with its owning peak's phase.
   * Mutates `outPhase` in place; peak bins keep their propagated value.
   */
  applyLock(outPhase: Float64Array, half: number): void {
    const owner = this.owner;
    for (let k = 0; k <= half; k++) {
      const p = owner[k]!;
      if (p >= 0 && p !== k) outPhase[k] = outPhase[p]!;
    }
  }
}
