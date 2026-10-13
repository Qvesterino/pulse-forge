/**
 * Analytic EQ response for the CORE `eq` effect — the same arithmetic the
 * worklet runs, done offline so the kit multiview can paint a curve.
 *
 * WHY THIS FILE IS A COPY OF THE WORKLET MATH AND NOT `BiquadFilterNode`:
 * `eq-processor.js` deliberately does NOT use textbook RBJ shelves. Shelves
 * are PARALLEL form (low shelf y = x + g·LP(x), high shelf y = x + g·(x −
 * LP(x)) over 2-pole Butterworth prototypes) so both ends land exactly on
 * 0 dB and ±G, and peaking bands carry a bilinear Q pre-correction. A
 * BiquadFilterNode response would therefore draw a curve that is *close to*
 * but not the curve the track is actually processing — which for a level
 * display is worse than no curve at all. Every prototype below is transcribed
 * from `src/audio-worklets/eq-processor.js`; the two must change together.
 *
 * The response is the exact cascade:
 *   HP → (v + lsG·LP_ls(v)) → peak_lm → peak_hm → f1 → f2
 *     → (v + hsG·(v − LP_hs(v))) → LP
 * evaluated at DC..Nyquist, in dB.
 */

const BUTTER_Q = 0.7071067811865475;

/** Signal-rate the worklet would use; the curve is a drawing, not audio. */
export const EQ_CURVE_SAMPLE_RATE = 48000;
export const EQ_CURVE_MIN_HZ = 20;
export const EQ_CURVE_MAX_HZ = 20000;
/** Shelf gains clamp to ±15 dB, peaks to ±15, free bands to ±24. */
export const EQ_CURVE_MIN_DB = -24;
export const EQ_CURVE_MAX_DB = 24;

type Proto = { b0: number; b1: number; b2: number; a1: number; a2: number };

function lpProto(fc: number, sr: number): Proto {
  const w0 = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * BUTTER_Q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function hpProto(fc: number, sr: number): Proto {
  const w0 = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * BUTTER_Q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function peakProto(fc: number, gdb: number, q: number, sr: number): Proto {
  const A = Math.pow(10, gdb / 40);
  const w0 = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cos) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

function notchProto(fc: number, q: number, sr: number): Proto {
  const w0 = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0,
    b1: (-2 * cos) / a0,
    b2: 1 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Inverse of the bilinear bandwidth warp — see the worklet for the derivation. */
function decrampedQ(q: number, fc: number, sr: number): number {
  const x = (Math.PI * fc) / sr;
  const s = Math.sin(x);
  if (s < 1e-6) return q;
  return (q * x) / s;
}

/** |H(e^jw)| for a normalized (a0 = 1) DF-I biquad. */
function protoMag(p: Proto, w: number): { re: number; im: number } {
  const c1 = Math.cos(-w);
  const s1 = Math.sin(-w);
  const c2 = Math.cos(-2 * w);
  const s2 = Math.sin(-2 * w);
  const nr = p.b0 + p.b1 * c1 + p.b2 * c2;
  const ni = p.b1 * s1 + p.b2 * s2;
  const dr = 1 + p.a1 * c1 + p.a2 * c2;
  const di = p.a1 * s1 + p.a2 * s2;
  const den = dr * dr + di * di;
  if (den === 0) return { re: 0, im: 0 };
  return { re: (nr * dr + ni * di) / den, im: (ni * dr - nr * di) / den };
}

function mul(a: { re: number; im: number }, b: { re: number; im: number }): { re: number; im: number } {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

function num(params: Record<string, number>, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Free bands: gain 0 is transparent, so skip the prototype entirely. */
function freeBand(
  p: Record<string, number>,
  index: 1 | 2,
  sr: number,
): Proto | null {
  const gain = num(p, `free${index}Gain`, 0);
  if (gain === 0) return null;
  const fc = num(p, `free${index}Freq`, index === 1 ? 1000 : 3000);
  const q = decrampedQ(num(p, `free${index}Q`, 2), fc, sr);
  return num(p, `free${index}Type`, 0) >= 0.5 ? notchProto(fc, q, sr) : peakProto(fc, gain, q, sr);
}

/**
 * Response in dB at one frequency. The value is clamped to ±24 dB so a
 * pathological parameter set cannot throw a canvas out of its own height.
 */
export function eqResponseDbAt(p: Record<string, number>, hz: number, sr = EQ_CURVE_SAMPLE_RATE): number {
  const f = Math.max(EQ_CURVE_MIN_HZ, Math.min(EQ_CURVE_MAX_HZ, hz));
  const w = (2 * Math.PI * f) / sr;

  let h = protoMag(hpProto(num(p, "hpFreq", 20), sr), w);
  const lsG = Math.pow(10, num(p, "lowShelfGain", 0) / 20) - 1;
  const ls = protoMag(lpProto(num(p, "lowShelfFreq", 120), sr), w);
  h = mul(h, { re: 1 + lsG * ls.re, im: lsG * ls.im });

  h = mul(h, protoMag(peakProto(num(p, "lowMidFreq", 400), num(p, "lowMidGain", 0), decrampedQ(num(p, "lowMidQ", 1), num(p, "lowMidFreq", 400), sr), sr), w));
  h = mul(h, protoMag(peakProto(num(p, "highMidFreq", 2500), num(p, "highMidGain", 0), decrampedQ(num(p, "highMidQ", 1), num(p, "highMidFreq", 2500), sr), sr), w));

  const f1 = freeBand(p, 1, sr);
  if (f1) h = mul(h, protoMag(f1, w));
  const f2 = freeBand(p, 2, sr);
  if (f2) h = mul(h, protoMag(f2, w));

  const hsG = Math.pow(10, num(p, "highShelfGain", 0) / 20) - 1;
  const hs = protoMag(lpProto(num(p, "highShelfFreq", 6000), sr), w);
  h = mul(h, { re: 1 + hsG * (1 - hs.re), im: -hsG * hs.im });

  h = mul(h, protoMag(lpProto(num(p, "lpFreq", 20000), sr), w));

  const mag = Math.hypot(h.re, h.im);
  if (!(mag > 0)) return EQ_CURVE_MIN_DB;
  const db = 20 * Math.log10(mag);
  return Math.max(EQ_CURVE_MIN_DB, Math.min(EQ_CURVE_MAX_DB, db));
}

/** Log-spaced dB samples across the spectrum, ready to plot. */
export function eqCurve(
  params: Record<string, number>,
  points = 96,
  sr = EQ_CURVE_SAMPLE_RATE,
): { hz: number; db: number }[] {
  const logMin = Math.log(EQ_CURVE_MIN_HZ);
  const logMax = Math.log(EQ_CURVE_MAX_HZ);
  const out: { hz: number; db: number }[] = [];
  for (let i = 0; i < points; i++) {
    const t = points === 1 ? 0 : i / (points - 1);
    const hz = Math.exp(logMin + t * (logMax - logMin));
    out.push({ hz, db: eqResponseDbAt(params, hz, sr) });
  }
  return out;
}
