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
import { dbToLinearGain } from "./scale-bridges";

const BUTTER_Q = 0.7071067811865475;

/** Signal-rate the worklet would use; the curve is a drawing, not audio. */
export const EQ_CURVE_SAMPLE_RATE = 48000;
export const EQ_CURVE_MIN_HZ = 20;
export const EQ_CURVE_MAX_HZ = 20000;
/** Shelf gains clamp to ±15 dB, peaks to ±15, free bands to ±24. */
export const EQ_CURVE_MIN_DB = -24;
export const EQ_CURVE_MAX_DB = 24;
/**
 * The analytic response floors far BELOW the drawn range on purpose. At
 * Nyquist a 2-pole lowpass is around -40 dB, and flooring it at -24 collapses
 * two different responses onto the same number — which is how a shelf spec
 * ends up measuring 0 dB of shelf instead of its gain. `eqCurve` clamps to the
 * drawn range instead, at the display boundary.
 */
const EQ_RESPONSE_FLOOR_DB = -60;

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
function freeBand(p: Record<string, number>, index: 1 | 2, sr: number): Proto | null {
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
  // Analytic: the frequency is NOT clamped to the drawn axis. Clamping here
  // would silently move a Nyquist probe to 20 kHz and make the shelf specs
  // below measure the wrong point. `eqCurve` picks the drawn range instead.
  const f = Math.max(1, hz);
  const w = (2 * Math.PI * f) / sr;

  let h = protoMag(hpProto(num(p, "hpFreq", 20), sr), w);
  const lsG = dbToLinearGain(num(p, "lowShelfGain", 0)) - 1;
  const ls = protoMag(lpProto(num(p, "lowShelfFreq", 120), sr), w);
  h = mul(h, { re: 1 + lsG * ls.re, im: lsG * ls.im });

  h = mul(
    h,
    protoMag(
      peakProto(
        num(p, "lowMidFreq", 400),
        num(p, "lowMidGain", 0),
        decrampedQ(num(p, "lowMidQ", 1), num(p, "lowMidFreq", 400), sr),
        sr,
      ),
      w,
    ),
  );
  h = mul(
    h,
    protoMag(
      peakProto(
        num(p, "highMidFreq", 2500),
        num(p, "highMidGain", 0),
        decrampedQ(num(p, "highMidQ", 1), num(p, "highMidFreq", 2500), sr),
        sr,
      ),
      w,
    ),
  );

  const f1 = freeBand(p, 1, sr);
  if (f1) h = mul(h, protoMag(f1, w));
  const f2 = freeBand(p, 2, sr);
  if (f2) h = mul(h, protoMag(f2, w));

  const hsG = Math.pow(10, num(p, "highShelfGain", 0) / 20) - 1;
  const hs = protoMag(lpProto(num(p, "highShelfFreq", 6000), sr), w);
  h = mul(h, { re: 1 + hsG * (1 - hs.re), im: -hsG * hs.im });

  h = mul(h, protoMag(lpProto(num(p, "lpFreq", 20000), sr), w));

  const mag = Math.hypot(h.re, h.im);
  if (!(mag > 0)) return EQ_RESPONSE_FLOOR_DB;
  const db = 20 * Math.log10(mag);
  return Math.max(EQ_RESPONSE_FLOOR_DB, Math.min(EQ_CURVE_MAX_DB, db));
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
    const db = eqResponseDbAt(params, hz, sr);
    out.push({ hz, db: Math.max(EQ_CURVE_MIN_DB, Math.min(EQ_CURVE_MAX_DB, db)) });
  }
  return out;
}

/**
 * The four gain bands the multiview curve exposes as draggable points.
 *
 * These are exactly the EQ params listed in `EDITOR_OVERRIDES.primaryParamIds`,
 * so a point on the curve and a knob under it are the same control — dragging
 * either one moves the other. That correspondence is the whole contract; a
 * curve with its own set of bands would let the two surfaces disagree.
 */
export interface EqBand {
  /** The effect param this point writes, e.g. "lowMidGain". */
  paramId: string;
  /** Centre frequency of the band, for hit-testing. */
  freqHz: number;
  /** Current gain in dB. */
  gainDb: number;
  min: number;
  max: number;
  label: string;
}

export const EQ_BAND_DEFS: readonly Pick<EqBand, "paramId" | "freqHz" | "label">[] = [
  { paramId: "lowShelfGain", freqHz: 120, label: "LOW SHELF" },
  { paramId: "lowMidGain", freqHz: 400, label: "LOW MID" },
  { paramId: "highMidGain", freqHz: 2500, label: "HIGH MID" },
  { paramId: "highShelfGain", freqHz: 6000, label: "HIGH SHELF" },
];

