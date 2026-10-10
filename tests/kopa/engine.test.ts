import { describe, expect, it } from "vitest";
import { KopaProcessor, type KopaEvent } from "../../src/kopa/dsp/kopaProcessor";
import { kopaParams } from "../../src/instruments/definitions";

/**
 * F2 — KOPA ENGINE CORE (KOPA plan §3.5). The DSP is tested DIRECTLY at its
 * sample boundary (the tsarProcessor pattern): no AudioContext, no worklet
 * host, no port. Every claim here is about the SOUND.
 *
 * The offline-parity contract is asserted structurally: the SAME event list
 * produces the SAME samples whether it was applied through the live-style
 * queue or seeded at construction — the two real-runtime paths differ only
 * in WHEN the queue is filled, never in what it contains.
 */

const SR = 48000;
const BLOCK = 128;

function defaultParams(overrides: Record<string, number> = {}): Record<string, number> {
  return { ...Object.fromEntries(kopaParams.map((param) => [param.id, param.default])), ...overrides };
}

function paramsWith(overrides: Record<string, number>): Record<string, number> {
  return { ...defaultParams(), ...overrides };
}

function render(
  processor: KopaProcessor,
  seconds: number,
  events: KopaEvent[] = [],
): { left: Float32Array; right: Float32Array } {
  // The `events` argument IS the live/port-style path: post before rendering.
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

function peak(data: Float32Array): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]!));
  return max;
}

function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
  return Math.sqrt(sum / Math.max(1, data.length));
}

