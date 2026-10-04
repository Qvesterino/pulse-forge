import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createInstrumentTrack } from "../src/commands/tracks";
import { normalizeIntent } from "../src/intent/normalize";
import { generatePattern } from "../src/ai/generator";
import { extractPatternFeatures, FEATURE_COUNT, FEATURE_NAMES } from "../src/ai/features/pattern-features";
import {
  extractPatternFeaturesV2,
  FEATURE_CONTRACT_V2,
  FEATURE_V2_COUNT,
  FEATURE_V2_EXTENSION_NAMES,
  FEATURE_V2_NAMES,
  normalizeFeatureVector,
  isSupportedFeatureVector,
  BASS_FEATURE_INDICES,
  HARMONY_FEATURE_INDICES,
  ARRANGEMENT_FEATURE_INDICES,
} from "../src/ai/features/pattern-features-v2";
import type { IntentSpec } from "../src/intent/types";
import type { GenerateOptions } from "../src/ai/types";
import type { NoteEvent, Pattern, ProjectDocument } from "../src/project-model/types";

/**
 * features.v2 contract gates (W4).
 *
 * The invariant that makes the whole migration safe is the PREFIX: the first
 * `FEATURE_COUNT` values of a v2 vector must be byte-identical to the v1
 * vector for the same input. If that ever drifts, the shipped 54-dim intent
 * ranker and every stored v1 Producer DNA observation silently change meaning.
 */

function intentOf(overrides: Partial<IntentSpec> = {}): IntentSpec {
  return normalizeIntent({
    genre: "house",
    energy: 0.7,
    density: 0.6,
    complexity: 0.4,
    variation: 0.5,
    seed: "feature-v2-test",
    roles: ["drums", "bass", "chords", "lead"],
    ...overrides,
  } as never) as IntentSpec;
}

function optionsOf(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    genre: "house",
    style: null,
    seed: "feature-v2-test",
    stepCount: 32,
    key: null,
    drumTrackId: undefined,
    roles: ["drums", "bass", "chords", "lead"],
    replaceMode: "replace",
    ...overrides,
  } as GenerateOptions;
}

function fixture(overrides: Partial<GenerateOptions> = {}) {
  const options = optionsOf(overrides);
  const doc = createProjectFromTemplate("house");
  const pattern = generatePattern(doc, options);
  return { doc, pattern, options, intent: intentOf() };
}

function extract(doc: ProjectDocument, pattern: Pattern, intent: IntentSpec, options: GenerateOptions) {
  return { doc, pattern, intent, options, resolvedBpm: doc.bpm, batch: [pattern] };
}

/**
 * A project with three EXPLICITLY NAMED melodic lanes (Bass / Chords / Lead).
 *
 * The shipped templates carry 1–2 instrument tracks with producer names
 * ("808 Sub", "Stab"), so `instrumentTrackForRole` resolves them by POSITION.
 * These tests need all three lanes addressable by name — which is the case the
 * engine itself supports in a hand-built project.
 */
function threeLaneDoc(): { doc: ProjectDocument; bass: string; chords: string; lead: string } {
  let doc = createProjectFromTemplate("house");
  const renamed = doc.tracks.map((track) => {
    if (track.kind !== "instrument") return track;
    if (track.name === "808") return { ...track, name: "Bass" };
    if (track.name === "Chords") return { ...track, name: "Chords" };
    return track;
  });
  doc = { ...doc, tracks: renamed };
  // Add the third lane ("Lead") so all three roles resolve by name.
  doc = createInstrumentTrack(doc, "synth").execute(doc);
  const lead = doc.tracks.filter((track) => track.kind === "instrument").at(-1)!;
  doc = {
    ...doc,
    tracks: doc.tracks.map((track) => (track.id === lead.id ? { ...track, name: "Lead" } : track)),
  };
  const instruments = doc.tracks.filter((track) => track.kind === "instrument");
  return {
    doc,
    bass: instruments[0].id,
    chords: instruments[1].id,
    lead: instruments[2].id,
  };
}

/** Build a pattern whose lanes hold exactly the notes given (absolute pitches). */
function patternWithNotes(doc: ProjectDocument, options: GenerateOptions, lanes: Record<string, number[]>): Pattern {
  const base = generatePattern(doc, options);
  const notes: Record<string, NoteEvent[]> = {};
  for (const [trackId, pitches] of Object.entries(lanes)) {
    notes[trackId] = pitches.map((pitch, index) => ({
      id: `${trackId}-${index}`,
      pitch,
      start: index * 480,
      duration: 480,
      velocity: 0.8,
    }));
  }
  return { ...base, notes, rows: {} };
}