/** Shelve the current params into the drawable bands. */
export function eqBands(params: Record<string, number>): EqBand[] {
  return EQ_BAND_DEFS.map((def) => {
    const gainDb = num(params, def.paramId, 0);
    return { ...def, gainDb, min: -15, max: 15 };
  });
}

/**
 * Magnitude of ONE band in isolation, at one frequency. This is what a hit-test
 * compares against: the full cascade at the pointer is not a usable distance,
 * because two neighbouring bands overlap and the curve would always look closest
 * to the sum.
 */
export function eqBandResponseDbAt(
  band: Pick<EqBand, "paramId">,
  params: Record<string, number>,
  hz: number,
  sr = EQ_CURVE_SAMPLE_RATE,
): number {
  const w = (2 * Math.PI * Math.max(1, hz)) / sr;
  const freq = num(params, `${band.paramId.replace("Gain", "Freq")}`, 1000);
  const q = decrampedQ(num(params, band.paramId.replace("Gain", "Q"), 1), freq, sr);
  const gain = num(params, band.paramId, 0);

  if (band.paramId.endsWith("ShelfGain")) {
    // Parallel shelf: 1 + g·(1 − LP), the same shape the cascade uses.
    const g = Math.pow(10, gain / 20) - 1;
    const shelfLp = protoMag(lpProto(freq, sr), w);
    return 20 * Math.log10(Math.max(1e-6, Math.hypot(1 + g * (1 - shelfLp.re), g * shelfLp.im)));
  }
  // Peaking bell. `protoMag` returns a complex pair, so take its modulus —
  // passing the pair itself to Math.max is what turns the whole hit-test into
  // NaN and makes every band ungrabbable.
  const bell = protoMag(peakProto(freq, gain, q, sr), w);
  return 20 * Math.log10(Math.max(1e-6, Math.hypot(bell.re, bell.im)));
}

/**
 * Which band, if any, the pointer is grabbing.
 *
 * Distance is measured in dB against the pointer's own row, but only for bands
 * whose centre is close in frequency: a pointer near 1 kHz is not "on" a 6 kHz
 * shelf no matter how their gains happen to line up. `hz` and `db` are the
 * pointer's position; `hzTolerance` and `dbTolerance` are the grab radius.
 */
export function hitEqBand(
  params: Record<string, number>,
  hz: number,
  db: number,
  options: { hzTolerance?: number; dbTolerance?: number } = {},
): EqBand | null {
  const hzTolerance = options.hzTolerance ?? 1.6;
  const dbTolerance = options.dbTolerance ?? 6;
  let best: { band: EqBand; score: number } | null = null;
  for (const band of eqBands(params)) {
    if (Math.abs(Math.log(hz / band.freqHz)) > Math.log(hzTolerance)) continue;
    const response = eqBandResponseDbAt(band, params, band.freqHz);
    const score = Math.abs(response - db);
    if (score <= dbTolerance && (!best || score < best.score)) best = { band, score };
  }
  return best?.band ?? null;
}

/**
 * Pointer position (in the canvas' own pixels) to the dB value it stands for,
 * and the frequency under it. The inverse of the plot's own xOf/yOf, kept here
 * so the maths that decides what a drag means cannot drift from the maths that
 * draws the line.
 */
export function eqPointToDb(y: number, height: number, rangeDb = EQ_CURVE_MAX_DB): number {
  if (height <= 0) return 0;
  const clamped = Math.max(0, Math.min(height, y));
  return (1 - (clamped / height) * 2) * rangeDb;
}

export function eqXToHz(x: number, width: number): number {
  if (width <= 0) return EQ_CURVE_MIN_HZ;
  const t = Math.max(0, Math.min(1, x / width));
  return Math.exp(Math.log(EQ_CURVE_MIN_HZ) + t * (Math.log(EQ_CURVE_MAX_HZ) - Math.log(EQ_CURVE_MIN_HZ)));
}

export function eqHzToX(hz: number, width: number): number {
  const t =
    (Math.log(Math.max(EQ_CURVE_MIN_HZ, Math.min(EQ_CURVE_MAX_HZ, hz))) - Math.log(EQ_CURVE_MIN_HZ)) /
    (Math.log(EQ_CURVE_MAX_HZ) - Math.log(EQ_CURVE_MIN_HZ));
  return t * width;
}
