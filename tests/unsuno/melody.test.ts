import { describe, expect, it } from "vitest";
import { detectMelodyNotes } from "../../src/reference/analysis/melody";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { unsunoCommand } from "../../src/reference/unsuno";
import { transcribeTrack } from "../../src/reference/transcribe";
import { goldenTracks, drumsOnlyTrack, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "./golden-synth";

const SR = GOLDEN_SAMPLE_RATE;

/** A clean lead: sine + octave, sustained notes. */
function leadPcm(notes: { startSec: number; durationSec: number; midi: number }[], seconds: number): Float32Array {
  const pcm = new Float32Array(Math.ceil(SR * seconds));
  for (const note of notes) {
    const start = Math.round(note.startSec * SR);
    const length = Math.round(note.durationSec * SR);
    const f0 = 440 * Math.pow(2, (note.midi - 69) / 12);
    for (let i = 0; i < length && start + i < pcm.length; i++) {
      pcm[start + i] += 0.3 * Math.sin((2 * Math.PI * f0 * i) / SR) + 0.08 * Math.sin((4 * Math.PI * f0 * i) / SR);
    }
  }
  return pcm;
}

describe("U7 melody — best-effort lead line", () => {
  it("a clean lead over the drums-only bed is tracked, both notes, right pitches", () => {
    const bed = renderGoldenTrack(drumsOnlyTrack());
    const lead = leadPcm(
      [
        { startSec: 0.5, durationSec: 1.5, midi: 69 },
        { startSec: 2.5, durationSec: 1.5, midi: 76 },
      ],
      bed.length / SR,
    );
    const mixed = new Float32Array(Math.max(bed.length, lead.length));
    for (let i = 0; i < mixed.length; i++) mixed[i] = bed[i] * 0.4 + lead[i];
    const detection = detectMelodyNotes(mixed, SR, { bpm: 120 });
    expect(detection).not.toBeNull();
    expect(detection!.notes.length).toBeGreaterThanOrEqual(2);
    const midis = detection!.notes.map((n) => n.midi).sort((a, b) => a - b);
    expect(midis).toContain(69);
    expect(midis).toContain(76);
  });

  it("golden harmonic mixes (no lead) come back honestly EMPTY", () => {
    for (const track of [goldenTracks()[0], goldenTracks()[3]]) {
      const t = transcribeTrack(renderGoldenTrack(track), SR);
      expect(t.melody.implemented).toBe(true);
      expect(t.melody.notes).toEqual([]);
      expect(t.melody.warning).toMatch(/lead line|polyphonic/);
    }
  });

  it("transcribeTrack hands the lead notes to the project as a sampler track", () => {
    const bed = renderGoldenTrack(drumsOnlyTrack());
    const lead = leadPcm(
      [
        { startSec: 0.5, durationSec: 1.5, midi: 69 },
        { startSec: 2.5, durationSec: 1.5, midi: 76 },
      ],
      bed.length / SR,
    );
    const mixed = new Float32Array(Math.max(bed.length, lead.length));
    for (let i = 0; i < mixed.length; i++) mixed[i] = bed[i] * 0.4 + lead[i];
    const transcription = transcribeTrack(mixed, SR);
    expect(transcription.melody.notes.length).toBeGreaterThanOrEqual(2);
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const result = unsunoCommand(store.doc, { transcription });
    expect(result.command).not.toBeNull();
    store.execute(result.command!);
    const doc = store.doc;
    const leadTrack = doc.tracks.find((t) => t.kind === "instrument" && t.instrument === "sampler");
    expect(leadTrack).toBeDefined();
    const leadNotes = doc.patterns
      .flatMap((p) => Object.entries(p.notes))
      .filter(([trackId]) => trackId === leadTrack!.id)
      .flatMap(([, notes]) => notes);
    expect(leadNotes.length).toBeGreaterThanOrEqual(2);
  });
});
