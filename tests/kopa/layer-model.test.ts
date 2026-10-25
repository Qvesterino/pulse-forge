import { describe, expect, it } from "vitest";
import { KopaProcessor, type KopaEvent } from "../../src/kopa/dsp/kopaProcessor";
import { kopaParams } from "../../src/instruments/definitions";
import {
  KOPA_TIME_MAX_MS,
  KOPA_TIME_MIN_MS,
  kopaLanes,
  kopaLayerEnvelope,
  kopaPitchEnvelope,
  kopaTimeMs,
  kopaTimeNorm,
} from "../../src/kopa/layerModel";

/**
 * THE GRAPHIC IS THE DSP'S PICTURE — measured, not asserted.
 *
 * The KOPA editor (roadmap wave 2) draws the kick's layers and its pitch
 * envelope. A drawing that only LOOKS right is worth nothing, so this spec
 * renders the REAL processor and compares what came out of it with what the
 * editor would draw:
 *
 *  - the body's amplitude envelope must follow the drawn envelope;
 *  - the body's pitch must follow the drawn pitch curve;
 *  - the sub must ride the LONGER of the body and tail envelopes — the rule
 *    the graphic states in words.
 *
 * The model and the processor share the pitch shape and the decay
 * coefficient (`src/kopa/layerModel.ts` imports them), so these specs check
 * the RENDER, not a formula against itself.
 */

const SR = 48000;
const BLOCK = 128;
/** The fixed reference note of KOPA (MIDI 36 = C2) when keyTrack is off. */
const C2 = 65.40639132514966;

function defaults(overrides: Record<string, number> = {}): Record<string, number> {
  return { ...Object.fromEntries(kopaParams.map((param) => [param.id, param.default])), ...overrides };
}

function render(
  processor: KopaProcessor,
  params: Record<string, number>,
  seconds: number,
  events: KopaEvent[] = [],
): { left: Float32Array; right: Float32Array } {
  // The processor owns its parameters — a render without them measures the
  // DEFAULTS, not the patch under test.
  processor.applyParams(params);
  for (const event of events) processor.postEvent(event);
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let frame = 0;
  while (frame < frames) {
    const count = Math.min(BLOCK, frames - frame);
    processor.process(left.subarray(frame, frame + count), right.subarray(frame, frame + count), frame);
    frame += count;
  }
  return { left, right };
}

/**
 * The peak-to-peak over a window.
 *
 * A window shorter than a period can miss the extremes, so the envelope
 * checks use windows of at least 1.5 periods — otherwise the measurement
 * reads the waveform's phase, not its level.
 */
function peakToPeak(signal: Float32Array, fromSec: number, toSec: number): number {
  const from = Math.floor(fromSec * SR);
  const to = Math.min(signal.length, Math.floor(toSec * SR));
  let max = -Infinity;
  let min = Infinity;
  for (let i = from; i < to; i++) {
    max = Math.max(max, signal[i]!);
    min = Math.min(min, signal[i]!);
  }
  return max - min;
}

/** The zero crossings (sub-sample, by linear interpolation) after `fromSec`. */
function zeroCrossings(signal: Float32Array, fromSec: number, toSec: number): number[] {
  const from = Math.floor(fromSec * SR);
  const to = Math.min(signal.length, Math.floor(toSec * SR));
  const crossings: number[] = [];
  for (let i = from + 1; i < to; i++) {
    const a = signal[i - 1]!;
    const b = signal[i]!;
    if (a === 0 || a < 0 === b < 0) continue;
    crossings.push(i - 1 + Math.abs(a) / Math.max(1e-12, Math.abs(a) + Math.abs(b)));
  }
  return crossings;
}

/** The model's drawn semitone offset at a time (the model's own points). */
function modelSemitonesAt(points: { timeSec: number; semitones: number }[], timeSec: number): number {
  if (points.length === 0) return 0;
  if (timeSec <= points[0]!.timeSec) return points[0]!.semitones;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (timeSec <= b.timeSec) {
      const span = b.timeSec - a.timeSec;
      const ratio = span > 0 ? (timeSec - a.timeSec) / span : 0;
      return a.semitones + (b.semitones - a.semitones) * ratio;
    }
  }
  return points[points.length - 1]!.semitones;
}

/** The body alone: no click, no sub, no tail, no harmonics, no drive. */
function bodyOnly(overrides: Record<string, number> = {}): Record<string, number> {
  return defaults({
    clickLevel: 0,
    subLevel: 0,
    tailLevel: 0,
    harmonicLevel: 0,
    bodyHollow: 0,
    drive: 0,
    punch: 0,
    stereo: 0,
    level: 0,
    ...overrides,
  });
}

