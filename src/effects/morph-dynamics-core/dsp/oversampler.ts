/**
 * MORPH DYNAMICS — 2× polyphase halfband oversampler.
 *
 * Wraps ONLY the nonlinear character stage (DSP_ARCHITECTURE.md §11 —
 * "oversample nonlinear subgraphs, never the whole plugin"): tanh drive up
 * to ×8 at 1× aliases audibly on hats/cymbals; at 2× the first alias zone
 * lands above the audio band and the downsampling halfband removes it.
 *
 * Design: 17-tap windowed-sinc halfband (cutoff at the quarter band).
 * Halfband property — every even tap is zero except the center — collapses
 * the polyphase decomposition to:
 *
 *   up, even phase:  y[2i]   = 2·c·x[i−4]          (×2 undoes zero-stuffing)
 *   up, odd phase:   y[2i+1] = 2·Σ_k o[k]·x[i−k]
 *   down:            v[i]    = c·w[2i−8] + Σ_k o[k]·w[2i−2k−1]
 *
 * with w = the nonlinear stage applied to y. The needed w history is the
 * even phase of i−4 and the odd phases of i−1..i−8 — three small fixed
 * FIFOs per instance. Group delay = (TAPS−1)/2 = 8 base samples; the
 * processor reports it through the latency port and delays its dry/mix
 * path to match (phase-conscious dry/wet, DSP_ARCHITECTURE.md §15).
 *
 * Per-sample API (the processor loop is per-frame); all state lives in
 * fixed Float32/Float64 arrays allocated at construction — the audio loop
 * never allocates. One instance per channel per cascade stage.
 */

const TAPS = 17;
const HALF = (TAPS - 1) / 2; // 8 — also the group delay in base samples
const EVEN_DELAY = 4; // even-phase group delay in input samples

/** Base-rate latency contributed by ONE 2× cascade stage. */
export const OS2_LATENCY = HALF;

function designHalfband(): { odd: Float64Array; center: number } {
  const full = new Float64Array(TAPS);
  let sum = 0;
  for (let n = 0; n < TAPS; n++) {
    const m = n - HALF;
    // Windowed sinc, cutoff at the quarter band (fc = 0.5 relative to the
    // 2× Nyquist). sin at even m ≠ 0 is zero — the halfband property.
    const v = m === 0 ? 0.5 : Math.sin((Math.PI * m) / 2) / (Math.PI * m);
    // Blackman window (deterministic; solid stopband for 17 taps).
    const w =
      0.42 + 0.5 * Math.cos((Math.PI * m) / HALF) + 0.08 * Math.cos((2 * Math.PI * m) / HALF);
    full[n] = v * w;
    sum += full[n];
  }
  // Normalize DC gain to 1 — the upsampler applies the ×2 itself.
  const odd = new Float64Array(HALF);
  for (let k = 0; k < HALF; k++) odd[k] = full[2 * k + 1] / sum;
  return { odd, center: full[HALF] / sum };
}

export class HalfbandStage {
  private odd: Float64Array;
  private center: number;
  private xEven = new Float32Array(EVEN_DELAY); // x[i−1..i−4]
  private xOdd = new Float32Array(HALF); // x[i−1..i−8]
  private wEven = new Float32Array(EVEN_DELAY); // w1(i−1..i−4)
  private wOdd = new Float32Array(HALF); // w2(i−1..i−8)

  constructor() {
    const { odd, center } = designHalfband();
    this.odd = odd;
    this.center = center;
  }

  /**
   * Process one base-rate input sample; returns the base-rate output sample
   * delayed by OS2_LATENCY. `apply2x` runs the nonlinear stage on both 2×
   * samples — the caller closes over the character transform.
   */
  process(x: number, apply2x: (y: number) => number): number {
    // ── Upsample ──────────────────────────────────────────────
    // Even phase reads x from EVEN_DELAY calls ago (group delay).
    const upEven = 2 * this.center * this.xEven[EVEN_DELAY - 1];
    let acc = this.odd[0] * x; // odd phase includes the current sample
    for (let k = 1; k < HALF; k++) acc += this.odd[k] * this.xOdd[k - 1];
    const upOdd = 2 * acc;
    // Shift input histories, then record this sample.
    for (let k = EVEN_DELAY - 1; k > 0; k--) this.xEven[k] = this.xEven[k - 1];
    this.xEven[0] = x;
    for (let k = HALF - 1; k > 0; k--) this.xOdd[k] = this.xOdd[k - 1];
    this.xOdd[0] = x;

    // ── Nonlinear stage at 2× (caller-supplied transform) ─────
    const w1 = apply2x(upEven);
    const w2 = apply2x(upOdd);

    // ── Downsample ────────────────────────────────────────────
    let acc2 = this.center * this.wEven[EVEN_DELAY - 1]; // w1(i−4)
    for (let k = 0; k < HALF; k++) acc2 += this.odd[k] * this.wOdd[k]; // w2(i−1−k)
    // Shift w histories, then record this pair.
    for (let k = EVEN_DELAY - 1; k > 0; k--) this.wEven[k] = this.wEven[k - 1];
    this.wEven[0] = w1;
    for (let k = HALF - 1; k > 0; k--) this.wOdd[k] = this.wOdd[k - 1];
    this.wOdd[0] = w2;

    return acc2;
  }

  reset(): void {
    this.xEven.fill(0);
    this.xOdd.fill(0);
    this.wEven.fill(0);
    this.wOdd.fill(0);
  }
}
