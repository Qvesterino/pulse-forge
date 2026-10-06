import { describe, expect, it } from "vitest";
import { normalizeProject } from "../../src/project-model/schema";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ProjectStore } from "../../src/store/ProjectStore";
import { regenerateStyleCommand } from "../../src/reference/regen-style";
import { unsunoCommand } from "../../src/reference/unsuno";
import { transcribeTrack } from "../../src/reference/transcribe";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "./golden-synth";

/**
 * RE-STYLE REGENERATION — the deep half of the remix bridge: section
 * content (drums + bass) is REGENERATED in the artist's style, while the
 * song's identity stays: section structure, chord voicings (the source
 * harmony), key, tempo. One undo restores everything.
 */

const SR = GOLDEN_SAMPLE_RATE;

function reconstructed() {
  const house = goldenTracks()[0];
  const transcription = transcribeTrack(renderGoldenTrack(house), SR, { separation: "off" });
  const sections = [0, 1].map((i) => ({
    role: i === 0 ? "intro" : "drop",
    startSec: i * 4 * (240 / 126),
    endSec: (i + 1) * 4 * (240 / 126),
  }));
  const store = new ProjectStore(createProjectFromTemplate("house"));
  store.execute(unsunoCommand(store.doc, { transcription, sections }).command!);
  return store;
}

function fingerprint(store: ProjectStore) {
  const doc = normalizeProject(store.doc);
  return {
    sectionNames: doc.patterns.filter((p) => p.name.startsWith("UN-SUNO")).map((p) => p.name),
    chordNotes: doc.patterns
      .filter((p) => p.name.startsWith("UN-SUNO"))
      .map((p) => {
        const keysTrack = doc.tracks.find((t) => t.kind === "instrument" && t.instrument === "keys");
        return (keysTrack ? (p.notes[keysTrack.id] ?? []) : []).map((n) => [n.pitch, n.start, n.duration]);
      }),
    key: doc.key,
    bpm: doc.bpm,
  };
}

describe("regenerateStyleCommand — regenerate content, keep identity", () => {
  it("regenerates drums + bass per section; chords/structure/key untouched; one undo restores", () => {
    const store = reconstructed();
    const before = fingerprint(store);
    const drumBefore = normalizeProject(store.doc).tracks.find((t) => t.kind === "drum") as {
      pads: Array<{ assetId: string | null }>;
    };
    const rowsBefore = normalizeProject(store.doc)
      .patterns.filter((p) => p.name.startsWith("UN-SUNO"))
      .map((p) => p.rows);

    const result = regenerateStyleCommand(store.doc, "travis scott");
    expect(result.command).not.toBeNull();
    expect(result.sections).toBe(2);
    expect(result.summary).toMatch(/travis scott/i);

    store.execute(result.command!);
    const after = normalizeProject(store.doc);

    // IDENTITY preserved: section names, chord voicings, key, tempo.
    expect(fingerprint(store)).toEqual(before);

    // CONTENT regenerated: rows differ from the transcribed fold...
    const rowsAfter = after.patterns.filter((p) => p.name.startsWith("UN-SUNO")).map((p) => p.rows);
    expect(JSON.stringify(rowsAfter)).not.toBe(JSON.stringify(rowsBefore));
    // ...row arrays still match stepCount, velocities in range
    for (const pattern of after.patterns.filter((p) => p.name.startsWith("UN-SUNO"))) {
      for (const row of Object.values(pattern.rows)) {
        expect(row.length).toBe(pattern.stepCount);
        for (const v of row) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
    // bass notes regenerated (present, in bass register 24..60)
    const bassTrack = after.tracks.find((t) => t.kind === "instrument" && t.instrument === "bass")!;
    const bassNotes = after.patterns
      .filter((p) => p.name.startsWith("UN-SUNO"))
      .flatMap((p) => p.notes[bassTrack.id] ?? []);
    expect(bassNotes.length).toBeGreaterThan(0);
    for (const note of bassNotes) {
      expect(note.pitch).toBeGreaterThanOrEqual(24);
      expect(note.pitch).toBeLessThanOrEqual(60);
    }
    void drumBefore;

    // ONE undo restores everything.
    store.undo();
    expect(fingerprint(store)).toEqual(before);
    expect(
      normalizeProject(store.doc)
        .patterns.filter((p) => p.name.startsWith("UN-SUNO"))
        .map((p) => p.rows),
    ).toEqual(rowsBefore);
  });

  it("determinism: same artist → identical regenerated rows", () => {
    const a = reconstructed();
    const b = reconstructed();
    a.execute(regenerateStyleCommand(a.doc, "kendrick lamar").command!);
    b.execute(regenerateStyleCommand(b.doc, "kendrick lamar").command!);
    const rows = (store: ProjectStore) =>
      normalizeProject(store.doc)
        .patterns.filter((p) => p.name.startsWith("UN-SUNO"))
        .map((p) => JSON.stringify(Object.values(p.rows))); // velocity content; pad IDs are uuids
    expect(rows(b)).toEqual(rows(a));
  });

  it("a different artist yields a different groove content", () => {
    const a = reconstructed();
    const b = reconstructed();
    a.execute(regenerateStyleCommand(a.doc, "travis scott").command!);
    b.execute(regenerateStyleCommand(b.doc, "dua lipa").command!);
    const rows = (store: ProjectStore) =>
      normalizeProject(store.doc)
        .patterns.filter((p) => p.name.startsWith("UN-SUNO"))
        .map((p) => JSON.stringify(Object.values(p.rows)));
    expect(rows(b)).not.toEqual(rows(a));
  });

  it("unknown artist → null command, honest summary", () => {
    const store = reconstructed();
    const result = regenerateStyleCommand(store.doc, "nikto taky 999");
    expect(result.command).toBeNull();
    expect(result.summary).toMatch(/unknown artist/i);
  });
});
