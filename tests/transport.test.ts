import { describe, expect, it } from "vitest";
import { Transport, systemClock } from "../src/transport/Transport";
import { PPQ } from "../src/project-model/types";
import type { ProjectDocument, TimeSignature } from "../src/project-model/types";
import {
  barAtTick,
  beatAtTick,
  beatsPerBar,
  tickAtBar,
  tickAtBarBeat,
  ticksPerBar,
  ticksPerBeat,
} from "../src/project-model/schema";

function controlledClock(start = 100) {
  let time = start;
  return {
    clock: { now: () => time },
    advance(seconds: number) {
      time += seconds;
    },
    set(seconds: number) {
      time = seconds;
    },
  };
}

describe("Transport", () => {
  it("converts ticks and audio time consistently at 120 BPM", () => {
    const { clock } = controlledClock();
    const transport = new Transport(clock, 120);
    transport.play(0);
    const tick = transport.tickAt(clock.now() + 1);
    expect(tick).toBeCloseTo(2 * PPQ, 5);
    const time = transport.timeAtTick(PPQ);
    expect(time).toBeCloseTo(clock.now() + 0.5, 5);
  });

  it("positions playhead at anchor when playback starts", () => {
    const { clock } = controlledClock();
    const transport = new Transport(clock, 124);
    transport.play(480);
    expect(transport.position).toBe(480);
  });

  it("pauses and resumes from the paused position", () => {
    const { clock, advance } = controlledClock();
    const transport = new Transport(clock, 120);
    transport.play(0);
    advance(1);
    transport.pause();
    const pausedAt = transport.position;
    expect(pausedAt).toBeCloseTo(2 * PPQ, 3);
    advance(5);
    expect(transport.position).toBeCloseTo(pausedAt, 5);
    transport.play();
    expect(transport.position).toBeCloseTo(pausedAt, 5);
  });

  it("stop resets position to zero", () => {
    const { clock, advance } = controlledClock();
    const transport = new Transport(clock, 120);
    transport.play(0);
    advance(0.5);
    transport.stop();
    expect(transport.playing).toBe(false);
    expect(transport.position).toBe(0);
  });

  it("rebases the anchor when BPM changes during playback", () => {
    const { clock, advance } = controlledClock();
    const transport = new Transport(clock, 120);
    transport.play(0);
    advance(1);
    const before = transport.position;
    transport.setBpm(240);
    expect(transport.position).toBeCloseTo(before, 5);
    advance(1);
    expect(transport.position).toBeCloseTo(before + 4 * PPQ, 3);
  });

  it("seek moves position while playing", () => {
    const { clock } = controlledClock();
    const transport = new Transport(clock, 120);
    transport.play(0);
    transport.seek(4 * PPQ);
    expect(transport.position).toBeCloseTo(4 * PPQ, 5);
  });

  it("loop state defaults to disabled with zero range", () => {
    const { clock } = controlledClock();
    const transport = new Transport(clock, 120);
    expect(transport.loopEnabled).toBe(false);
    expect(transport.loopStart).toBe(0);
    expect(transport.loopEnd).toBe(0);
  });

  it("setLoop stores start and end and flips the enabled flag", () => {
    const { clock } = controlledClock();
    const transport = new Transport(clock, 120);
    transport.setLoop(true, PPQ, 3 * PPQ);
    expect(transport.loopEnabled).toBe(true);
    expect(transport.loopStart).toBe(PPQ);
    expect(transport.loopEnd).toBe(3 * PPQ);
  });

  it("setLoop clamps start to zero and end to be >= start", () => {
    const { clock } = controlledClock();
    const transport = new Transport(clock, 120);
    // Negative start clamps to 0; degenerate range (end < start) collapses.
    transport.setLoop(true, -50, -10);
    expect(transport.loopStart).toBe(0);
    expect(transport.loopEnd).toBe(0);
    // Below-start end clamps to start so a zero-width loop is well-defined.
    transport.setLoop(true, 200, 100);
    expect(transport.loopStart).toBe(200);
    expect(transport.loopEnd).toBe(200);
  });

  it("setLoop keeps end === 0 as the 'to end of content' sentinel", () => {
    const { clock } = controlledClock();
    const transport = new Transport(clock, 120);
    transport.setLoop(true, PPQ, 0);
    expect(transport.loopStart).toBe(PPQ);
    expect(transport.loopEnd).toBe(0);
  });

  it("clearLoop resets state but does not move transport position", () => {
    const { clock, advance } = controlledClock();
    const transport = new Transport(clock, 120);
    transport.setLoop(true, PPQ, 3 * PPQ);
    transport.play(PPQ);
    advance(0.5);
    transport.clearLoop();
    expect(transport.loopEnabled).toBe(false);
    expect(transport.loopStart).toBe(0);
    expect(transport.loopEnd).toBe(0);
    // Position should still be the in-progress tick, not snapped to 0.
    expect(transport.position).toBeGreaterThan(PPQ);
  });

  it("play snaps to loopStart when the pause position is before the loop", () => {
    const { clock } = controlledClock();
    const transport = new Transport(clock, 120);
    transport.setLoop(true, 2 * PPQ, 4 * PPQ);
    transport.play(0);
    expect(transport.position).toBe(2 * PPQ);
  });

  it("play keeps the pause position when it is inside (or past) the loop", () => {
    const { clock } = controlledClock();
    const transport = new Transport(clock, 120);
    transport.setLoop(true, PPQ, 4 * PPQ);
    transport.play(3 * PPQ);
    expect(transport.position).toBe(3 * PPQ);
  });

  it("play ignores the loop when loop is disabled", () => {
    const { clock } = controlledClock();
    const transport = new Transport(clock, 120);
    // Even with a range configured, disabled loop means "play from pauseTick".
    transport.setLoop(false, 2 * PPQ, 4 * PPQ);
    transport.play(0);
    expect(transport.position).toBe(0);
  });
});

