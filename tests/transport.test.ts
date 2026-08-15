import { describe, expect, it } from "vitest";
import { Transport, systemClock } from "../src/transport/Transport";
import { PPQ } from "../src/project-model/types";

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
});

describe("systemClock", () => {
  it("advances monotonically", () => {
    const a = systemClock.now();
    const b = systemClock.now();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
