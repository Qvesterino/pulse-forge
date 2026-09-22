import { describe, expect, it } from "vitest";
import { TEMPLATES, createProjectFromTemplate, templateInfo } from "../src/project-model/templates";
import type { TemplateId } from "../src/project-model/templates";
import { SCHEMA_VERSION, normalizeProject, validateProjectShape } from "../src/project-model/schema";
import { PPQ } from "../src/project-model/types";
import type { DrumTrack, InstrumentTrack, ProjectDocument } from "../src/project-model/types";

const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

function drumPadIds(doc: ProjectDocument): Set<string> {
  const ids = new Set<string>();
  for (const track of doc.tracks) {
    if (track.kind === "drum") for (const pad of track.pads) ids.add(pad.id);
  }
  return ids;
}

describe("templates", () => {
  it("ships the twelve promised templates", () => {
    expect(TEMPLATE_IDS.sort()).toEqual(
      [
        "ambient",
        "drill",
        "empty",
        "house",
        "jersey",
        "lofi-house",
        "phonk",
        "reggaeton",
        "scene-score",
        "techno",
        "trap",
        "ukg",
      ].sort(),
    );
  });

  it("every template has metadata with description, bpm and tags", () => {
    for (const template of TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.bpm).toBeGreaterThanOrEqual(20);
      expect(template.bpm).toBeLessThanOrEqual(300);
      expect(template.tags.length).toBeGreaterThan(0);
    }
  });

  it("templateInfo falls back to the first template for unknown ids", () => {
    expect(templateInfo("nope" as TemplateId).id).toBe(TEMPLATES[0].id);
  });

  describe.each(TEMPLATES)("$id template", (template) => {
    const doc = createProjectFromTemplate(template.id);

    it("produces a schema-valid project", () => {
      expect(validateProjectShape(doc)).toBe(true);
      expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
      expect(doc.bpm).toBe(template.bpm);
    });

    it("is unchanged by normalization (already canonical)", () => {
      expect(normalizeProject(doc)).toBe(doc);
    });

    it("has at least one drum track, one pattern, one scene and a usable arrangement", () => {
      expect(doc.tracks.some((t) => t.kind === "drum")).toBe(true);
      expect(doc.patterns.length).toBeGreaterThanOrEqual(1);
      expect(doc.scenes.length).toBeGreaterThanOrEqual(1);
      expect(doc.arrangement.clips.length).toBeGreaterThanOrEqual(1);
    });

    it("activePatternId points at an existing pattern", () => {
      expect(doc.patterns.some((p) => p.id === doc.activePatternId)).toBe(true);
    });

    it("every pattern row covers a real pad with the pattern's step count", () => {
      const padIds = drumPadIds(doc);
      for (const pattern of doc.patterns) {
        for (const [padId, row] of Object.entries(pattern.rows)) {
          expect(padIds.has(padId)).toBe(true);
          expect(row.length).toBe(pattern.stepCount);
          for (const velocity of row) {
            expect(velocity).toBeGreaterThanOrEqual(0);
            expect(velocity).toBeLessThanOrEqual(1);
          }
        }
      }
    });

    it("every note belongs to an existing instrument track and stays inside the pattern", () => {
      const trackIds = new Set(doc.tracks.map((t) => t.id));
      for (const pattern of doc.patterns) {
        const patternTicks = pattern.stepCount * (PPQ / 4);
        for (const [trackId, notes] of Object.entries(pattern.notes)) {
          expect(trackIds.has(trackId)).toBe(true);
          const track = doc.tracks.find((t) => t.id === trackId);
          expect(track?.kind).toBe("instrument");
          for (const note of notes) {
            expect(note.start).toBeGreaterThanOrEqual(0);
            expect(note.duration).toBeGreaterThan(0);
            expect(note.start + note.duration).toBeLessThanOrEqual(patternTicks);
            expect(note.velocity).toBeGreaterThan(0);
            expect(note.velocity).toBeLessThanOrEqual(1);
          }
        }
      }
    });

    it("every scene references an existing pattern", () => {
      const patternIds = new Set(doc.patterns.map((p) => p.id));
      for (const scene of doc.scenes) expect(patternIds.has(scene.patternId)).toBe(true);
    });

    it("arrangement clips reference existing scenes and do not overlap", () => {
      const sceneIds = new Set(doc.scenes.map((s) => s.id));
      const sorted = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
      for (let i = 0; i < sorted.length; i++) {
        const clip = sorted[i];
        expect(sceneIds.has(clip.sceneId)).toBe(true);
        expect(clip.startBar).toBeGreaterThanOrEqual(0);
        expect(clip.lengthBars).toBeGreaterThanOrEqual(1);
        const next = sorted[i + 1];
        if (next) expect(clip.startBar + clip.lengthBars).toBeLessThanOrEqual(next.startBar);
      }
    });

    it("instrument tracks carry valid params and unique ids", () => {
      const ids = new Set<string>();
      for (const track of doc.tracks) {
        expect(ids.has(track.id)).toBe(false);
        ids.add(track.id);
        if (track.kind === "instrument") {
          const instrument = track as InstrumentTrack;
          expect(Object.keys(instrument.params).length).toBeGreaterThan(0);
          for (const value of Object.values(instrument.params)) expect(Number.isFinite(value)).toBe(true);
        } else {
          expect((track as DrumTrack).pads.length).toBe(16);
        }
      }
    });
  });

  it("house template keeps the starter groove: kick on beat 1 and a bass line", () => {
    const doc = createProjectFromTemplate("house");
    const drums = doc.tracks.find((t) => t.kind === "drum") as DrumTrack;
    const pattern = doc.patterns[0];
    const kickRow = pattern.rows[drums.pads[0].id];
    expect(kickRow[0]).toBeGreaterThan(0);
    expect(kickRow[4]).toBeGreaterThan(0);
    const bassTrack = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "808");
    expect(bassTrack).toBeDefined();
    expect((pattern.notes[bassTrack!.id] ?? []).length).toBeGreaterThan(0);
  });

  it("templates ship four named performance macros mapped to mix bus roles", () => {
    for (const template of TEMPLATES) {
      const doc = createProjectFromTemplate(template.id);
      expect(doc.macros.map((m) => m.name)).toEqual(["DRUMS", "BASS", "MUSIC", "WIDTH"]);
      expect(doc.macros.every((m) => m.value === 0.5)).toBe(true);
      // DRUMS always maps to the drum track's gain.
      const drums = doc.tracks.find((t) => t.kind === "drum")!;
      expect(doc.macros[0].mappings).toEqual([expect.objectContaining({ trackId: drums.id, param: "gain" })]);
    }
  });

  it("house template adds a melodic chords track (drums + bass + music)", () => {
    const doc = createProjectFromTemplate("house");
    expect(doc.tracks.filter((t) => t.kind === "instrument")).toHaveLength(2);
    const music = doc.tracks.find((t) => t.kind === "instrument" && t.instrument === "analog");
    expect(music).toBeDefined();
    expect(doc.patterns[0].notes[music!.id]?.length).toBeGreaterThan(0);
    // MUSIC macro targets that track.
    expect(doc.macros[2].mappings[0].trackId).toBe(music!.id);
  });

  it("scene-score template spans a long arrangement with named sections", () => {
    const doc = createProjectFromTemplate("scene-score");
    const names = doc.scenes.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["INTRO", "BUILD", "DROP", "BREAK", "OUTRO"]));
    const totalBars = Math.max(...doc.arrangement.clips.map((c) => c.startBar + c.lengthBars));
    expect(totalBars).toBeGreaterThanOrEqual(16);
  });

  it("empty template has no instrument tracks and empty rows", () => {
    const doc = createProjectFromTemplate("empty");
    expect(doc.tracks.every((t) => t.kind === "drum")).toBe(true);
    for (const pattern of doc.patterns) {
      for (const row of Object.values(pattern.rows)) {
        expect(row.every((v) => v === 0)).toBe(true);
      }
      expect(Object.keys(pattern.notes).length).toBe(0);
    }
  });

  it("creates distinct project ids across invocations", () => {
    const a = createProjectFromTemplate("house");
    const b = createProjectFromTemplate("house");
    expect(a.id).not.toBe(b.id);
  });
});
