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

  it("handleSlavePulse advances transport while playing", () => {
    const clock = new MidiClock();
    const transport = { position: 0, seek: vi.fn(), setBpm: vi.fn(), playing: true, bpm: 120 };
    clock.handleSlavePulse(transport as any);
    expect(transport.seek).toHaveBeenCalled();
  });

  it("handleSlaveStart resets position while playing", () => {
    const clock = new MidiClock();
    const transport = { position: 100, seek: vi.fn(), setBpm: vi.fn(), playing: true, bpm: 120 };
    clock.handleSlaveStart(transport as any);
    expect(transport.seek).toHaveBeenCalledWith(0);
  });

  it("handleSlaveStop resets pulse tracking", () => {
    const clock = new MidiClock();
    const transport = { position: 0, seek: vi.fn(), setBpm: vi.fn(), playing: true, bpm: 120 };
    clock.handleSlavePulse(transport as any);
    clock.handleSlaveStop(transport as any);
    // Next pulse should restart timing
    clock.handleSlavePulse(transport as any);
    expect(transport.seek).toHaveBeenCalledTimes(2);
  });

  it("slave pulses do NOT move a stopped transport", () => {
    // Regression: external gear streams 0xF8 clocks whenever it runs. Each
    // pulse used to raw-seek the transport (+20 ticks), so the playhead crept
    // forward while idle and Play resumed from the wrong spot.
    const clock = new MidiClock();
    const transport = { position: 0, seek: vi.fn(), setBpm: vi.fn(), playing: false, bpm: 120 };
    for (let i = 0; i < 10; i++) clock.handleSlavePulse(transport as any);
    expect(transport.seek).not.toHaveBeenCalled();
    expect(transport.position).toBe(0);
  });

  it("slave Start/Continue do not hijack playback state while stopped", () => {
    const clock = new MidiClock();
    const transport = { position: 480, seek: vi.fn(), setBpm: vi.fn(), playing: false, bpm: 120 };
    clock.handleSlaveStart(transport as any);
    expect(transport.seek).not.toHaveBeenCalled();
  });

  it("a timing gap does not poison the derived BPM (outlier rejection)", () => {
    // Regression: one huge interval (device paused mid-song) produced bpm≈0
    // which was applied via setBpm, slowing the transport hundreds-fold.
    vi.useFakeTimers();
    try {
      const clock = new MidiClock();
      const transport = { position: 0, seek: vi.fn(), setBpm: vi.fn(), playing: true, bpm: 120 };
      const t0 = performance.now();
      let now = t0;
      const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
      // Steady 120 BPM pulses: 20.833 ms apart — 96 of them to fill the batch.
      for (let i = 0; i < 95; i++) {
        now += 20.8333;
        clock.handleSlavePulse(transport as any);
      }
      expect(transport.setBpm).not.toHaveBeenCalled();
      // Cable-pull style gap: minutes pass, then a single pulse arrives.
      now += 5 * 60 * 1000;
      clock.handleSlavePulse(transport as any);
      // The batch completes on steady pulses afterwards.
      for (let i = 0; i < 100; i++) {
        now += 20.8333;
        clock.handleSlavePulse(transport as any);
      }
      const applied = (transport.setBpm as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as number | undefined;
      expect(applied).toBeGreaterThan(60);
      expect(applied).toBeLessThan(300);
      perfSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
