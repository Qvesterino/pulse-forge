import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import {
  addMidiCcMapping,
  removeMidiCcMapping,
  setDrumNoteMapping,
  setMidiConfig,
  resetDrumNoteMapping,
} from "../../src/commands/commands";

describe("MIDI commands", () => {
  const doc = createProjectFromTemplate("house");

  it("setMidiConfig enables MIDI", () => {
    const cmd = setMidiConfig(doc, { enabled: true });
    const next = cmd.execute(doc);
    expect(next.midi?.enabled).toBe(true);
  });

  it("setMidiConfig sets device", () => {
    const cmd = setMidiConfig(doc, { deviceId: "abc-123" });
    const next = cmd.execute(doc);
    expect(next.midi?.deviceId).toBe("abc-123");
  });

  it("setMidiConfig sets channels", () => {
    const cmd = setMidiConfig(doc, { drumChannel: 10, instrumentChannel: 1 });
    const next = cmd.execute(doc);
    expect(next.midi?.drumChannel).toBe(10);
    expect(next.midi?.instrumentChannel).toBe(1);
  });

  it("addMidiCcMapping adds mapping", () => {
    const cmd = addMidiCcMapping(doc, 1, { kind: "trackGain", trackId: "t1" }, 0, 1);
    const next = cmd.execute(doc);
    expect(next.midi?.ccMappings.length).toBe(1);
    expect(next.midi?.ccMappings[0].ccNumber).toBe(1);
  });

  it("removeMidiCcMapping removes mapping", () => {
    const withMapping = addMidiCcMapping(doc, 1, { kind: "trackGain", trackId: "t1" }, 0, 1).execute(doc);
    const mappingId = withMapping.midi!.ccMappings[0].id;
    const cmd = removeMidiCcMapping(withMapping, mappingId);
    const next = cmd.execute(withMapping);
    expect(next.midi?.ccMappings.length).toBe(0);
  });

  it("setDrumNoteMapping adds mapping", () => {
    const cmd = setDrumNoteMapping(doc, 36, "pad-kick");
    const next = cmd.execute(doc);
    expect(next.midi?.drumNoteMap.length).toBe(1);
    expect(next.midi?.drumNoteMap[0].midiNote).toBe(36);
    expect(next.midi?.drumNoteMap[0].padId).toBe("pad-kick");
  });

  it("resetDrumNoteMapping clears all", () => {
    const withMap = setDrumNoteMapping(doc, 36, "pad-kick").execute(doc);
    const cmd = resetDrumNoteMapping(withMap);
    const next = cmd.execute(withMap);
    expect(next.midi?.drumNoteMap.length).toBe(0);
  });

  it("undo setMidiConfig restores original", () => {
    const cmd = setMidiConfig(doc, { enabled: true });
    const next = cmd.execute(doc);
    const undone = cmd.undo(next);
    expect(undone.midi?.enabled).toBe(false);
  });

  it("setMidiConfig sets channel value", () => {
    const cmd = setMidiConfig(doc, { drumChannel: 20 });
    const next = cmd.execute(doc);
    // Clamping happens in normalizeProject, not in the command itself
    expect(next.midi?.drumChannel).toBe(20);
  });

  it("setMidiConfig sets pitchBendRange value", () => {
    const cmd = setMidiConfig(doc, { pitchBendRange: 50 });
    const next = cmd.execute(doc);
    // Clamping happens in normalizeProject, not in the command itself
    expect(next.midi?.pitchBendRange).toBe(50);
  });
});
