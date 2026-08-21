import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import {
  setTrackPreset,
  setMidiProgramMap,
  setMidiAftertouch,
  setTrackMidiOutput,
  setMidiClockMode,
} from "../../src/commands/commands";

describe("Program Change commands", () => {
  const doc = createProjectFromTemplate("house");

  it("setTrackPreset changes preset on instrument track", () => {
    const instTrack = doc.tracks.find((t) => t.kind === "instrument")!;
    const cmd = setTrackPreset(doc, instTrack.id, "preset-abc");
    const next = cmd.execute(doc);
    const track = next.tracks.find((t) => t.id === instTrack.id && t.kind === "instrument");
    if (track?.kind === "instrument") {
      expect(track.presetId).toBe("preset-abc");
    }
  });

  it("setTrackPreset undo restores original", () => {
    const instTrack = doc.tracks.find((t) => t.kind === "instrument")!;
    const cmd = setTrackPreset(doc, instTrack.id, "preset-abc");
    const next = cmd.execute(doc);
    const undone = cmd.undo(next);
    const restored = undone.tracks.find((t) => t.id === instTrack.id);
    if (restored?.kind === "instrument") {
      expect(restored.presetId).toBeUndefined();
    }
  });

  it("setTrackPreset throws for non-existent track", () => {
    expect(() => setTrackPreset(doc, "nonexistent", "preset")).toThrow();
  });

  it("setMidiProgramMap sets program map", () => {
    const map = [{ program: 0, presetId: "piano" }, { program: 1, presetId: "organ" }];
    const cmd = setMidiProgramMap(doc, map);
    const next = cmd.execute(doc);
    expect(next.midi?.programMap).toEqual(map);
  });
});

describe("Aftertouch commands", () => {
  const doc = createProjectFromTemplate("house");

  it("setMidiAftertouch sets target and range", () => {
    const cmd = setMidiAftertouch(doc, { kind: "trackGain", trackId: "t1" }, 0.7);
    const next = cmd.execute(doc);
    expect(next.midi?.aftertouchTarget?.kind).toBe("trackGain");
    expect(next.midi?.aftertouchRange).toBe(0.7);
  });
});

describe("MIDI Output commands", () => {
  const doc = createProjectFromTemplate("house");

  it("setTrackMidiOutput enables output", () => {
    const instTrack = doc.tracks.find((t) => t.kind === "instrument")!;
    const cmd = setTrackMidiOutput(doc, instTrack.id, { enabled: true, channel: 1 });
    const next = cmd.execute(doc);
    const track = next.tracks.find((t) => t.id === instTrack.id);
    if (track?.kind === "instrument") {
      expect(track.midiOutput?.enabled).toBe(true);
      expect(track.midiOutput?.channel).toBe(1);
    }
  });
});

describe("MIDI Clock commands", () => {
  const doc = createProjectFromTemplate("house");

  it("setMidiClockMode sets master", () => {
    const cmd = setMidiClockMode(doc, "master");
    const next = cmd.execute(doc);
    expect(next.midi?.clockMode).toBe("master");
  });

  it("setMidiClockMode sets slave", () => {
    const cmd = setMidiClockMode(doc, "slave");
    const next = cmd.execute(doc);
    expect(next.midi?.clockMode).toBe("slave");
  });

  it("setMidiClockMode undo restores", () => {
    const cmd = setMidiClockMode(doc, "master");
    const next = cmd.execute(doc);
    const undone = cmd.undo(next);
    expect(undone.midi?.clockMode).toBeUndefined();
  });
});
