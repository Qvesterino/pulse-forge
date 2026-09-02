/**
 * Shared DAHDSR envelope scheduling for gain AudioParams.
 *
 * Fully scheduled at noteOn — deterministic by construction, so offline
 * renders match live playback. Stage curves: 0 = classic exponential (the
 * legacy per-instrument automation calls), 1 = linear, 2 = logarithmic
 * (slow start, fast settle). decayLoops re-runs the decay ramp for pulsing
 * pads and percussion-style envelopes.
 *
 * Release: the exponential curve starts from whatever value the param has at
 * gate-off (setTargetAtTime is state-relative). Linear/log release need an
 * explicit anchor; they anchor at the sustain value only when the gate
 * outlasts the decay, and fall back to exponential on short gates so a
 * mid-decay release never jumps.
 *
 * Render-neutrality contract: with delay 0, hold 0, all shapes 0, loops 0
 * and the per-instrument compat constants, the emitted automation events are
 * EXACTLY the legacy sequence (same values, same times, same setTarget taus).
 */

export type EnvShape = 0 | 1 | 2;

export const ENV_SHAPE_OPTIONS = [
  { value: 0, label: "Exp" },
  { value: 1, label: "Lin" },
  { value: 2, label: "Log" },
];

export interface DahdsrSpec {
  delay: number;
  hold: number;
  attack: number;
  decay: number;
  /** 0..1 fraction of peak held during sustain. */
  sustain: number;
  release: number;
  aShape: number;
  dShape: number;
  rShape: number;
  /** Extra decay re-runs after the first (0 = single decay). */
  decayLoops: number;
  /** Gate-off floor for attack/delay/release events (legacy Analog: 0.0001). */
  eps?: number;
  /** Sustain/peak floor (legacy Analog: 0.0002). */
  susFloor?: number;
  /** setTargetAtTime tau divisor for the classic release (legacy: 4). */
  releaseTauDiv?: number;
  /** Final snap-to-zero anchor after the tail (off for bit-legacy). */
  finalAnchor?: boolean;
}

const DEFAULT_EPS = 0.0002;

function rampStage(param: AudioParam, from: number, to: number, t0: number, dur: number, shape: EnvShape): void {
  if (dur <= 0) {
    param.setValueAtTime(to, t0);
    return;
  }
  if (shape === 1) {
    param.setValueAtTime(from, t0);
    param.linearRampToValueAtTime(to, t0 + dur);
    return;
  }
  if (shape === 2) {
    // Log-ish: ease out of the start, settle exponentially at the end
    param.setValueAtTime(from, t0);
    param.linearRampToValueAtTime(from + (to - from) * 0.25, t0 + dur * 0.3);
    param.exponentialRampToValueAtTime(Math.max(DEFAULT_EPS, to), t0 + dur);
    return;
  }
  // Classic exponential attack / setTarget-style settle. setTargetAtTime is
  // state-relative — NO anchor event, exactly like the legacy per-instrument
  // automation (an extra setValueAtTime would break bit-compat).
  if (from <= DEFAULT_EPS) {
    param.exponentialRampToValueAtTime(Math.max(DEFAULT_EPS, to), t0 + dur);
  } else {
    param.setTargetAtTime(to, t0, dur / 3);
  }
}

export function scheduleDahdsr(
  param: AudioParam,
  t0: number,
  off: number,
  end: number,
  peak: number,
  spec: DahdsrSpec,
): void {
  const eps = spec.eps ?? DEFAULT_EPS;
  const susFloor = spec.susFloor ?? DEFAULT_EPS;
  const sus = Math.max(susFloor, peak * Math.max(0, Math.min(1, spec.sustain)));
  const top = Math.max(susFloor, peak);
  // Durations are trusted to the caller (each instrument clamps its own
  // parameter ranges — re-clamping here would break legacy bit-compat).
  const a = Math.max(0, spec.attack);
  const d = Math.max(0.005, spec.decay);
  const r = Math.max(0.005, spec.release);
  const delay = Math.max(0, spec.delay);
  const hold = Math.max(0, spec.hold);
  const loops = Math.max(0, Math.min(8, Math.round(spec.decayLoops)));
  const shapeOf = (v: number): EnvShape => (Math.max(0, Math.min(2, Math.round(v))) as EnvShape);
  const aShape = shapeOf(spec.aShape);
  const dShape = shapeOf(spec.dShape);
  const rShape = shapeOf(spec.rShape);

  // DELAY + ATTACK
  param.setValueAtTime(eps, t0);
  let t = t0 + delay;
  if (t > t0) param.setValueAtTime(eps, t);
  rampStage(param, eps, top, t, a, aShape);
  t += a;
  // HOLD at peak
  if (hold > 0) {
    param.setValueAtTime(top, t);
    t += hold;
  }
  // DECAY (+ loops): peak -> sustain, repeated from the top
  const decayOnce = (start: number) => rampStage(param, top, sus, start, d, dShape);
  decayOnce(t);
  t += d;
  for (let i = 0; i < loops; i++) {
    param.setValueAtTime(top, t);
    decayOnce(t);
    t += d;
  }
  // Sustain rests at `sus` — no further automation until release.
  // RELEASE from the gate-off point.
  const decayDone = off >= t;
  if (rShape === 0 || !decayDone) {
    param.setTargetAtTime(eps, off, r / (spec.releaseTauDiv ?? 3));
  } else {
    param.setValueAtTime(sus, off);
    rampStage(param, sus, eps, off, r, rShape);
  }
  if (spec.finalAnchor !== false) {
    param.setValueAtTime(eps, Math.max(off, end));
  }
}
