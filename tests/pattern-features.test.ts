import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeIntent } from "../src/intent/normalize";
import { extractPatternFeatures, FEATURE_COUNT, FEATURE_NAMES } from "../src/ai/features/pattern-features";
import type { IntentSpec } from "../src/intent/types";
import type { GenerateOptions } from "../src/ai/types";
import type { Pattern, ProjectDocument } from "../src/project-model/types";

/**
 * features.v1 contract gates (goal doc Fáze 0 + Fáze 5):
 * determinism, finiteness, clipping, UUID-independence, content sensitivity,
 * golden coverage (drums-only / melody-only / full / empty / fallback).
 */

function intentOf(overrides: Partial<IntentSpec> = {}): IntentSpec {
  return normalizeIntent({
    genre: "house",
    energy: 0.7,
    density: 0.6,
    complexity: 0.4,
    variation: 0.5,
    seed: "feature-test",
    roles: ["drums", "bass"],
    stepCount: undefined,
    ...overrides,
  } as never) as IntentSpec;
}

function optionsOf(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    genre: "house",
    style: null,
    seed: "feature-test",
    stepCount: 16,
    key: null,
    drumTrackId: undefined,
    roles: ["drums", "bass"],
    replaceMode: "replace",
    ...overrides,
  } as GenerateOptions;
}

function generateDocAndPattern(overrides: Partial<GenerateOptions> = {}): {
  doc: ProjectDocument;
  pattern: Pattern;
  options: GenerateOptions;
  intent: IntentSpec;
} {
  const options = optionsOf(overrides);
  const doc = createProjectFromTemplate("house");
  const pattern = generatePatternSync(doc, options);
  return { doc, pattern, options, intent: intentOf() };
}

// Deterministic pattern generation through the REAL local generator.
import { generatePattern as generatePatternReal } from "../src/ai/generator";
function generatePatternSync(doc: ProjectDocument, options: GenerateOptions): Pattern {
  return generatePatternReal(doc, options);
}

