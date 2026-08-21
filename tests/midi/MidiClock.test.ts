import { describe, expect, it, vi } from "vitest";
import { MidiClock } from "../../src/midi/MidiClock";

describe("MidiClock", () => {
  it("can be instantiated", () => {
    const clock = new MidiClock();
    expect(clock).toBeDefined();
  });

  it("stopMaster is safe when not running", () => {
    const clock = new MidiClock();
    clock.stopMaster(); // should not throw
  });

  it("dispose is safe", () => {
    const clock = new MidiClock();
    clock.dispose(); // should not throw
  });

  it("handleSlavePulse advances transport", () => {
    const clock = new MidiClock();
    const transport = { position: 0, seek: vi.fn(), setBpm: vi.fn(), bpm: 120 };
    clock.handleSlavePulse(transport as any);
    expect(transport.seek).toHaveBeenCalled();
  });

  it("handleSlaveStart resets position", () => {
    const clock = new MidiClock();
    const transport = { position: 100, seek: vi.fn(), setBpm: vi.fn(), bpm: 120 };
    clock.handleSlaveStart(transport as any);
    expect(transport.seek).toHaveBeenCalledWith(0);
  });

  it("handleSlaveStop resets pulse tracking", () => {
    const clock = new MidiClock();
    const transport = { position: 0, seek: vi.fn(), setBpm: vi.fn(), bpm: 120 };
    clock.handleSlavePulse(transport as any);
    clock.handleSlaveStop(transport as any);
    // Next pulse should restart timing
    clock.handleSlavePulse(transport as any);
    expect(transport.seek).toHaveBeenCalled();
  });
});
