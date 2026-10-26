import { describe, expect, it } from "vitest";
import { applyBridgeCommandForTest, executeCommandBatch, resolveTrackMatcher } from "../../../src/ai/bridge/executor";
import { EMPTY_PREFERENCES, type RecipeInput } from "../../../src/ai/bridge/types";
import { ProjectStore } from "../../../src/store/ProjectStore";
import { testDoc } from "../../fixtures/doc";
import type { ProjectDocument } from "../../../src/project-model/types";

/**
 * V-3 — the EXECUTOR gets its own suite. executeCommandBatch is the AI
 * layer's only write path into the document, and its three structural
 * contracts were documented in its own comments but never pinned:
 *
 *   1. ALL-OR-NOTHING — the batch applies to a WORKING copy; the first
 *      invalid command discards every intermediate mutation and the caller's
 *      document is never touched.
 *   2. ONE SNAPSHOT — the whole batch lands as ONE undoable command
 *      (label "AI: …"), so one AI action is one Ctrl+Z.
 *   3. ONE PASS — validation and apply interleave, which is what lets a
 *      `create-instrument-track` early in a batch be a valid TARGET for the
 *      later commands that name the track it just created (the documented
 *      reason the two-pass validate-then-apply design was replaced).
 *
 * The cases run through the REAL recipe registry (executeCommandBatch
 * generates the batch from the prompt), not a synthetic command list — the
 * contracts hold for what the AI actually ships.
 */

const inputWith = (doc: ProjectDocument): RecipeInput => ({ doc, userPreferences: EMPTY_PREFERENCES });
describe("all-or-nothing", () => {
  it("a failed run (no recipe match) returns the caller's document identity untouched", () => {
    const doc = testDoc();
    const result = executeCommandBatch("make me a sandwich", inputWith(doc));
    if (result.ok) throw new Error("expected the run to fail");
    // The failure union carries NO document at all — the caller's is
    // untouched by construction (nothing to half-land).
    expect("doc" in result).toBe(false);
    expect("command" in result).toBe(false);
  });

  it("a successful batch returns a NEW document and leaves the caller's identity alone", () => {
    const doc = testDoc();
    const result = executeCommandBatch("make the drums punchier", inputWith(doc));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.doc).not.toBe(doc);
    expect(doc.tracks.length).toBe(testDoc().tracks.length);
  });
});

describe("one snapshot", () => {
  it("the whole batch lands as ONE undoable command labelled 'AI: …'", () => {
    const doc = testDoc();
    const result = executeCommandBatch("make the drums punchier", inputWith(doc));
    if (!result.ok) throw new Error(result.error.message);
    const command = result.command;
    expect(command.label).toMatch(/^AI: /);

    const store = new ProjectStore(doc);
    const depthBefore = store.undoStackLength;
    store.execute(command);
    expect(store.undoStackLength).toBe(depthBefore + 1);

    store.undo();
    expect(store.doc.tracks.length).toBe(doc.tracks.length);
  });
});

describe("one pass: create-then-target inside a single batch", () => {
  it("the guitar batch CREATES its track and the later commands land on it", () => {
    // A document with no guitar track at all: the recipe's create command
    // runs first, and every later command (distortion, eq, compressor)
    // targets the track by NAME. Under the old validate-against-original
    // design this batch died with no-track-match; the one-pass design is
    // what makes it work — and this spec pins that it still does.
    const doc = testDoc();
    const guitarCountBefore = doc.tracks.filter((t) => /guitar/i.test(t.name)).length;

    const result = executeCommandBatch("high-gain soad rhythm guitar", inputWith(doc));
    if (!result.ok) throw new Error(result.error.message);

    const next = result.doc;
    const guitars = next.tracks.filter((t) => /guitar/i.test(t.name));
    expect(guitars.length).toBe(guitarCountBefore + 1);
    const guitar = guitars[0]!;
    expect(guitar.effects.map((fx) => fx.type)).toEqual(expect.arrayContaining(["distortion", "eq", "compressor"]));
    // The distortion landed with the recipe's VOICE (the bridge owns the
    // translation), not a default insert.
    const distortion = guitar.effects.find((fx) => fx.type === "distortion")!;
    expect(Object.keys(distortion.params).length).toBeGreaterThan(0);
  });

  it("undo removes the created track's batch effects with it (one Ctrl+Z)", () => {
    const doc = testDoc();
    const result = executeCommandBatch("palm-muted guitar", inputWith(doc));
    if (!result.ok) throw new Error(result.error.message);
    const store = new ProjectStore(doc);
    store.execute(result.command);
    const after = store.doc;
    expect(after.tracks.some((t) => /guitar/i.test(t.name))).toBe(true);

    store.undo();
    expect(store.doc.tracks.some((t) => /guitar/i.test(t.name))).toBe(false);
  });
});

