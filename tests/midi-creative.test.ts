import { describe, expect, it } from "vitest";
import type { NoteEvent } from "../src/project-model/types";
import {
  createChordNotes,
  doubleNotes,
  arpeggiateNotes,
  basslineNotes,
  euclideanNotes,
  euclideanPattern,
  gateNotes,
  halveNotes,
  humanizeNotes,
  invertNotes,
  repeatNotes,
  randomizeVelocity,
  reverseNotes,
  snapNotesToScale,
  strumNotes,
} from "../src/midi/creative";

const note = (id: string, pitch: number, start: number, duration = 120, velocity = 0.8): NoteEvent => ({
  id,
  pitch,
  start,
  duration,
  velocity,
});

describe("MIDI creativity", () => {
  it("creates explicit and diatonic chords with voicing", () => {
    const explicit = createChordNotes(
      note("root", 60, 0),
      {
        mode: "explicit",
        quality: "major",
        voicing: "close",
        inversion: 0,
        seventh: false,
        gate: 1,
        strumTicks: 0,
        strumDirection: "up",
        scaleLock: false,
      },
      1920,
      (index) => `generated-${index}`,
    );
    expect(explicit.map((value) => value.pitch)).toEqual([60, 64, 67]);

    const diatonic = createChordNotes(
      note("root", 62, 0),
      {
        mode: "diatonic",
        quality: "major",
        voicing: "open",
        inversion: 0,
        seventh: false,
        gate: 0.5,
        strumTicks: 0,
        strumDirection: "up",
        scaleLock: true,
        key: "C Major",
      },
      1920,
      (index) => `generated-${index}`,
    );
    expect(diatonic.map((value) => value.pitch)).toEqual([62, 69, 77]);
    expect(diatonic.every((value) => value.duration === 60)).toBe(true);
  });

  it("supports inversions, gate and strum without leaving the pattern", () => {
    const result = createChordNotes(
      note("root", 60, 1740, 240),
      {
        mode: "explicit",
        quality: "major7",
        voicing: "close",
        inversion: 1,
        seventh: false,
        gate: 0.5,
        strumTicks: 240,
        strumDirection: "up",
        scaleLock: false,
      },
      1920,
      (index) => `generated-${index}`,
    );
    expect(result.map((value) => value.pitch)).toEqual([64, 67, 71, 72]);
    expect(result.map((value) => value.start)).toEqual([1740, 1820, 1900, 1919]);
    expect(result.every((value) => value.start + value.duration <= 1920)).toBe(true);
  });

  it("reverses, inverts, halves and doubles selected timing", () => {
    const source = [note("a", 60, 0), note("b", 64, 240)];
    expect(reverseNotes(source, 1920).map((value) => value.start)).toEqual([240, 0]);
    expect(invertNotes(source, 1920).map((value) => value.pitch)).toEqual([64, 60]);
    expect(halveNotes(source, 1920).map((value) => [value.start, value.duration])).toEqual([[0, 60], [120, 60]]);
    expect(doubleNotes(source, 480).map((value) => [value.start, value.duration])).toEqual([[0, 240], [479, 1]]);
  });

  it("applies scale lock, gate and strum deterministically", () => {
    const source = [note("a", 66, 0), note("b", 60, 0), note("c", 64, 0)];
    expect(snapNotesToScale(source, "C Major", 1920).map((value) => value.pitch)).toEqual([65, 60, 64]);
    expect(gateNotes(source, 0.5, 1920).every((value) => value.duration === 60)).toBe(true);
    expect(strumNotes(source, { spreadTicks: 120, direction: "up" }, 1920).map((value) => value.start)).toEqual([120, 0, 60]);
  });

  it("uses a stable seed for humanize and velocity randomization", () => {
    const source = [note("a", 60, 0), note("b", 64, 240)];
    const first = humanizeNotes(source, { timingTicks: 80, velocityAmount: 0.2, seed: "same" }, 480);
    const second = humanizeNotes(source, { timingTicks: 80, velocityAmount: 0.2, seed: "same" }, 480);
    expect(second).toEqual(first);
    expect(first.every((value) => value.start >= 0 && value.start + value.duration <= 480)).toBe(true);
    expect(randomizeVelocity(source, { amount: 2, seed: "same" }, 480).every((value) => value.velocity >= 0.05 && value.velocity <= 1)).toBe(true);
  });

  it("materializes seeded arpeggios across chord groups", () => {
    const source = [note("c", 60, 0, 960), note("e", 64, 0, 960), note("g", 67, 0, 960)];
    const first = arpeggiateNotes(source, { mode: "random", rateTicks: 120, octaveRange: 1, gate: 0.5, seed: "arp" }, 1920, (index) => `arp-${index}`);
    const second = arpeggiateNotes(source, { mode: "random", rateTicks: 120, octaveRange: 1, gate: 0.5, seed: "arp" }, 1920, (index) => `arp-${index}`);
    expect(second).toEqual(first);
    expect(first).toHaveLength(8);
    expect(first.every((value) => value.duration === 60 && value.start + value.duration <= 1920)).toBe(true);
    expect(arpeggiateNotes(source, { mode: "down", rateTicks: 120, octaveRange: 0, gate: 1, seed: "x" }, 1920, (index) => `arp-${index}`).map((value) => value.pitch)).toEqual([67, 64, 60, 67, 64, 60, 67, 64]);
  });

  it("creates note repeats with velocity falloff and clamps overflow", () => {
    const result = repeatNotes([note("a", 60, 420, 240, 0.8)], { rateTicks: 60, count: 8, velocityFalloff: 0.2 }, 480, (index) => `repeat-${index}`);
    expect(result.map((value) => value.start)).toEqual([420]);
    expect(result[0].duration).toBe(60);
    expect(result[0].velocity).toBeCloseTo(0.8);
  });

  it("generates rotated Euclidean rhythms", () => {
    expect(euclideanPattern(3, 8, 0)).toEqual([false, false, true, false, false, true, false, true]);
    const result = euclideanNotes([note("root", 48, 0, 1920)], { pulses: 3, steps: 8, rotation: 1, pitch: 36, velocity: 0.75, gate: 0.5 }, 1920, (index) => `euclid-${index}`);
    expect(result.map((value) => value.start)).toEqual([0, 720, 1440]);
    expect(result.every((value) => value.pitch === 36 && value.duration === 120 && value.velocity === 0.75)).toBe(true);
  });

  it("infers chord roots for a clamped bassline", () => {
    const source = [note("e", 64, 0, 480), note("g", 67, 0, 480), note("c", 60, 0, 480), note("f", 65, 960, 480)];
    const result = basslineNotes(source, { octave: 1, gate: 0.5, scaleLock: false }, 1440, (index) => `bass-${index}`);
    expect(result.map((value) => [value.pitch, value.start, value.duration])).toEqual([[24, 0, 240], [29, 960, 240]]);
    expect(result.every((value) => value.start + value.duration <= 1440)).toBe(true);
  });
});
