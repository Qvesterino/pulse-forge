/**
 * KOPA LAYER MODEL — the graphic's truth, as pure data.
 *
 * The KOPA editor (roadmap wave 2) draws what the KOPA DSP actually does.
 * That claim is only worth something if the drawing comes from ONE place that
 * the DSP and the editor both agree on — so this module owns the layer
 * geometry and the pitch envelope, and the DSP's own formulas are mirrored
 * here EXACTLY:
 *
 *  - the layer envelopes are the DSP's one-pole decays. The DSP uses
 *    `coef = min(1, 1/(decaySec * sr * 0.33))` per sample, so the envelope at
 *    time t is `exp(-t / (0.33 * decaySec))` — which is why the DSP's comment
 *    says it "reaches ~5 % after `decaySec`" (exp(-1/0.33) = 0.048).
 *  - the pitch envelope is the DSP's: `t = min(1, samples/(pitchTime*sr))`,
 *    then the curve (exp / lin / snap / hold), then the semitone offset is
 *    `pitchAmount * env`.
 *  - the SUB layer rides `max(bodyEnv, tailEnv)`, so its length is the LONGER
 *    of the two decays — it has no length of its own and the editor must not
 *    pretend otherwise.
 *
 * The model is PURE: it takes the stored parameters and returns geometry. It
 * never reads the document, never touches the engine and never allocates per
 * frame — the editor re-renders it on a drag, the tests assert it.
 */

/** The editor's time axis: a LOG scale, because the layers differ by decades. */
export const KOPA_TIME_MIN_MS = 1;
export const KOPA_TIME_MAX_MS = 3000;

/** The DSP's decay constant: the envelope reaches ~5 % after `decaySec`. */
export const KOPA_DECAY_K = 0.33;

/** A layer of the kick as the editor shows it. */
export interface KopaLane {
  /** Stable id (also the test hook). */
  id: string;
  /** Short label on the lane. */
  label: string;
  /** The parameter that sets this lane's LENGTH (its decay), if it has one. */
  lengthParam?: string;
  /** The parameter that sets this lane's LEVEL, if it has one. */
  levelParam?: string;
  /** The decay in seconds (the time to ~5 %). */
  decaySec: number;
  /** The drawn height (0..1) — the stored level, or the DSP's fixed mix gain. */
  level: number;
  /** The DSP's fixed mix gain for this layer (the drawn height is NOT scaled by it). */
  mixGain: number;
  /** True when the length follows another lane (the sub rides body/tail). */
  followsLength?: string;
}

export interface KopaPitchPoint {
  /** Seconds from the note start. */
  timeSec: number;
  /** The pitch offset in semitones (the DSP's `pitchAmount * env`). */
  semitones: number;
}

/**
 * The lanes, in the order the editor stacks them.
 *
 * The four layers the roadmap names (click / body / sub / tail) plus the
 * kick's own harmonic layer — it is audible, it has a level and a decay, and
 * hiding it would make the graphic a partial truth.
 */
export function kopaLanes(params: Record<string, number>): KopaLane[] {
  const p = params;
  const clickDecay = clamp(p.clickDecay ?? 3, 0.2, 20) / 1000;
  const bodyDecay = clamp(p.bodyDecay ?? 0.35, 0.03, 2);
  const tailDecay = clamp(p.tailDecay ?? 0.4, 0.05, 3);
  const harmonicDecay = clamp(p.harmonicDecay ?? 0.25, 0.03, 2);
  return [
    {
      id: "click",
      label: "CLICK",
      lengthParam: "clickDecay",
      levelParam: "clickLevel",
      decaySec: clickDecay,
      level: clamp(p.clickLevel ?? 0.35, 0, 1),
      mixGain: 1,
    },
    {
      id: "body",
      label: "BODY",
      lengthParam: "bodyDecay",
      decaySec: bodyDecay,
      level: 0.9,
      mixGain: 0.9,
    },
    {
      id: "sub",
      label: "SUB",
      levelParam: "subLevel",
      decaySec: Math.max(bodyDecay, tailDecay),
      level: clamp(p.subLevel ?? 0.3, 0, 1),
      mixGain: 0.5,
      followsLength: "body/tail",
    },
    {
      id: "tail",
      label: "TAIL",
      lengthParam: "tailDecay",
      levelParam: "tailLevel",
      decaySec: tailDecay,
      level: clamp(p.tailLevel ?? 0.25, 0, 1),
      mixGain: 0.9,
    },
    {
      id: "harm",
      label: "HARM",
      lengthParam: "harmonicDecay",
      levelParam: "harmonicLevel",
      decaySec: harmonicDecay,
      level: clamp(p.harmonicLevel ?? 0.25, 0, 1),
      mixGain: 0.55,
    },
  ];
}

/**
 * The pitch envelope, in semitones over time — the DSP's own curve.
 *
 * `pitchCurve`: 0 = exp ((1-t)²), 1 = lin (1-t), 2 = snap (1 for t < 0.35),
 * 3 = hold (1 for t < 0.15, then a linear fall).
 */
export function kopaPitchEnvelope(params: Record<string, number>, steps = 48): KopaPitchPoint[] {
  const amount = clamp(params.pitchAmount ?? 24, 0, 48);
  const timeSec = clamp(params.pitchTime ?? 40, 5, 200) / 1000;
  const curve = Math.round(clamp(params.pitchCurve ?? 0, 0, 3));
  const points: KopaPitchPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const timeSec_i = (i / steps) * timeSec;
    const t = timeSec > 0 ? Math.min(1, timeSec_i / timeSec) : 1;
    points.push({ timeSec: timeSec_i, semitones: amount * pitchEnv(t, curve) });
  }
  return points;
}

/** The DSP's pitch envelope shape, extracted so the model and the DSP agree. */
export function pitchEnv(t: number, curve: number): number {
  if (curve === 0) return (1 - t) * (1 - t);
  if (curve === 1) return 1 - t;
  if (curve === 2) return t < 0.35 ? 1 : 0;
  return t < 0.15 ? 1 : Math.max(0, 1 - (t - 0.15) / 0.85);
}

/**
 * The drawn envelope of a layer at time `t` seconds.
 *
 * The DSP decays `env -= env * coef` per sample with `coef = 1/(decay*sr*0.33)`,
 * so the envelope is `exp(-t/(0.33*decay))` — the same function the DSP's
 * "reaches ~5 % after decaySec" comment describes.
 */
export function kopaLayerEnvelope(t: number, decaySec: number): number {
  if (decaySec <= 0) return 0;
  return Math.exp(-t / (KOPA_DECAY_K * decaySec));
}

/** The time-axis position of `ms` — 0 at the axis start, 1 at the axis end. */
export function kopaTimeNorm(ms: number): number {
  const clamped = Math.max(KOPA_TIME_MIN_MS, Math.min(KOPA_TIME_MAX_MS, ms));
  const lo = Math.log(KOPA_TIME_MIN_MS);
  const hi = Math.log(KOPA_TIME_MAX_MS);
  return (Math.log(clamped) - lo) / (hi - lo);
}

/** The inverse of `kopaTimeNorm`: the axis position back to milliseconds. */
export function kopaTimeMs(norm: number): number {
  const clamped = Math.max(0, Math.min(1, norm));
  const lo = Math.log(KOPA_TIME_MIN_MS);
  const hi = Math.log(KOPA_TIME_MAX_MS);
  return Math.exp(lo + clamped * (hi - lo));
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