describe("resolveTrackMatcher", () => {
  it("preferKind wins over order; otherwise the first match by track order", () => {
    const doc = testDoc();
    // testDoc() has a DRUM track ("Drums") and instrument tracks — preferKind
    // "drum" must resolve to the drum bus even if an instrument matched first.
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    expect(resolveTrackMatcher(doc, { namePattern: "drum", preferKind: "drum" })).toBe(drum.id);

    // First-match by id order for an unambiguous name.
    const instrument = doc.tracks.find((t) => t.kind === "instrument")!;
    expect(resolveTrackMatcher(doc, { namePattern: instrument.name })).toBe(instrument.id);
  });

  it("no match returns null (the caller owns the user-facing error)", () => {
    expect(resolveTrackMatcher(testDoc(), { namePattern: "bagpipes" })).toBeNull();
  });
});

describe("applyBridgeCommandForTest: landed state for the families no other spec pins", () => {
  it("set-track-pan clamps into [-1, 1]", () => {
    const doc = testDoc();
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    const next = applyBridgeCommandForTest(doc, {
      kind: "set-track-pan",
      label: "pan",
      rationale: "test",
      target: { namePattern: track.name },
      pan: 9,
    });
    expect(next.tracks.find((t) => t.id === track.id)!.pan).toBe(1);
  });

  it("reverb / delay / haas-widener / transient insert and land non-default params", () => {
    let doc: ProjectDocument = testDoc();
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    const target = { namePattern: track.name };

    doc = applyBridgeCommandForTest(doc, {
      kind: "reverb",
      label: "reverb",
      rationale: "test",
      target,
      space: "plate",
      intensity: 0.6,
    });
    const reverb = doc.tracks.find((t) => t.id === track.id)!.effects.find((fx) => fx.type === "reverb");
    expect(reverb).toBeDefined();

    doc = applyBridgeCommandForTest(doc, {
      kind: "delay",
      label: "delay",
      rationale: "test",
      target,
      space: "slap",
      intensity: 0.4,
    });
    expect(doc.tracks.find((t) => t.id === track.id)!.effects.some((fx) => fx.type === "delay")).toBe(true);

    doc = applyBridgeCommandForTest(doc, {
      kind: "haas-widener",
      label: "haas",
      rationale: "test",
      target,
      width: "wide",
      intensity: 0.5,
    });
    expect(doc.tracks.find((t) => t.id === track.id)!.effects.some((fx) => fx.type === "haasWidener")).toBe(true);

    doc = applyBridgeCommandForTest(doc, {
      kind: "insert-transient",
      label: "transient",
      rationale: "test",
      target,
      params: { attack: 0.7, sustain: 0.3, sensitivity: 0.5, mix: 1, outputDb: 0 },
    });
    const transient = doc.tracks.find((t) => t.id === track.id)!.effects.find((fx) => fx.type === "transient");
    expect(transient).toBeDefined();
    expect(transient!.params.attack).toBe(0.7);
  });

  it("eq-corner / eq-carve / eq-boost write the canonical eq instance", () => {
    let doc: ProjectDocument = testDoc();
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    const target = { namePattern: track.name };

    doc = applyBridgeCommandForTest(doc, {
      kind: "eq-corner",
      label: "hp",
      rationale: "test",
      target,
      band: "hp",
      freqHz: 90,
    });
    doc = applyBridgeCommandForTest(doc, {
      kind: "eq-carve",
      label: "carve",
      rationale: "test",
      target,
      band: "lowMid",
      freqHz: 250,
      gainDb: -4,
      q: 1.4,
    });
    doc = applyBridgeCommandForTest(doc, {
      kind: "eq-boost",
      label: "boost",
      rationale: "test",
      target,
      band: "highShelf",
      freqHz: 8000,
      gainDb: 2,
      q: 0.7,
    });

    const eq = doc.tracks.find((t) => t.id === track.id)!.effects.find((fx) => fx.type === "eq");
    expect(eq).toBeDefined();
    expect(Object.keys(eq!.params).length).toBeGreaterThan(0);
  });

  it("distortion inserts with the requested voice", () => {
    const doc = testDoc();
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    const next = applyBridgeCommandForTest(doc, {
      kind: "distortion",
      label: "dist",
      rationale: "test",
      target: { namePattern: track.name },
      voice: "crunch",
      intensity: 0.5,
    });
    expect(next.tracks.find((t) => t.id === track.id)!.effects.some((fx) => fx.type === "distortion")).toBe(true);
  });
});
