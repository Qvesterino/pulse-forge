import { describe, expect, it } from "vitest";
import { TsarProcessor, FRAME_SIZE } from "../../src/tsar/dsp/tsarProcessor";

/**
 * T6 — ARPEGGIATOR (docs/TSAR-ROADMAP.md). The arp is a per-sample clock in
 * the DSP so it is sample-accurate AND deterministic: the same held notes and
 * seed produce the same melody. These tests assert the observable contract —
 * notes retrigger at the arp rate, the gate shortens them, and random mode is
 * seeded (two runs identical).
 */

const SR = 44100;

function sineTable() {
  const flat = new Float32Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) flat[i] = Math.sin((2 * Math.PI * i) / FRAME_SIZE) * 0.5;
  return { frames: flat, frameCount: 1 };
}

const BASE: Record<string, number> = {
  srcAEngine: 1,
  srcALevel: 0.8,
  srcAMorph: 0,
  srcAAtk: 0.001,
  srcADec: 0.2,
  srcASus: 0.8,
  srcARel: 0.02,
  srcACutoff: 18000,
  srcAQ: 0.8,
  velocity: 1,
  level: 0.8,
  arpOn: 1,
  arpMode: 0,
  arpRate: 8,
  arpOctaves: 1,
  arpGate: 0.5,
  arpSwing: 0,
};

function makeProcessor(overrides: Record<string, number> = {}) {
  const processor = new TsarProcessor({ sampleRate: SR });
  processor.applyParams({ ...BASE, ...overrides });
  const table = sineTable();
  processor.setWavetable(0, table.frames, table.frameCount);
  processor.setBpm(120);
  return processor;
}

function renderEvents(processor: TsarProcessor, seconds: number): Float32Array {
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let frame = 0;
  while (frame < frames) {
    const count = Math.min(128, frames - frame);
    processor.process(left.subarray(frame, frame + count), right.subarray(frame, frame + count), frame);
    frame += count;
  }
  return left;
}

/** Note onsets from the rendered signal: energy rising through a threshold. */
function countNotes(data: Float32Array): number {
  const window = Math.round(0.005 * SR);
  let on = false;
  let count = 0;
  for (let start = 0; start + window < data.length; start += window) {
    let energy = 0;
    for (let i = start; i < start + window; i++) energy += data[i]! * data[i]!;
    const rms = Math.sqrt(energy / window);
    if (!on && rms > 0.02) {
      on = true;
      count += 1;
    } else if (on && rms < 0.005) {
      on = false;
    }
  }
  return count;
}

describe("TsarProcessor — arpeggiator", () => {
  it("a held note retriggers at the arp rate (8 sixteenths per bar)", () => {
    const processor = makeProcessor();
    processor.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    // A bar at 120 BPM is 2 s; 8 steps/bar → 4 steps per second, first step
    // immediate → 9 retriggers across one bar (t=0 plus 8 ticks).
    const out = renderEvents(processor, 2.0);
    const notes = countNotes(out);
    expect(notes, `expected ~9 retriggers, measured ${notes}`).toBeGreaterThanOrEqual(8);
    expect(notes).toBeLessThanOrEqual(10);
  });

  it("gate 0.2 makes each note much shorter than gate 1.0", () => {
    const long = makeProcessor({ arpGate: 1 });
    long.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    const short = makeProcessor({ arpGate: 0.2 });
    short.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    const energy = (data: Float32Array): number => {
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
      return sum;
    };
    // Same note count, less total energy with a short gate.
    expect(energy(renderEvents(short, 0.8))).toBeLessThan(energy(renderEvents(long, 0.8)) * 0.85);
  });

  it("random mode is seeded: two runs produce identical samples", () => {
    const a = makeProcessor({ arpMode: 4 });
    a.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    a.postEvent({ type: "noteOn", pitch: 64, velocity: 1, when: 0 });
    a.postEvent({ type: "noteOn", pitch: 67, velocity: 1, when: 0 });
    const b = makeProcessor({ arpMode: 4 });
    b.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    b.postEvent({ type: "noteOn", pitch: 64, velocity: 1, when: 0 });
    b.postEvent({ type: "noteOn", pitch: 67, velocity: 1, when: 0 });
    const outA = renderEvents(a, 0.8);
    const outB = renderEvents(b, 0.8);
    for (let i = 0; i < outA.length; i++) {
      if (outA[i] !== outB[i]) throw new Error(`random arp diverged at sample ${i}`);
    }
  });

  it("releasing all keys stops the arp cleanly", () => {
    const processor = makeProcessor();
    processor.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    processor.postEvent({ type: "noteOff", pitch: 60, when: 0.4 });
    const out = renderEvents(processor, 1.2);
    const tail = out.subarray(Math.ceil(0.7 * SR));
    let energy = 0;
    for (let i = 0; i < tail.length; i++) energy += tail[i]! * tail[i]!;
    expect(Math.sqrt(energy / tail.length), "arp must stop when keys are released").toBeLessThan(1e-3);
  });

  it("octaves expand the walking range upward", () => {
    const single = makeProcessor({ arpOctaves: 1 });
    single.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    const triple = makeProcessor({ arpOctaves: 3 });
    triple.postEvent({ type: "noteOn", pitch: 60, velocity: 1, when: 0 });
    // With 3 octaves the step pattern walks 60 → 72 → 84; the per-window
    // energy differs from a single-octave repeat at the same rate.
    const a = renderEvents(single, 1.0);
    const b = renderEvents(triple, 1.0);
    let differs = false;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i]! - b[i]!) > 1e-6) {
        differs = true;
        break;
      }
    }
    expect(differs, "octaves must change the arp line").toBe(true);
  });
});
