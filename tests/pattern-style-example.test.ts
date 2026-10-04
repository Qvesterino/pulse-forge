import { describe, expect, it } from "vitest";
import { generatePattern } from "../src/ai/generator";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { patternStyleExampleFromProject } from "../src/intent/pattern-style-example";
import type { GenerateOptions } from "../src/ai/types";
import type { Pattern, ProjectDocument } from "../src/project-model/types";

/**
 * LEARN LOCAL PRODUCER STYLE FROM EDITS — the pattern summarizer.
 *
 * This turns a LIVE pattern into a compact, privacy-safe style summary. The
 * two contract points worth pinning:
 *   1. PRIVACY: the summary carries only sliders + genre/groove id + a content
 *      hash — never a note, a project id, or a filename.
 *   2. DETERMINISM + SIGNAL: the same pattern always produces the same hash and
 *      sliders, and the sliders actually move with musical content (a dense
 *      busy pattern reads denser than a sparse one).
 */

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    genre: "techno",
    style: null,
    seed: "style-example-test",
    stepCount: 32,
    key: null,
    drumTrackId: undefined,
    roles: ["drums", "bass", "chords", "lead"],
    replaceMode: "replace",
    ...overrides,
  } as GenerateOptions;
}

function fixture(overrides: Partial<GenerateOptions> = {}): { doc: ProjectDocument; pattern: Pattern } {
  const doc = createProjectFromTemplate("techno");
  const pattern = generatePattern(doc, options(overrides));
  return { doc, pattern };
}

describe("pattern style example", () => {
  it("summarizes a real generated pattern with bounded sliders", () => {
    const { doc, pattern } = fixture();
    const example = patternStyleExampleFromProject(doc, pattern, "techno");
    expect(example).not.toBeNull();
    expect(example!.genre).toBe("techno");
    expect(example!.version).toBe(1);
    for (const field of ["energy", "density", "complexity", "variation"] as const) {
      expect(example![field]).toBeGreaterThanOrEqual(0);
      expect(example![field]).toBeLessThanOrEqual(1);
      expect(Number.isFinite(example![field])).toBe(true);
    }
  });

  it("is deterministic: same pattern ⇒ same hash and sliders", () => {
    const { doc, pattern } = fixture();
    const a = patternStyleExampleFromProject(doc, pattern, "techno");
    const b = patternStyleExampleFromProject(doc, pattern, "techno");
    // savedAt differs (Date.now), everything else is content-derived.
    expect(a!.contentHash).toBe(b!.contentHash);
    expect(a!.energy).toBe(b!.energy);
    expect(a!.density).toBe(b!.density);
    expect(a!.complexity).toBe(b!.complexity);
    expect(a!.variation).toBe(b!.variation);
  });

  it("content hash changes when the pattern's notes change (an edit is a new example)", () => {
    const { doc, pattern } = fixture();
    const original = patternStyleExampleFromProject(doc, pattern, "techno")!;
    // Edit one note: the hash must move, otherwise re-teaching is a no-op.
    const instrument = doc.tracks.find((track) => track.kind === "instrument")!;
    const edited: Pattern = {
      ...pattern,
      notes: {
        ...pattern.notes,
        [instrument.id]: [
          ...(pattern.notes[instrument.id] ?? []),
          { id: "edit-1", pitch: 64, start: 0, duration: 120, velocity: 0.8 },
        ],
      },
    };
    const after = patternStyleExampleFromProject(doc, edited, "techno")!;
    expect(after.contentHash).not.toBe(original.contentHash);
  });

  it("returns null for an empty pattern (nothing to learn)", () => {
    const { doc, pattern } = fixture();
    const empty: Pattern = { ...pattern, rows: {}, notes: {} };
    expect(patternStyleExampleFromProject(doc, empty, "techno")).toBeNull();
  });

  it("resolves genre from generation metadata, then the intent hint, then tags", () => {
    const { doc, pattern } = fixture();
    // The generated pattern carries generation.genre from its options — the
    // STRONGEST signal wins.
    expect(patternStyleExampleFromProject(doc, pattern, "dnb")?.genre).toBe("techno");
    // 2) With no generation metadata, the intent hint is next.
    const manual: Pattern = { ...pattern, generation: undefined };
    expect(patternStyleExampleFromProject(doc, manual, "dnb")?.genre).toBe("dnb");
    // 3) Explicit tags are the last resort.
    const tagged = { ...doc, tags: ["jersey"] };
    expect(patternStyleExampleFromProject(tagged, manual, null)?.genre).toBe("jersey");
  });

  it("PRIVACY: the summary carries no note or project payload", () => {
    const { doc, pattern } = fixture();
    const example = patternStyleExampleFromProject(doc, pattern, "techno")!;
    const serialized = JSON.stringify(example);
    // No note ids, no project id, no pattern id, no filename field.
    expect(example).not.toHaveProperty("notes");
    expect(example).not.toHaveProperty("rows");
    expect(example).not.toHaveProperty("projectId");
    expect(serialized).not.toContain(doc.id);
    expect(serialized).not.toContain(pattern.id);
  });

  it("a denser pattern reads denser than a sparse one", () => {
    const doc = createProjectFromTemplate("techno");
    const sparse = patternStyleExampleFromProject(doc, generatePattern(doc, options({ seed: "sparse" })), "techno")!;
    // Force a saturated drum pattern by copying a generated one and filling rows.
    const drumTrack = doc.tracks.find((track) => track.kind === "drum")!;
    const busyPattern = generatePattern(doc, options({ seed: "busy" }));
    const row = new Array(32).fill(0.8);
    const busy: Pattern = { ...busyPattern, rows: Object.fromEntries(drumTrack.pads.map((pad) => [pad.id, row])) };
    const dense = patternStyleExampleFromProject(doc, busy, "techno")!;
    expect(dense.density).toBeGreaterThanOrEqual(sparse.density);
  });
});
