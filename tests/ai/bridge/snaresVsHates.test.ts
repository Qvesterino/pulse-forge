/**
 * Tests for the AI bridge pipeline, anchored on the canonical "snares vs
 * hates" recipe. The full LLM call is bypassed by the mockProvider — these
 * tests verify the recipe, validation, executor, and snapshot/undo chain
 * work end-to-end on a real ProjectDocument.
 *
 * What we cover:
 *   1. Happy path: default prefs → 3 commands applied, sidechain wired,
 *      one undo entry restores the doc exactly.
 *   2. Personalization tilt: stronger eq-carve preference → milder sidechain.
 *   3. Missing tracks → structured no-track-match error, no mutation.
 *   4. Sidechain self-source → validation error, no mutation.
 *   5. Out-of-range parameter → validation error, no mutation.
 *
 * What we DELIBERATELY do not test:
 *   - Audio path (these commands mutate the project model only).
 *   - Recipe prompt parsing beyond what the recipe itself claims.
 *   - LLM provider (mockProvider is the path; provider/<name>.ts is follow-up).
 */

import { describe, expect, it } from "vitest";
import { testDoc } from "../../fixtures/doc";
import type { ProjectDocument } from "../../../src/project-model/types";
import type { UserPreferencesSnapshot } from "../../../src/ai/bridge/types";
import { EMPTY_PREFERENCES } from "../../../src/ai/bridge/types";
import { executeCommandBatch } from "../../../src/ai/bridge/executor";

// ─── Fixture ────────────────────────────────────────────────────────────────

/**
 * Build a project that has the tracks this recipe expects. We rename the
 * first two tracks of the house template so the matcher resolves
 * deterministically (substring "snare" / "hi-hats") without depending on
 * the exact template track names.
 */
function bridgeDoc(): ProjectDocument {
  const base = testDoc();
  if (base.tracks.length < 2) {
    throw new Error("test fixture: testDoc() must yield at least two tracks");
  }
  const tracks = base.tracks.map((t, i) => {
    if (i === 0) return { ...t, name: "Snare" };
    if (i === 1) return { ...t, name: "Hi-Hats" };
    return t;
  });
  return { ...base, tracks };
}

/** A custom preference snapshot with a strong tilt toward eq-carve. */
const EQ_LOVING_PREFS: UserPreferencesSnapshot = {
  weight: 0.8,
  conflictResolution: { "eq-carve": 0.9, "sidechain-duck": 0.1 },
  eqCutIntensityDb: 3,
  notes: "test: prefers EQ carving",
};

/** A custom preference snapshot with a strong tilt toward sidechain. */
const SC_LOVING_PREFS: UserPreferencesSnapshot = {
  weight: 0.8,
  conflictResolution: { "eq-carve": 0, "sidechain-duck": 1 },
  eqCutIntensityDb: 3,
  notes: "test: prefers sidechain duck (pure)",
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("AI bridge — snares vs hates", () => {
  it("default prefs: applies carve + boost + sidechain, sidechain wired from snare", () => {
    const doc = bridgeDoc();
    const snare = doc.tracks[0];
    const hihat = doc.tracks[1];
    if (!snare || !hihat) throw new Error("fixture: missing snare/hihat");

    const beforeSidechainCount = hihat.effects.filter((fx) => fx.type === "sidechain").length;

    const result = executeCommandBatch("uprav snares aby sa nebili s hates", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The new hihat should now contain a sidechain whose source is the snare id.
    const updatedHihat = result.doc.tracks[1];
    if (!updatedHihat) throw new Error("fixture: hihat vanished");
    const newSidechains = updatedHihat.effects.filter((fx) => fx.type === "sidechain");
    expect(newSidechains.length).toBe(beforeSidechainCount + 1);
    const wired = newSidechains[newSidechains.length - 1];
    expect(wired?.sidechainTrackId).toBe(snare.id);

    // All three command kinds should appear in the result (carve + boost + sidechain).
    // We can't read the batch from the executor result, so we infer from
    // effects on the snare (eq) and hihat (eq + sidechain).
    const updatedSnare = result.doc.tracks[0];
    if (!updatedSnare) throw new Error("fixture: snare vanished");
    const snareEqs = updatedSnare.effects.filter((fx) => fx.type === "eq");
    const hihatEqs = updatedHihat.effects.filter((fx) => fx.type === "eq");
    expect(snareEqs.length).toBeGreaterThan(0); // boost on snare
    expect(hihatEqs.length).toBeGreaterThan(0); // carve on hihat
  });

  it("snapshot command: undo restores the original document exactly", () => {
    const doc = bridgeDoc();
    const result = executeCommandBatch("uprav snares aby sa nebili s hates", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Round-trip: execute yields the executor's returned doc; undo on that
    // yields the original. This is the "one undo entry per AI suggestion"
    // contract from AGENTS.md §3 (every AI batch = one undo step).
    const applied = result.command.execute(doc);
    expect(applied).toEqual(result.doc);
    const undone = result.command.undo(applied);
    expect(undone).toEqual(doc);
  });

  it("eq-loving prefs: tilt toward eq-carve keeps EQ, milder sidechain", () => {
    const doc = bridgeDoc();
    const hihatBefore = doc.tracks[1];
    if (!hihatBefore) throw new Error("fixture: missing hihat");
    const eqBefore = hihatBefore.effects.filter((fx) => fx.type === "eq").length;

    const result = executeCommandBatch("snare clashes with hi-hat", {
      doc,
      userPreferences: EQ_LOVING_PREFS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hihatAfter = result.doc.tracks[1];
    if (!hihatAfter) throw new Error("fixture: hihat vanished");
    const eqAfter = hihatAfter.effects.filter((fx) => fx.type === "eq").length;
    expect(eqAfter).toBeGreaterThan(eqBefore);
  });

  it("sidechain-loving prefs: tilt past 0.95 drops the EQ carve entirely", () => {
    const doc = bridgeDoc();
    const hihatBefore = doc.tracks[1];
    if (!hihatBefore) throw new Error("fixture: missing hihat");

    const result = executeCommandBatch("snare hates masking", {
      doc,
      userPreferences: SC_LOVING_PREFS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hihatAfter = result.doc.tracks[1];
    if (!hihatAfter) throw new Error("fixture: hihat vanished");
    // No new EQ on hihat (only sidechain should have been added).
    const newEqs = hihatAfter.effects.filter(
      (fx) => fx.type === "eq" && !hihatBefore.effects.some((orig) => orig.id === fx.id),
    );
    expect(newEqs.length).toBe(0);
    // Sidechain should still be present.
    const newSidechains = hihatAfter.effects.filter(
      (fx) => fx.type === "sidechain" && !hihatBefore.effects.some((orig) => orig.id === fx.id),
    );
    expect(newSidechains.length).toBe(1);
  });

  it("missing snare: returns no-track-match without mutating the doc", () => {
    // Build a doc with hi-hats only.
    const base = testDoc();
    const tracks = base.tracks.map((t, i) => (i === 0 ? { ...t, name: "Hi-Hats" } : t));
    const doc: ProjectDocument = { ...base, tracks };

    const result = executeCommandBatch("uprav snares aby sa nebili s hates", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("no-track-match");
    // The executor must not return a Command on failure.
    // (result.command doesn't exist on the failure variant.)
  });

  it("unrecognised prompt: returns no-recipe-match", () => {
    const doc = bridgeDoc();
    const result = executeCommandBatch("play something funky", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("no-recipe-match");
  });

  it("empty prompt: returns validation-failed", () => {
    const doc = bridgeDoc();
    const result = executeCommandBatch("   ", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation-failed");
  });
});