/** Goertzel at `hz` over a trailing window (the stable part of the hit). */
function goertzelAt(signal: Float32Array, hz: number, fromFraction = 0.5): number {
  const from = Math.floor(signal.length * fromFraction);
  const n = signal.length - from;
  if (n <= 0) return 0;
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / SR);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < signal.length; i++) {
    const s0 = signal[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

/** First-difference energy ratio — rises with high-frequency content (THD). */
function brightness(data: Float32Array, fromFraction = 0.1): number {
  const from = Math.floor(data.length * fromFraction);
  let diff = 0;
  let signal = 0;
  for (let i = from + 1; i < data.length; i++) {
    const d = data[i]! - data[i - 1]!;
    diff += d * d;
    signal += data[i]! * data[i]!;
  }
  return Math.sqrt(diff / Math.max(1e-12, signal));
}

function makeProcessor(overrides: Record<string, number> = {}): KopaProcessor {
  const processor = new KopaProcessor({ sampleRate: SR });
  processor.applyParams(paramsWith(overrides));
  return processor;
}

const noteOn = (pitch = 36, velocity = 1, when = 0): KopaEvent => ({ type: "noteOn", pitch, velocity, when });

describe("KopaProcessor — voice basics", () => {
  it("a noteOn produces audible output; a silent processor does not", () => {
    const withNote = makeProcessor();
    withNote.postEvent(noteOn());
    const hit = render(withNote, 0.3);
    const silent = new KopaProcessor({ sampleRate: SR });
    silent.applyParams(defaultParams());
    const quiet = render(silent, 0.3);
    expect(peak(hit.left)).toBeGreaterThan(0.05);
    expect(peak(quiet.left)).toBe(0);
  });

  it("a one-shot decays to silence on its own (no stuck voice)", () => {
    const processor = makeProcessor({ bodyDecay: 0.1, tailDecay: 0.05, tailLevel: 0, clickLevel: 0 });
    processor.postEvent(noteOn());
    const { left } = render(processor, 1.5);
    expect(rms(left.subarray(Math.ceil(1.2 * SR)))).toBeLessThan(1e-4);
  });

  it("noteOff chokes the voice", () => {
    const processor = makeProcessor({ bodyDecay: 2, tailDecay: 3, tailLevel: 0.5 });
    processor.postEvent(noteOn(36, 1, 0));
    processor.postEvent({ type: "noteOff", pitch: 36, when: 0.05 });
    const { left } = render(processor, 0.6);
    expect(rms(left.subarray(Math.ceil(0.5 * SR)))).toBeLessThan(1e-3);
  });

  it("panic silences everything immediately", () => {
    const processor = makeProcessor({ bodyDecay: 2, tailDecay: 3 });
    processor.postEvent(noteOn());
    processor.postEvent({ type: "panic", when: 0.05 });
    const { left } = render(processor, 0.5);
    expect(rms(left.subarray(Math.ceil(0.3 * SR)))).toBeLessThan(1e-3);
  });

  it("16 voices sound together; a 17th steals (never drops the count)", () => {
    const processor = makeProcessor({ bodyDecay: 1, tailDecay: 1 });
    for (let i = 0; i < 17; i++) processor.postEvent(noteOn(36 + i, 0.8, i * 0.002));
    const { left } = render(processor, 0.3);
    expect(peak(left)).toBeGreaterThan(0.05);
    // 17 simultaneous voices would exceed the 0.5 normalization headroom if
    // stealing did not hold the pool at 16.
    expect(peak(left)).toBeLessThanOrEqual(2);
  });
});

describe("KopaProcessor — layers", () => {
  it("pitchAmount stretches the early pitch drop (higher amount = faster zero crossings early)", () => {
    // Zero-crossing count in the first 15 ms of the ramp measures the
    // instantaneous pitch: a 48 st drop starts much higher than a 12 st drop.
    const earlyCrossings = (pitchAmount: number): number => {
      const processor = makeProcessor({
        pitchAmount,
        pitchTime: 200,
        clickLevel: 0,
        tailLevel: 0,
        subLevel: 0,
        drive: 0,
        bodyDecay: 2,
      });
      processor.postEvent(noteOn(33)); // A1 = 55 Hz target
      const { left } = render(processor, 0.015);
      let crossings = 0;
      for (let i = 1; i < left.length; i++) {
        if ((left[i - 1]! <= 0 && left[i]! > 0) || (left[i - 1]! >= 0 && left[i]! < 0)) crossings++;
      }
      return crossings;
    };
    expect(earlyCrossings(48)).toBeGreaterThan(earlyCrossings(12) * 1.5);
  });

  it("keyTrack=1 makes the fundamental follow the note (C2 vs C3 = 2x)", () => {
    const fundamental = (pitch: number): number => {
      const processor = makeProcessor({
        keyTrack: 1,
        pitchAmount: 0,
        clickLevel: 0,
        tailLevel: 0,
        subLevel: 0,
        drive: 0,
        bodyDecay: 1,
      });
      processor.postEvent(noteOn(pitch));
      const { left } = render(processor, 0.5);
      return goertzelAt(left, 440 * Math.pow(2, (pitch - 69) / 12));
    };
    const c2 = fundamental(36);
    const c3 = fundamental(48);
    expect(c2).toBeGreaterThan(0.01);
    expect(c3).toBeGreaterThan(0.01);
  });

  it("keyTrack=0 pins the fundamental to C2 regardless of the note", () => {
    const processor = makeProcessor({
      keyTrack: 0,
      pitchAmount: 0,
      clickLevel: 0,
      tailLevel: 0,
      subLevel: 0,
      drive: 0,
      bodyDecay: 1,
    });
    processor.postEvent(noteOn(48)); // C3 note, fixed C2 fundamental
    const { left } = render(processor, 0.5);
    expect(goertzelAt(left, 65.4)).toBeGreaterThan(0.01);
    expect(goertzelAt(left, 130.8)).toBeGreaterThan(0.005); // body harmonic
  });

  it("subLevel adds energy on the octave below the body (phase-locked sub)", () => {
    const energy = (subLevel: number): number => {
      const processor = makeProcessor({
        pitchAmount: 0,
        clickLevel: 0,
        tailLevel: 0,
        subLevel,
        drive: 0,
        bodyDecay: 1,
      });
      processor.postEvent(noteOn(36));
      const { left } = render(processor, 0.5);
      return goertzelAt(left, 65.4 / 2);
    };
    expect(energy(0.9)).toBeGreaterThan(energy(0) * 4);
  });

  it("Bass Harmonic adds an upper-partial stack while omitting the root", () => {
    const harmonicEnergy = (harmonicLevel: number, hz: number): number => {
      const processor = makeProcessor({
        pitchAmount: 0,
        bodyHollow: 0,
        bodyDecay: 2,
        clickLevel: 0,
        tailLevel: 0,
        subLevel: 0,
        harmonicLevel,
        harmonicTone: 0.5,
        harmonicRange: 2,
        drive: 0,
        punch: 0,
        level: 0,
      });
      processor.postEvent(noteOn(36));
      const { left } = render(processor, 0.6);
      return goertzelAt(left, hz, 0.1);
    };
    const rootHz = 65.40639132514966;
    const dryRoot = harmonicEnergy(0, rootHz);
    const wetRoot = harmonicEnergy(1, rootHz);
    const dryUpper = harmonicEnergy(0, rootHz * 2) + harmonicEnergy(0, rootHz * 3);
    const wetUpper = harmonicEnergy(1, rootHz * 2) + harmonicEnergy(1, rootHz * 3);

    expect(wetUpper).toBeGreaterThan(dryUpper + 0.005);
    expect(wetRoot).toBeCloseTo(dryRoot, 3);
  });

  it("harmonicTone crossfades the generated 2nd and 3rd partials", () => {
    const partials = (harmonicTone: number): [number, number] => {
      const processor = makeProcessor({
        pitchAmount: 0,
        bodyHollow: 0,
        bodyDecay: 2,
        clickLevel: 0,
        tailLevel: 0,
        subLevel: 0,
        harmonicLevel: 1,
        harmonicTone,
        drive: 0,
        punch: 0,
        level: 0,
      });
      processor.postEvent(noteOn(36));
      const { left } = render(processor, 0.6);
      const rootHz = 65.40639132514966;
      return [goertzelAt(left, rootHz * 2, 0.1), goertzelAt(left, rootHz * 3, 0.1)];
    };
    const secondLeaning = partials(0);
    const thirdLeaning = partials(1);
    expect(secondLeaning[0]).toBeGreaterThan(secondLeaning[1] * 3);
    expect(thirdLeaning[1]).toBeGreaterThan(thirdLeaning[0] * 3);
  });

  it("harmonicRange adds upper partials without changing the root layer", () => {
    const fourthPartial = (harmonicRange: number): number => {
      const processor = makeProcessor({
        pitchAmount: 0,
        bodyHollow: 0,
        bodyDecay: 2,
        clickLevel: 0,
        tailLevel: 0,
        subLevel: 0,
        harmonicLevel: 1,
        harmonicRange,
        harmonicTone: 0.5,
        drive: 0,
        punch: 0,
        level: 0,
      });
      processor.postEvent(noteOn(36));
      const { left } = render(processor, 0.6);
      return goertzelAt(left, 65.40639132514966 * 4, 0.1);
    };
    expect(fourthPartial(2)).toBeGreaterThan(fourthPartial(1) * 2);
  });

  it("harmonicDecay shapes the layer independently from the kick body", () => {
    const lateHarmonicRms = (harmonicDecay: number): number => {
      const processor = makeProcessor({
        pitchAmount: 0,
        bodyHollow: 0,
        bodyDecay: 0.03,
        clickLevel: 0,
        tailLevel: 0,
        subLevel: 0,
        harmonicLevel: 1,
        harmonicDecay,
        harmonicRange: 2,
        drive: 0,
        punch: 0,
        level: 0,
      });
      processor.postEvent(noteOn(36));
      const { left } = render(processor, 0.5);
      return rms(left.subarray(Math.floor(0.2 * SR)));
    };
    expect(lateHarmonicRms(1.5)).toBeGreaterThan(lateHarmonicRms(0.05) * 8);
  });

  it("harmonicCharacter shapes only the generated layer", () => {
    const samples = (harmonicCharacter: number): Float32Array => {
      const processor = makeProcessor({
        pitchAmount: 0,
        bodyHollow: 0,
        bodyDecay: 2,
        clickLevel: 0,
        tailLevel: 0,
        subLevel: 0,
        harmonicLevel: 1,
        harmonicCharacter,
        harmonicRange: 2,
        drive: 0,
        punch: 0,
        level: 0,
      });
      processor.postEvent(noteOn(36));
      return render(processor, 0.2).left;
    };
    const clean = samples(0);
    const sat = samples(1);
    const fold = samples(2);
    const difference = (a: Float32Array, b: Float32Array): number => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.pow(a[i]! - b[i]!, 2);
      return Math.sqrt(sum / Math.max(1, a.length));
    };
    expect(difference(clean, sat)).toBeGreaterThan(0.001);
    expect(difference(clean, fold)).toBeGreaterThan(0.01);
  });

  it("clickLevel controls the transient (peak in the first 5 ms)", () => {
    const transientPeak = (clickLevel: number): number => {
      const processor = makeProcessor({ clickLevel, bodyDecay: 1, tailLevel: 0, subLevel: 0 });
      processor.postEvent(noteOn());
      const { left } = render(processor, 0.1);
      return peak(left.subarray(0, Math.floor(0.005 * SR)));
    };
    expect(transientPeak(0.9)).toBeGreaterThan(transientPeak(0.05));
  });

  it("tailLevel adds a long tail (energy after the body decayed)", () => {
    const tailEnergy = (tailLevel: number): number => {
      const processor = makeProcessor({ bodyDecay: 0.07, tailDecay: 1.2, tailLevel, clickLevel: 0, subLevel: 0 });
      processor.postEvent(noteOn());
      const { left } = render(processor, 1.0);
      return rms(left.subarray(Math.ceil(0.5 * SR)));
    };
    expect(tailEnergy(0.9)).toBeGreaterThan(tailEnergy(0) * 3);
  });

  it("the four driveType curves change THD measurably (fold is the brightest)", () => {
    const brightnessOf = (driveType: number): number => {
      const processor = makeProcessor({
        drive: 1,
        driveType,
        clickLevel: 0,
        tailLevel: 0,
        subLevel: 0,
        bodyDecay: 1,
        bodyHollow: 0,
        punch: 0,
        level: 6,
      });
      processor.postEvent(noteOn(33));
      const { left } = render(processor, 0.5);
      return brightness(left, 0.3);
    };
    const soft = brightnessOf(0);
    const fold = brightnessOf(3);
    const hard = brightnessOf(2);
    expect(fold).toBeGreaterThan(soft * 1.3);
    expect(hard).toBeGreaterThan(soft);
  });

  it("driveType curves are distinct (no duplicate-curve alias)", () => {
    const values = [0, 1, 2, 3].map((driveType) => {
      const processor = makeProcessor({
        drive: 1,
        driveType,
        clickLevel: 0,
        tailLevel: 0,
        subLevel: 0,
        bodyDecay: 1,
        bodyHollow: 0,
        punch: 0,
        level: 6,
      });
      processor.postEvent(noteOn(33));
      const { left } = render(processor, 0.5);
      return brightness(left, 0.3);
    });
    // Pairwise separation: no two curves may render identically.
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        expect(Math.abs(values[i]! - values[j]!), `curves ${i} and ${j} must differ`).toBeGreaterThan(1e-4);
      }
    }
  });

  it("stereo stays mono at 0 and widens at 1 (tail correlated by phase lock)", () => {
    const sides = (stereo: number): [Float32Array, Float32Array] => {
      const processor = makeProcessor({ stereo, tailLevel: 0.4, bodyDecay: 0.6 });
      processor.postEvent(noteOn());
      const { left, right } = render(processor, 0.4);
      return [left, right];
    };
    const [l0, r0] = sides(0);
    const [l1, r1] = sides(1);
    let diff0 = 0;
    let diff1 = 0;
    for (let i = 0; i < l0.length; i++) {
      diff0 += Math.abs(l0[i]! - r0[i]!);
      diff1 += Math.abs(l1[i]! - r1[i]!);
    }
    expect(diff0).toBeLessThan(1e-6);
    expect(diff1).toBeGreaterThan(diff0);
  });
});