describe("the KOPA graphic is the DSP's picture", () => {
  it("the drawn body envelope follows the RENDERED body envelope", () => {
    const params = bodyOnly({ bodyDecay: 0.35 });
    const { left } = render(new KopaProcessor({ sampleRate: SR }), params, 0.6, [
      { type: "noteOn", when: 0, pitch: 36, velocity: 1 },
    ]);
    // The body is `sin * bodyEnv * 0.9` and the processor's output is scaled
    // by 0.5 — so the rendered peak-to-peak is 0.9 × the envelope. The window
    // spans 1.6 periods of the body, so it always contains both extremes.
    const window = 1.6 / C2;
    for (const t of [0.01, 0.05, 0.12, 0.25, 0.4]) {
      const expected = 0.9 * kopaLayerEnvelope(t + window / 2, params.bodyDecay!, SR);
      const measured = peakToPeak(left, t, t + window);
      expect(Math.abs(measured - expected) / expected, `the drawn envelope is wrong at ${t}s`).toBeLessThan(0.08);
    }
  });

  it("the drawn pitch curve follows the RENDERED pitch", () => {
    const params = bodyOnly({ pitchAmount: 24, pitchTime: 200, bodyDecay: 2 });
    const { left } = render(new KopaProcessor({ sampleRate: SR }), params, 0.3, [
      { type: "noteOn", when: 0, pitch: 36, velocity: 1 },
    ]);
    const points = kopaPitchEnvelope(params);
    const crossings = zeroCrossings(left, 0.004, 0.12);
    expect(crossings.length, "the rendered body has no pitch to measure").toBeGreaterThan(3);
    for (let i = 1; i < crossings.length; i++) {
      const period = (crossings[i]! - crossings[i - 1]!) / SR;
      const measured = 1 / (2 * period);
      const midSec = (crossings[i]! + crossings[i - 1]!) / 2 / SR;
      const semitones = modelSemitonesAt(points, midSec);
      const predicted = C2 * Math.pow(2, semitones / 12);
      expect(
        Math.abs(measured - predicted) / predicted,
        `the drawn pitch is wrong at ${(midSec * 1000).toFixed(1)}ms`,
      ).toBeLessThan(0.08);
    }
  });

  it("the sub rides the LONGER of the body and the tail — as the graphic says", () => {
    const params = defaults({
      clickLevel: 0,
      harmonicLevel: 0,
      tailLevel: 0,
      bodyHollow: 0,
      bodyDecay: 0.1,
      tailDecay: 1.0,
      subLevel: 0.5,
      level: 0,
      drive: 0,
      punch: 0,
      stereo: 0,
    });
    const { left } = render(new KopaProcessor({ sampleRate: SR }), params, 0.8, [
      { type: "noteOn", when: 0, pitch: 36, velocity: 1 },
    ]);
    // The body is dead by 0.3 s, so at 0.5 s only the sub sounds — and it
    // must be following the TAIL's envelope, not the body's. The sub runs one
    // octave under the body (32.7 Hz here), so the window spans its period.
    const window = 1.6 / (C2 / 2);
    const tailEnv = kopaLayerEnvelope(0.5 + window / 2, params.tailDecay!, SR);
    const bodyEnv = kopaLayerEnvelope(0.5 + window / 2, params.bodyDecay!, SR);
    // The sub's mix gain is 0.5 and the output is scaled by 0.5.
    const expected = 2 * 0.5 * 0.5 * params.subLevel! * tailEnv;
    const measured = peakToPeak(left, 0.5, 0.5 + window);
    expect(Math.abs(measured - expected) / expected).toBeLessThan(0.08);
    // The body is long gone — if the sub followed the body, it would be silent.
    expect(bodyEnv / tailEnv).toBeLessThan(0.02);
    // And the MODEL states the same rule.
    const lanes = kopaLanes(params);
    const sub = lanes.find((lane) => lane.id === "sub")!;
    expect(sub.decaySec).toBeCloseTo(Math.max(params.bodyDecay!, params.tailDecay!), 6);
    expect(sub.followsLength).toBeTruthy();
  });

  it("the time axis is logarithmic, monotonic and spans the layers", () => {
    expect(kopaTimeNorm(KOPA_TIME_MIN_MS)).toBeCloseTo(0, 6);
    expect(kopaTimeNorm(KOPA_TIME_MAX_MS)).toBeCloseTo(1, 6);
    // The axis spans 3.48 decades (1 ms → 3 s), so a decade is 28.8 % of it —
    // that is what lets a 3 ms click and a 400 ms tail share one timeline.
    const decade = kopaTimeNorm(10) - kopaTimeNorm(1);
    expect(decade).toBeCloseTo(1 / Math.log10(3000), 6);
    for (const ms of [1, 3, 10, 100, 350, 1000, 3000]) {
      expect(kopaTimeMs(kopaTimeNorm(ms))).toBeCloseTo(ms, 6);
    }
    expect(kopaTimeNorm(3000)).toBeGreaterThan(kopaTimeNorm(350));
  });

  it("the lanes are the DSP's layers — with the handles the DSP really has", () => {
    const params = defaults();
    const lanes = kopaLanes(params);
    expect(lanes.map((lane) => lane.id)).toEqual(["click", "body", "sub", "tail", "harm"]);
    // The body has no level parameter in the DSP, and the sub has no decay of
    // its own — the graphic must not offer handles for them.
    expect(lanes.find((lane) => lane.id === "body")!.levelParam).toBeUndefined();
    expect(lanes.find((lane) => lane.id === "sub")!.lengthParam).toBeUndefined();
    // Every level handle the graphic offers IS a parameter the instrument has.
    const ids = new Set(kopaParams.map((param) => param.id));
    for (const lane of lanes) {
      if (lane.levelParam) expect(ids.has(lane.levelParam)).toBe(true);
      if (lane.lengthParam) expect(ids.has(lane.lengthParam)).toBe(true);
    }
  });
});
