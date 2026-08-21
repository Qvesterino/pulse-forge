import { describe, expect, it } from "vitest";
import { MidiInput } from "../../src/midi/MidiInput";
import { GM_DRUM_MAP } from "../../src/project-model/types";

describe("MidiInput", () => {
  it("can be instantiated", () => {
    const midi = new MidiInput();
    expect(midi).toBeDefined();
  });

  it("returns empty device list without access", () => {
    const midi = new MidiInput();
    expect(midi.getDevices()).toEqual([]);
  });

  it("requestAccess returns false when navigator unavailable", async () => {
    const midi = new MidiInput();
    const result = await midi.requestAccess();
    // jsdom has no navigator.requestMIDIAccess
    expect(result).toBe(false);
  });

  it("stop is safe to call even if never started", () => {
    const midi = new MidiInput();
    midi.stop(); // should not throw
  });
});

describe("GM_DRUM_MAP", () => {
  it("contains standard GM percussion notes", () => {
    expect(GM_DRUM_MAP.length).toBeGreaterThan(10);
    const kick = GM_DRUM_MAP.find((m) => m.note === 36);
    expect(kick).toBeDefined();
    expect(kick!.name).toBe("Bass Drum 1");
    const snare = GM_DRUM_MAP.find((m) => m.note === 38);
    expect(snare).toBeDefined();
    const closedHat = GM_DRUM_MAP.find((m) => m.note === 42);
    expect(closedHat).toBeDefined();
  });
});