describe("systemClock", () => {
  it("advances monotonically", () => {
    const a = systemClock.now();
    const b = systemClock.now();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe("bar/beat conversions", () => {
  function docWith(signature: TimeSignature): ProjectDocument {
    return {
      schemaVersion: 1,
      id: "test",
      name: "test",
      bpm: 124,
      timeSignature: signature,
      tracks: [],
      patterns: [],
      activePatternId: "",
      scenes: [],
      arrangement: { clips: [] },
      markers: [],
      sceneAutomation: [],
      automation: [],
      lfos: [],
      macros: [],
      returns: [],
      master: { masterGain: 1, ceilingDb: -1, limiterEnabled: true, clipperEnabled: false },
      createdAt: "",
      updatedAt: "",
    };
  }

  it("ticksPerBar / beatsPerBar / ticksPerBeat are correct for common signatures", () => {
    const fourFour = docWith({ numerator: 4, denominator: 4 });
    expect(beatsPerBar(fourFour)).toBe(4);
    expect(ticksPerBar(fourFour)).toBe(4 * PPQ);
    expect(ticksPerBeat(fourFour)).toBe(PPQ);

    const threeFour = docWith({ numerator: 3, denominator: 4 });
    expect(beatsPerBar(threeFour)).toBe(3);
    expect(ticksPerBar(threeFour)).toBe(3 * PPQ);
    expect(ticksPerBeat(threeFour)).toBe(PPQ);

    const sixEight = docWith({ numerator: 6, denominator: 8 });
    expect(beatsPerBar(sixEight)).toBe(6);
    expect(ticksPerBar(sixEight)).toBe(3 * PPQ);
    // In 6/8 the beat is an eighth note, so two beats per quarter.
    expect(ticksPerBeat(sixEight)).toBe(PPQ / 2);
  });

  it("barAtTick returns 1-indexed bar numbers and clamps negative ticks to 0", () => {
    const fourFour = docWith({ numerator: 4, denominator: 4 });
    const tpb = ticksPerBar(fourFour);
    expect(barAtTick(0, fourFour)).toBe(1);
    expect(barAtTick(tpb - 1, fourFour)).toBe(1);
    expect(barAtTick(tpb, fourFour)).toBe(2);
    expect(barAtTick(2 * tpb + 100, fourFour)).toBe(3);
    expect(barAtTick(-50, fourFour)).toBe(0);
  });

  it("beatAtTick returns 1-indexed beat within the current bar", () => {
    const fourFour = docWith({ numerator: 4, denominator: 4 });
    const tpbBeat = ticksPerBeat(fourFour);
    expect(beatAtTick(0, fourFour)).toBe(1);
    expect(beatAtTick(tpbBeat - 1, fourFour)).toBe(1);
    expect(beatAtTick(tpbBeat, fourFour)).toBe(2);
    expect(beatAtTick(2 * tpbBeat, fourFour)).toBe(3);
    expect(beatAtTick(3 * tpbBeat, fourFour)).toBe(4);
    // Crossing into bar 2 resets the beat counter to 1.
    const tpb = ticksPerBar(fourFour);
    expect(beatAtTick(tpb, fourFour)).toBe(1);
    expect(beatAtTick(tpb + tpbBeat, fourFour)).toBe(2);
  });

  it("tickAtBar and tickAtBarBeat round-trip with bar/beat helpers at beat granularity", () => {
    const fourFour = docWith({ numerator: 4, denominator: 4 });
    expect(tickAtBar(1, fourFour)).toBe(0);
    expect(tickAtBar(2, fourFour)).toBe(ticksPerBar(fourFour));
    expect(tickAtBar(0, fourFour)).toBe(0);

    const tpbBeat = ticksPerBeat(fourFour);
    expect(tickAtBarBeat(1, 1, fourFour)).toBe(0);
    expect(tickAtBarBeat(1, 2, fourFour)).toBe(tpbBeat);
    expect(tickAtBarBeat(2, 1, fourFour)).toBe(ticksPerBar(fourFour));
    expect(tickAtBarBeat(2, 4, fourFour)).toBe(ticksPerBar(fourFour) + 3 * tpbBeat);
    expect(tickAtBarBeat(0, 0, fourFour)).toBe(0);
  });

  it("bar/beat helpers are consistent under time-signature changes (3/4 and 6/8)", () => {
    const threeFour = docWith({ numerator: 3, denominator: 4 });
    const tpb3 = ticksPerBar(threeFour);
    const tpbBeat3 = ticksPerBeat(threeFour);
    expect(barAtTick(0, threeFour)).toBe(1);
    expect(barAtTick(tpb3 - 1, threeFour)).toBe(1);
    expect(barAtTick(tpb3, threeFour)).toBe(2);
    expect(beatAtTick(0, threeFour)).toBe(1);
    expect(beatAtTick(tpbBeat3, threeFour)).toBe(2);
    expect(beatAtTick(2 * tpbBeat3, threeFour)).toBe(3);
    expect(beatAtTick(3 * tpbBeat3, threeFour)).toBe(1); // wraps to next bar

    const sixEight = docWith({ numerator: 6, denominator: 8 });
    const tpbBeat6 = ticksPerBeat(sixEight);
    expect(beatAtTick(0, sixEight)).toBe(1);
    expect(beatAtTick(tpbBeat6, sixEight)).toBe(2);
    expect(beatAtTick(5 * tpbBeat6, sixEight)).toBe(6);
    expect(beatAtTick(6 * tpbBeat6, sixEight)).toBe(1); // wraps to next bar
  });
});
