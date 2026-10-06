import { describe, expect, it } from "vitest";
import { normalizeProject } from "../../src/project-model/schema";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ProjectStore } from "../../src/store/ProjectStore";
import { coverBandCandidates, pickCoverPattern } from "../../src/reference/cover-band";
import { unsunoCommand } from "../../src/reference/unsuno";
import { transcribeTrack } from "../../src/reference/transcribe";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "./golden-synth";

const SR = GOLDEN_SAMPLE_RATE;

function reconstructed() {
  const house = goldenTracks()[0];
  const transcription = transcribeTrack(renderGoldenTrack(house), SR, { separation: "off" });
  const store = new ProjectStore(createProjectFromTemplate("house"));
  store.execute(unsunoCommand(store.doc, { transcription }).command!);
  return store;
}

describe("cover band — pure candidates", () => {
  it("the default cast yields 3 covers; each regenerates DIFFERENT drums over the SAME chords", () => {
    const store = reconstructed();
    const doc = store.doc;
    const candidates = coverBandCandidates(doc);
    expect(candidates.length).toBe(3);

    const keysTrack = doc.tracks.find((t) => t.kind === "instrument" && t.instrument === "keys");
    const chordSignature = (candidate: (typeof candidates)[number]): string => {
      const preview = candidate.command.execute(doc);
      const pattern = pickCoverPattern(preview)!;
      return JSON.stringify(pattern.notes[keysTrack!.id] ?? []);
    };
    // IDENTITY: every cover keeps the source chord voicings.
    const signatures = new Set(candidates.map(chordSignature));
    expect(signatures.size).toBe(1);

    // STYLE: drum row content differs per persona genre.
    const drumSignature = (candidate: (typeof candidates)[number]): string => {
      const preview = candidate.command.execute(doc);
      const pattern = pickCoverPattern(preview)!;
      return JSON.stringify(Object.values(pattern.rows).map((row) => row.map((v) => Math.round(v * 10) / 10)));
    };
    const drums = new Set(candidates.map(drumSignature));
    expect(drums.size).toBe(3);
  });

  it("determinism: same doc → identical candidates (commands produce equal rows)", () => {
    const store = reconstructed();
    const a = coverBandCandidates(store.doc);
    const b = coverBandCandidates(store.doc);
    expect(a.map((c) => c.personaSlug)).toEqual(b.map((c) => c.personaSlug));
    for (let i = 0; i < a.length; i++) {
      const rowsA = JSON.stringify(
        Object.values(a[i].command.execute(store.doc).patterns.find((p) => p.name.startsWith("UN-SUNO"))!.rows),
      );
      const rowsB = JSON.stringify(
        Object.values(b[i].command.execute(store.doc).patterns.find((p) => p.name.startsWith("UN-SUNO"))!.rows),
      );
      expect(rowsA).toBe(rowsB);
    }
  });

  it("a doc without UN-SUNO sections → no candidates (personas sit out honestly)", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    expect(coverBandCandidates(store.doc)).toEqual([]);
  });

  it("pickCoverPattern: prefers the DROP section, else the first UN-SUNO section", () => {
    // no sections passed -> single "UN-SUNO full" -> first-section fallback
    const store = reconstructed();
    store.execute(coverBandCandidates(store.doc)[0].command);
    const pattern = pickCoverPattern(normalizeProject(store.doc))!;
    expect(pattern.name).toBe("UN-SUNO full");
  });
});
