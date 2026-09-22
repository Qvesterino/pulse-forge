import { afterEach, describe, expect, it, vi } from "vitest";
import { MidiClock } from "../../src/midi/MidiClock";
import { Transport } from "../../src/transport/Transport";

/**
 * GOAL 08 — MidiClock MASTER mode was untested (the suite only covered
 * slave pulse handling). Pins: 24 pulses per quarter, start/stop ordering,
 * tempo recalculation, and stop silencing the stream.
 */

function fakeOutput() {
  return {
    sendStart: vi.fn(),
    sendStop: vi.fn(),
    sendClock: vi.fn(),
    sendContinue: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MidiClock master mode (GOAL 08)", () => {
  it("sends start once, then 24 clocks per quarter at the transport tempo", () => {
    vi.useFakeTimers();
    const output = fakeOutput();
    const transport = new Transport({ now: () => 0 }, 120); // 2 beats/sec → 48 pulses/sec
    const clock = new MidiClock();
    clock.startMaster(transport, output as never);

    expect(output.sendStart).toHaveBeenCalledTimes(1);
    expect(output.sendStop).not.toHaveBeenCalled();

    // One beat worth of time → 24 pulses (±1 for interval boundary alignment).
    vi.advanceTimersByTime(500);
    const beats = output.sendClock.mock.calls.length / 24;
    expect(beats).toBeGreaterThanOrEqual(0.9);
    expect(beats).toBeLessThanOrEqual(1.1);

    clock.stopMaster();
    const callsAtStop = output.sendClock.mock.calls.length;
    expect(output.sendStop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(output.sendClock.mock.calls.length).toBe(callsAtStop); // silenced
  });

  it("recalculates the pulse interval when the tempo changes mid-stream", () => {
    vi.useFakeTimers();
    const output = fakeOutput();
    const transport = new Transport({ now: () => 0 }, 60); // 1 beat/sec → 24 pulses/sec
    const clock = new MidiClock();
    clock.startMaster(transport, output as never);

    vi.advanceTimersByTime(1000);
    const at60 = output.sendClock.mock.calls.length;
    expect(at60).toBeGreaterThanOrEqual(23);
    expect(at60).toBeLessThanOrEqual(25);

    // Double the tempo → double the pulses in the next second (±boundary).
    output.sendClock.mockClear();
    clock.setTempo(120);
    vi.advanceTimersByTime(1000);
    const at120 = output.sendClock.mock.calls.length;
    expect(at120).toBeGreaterThanOrEqual(46);
    expect(at120).toBeLessThanOrEqual(50);
    clock.stopMaster();
  });
});
