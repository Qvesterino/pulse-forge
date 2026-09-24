import { describe, it, expect, beforeEach } from "vitest";
import { analyzeVoiceIdea } from "../src/intent/voice-idea";
import { composeFullTrack } from "../src/intent/compose";
import { testDoc } from "./fixtures/doc";
import type { PitchFrame } from "../src/audio-workers/pitch-tracker";

/** A hummed C-major-ish phrase: C4 D4 E4 G4, one note per half second. */
function sungFrames(): PitchFrame[] {
  const melody = [60, 62, 64, 67];
  const frames: PitchFrame[] = [];
  const frameSec = 0.02;
  const noteSec = 0.45;
  melody.forEach((midi, noteIndex) => {
    const startSec = noteIndex * noteSec;
    for (let t = 0; t < noteSec; t += frameSec) {
      frames.push({ timeSec: startSec + t, midi, clarity: 0.9, rms: 0.2 });
    }
  });
  return frames;
}

/** Sine bed at C — the Goertzel chroma probe locks onto C. */
function cSinePcm(): Float32Array {
  const sampleRate = 16000;
  const pcm = new Float32Array(sampleRate * 3);
  for (let index = 0; index < pcm.length; index++) {
    pcm[index] = 0.3 * Math.sin((2 * Math.PI * 261.63 * index) / sampleRate);
  }
  return pcm;
}

beforeEach(() => {
  localStorage.clear();
});

describe("analyzeVoiceIdea", () => {
  it("turns injected pitch frames into quantized notes in the detected key", async () => {
    const result = await analyzeVoiceIdea(cSinePcm(), 16000, {
      bpm: 120,
      track: async () => sungFrames(),
    });
    expect(result).not.toBeNull();
    expect(result?.bpm).toBe(120);
    expect(result?.patch.bpmRange).toEqual([118, 122]);
    expect(result?.key?.startsWith("C")).toBe(true);
    expect(result?.patch.key?.startsWith("C")).toBe(true);
    expect(result?.noteCount).toBeGreaterThanOrEqual(3);
    expect(result?.notes[0].pitch).toBe(60);
    expect(result?.summary).toMatch(/BPM/);
  });

  it("no steady pitches → patch without melody, no crash", async () => {
    const result = await analyzeVoiceIdea(cSinePcm(), 16000, {
      bpm: 120,
      track: async () => [{ timeSec: 0.1, midi: 0, clarity: 0.1, rms: 0.001 }],
    });
    expect(result).not.toBeNull();
    expect(result?.noteCount).toBe(0);
    expect(result?.patch.bpmRange).toEqual([118, 122]);
  });
});

describe("SUNO MODE with a hummed hook", () => {
  it("hum notes become the LEAD of lead sections, tiled across the song", async () => {
    const doc = testDoc();
    const result = await composeFullTrack(doc, "house at 124", {
      loudness: false,
      hum: {
        notes: [
          { id: "hum-c", pitch: 72, start: 0, duration: 240, velocity: 0.8 },
          { id: "hum-d", pitch: 74, start: 240, duration: 240, velocity: 0.8 },
        ],
        loopTicks: 7680,
        key: "C Major",
      },
    });
    const leadSections = result.build.sections.filter((section) => section.roles.includes("lead"));
    expect(leadSections.length).toBeGreaterThan(0);
    // the hum ids (tile-stamped) appear in the section patterns
    const allNoteIds = leadSections.flatMap((section) =>
      Object.values(section.pattern.notes ?? {})
        .flat()
        .map((note) => note.id),
    );
    expect(allNoteIds.some((id) => id.startsWith("hum-c"))).toBe(true);
    // song key defaults to the hum key when the intent has none — no transposition
    const someSection = leadSections.find((section) => Object.keys(section.pattern.notes ?? {}).length > 0);
    const notes = Object.values(someSection?.pattern.notes ?? {}).flat();
    expect(notes.some((note) => note.id.startsWith("hum-"))).toBe(true);
  });

  it("transposes the hook when the song key differs from the hum key", async () => {
    const doc = testDoc();
    const result = await composeFullTrack(doc, "house at 124 in D Minor", {
      loudness: false,
      hum: {
        notes: [{ id: "hum-c", pitch: 60, start: 0, duration: 240, velocity: 0.8 }],
        loopTicks: 7680,
        key: "C Major",
      },
    });
    const leadSections = result.build.sections.filter((section) => section.roles.includes("lead"));
    const allNotes = leadSections.flatMap((section) => Object.values(section.pattern.notes ?? {}).flat());
    // C (60) toward D minor root (62): transposed UP a whole tone minimum
    const humNotes = allNotes.filter((note) => note.id.startsWith("hum-c"));
    expect(humNotes.length).toBeGreaterThan(0);
    for (const note of humNotes) expect(Math.abs(note.pitch - 60)).toBeGreaterThanOrEqual(1);
  });

  it("no hum → sections unchanged", async () => {
    const doc = testDoc();
    const result = await composeFullTrack(doc, "house at 124", { loudness: false });
    const leadSections = result.build.sections.filter((section) => section.roles.includes("lead"));
    const allNoteIds = leadSections.flatMap((section) =>
      Object.values(section.pattern.notes ?? {})
        .flat()
        .map((note) => note.id),
    );
    expect(allNoteIds.some((id) => id.startsWith("hum-"))).toBe(false);
  });
});
