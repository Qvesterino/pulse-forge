import { describe, expect, it, vi } from "vitest";
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

describe("MidiInput — system realtime messages and arity", () => {
  type ClockMode = "off" | "master" | "slave";

  function slaveConfig(clockMode: ClockMode) {
    return {
      enabled: true,
      deviceId: "test",
      drumChannel: 10,
      instrumentChannel: 1,
      ccMappings: [],
      drumNoteMap: [],
      pitchBendRange: 2,
      clockMode,
    };
  }

  function makeMidi(clockMode: ClockMode = "slave"): MidiInput {
    const midi = new MidiInput();
    (midi as unknown as { configCb: () => unknown }).configCb = () => slaveConfig(clockMode);
    return midi;
  }

  function send(midi: MidiInput, bytes: number[]): void {
    (midi as unknown as { onMidiMessage: (e: { data: Uint8Array }) => void }).onMidiMessage({
      data: new Uint8Array(bytes),
    });
  }

  it("dispatches single-byte MIDI clock/start/continue/stop messages", () => {
    const midi = makeMidi();
    const calls: string[] = [];
    midi.onClock({
      pulse: () => calls.push("pulse"),
      start: () => calls.push("start"),
      continue: () => calls.push("continue"),
      stop: () => calls.push("stop"),
    });
    // Regression: these were doubly dead — dropped by `data.length < 3` and
    // unmatchable after `data[0] & 0xf0` masked 0xf8..0xfc down to 0xf0.
    send(midi, [0xf8]);
    send(midi, [0xfa]);
    send(midi, [0xfb]);
    send(midi, [0xfc]);
    expect(calls).toEqual(["pulse", "start", "continue", "stop"]);
  });

  it("ignores clock messages when clockMode is not slave", () => {
    const midi = makeMidi("master");
    const pulse = vi.fn();
    midi.onClock({ pulse });
    send(midi, [0xf8]);
    expect(pulse).not.toHaveBeenCalled();
  });

  it("ignores realtime messages when the config is disabled", () => {
    const midi = new MidiInput();
    (midi as unknown as { configCb: () => unknown }).configCb = () => ({
      ...slaveConfig("slave"),
      enabled: false,
    });
    const pulse = vi.fn();
    midi.onClock({ pulse });
    send(midi, [0xf8]);
    expect(pulse).not.toHaveBeenCalled();
  });

  it("accepts 2-byte Program Change and Channel Pressure messages", () => {
    const midi = makeMidi("off");
    const pc = vi.spyOn(midi as never as { handleProgramChange: () => void }, "handleProgramChange").mockImplementation(() => {});
    const cp = vi.spyOn(midi as never as { handleChannelPressure: () => void }, "handleChannelPressure").mockImplementation(() => {});
    // Regression: used to be dropped by the `data.length < 3` guard.
    send(midi, [0xc0, 5]);
    send(midi, [0xd0, 64]);
    expect(pc).toHaveBeenCalledWith(5, 1, expect.anything());
    expect(cp).toHaveBeenCalledWith(64, 1, expect.anything());
  });

  it("still drops truncated channel-voice messages", () => {
    const midi = makeMidi("off");
    const noteOn = vi.spyOn(midi as never as { handleNoteOn: () => void }, "handleNoteOn").mockImplementation(() => {});
    send(midi, [0x90, 60]); // note on without a velocity byte
    expect(noteOn).not.toHaveBeenCalled();
    send(midi, [0x90, 60, 100]);
    expect(noteOn).toHaveBeenCalledWith(60, 100, 1, expect.anything());
  });
});

describe("MidiInput — device subscriptions", () => {
  function makeStartedMidi() {
    const midi = new MidiInput();
    const inputs = new Map<string, unknown>();
    (midi as unknown as { access: unknown }).access = { inputs, onstatechange: null as null | (() => void) };
    midi.start({} as never, {} as never, {} as never, () => ({} as never), () => ({} as never));
    return { midi, inputs };
  }

  it("notifies device subscribers when device state changes", () => {
    const { midi, inputs } = makeStartedMidi();
    const seen: { id: string }[][] = [];
    const unsubscribe = midi.subscribeDevices((devices) => seen.push(devices));

    const handler = (midi as unknown as { access: { onstatechange: (() => void) | null } }).access.onstatechange;
    expect(typeof handler).toBe("function");
    inputs.set("in-1", { id: "in-1", name: "Test Knob", manufacturer: "Test", addEventListener: vi.fn(), removeEventListener: vi.fn() });
    handler!();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1].some((d) => d.id === "in-1")).toBe(true);
    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    const { midi, inputs } = makeStartedMidi();
    const seen: unknown[][] = [];
    const unsubscribe = midi.subscribeDevices((devices) => seen.push(devices));
    const handler = (midi as unknown as { access: { onstatechange: (() => void) | null } }).access.onstatechange;
    inputs.set("in-2", { id: "in-2", name: "X", manufacturer: "", addEventListener: vi.fn(), removeEventListener: vi.fn() });
    handler!();
    const count = seen.length;
    unsubscribe();
    handler!();
    expect(seen.length).toBe(count);
  });
});