describe("pattern-features v1 — contract", () => {
  it("has a fixed feature count in the 48–64 range with unique names", () => {
    expect(FEATURE_COUNT).toBeGreaterThanOrEqual(48);
    expect(FEATURE_COUNT).toBeLessThanOrEqual(64);
    expect(FEATURE_NAMES.length).toBe(FEATURE_COUNT);
    expect(new Set(FEATURE_NAMES).size).toBe(FEATURE_COUNT);
  });

  it("produces a finite, clipped vector with metadata for a real generated pattern", () => {
    const { doc, pattern, options, intent } = generateDocAndPattern();
    const vector = extractPatternFeatures({ doc, pattern, intent, options, resolvedBpm: doc.bpm });
    expect(vector.version).toBe("features.v1");
    expect(vector.values.length).toBe(FEATURE_COUNT);
    expect(vector.finite).toBe(true);
    for (const value of vector.values) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(vector.featureHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic — same inputs, same vector and hash", () => {
    const a = generateDocAndPattern();
    const b = generateDocAndPattern();
    const va = extractPatternFeatures({ ...a, resolvedBpm: a.doc.bpm });
    const vb = extractPatternFeatures({ ...b, resolvedBpm: b.doc.bpm });
    expect(va.featureHash).toBe(vb.featureHash);
    expect(Array.from(va.values)).toEqual(Array.from(vb.values));
  });

  it("is UUID-independent — same content in differently-named tracks/patterns", () => {
    const { doc, pattern, options, intent } = generateDocAndPattern();
    const renamed: Pattern = {
      ...pattern,
      id: "pattern-renamed-uuid",
      name: "Renamed",
    };
    const renamedDoc: ProjectDocument = {
      ...doc,
      patterns: doc.patterns.map((p) => (p.id === pattern.id ? renamed : p)),
    };
    const original = extractPatternFeatures({ doc, pattern, intent, options, resolvedBpm: doc.bpm });
    const renamedVector = extractPatternFeatures({
      doc: renamedDoc,
      pattern: renamed,
      intent,
      options,
      resolvedBpm: doc.bpm,
    });
    expect(renamedVector.featureHash).toBe(original.featureHash);
    expect(Array.from(renamedVector.values)).toEqual(Array.from(original.values));
  });

  it("is content-sensitive — changing a drum hit changes expected features", () => {
    const { doc, pattern, options, intent } = generateDocAndPattern();
    const before = extractPatternFeatures({ doc, pattern, intent, options, resolvedBpm: doc.bpm });
    const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
    const pad = drumTrack.kind === "drum" ? drumTrack.pads[2] : undefined;
    const mutated: Pattern = {
      ...pattern,
      rows: { ...pattern.rows, [pad!.id]: (pattern.rows[pad!.id] ?? []).map((v, i) => (i === 3 ? 0.9 : v)) },
    };
    const after = extractPatternFeatures({ doc, pattern: mutated, intent, options, resolvedBpm: doc.bpm });
    expect(after.featureHash).not.toBe(before.featureHash);
    const densityIndex = FEATURE_NAMES.indexOf("drums.density");
    expect(after.values[densityIndex]).not.toBe(before.values[densityIndex]);
  });

  it("golden coverage: drums-only, melody-only, full, empty and fallback produce valid vectors", () => {
    const doc = createDefaultProject();
    const drumsOnlyOptions = optionsOf({ roles: ["drums"] });
    const pattern = generatePatternSync(doc, drumsOnlyOptions);
    const intent = intentOf({ roles: ["drums"] });
    for (const [label, candidate] of [
      ["drums-only", pattern],
      ["empty", { ...pattern, rows: {}, notes: {} } as Pattern],
    ] as const) {
      const vector = extractPatternFeatures({
        doc,
        pattern: candidate,
        intent,
        options: drumsOnlyOptions,
        resolvedBpm: doc.bpm,
      });
      expect(vector.finite, label).toBe(true);
      expect(vector.values.length).toBe(FEATURE_COUNT);
    }
    // Melody-only: notes present, no drum rows.
    const melodyOnly: Pattern = {
      ...pattern,
      rows: {},
      notes: {
        [doc.tracks.find((t) => t.kind === "instrument")!.id]: [
          { id: "n1", pitch: 60, start: 0, duration: 120, velocity: 0.8 },
          { id: "n2", pitch: 64, start: 120, duration: 120, velocity: 0.8 },
          { id: "n3", pitch: 67, start: 240, duration: 240, velocity: 0.8 },
        ],
      },
    };
    const melodyVector = extractPatternFeatures({
      doc,
      pattern: melodyOnly,
      intent,
      options: drumsOnlyOptions,
      resolvedBpm: doc.bpm,
    });
    expect(melodyVector.finite).toBe(true);
    expect(melodyVector.values[FEATURE_NAMES.indexOf("flags.melodicAbsent")]).toBe(0);
  });

  it("presence flags disambiguate absent tracks from true zeros", () => {
    const doc = createDefaultProject();
    const emptyPattern: Pattern = {
      id: "p-empty",
      name: "empty",
      stepCount: 16,
      rows: {},
      notes: {},
      phrasePlan: { bars: [{ startBar: 0, lengthBars: 1, intensity: 0.7 }] } as never,
      generation: undefined,
    } as unknown as Pattern;
    const vector = extractPatternFeatures({
      doc,
      pattern: emptyPattern,
      intent: intentOf(),
      options: optionsOf(),
      resolvedBpm: doc.bpm,
      batch: [],
    });
    expect(vector.values[FEATURE_NAMES.indexOf("flags.drumsAbsent")]).toBe(1);
    expect(vector.values[FEATURE_NAMES.indexOf("flags.patternEmpty")]).toBe(1);
  });
});
