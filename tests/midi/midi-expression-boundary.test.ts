import { describe, expect, it, vi } from "vitest";
import { MidiInput } from "../../src/midi/MidiInput";
import { parseMidiFile } from "../../src/midi/midiFile";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { MidiConfig, ProjectDocument } from "../../src/project-model/types";

describe("partial MPE MIDI input boundary", () => {
  function makeHarness() {
    const doc = createProjectFromTemplate("house");
    const firstInstrument = doc.tracks.find((track) => track.kind === "instrument");
    if (!firstInstrument || firstInstrument.kind !== "instrument") {
      throw new Error("house template must contain an instrument track");
    }

    const config: MidiConfig = {
      enabled: true,
      deviceId: "test-device",
      drumChannel: 10,
      instrumentChannel: 0,
      ccMappings: [],
      drumNoteMap: [],
      pitchBendRange: 2,
      clockMode: "off",
    };
    const engine = {
      currentTime: 0,
      noteOn: vi.fn(),
      polyPressure: vi.fn(),
      polyTimbre: vi.fn(),
      setMidiPitchBend: vi.fn(),
    };
    const midi = new MidiInput();
    const internals = midi as unknown as {
      configCb: () => MidiConfig;
      getDoc: () => ProjectDocument;
      engine: unknown;
      store: unknown;
      transport: unknown;
      onMidiMessage: (event: { data: Uint8Array }) => void;
    };
    Object.assign(internals, {
      configCb: () => config,
      getDoc: () => doc,
      engine,
      store: { execute: vi.fn() },
      transport: {},
    });

    const send = (bytes: number[]) => internals.onMidiMessage({ data: new Uint8Array(bytes) });
    return { doc, engine, firstInstrument, midi, send };
  }

  it("routes pressure, CC74 and channel pitch bend to the first instrument and does not track member channels", () => {
    const { engine, firstInstrument, midi, send } = makeHarness();

    // Same pitch on two channels collapses to one pitch-keyed activity row.
    send([0x91, 60, 100]);
    send([0x92, 60, 90]);
    expect(engine.noteOn).toHaveBeenNthCalledWith(1, firstInstrument.id, 60, 100 / 127, 0.005, 0.5);
    expect(engine.noteOn).toHaveBeenNthCalledWith(2, firstInstrument.id, 60, 90 / 127, 0.005, 0.5);
    expect(midi.getMpeNotes()).toEqual([{ pitch: 60, pressure: 0, timbre: 0.5 }]);

    send([0xa2, 60, 64]); // Poly pressure, channel 3.
    expect(engine.polyPressure).toHaveBeenCalledWith(firstInstrument.id, 60, 64 / 127);

    send([0xb2, 74, 127]); // CC74 uses the most recent pitch on channel 3.
    expect(engine.polyTimbre).toHaveBeenCalledWith(firstInstrument.id, 60, 1);

    send([0xe2, 0, 127]); // Pitch bend remains track-wide; channel 3 is ignored.
    expect(engine.setMidiPitchBend).toHaveBeenCalledWith(firstInstrument.id, ((16256 - 8192) / 8192) * 2);
    expect(midi.hasMpeActivity()).toBe(true);
  });

  it("counts MIDI-file expression classes that the note-only importer skips", () => {
    const payload = [
      0x00,
      0xb0,
      74,
      127, // CC74 timbre
      0x00,
      0xe0,
      0,
      127, // Pitch bend
      0x00,
      0xa0,
      60,
      64, // Poly pressure
      0x00,
      0xd0,
      64, // Channel pressure
      0x00,
      0xc0,
      5, // Program change
      0x00,
      0xf0,
      0x02,
      0x7d,
      0x01, // SysEx payload
      0x00,
      0xff,
      0x2f,
      0x00, // End of track
    ];
    const header = [
      0x4d,
      0x54,
      0x68,
      0x64,
      0,
      0,
      0,
      6,
      0,
      1,
      0,
      1,
      1,
      0xe0, // format 1, one track, 480 PPQ
    ];
    const track = [
      0x4d,
      0x54,
      0x72,
      0x6b,
      (payload.length >>> 24) & 0xff,
      (payload.length >>> 16) & 0xff,
      (payload.length >>> 8) & 0xff,
      payload.length & 0xff,
      ...payload,
    ];

    const parsed = parseMidiFile(new Uint8Array([...header, ...track]));
    expect(parsed.unsupportedEvents).toEqual({
      controlChanges: 1,
      pitchBends: 1,
      programChanges: 1,
      aftertouch: 2,
      systemExclusive: 1,
    });
    expect(parsed.tracks).toEqual([]);
  });
});
