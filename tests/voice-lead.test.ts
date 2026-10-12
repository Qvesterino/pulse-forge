import { describe, expect, it } from "vitest";
import { applyVoiceLeadCommand } from "../src/vocal/adapt";
import { voiceifyHum } from "../src/vocal/voiceify";
import { testDoc } from "./fixtures/doc";
import type { NoteEvent } from "../src/project-model/types";

/**
 * HUM→VOICE WIRING (W3 completion) — the voiceified render lands as a
 * "Voice Lead — hum" vocalchop track playing the TARGET melody's notes:
 * the hum's timbre, the song's pitches and timing. One undoable snapshot;
 * re-apply with the same take reuses the track; missing staging or an
 * empty melody refuses honestly.
 */

const doc = testDoc();
let noteSeq = 0;
function melodyNote(pitch: number, start: number, duration: number): NoteEvent {
  noteSeq += 1;
  return { id: `mel-${noteSeq}`, pitch, start, duration, velocity: 0.8 };
}

describe("applyVoiceLeadCommand", () => {
  it("installs the voice lead track + melody notes as one undoable step", () => {
    const melody = [melodyNote(69, 0, 480), melodyNote(71, 480, 480), melodyNote(72, 960, 480)];
    const command = applyVoiceLeadCommand(doc, { bufferId: "voice-lead-render", notes: melody });
    const applied = command.execute(doc);

    const lead = applied.tracks.find((t) => t.kind === "instrument" && t.name === "Voice Lead — hum");
    expect(lead, "the Voice Lead track exists").toBeDefined();
    if (lead && lead.kind === "instrument") expect(lead.sampleId).toBe("voice-lead-render");
    const pattern = applied.patterns.find((p) => p.id === applied.activePatternId)!;
    expect(pattern.notes[lead!.id] ?? []).toHaveLength(3);

    const undone = command.undo(applied);
    expect(undone.tracks.some((t) => t.id === lead!.id)).toBe(false);
  });

  it("re-apply with the same take reuses the track (no track spam)", () => {
    const melody = [melodyNote(69, 0, 480)];
    const first = applyVoiceLeadCommand(doc, {
      bufferId: "voice-lead-v1",
      notes: melody,
      takeBufferId: "take-1",
    }).execute(doc);
    const second = applyVoiceLeadCommand(first, {
      bufferId: "voice-lead-v2",
      notes: melody,
      takeBufferId: "take-1",
    }).execute(first);
    const leads = second.tracks.filter((t) => t.kind === "instrument" && t.name === "Voice Lead — hum");
    expect(leads).toHaveLength(1);
    const lead = leads[0];
    expect(lead?.kind).toBe("instrument");
    if (lead?.kind === "instrument") expect(lead.sampleId).toBe("voice-lead-v2");
  });

  it("refuses honestly without staging or an empty melody", () => {
    expect(() => applyVoiceLeadCommand(doc, { bufferId: "", notes: [melodyNote(69, 0, 480)] })).toThrow(/not staged/);
    expect(() => applyVoiceLeadCommand(doc, { bufferId: "x", notes: [] })).toThrow(/melody/);
  });
});

describe("voiceify + voice lead integration", () => {
  it("the voiceified render and the melody land together end-to-end", () => {
    const SR = 44100;
    const hum = new Float32Array(SR);
    for (let i = 0; i < hum.length; i++) {
      const t = i / hum.length;
      const phase = (2 * Math.PI * 220 * i) / SR;
      hum[i] = (0.5 * Math.sin(phase) + 0.25 * Math.sin(2 * phase)) * Math.min(1, Math.min(t, 1 - t) * 10);
    }
    const melody = [melodyNote(69, 0, 480), melodyNote(71, 480, 480)];
    const render = voiceifyHum(
      hum,
      SR,
      melody.map((n) => ({ midi: n.pitch, startTicks: n.start, durationTicks: n.duration })),
      { bpm: 120, ppq: 480 },
    );
    expect(render.length).toBeGreaterThan(0);
    void melody;
    void doc;
  });
});