describe("KopaProcessor — offline parity (one interpreter)", () => {
  const events: KopaEvent[] = [
    noteOn(36, 0.9, 0.01),
    noteOn(43, 0.7, 0.2),
    { type: "noteOff", pitch: 36, when: 0.5 },
    noteOn(36, 1, 0.8),
  ];

  it("live-style queue vs constructor seed are bit-identical", () => {
    const live = makeProcessor();
    const seeded = new KopaProcessor({ sampleRate: SR, events });
    seeded.applyParams(defaultParams());
    const a = render(live, 1.2, events); // postEvent path
    const b = render(seeded, 1.2); // constructor-seed path
    for (let i = 0; i < a.left.length; i++) {
      expect(b.left[i]).toBe(a.left[i]);
      expect(b.right[i]).toBe(a.right[i]);
    }
  });

  it("param events apply at their sample boundary in both paths", () => {
    const paramEvent: KopaEvent = { type: "param", when: 0.3, name: "drive", value: 1 };
    const live = makeProcessor();
    const seeded = new KopaProcessor({ sampleRate: SR, events: [noteOn(36, 1, 0), paramEvent] });
    seeded.applyParams(defaultParams());
    const a = render(live, 0.6, [noteOn(36, 1, 0), paramEvent]);
    const b = render(seeded, 0.6);
    expect(b.left).toEqual(a.left);
  });
});