describe("features.v2 — contract", () => {
  it("extends v1 by a fixed, uniquely named block", () => {
    expect(FEATURE_CONTRACT_V2.version).toBe("features.v2");
    expect(FEATURE_V2_NAMES.length).toBe(FEATURE_V2_COUNT);
    expect(new Set(FEATURE_V2_NAMES).size).toBe(FEATURE_V2_COUNT);
    expect(FEATURE_V2_COUNT).toBe(FEATURE_COUNT + FEATURE_V2_EXTENSION_NAMES.length);
    // The v1 block survives untouched at the same indices.
    for (let index = 0; index < FEATURE_COUNT; index++) {
      expect(FEATURE_V2_NAMES[index]).toBe(FEATURE_NAMES[index]);
    }
  });

  it("PREFIX INVARIANT: the first v1 dimensions are byte-identical to the v1 extractor", () => {
    const { doc, pattern, options, intent } = fixture();
    const input = extract(doc, pattern, intent, options);
    const v1 = extractPatternFeatures(input);
    const v2 = extractPatternFeaturesV2(input);
    expect(v2.version).toBe("features.v2");
    expect(v2.values.length).toBe(FEATURE_V2_COUNT);
    for (let index = 0; index < FEATURE_COUNT; index++) {
      expect(v2.values[index], `dim ${index} (${FEATURE_NAMES[index]})`).toBe(v1.values[index]);
    }
  });

  it("produces a finite, in-range, deterministic vector", () => {
    const { doc, pattern, options, intent } = fixture();
    const input = extract(doc, pattern, intent, options);
    const first = extractPatternFeaturesV2(input);
    const second = extractPatternFeaturesV2(input);
    expect(first.finite).toBe(true);
    expect(Array.from(first.values)).toEqual(Array.from(second.values));
    expect(first.featureHash).toBe(second.featureHash);
    for (const value of first.values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("stays safe on a drums-only pattern with no melodic lanes", () => {
    const options = optionsOf({ roles: ["drums"] });
    const doc = createProjectFromTemplate("house");
    const pattern: Pattern = { ...generatePattern(doc, options), notes: {}, rows: generatePattern(doc, options).rows };
    const vector = extractPatternFeaturesV2(extract(doc, pattern, intentOf({ roles: ["drums"] }), options));
    expect(vector.finite).toBe(true);
    for (const value of vector.values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // With no bass/chords/lead lane, the presence flags must say "absent".
    const flags = [
      FEATURE_V2_NAMES.indexOf("flags.bassAbsent"),
      FEATURE_V2_NAMES.indexOf("flags.chordsAbsent"),
      FEATURE_V2_NAMES.indexOf("flags.leadAbsent"),
    ];
    for (const index of flags) expect(vector.values[index]).toBe(1);
  });
});

describe("features.v2 — the new measurements answer a musical question", () => {
  const value = (vector: Float32Array, name: string): number => vector[FEATURE_V2_NAMES.indexOf(name)];
  const at = (name: string): number => FEATURE_V2_NAMES.indexOf(name);

  it("bass.rootAlignment separates a root-locked bass from a wandering one", () => {
    const options = optionsOf();
    const { doc, bass: bassId, chords: chordId } = threeLaneDoc();

    // A perfect fourth above the bass root is a chord tone; a tritone is not.
    const root = 40;
    const locked = patternWithNotes(doc, options, {
      [bassId]: [root, root, root, root],
      [chordId]: [root + 5, root + 9, root + 12],
    });
    const wandering = patternWithNotes(doc, options, {
      [bassId]: [root + 6, root + 6, root + 6, root + 6],
      [chordId]: [root + 5, root + 9, root + 12],
    });
    const lockedVector = extractPatternFeaturesV2(extract(doc, locked, intentOf(), options)).values;
    const wanderingVector = extractPatternFeaturesV2(extract(doc, wandering, intentOf(), options)).values;
    expect(value(lockedVector, "bass.rootAlignment")).toBe(1);
    expect(value(wanderingVector, "bass.rootAlignment")).toBeLessThan(1);
  });

  it("bass.registerStability separates a static bass from a leaping one", () => {
    const options = optionsOf();
    const { doc, bass: bassId } = threeLaneDoc();
    const steady = patternWithNotes(doc, options, { [bassId]: [40, 40, 40, 40, 40, 40] });
    const leaping = patternWithNotes(doc, options, { [bassId]: [28, 52, 31, 55, 29, 53] });
    expect(
      value(extractPatternFeaturesV2(extract(doc, steady, intentOf(), options)).values, "bass.registerStability"),
    ).toBeGreaterThan(
      value(extractPatternFeaturesV2(extract(doc, leaping, intentOf(), options)).values, "bass.registerStability"),
    );
  });

  it("harmony.voicingMovement drops when the chord track re-voices in place", () => {
    const options = optionsOf();
    const { doc, chords: chordId } = threeLaneDoc();
    const smooth = patternWithNotes(doc, options, { [chordId]: [52, 55, 59, 52, 55, 59] });
    const jumpy = patternWithNotes(doc, options, { [chordId]: [52, 55, 59, 76, 79, 83] });
    expect(
      value(extractPatternFeaturesV2(extract(doc, smooth, intentOf(), options)).values, "harmony.voicingMovement"),
    ).toBeLessThan(
      value(extractPatternFeaturesV2(extract(doc, jumpy, intentOf(), options)).values, "harmony.voicingMovement"),
    );
  });

  it("arrangement.roleCount counts the melodic lanes actually present", () => {
    const options = optionsOf();
    const { doc, bass: bassId, chords: chordId, lead: leadId } = threeLaneDoc();
    const all = patternWithNotes(doc, options, { [bassId]: [40], [chordId]: [60], [leadId]: [72] });
    const one = patternWithNotes(doc, options, { [bassId]: [40] });
    expect(value(extractPatternFeaturesV2(extract(doc, all, intentOf(), options)).values, "arrangement.roleCount")).toBe(1);
    expect(value(extractPatternFeaturesV2(extract(doc, one, intentOf(), options)).values, "arrangement.roleCount")).toBe(
      1 / 3,
    );
  });

  it("reports the chord lane as present and bass as absent when only chords are written", () => {
    const options = optionsOf();
    const { doc, chords: chordId } = threeLaneDoc();
    const vector = extractPatternFeaturesV2(
      extract(doc, patternWithNotes(doc, options, { [chordId]: [52, 55, 59] }), intentOf(), options),
    ).values;
    expect(vector[at("flags.bassAbsent")]).toBe(1);
    expect(vector[at("flags.chordsAbsent")]).toBe(0);
  });

  it("exposes disjoint, non-empty index groups past the v1 prefix", () => {
    expect(BASS_FEATURE_INDICES.length).toBeGreaterThan(0);
    expect(HARMONY_FEATURE_INDICES.length).toBeGreaterThan(0);
    expect(ARRANGEMENT_FEATURE_INDICES.length).toBeGreaterThan(0);
    const all = [...BASS_FEATURE_INDICES, ...HARMONY_FEATURE_INDICES, ...ARRANGEMENT_FEATURE_INDICES];
    expect(new Set(all).size).toBe(all.length);
    for (const index of all) expect(index).toBeGreaterThanOrEqual(FEATURE_COUNT);
  });
});

describe("features.v2 — dual-read normalization", () => {
  it("passes a v2 vector through unchanged", () => {
    const values = Array.from({ length: FEATURE_V2_COUNT }, (_, index) => (index % 10) / 10);
    const normalized = normalizeFeatureVector(values)!;
    expect(normalized).toHaveLength(FEATURE_V2_COUNT);
    expect(normalized).toEqual(values);
  });

  it("pads a v1 vector with neutral 0.5 so its A/B difference on the new axes is zero", () => {
    const a = Array.from({ length: FEATURE_COUNT }, (_, index) => (index % 10) / 10);
    const b = Array.from({ length: FEATURE_COUNT }, (_, index) => ((index + 3) % 10) / 10);
    const na = normalizeFeatureVector(a)!;
    const nb = normalizeFeatureVector(b)!;
    for (let index = FEATURE_COUNT; index < FEATURE_V2_COUNT; index++) {
      expect(na[index]).toBe(0.5);
      expect(na[index] - nb[index]).toBe(0);
    }
  });

  it("rejects an unknown width and any out-of-range value", () => {
    expect(normalizeFeatureVector(new Array(10).fill(0.5))).toBeNull();
    expect(normalizeFeatureVector(new Array(FEATURE_V2_COUNT).fill(2))).toBeNull();
    expect(normalizeFeatureVector(new Array(FEATURE_COUNT).fill(Number.NaN))).toBeNull();
    expect(isSupportedFeatureVector(new Array(FEATURE_COUNT))).toBe(true);
    expect(isSupportedFeatureVector(new Array(FEATURE_V2_COUNT))).toBe(true);
    expect(isSupportedFeatureVector(new Array(10))).toBe(false);
  });
});
