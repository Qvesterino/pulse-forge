import { describe, expect, it, vi } from "vitest";
import { MidiInput } from "../../src/midi/MidiInput";
import { NoteRepeatController } from "../../src/audio-engine/NoteRepeat";
import { Transport } from "../../src/transport/Transport";
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
    const pc = vi
      .spyOn(midi as never as { handleProgramChange: () => void }, "handleProgramChange")
      .mockImplementation(() => {});
    const cp = vi
      .spyOn(midi as never as { handleChannelPressure: () => void }, "handleChannelPressure")
      .mockImplementation(() => {});
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

  it("supports running status: chord tails after a single status byte are parsed", () => {
    // Regression: keyboards commonly send [0x90, n1, v1] then bare [n2, v2]
    // pairs. Those tails were silently discarded (data byte masked to a
    // status nibble matching nothing), so only the first chord note played.
    const midi = makeMidi("off");
    const noteOn = vi.spyOn(midi as never as { handleNoteOn: () => void }, "handleNoteOn").mockImplementation(() => {});
    send(midi, [0x90, 60, 100]); // status established
    send(midi, [62, 90]); // running-status tail
    send(midi, [64, 80]); // and another
    expect(noteOn).toHaveBeenCalledTimes(3);
    expect(noteOn).toHaveBeenNthCalledWith(2, 62, 90, 1, expect.anything());
    expect(noteOn).toHaveBeenNthCalledWith(3, 64, 80, 1, expect.anything());
    // System Common (here: Song Select 0xF2) clears running status — a stray
    // data-byte message afterwards must be dropped, not misparsed.
    send(midi, [0xf2, 0, 0]);
    send(midi, [65, 70]);
    expect(noteOn).toHaveBeenCalledTimes(3);
    // A fresh status byte re-establishes running status...
    send(midi, [0x90, 72, 100]);
    expect(noteOn).toHaveBeenCalledTimes(4);
    // ...and interleaved realtime bytes do not disturb it (per MIDI spec,
    // realtime can appear between the bytes of a message).
    send(midi, [0xf8]);
    send(midi, [74, 90]);
    expect(noteOn).toHaveBeenCalledTimes(5);
  });
});

describe("MidiInput — device subscriptions", () => {
  function makeStartedMidi() {
    const midi = new MidiInput();
    const inputs = new Map<string, unknown>();
    (midi as unknown as { access: unknown }).access = { inputs, onstatechange: null as null | (() => void) };
    midi.start(
      {} as never,
      {} as never,
      {} as never,
      () => ({}) as never,
      () => ({}) as never,
    );
    return { midi, inputs };
  }

  it("notifies device subscribers when device state changes", () => {
    const { midi, inputs } = makeStartedMidi();
    const seen: { id: string }[][] = [];
    const unsubscribe = midi.subscribeDevices((devices) => seen.push(devices));

    const handler = (midi as unknown as { access: { onstatechange: (() => void) | null } }).access.onstatechange;
    expect(typeof handler).toBe("function");
    inputs.set("in-1", {
      id: "in-1",
      name: "Test Knob",
      manufacturer: "Test",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
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
    inputs.set("in-2", {
      id: "in-2",
      name: "X",
      manufacturer: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    handler!();
    const count = seen.length;
    unsubscribe();
    handler!();
    expect(seen.length).toBe(count);
  });
});

describe("MidiInput — device disconnect recovery", () => {
  function makeMidiWithRepeat() {
    const midi = new MidiInput();
    const controller = new NoteRepeatController({
      getTransport: () => new Transport({ now: () => 0 }, 120),
      getAudioTime: () => 0,
      fire: () => {},
    });
    midi.attachNoteRepeat(controller);
    const inputs = new Map<string, unknown>();
    (midi as unknown as { access: unknown }).access = {
      inputs,
      onstatechange: null as null | ((event?: unknown) => void),
    };
    midi.start(
      {} as never,
      {} as never,
      {} as never,
      () => ({}) as never,
      () => ({}) as never,
    );
    const handler = (midi as unknown as { access: { onstatechange: ((event?: unknown) => void) | null } }).access
      .onstatechange!;
    return { midi, controller, inputs, handler };
  }

  it("releases midi-originated note repeat holds when a device disconnects", () => {
    // Recovery audit: a controller unplugged mid-hold never delivers its
    // note-off — the roll must not outlive the device.
    const { controller, handler } = makeMidiWithRepeat();
    controller.setRate("1/16");
    controller.start("midi:0:36", "t1", "kick", 1);
    controller.start("pad:t1:padX", "t1", "padX", 1);
    handler({ port: { state: "disconnected" } });
    expect(controller.isHolding("midi:0:36")).toBe(false);
    expect(controller.isHolding("pad:t1:padX")).toBe(true);
    controller.stopAll();
  });

  it("keeps holds when the state change is a connect or unrelated", () => {
    const { controller, handler } = makeMidiWithRepeat();
    controller.setRate("1/16");
    controller.start("midi:0:36", "t1", "kick", 1);
    handler({ port: { state: "connected" } });
    handler(); // legacy no-arg notification shape
    expect(controller.isHolding("midi:0:36")).toBe(true);
    controller.stopAll();
  });
});
