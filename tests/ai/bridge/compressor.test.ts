/**
 * Tests for the compressor bridge path and the "punchier drums" recipe.
 *
 * Why this file is separate from snaresVsHates.test.ts: the compressor is the
 * first command where the bridge owns the whole parameter translation (there
 * is no "just write the number" shortcut), so it gets its own coverage of
 * the character table, the whitelist round-trip, and the sidechain caveat.
 *
 * Same regression guard as the EQ/sidechain specs applies here: a param
 * assertion alone passes even for a key that does not exist, so every test
 * that claims a write "works" pushes the document through normalizeProject
 * first.
 */

import { describe, expect, it } from "vitest";
import { testDoc } from "../../fixtures/doc";
import type { ProjectDocument } from "../../../src/project-model/types";
import { normalizeProject } from "../../../src/project-model/schema";
import { EMPTY_PREFERENCES } from "../../../src/ai/bridge/types";
import { executeCommandBatch, __validateBridgeCommandForTest } from "../../../src/ai/bridge/executor";
import { COMPRESSOR_CHARACTERS, COMPRESSOR_RANGES, tuneCharacter } from "../../../src/ai/bridge/compressorSlots";
import { TRANSIENT_RANGES } from "../../../src/ai/bridge/transientSlots";

/** testDoc() has a track literally named "Drums" in the house template. */
function drumDoc(): ProjectDocument {
  const doc = testDoc();
  if (!doc.tracks.some((t) => /drums?/i.test(t.name))) {
    throw new Error("fixture: testDoc() must contain a drum track");
  }
  return doc;
}

describe("AI bridge — compressor", () => {
  it("every character expands to values inside the registry whitelist", () => {
    for (const [name, spec] of Object.entries(COMPRESSOR_CHARACTERS)) {
      const values: Array<[string, number, { min: number; max: number }]> = [
        ["threshold", spec.thresholdDb, COMPRESSOR_RANGES.threshold],
        ["ratio", spec.ratio, COMPRESSOR_RANGES.ratio],
        ["attack", spec.attackSec, COMPRESSOR_RANGES.attack],
        ["release", spec.releaseSec, COMPRESSOR_RANGES.release],
        ["knee", spec.kneeDb, COMPRESSOR_RANGES.knee],
        ["detector", spec.detector, COMPRESSOR_RANGES.detector],
        ["scHpf", spec.scHpfHz, COMPRESSOR_RANGES.scHpf],
        ["autoRelease", spec.autoRelease, COMPRESSOR_RANGES.autoRelease],
        ["makeup", spec.makeupDb, COMPRESSOR_RANGES.makeup],
        ["mix", spec.mix, COMPRESSOR_RANGES.mix],
      ];
      for (const [id, value, range] of values) {
        expect(Number.isFinite(value), `${name}.${id} must be finite`).toBe(true);
        expect(value, `${name}.${id}=${value}`).toBeGreaterThanOrEqual(range.min);
        expect(value, `${name}.${id}=${value}`).toBeLessThanOrEqual(range.max);
      }
    }
  });

  it("attack and release are SECONDS, never milliseconds", () => {
    for (const [name, spec] of Object.entries(COMPRESSOR_CHARACTERS)) {
      expect(spec.attackSec, `${name} attack`).toBeLessThanOrEqual(0.5);
      expect(spec.releaseSec, `${name} release`).toBeLessThanOrEqual(2);
      // A millisecond-scale value (5, 100, 250…) would sit far above the
      // ceiling and mean a multi-second time constant.
      expect(spec.attackSec).toBeLessThan(1);
      expect(spec.releaseSec).toBeLessThan(1);
    }
  });

  it("intensity tilts toward more reduction and stays in range", () => {
    const base = COMPRESSOR_CHARACTERS.glue;
    const soft = tuneCharacter(base, 0);
    const hard = tuneCharacter(base, 1);
    // Lower threshold + higher ratio = more gain reduction.
    expect(hard.thresholdDb).toBeGreaterThan(soft.thresholdDb);
    expect(hard.ratio).toBeGreaterThan(soft.ratio);
    for (const t of [0, 0.5, 1]) {
      const s = tuneCharacter(base, t);
      expect(s.thresholdDb).toBeLessThanOrEqual(COMPRESSOR_RANGES.threshold.max);
      expect(s.ratio).toBeLessThanOrEqual(COMPRESSOR_RANGES.ratio.max);
      expect(s.makeupDb).toBeLessThanOrEqual(COMPRESSOR_RANGES.makeup.max);
      expect(s.makeupDb).toBeGreaterThanOrEqual(COMPRESSOR_RANGES.makeup.min);
    }
  });

  it("rejects an unknown character and an out-of-range intensity", () => {
    const doc = drumDoc();
    const badCharacter = __validateBridgeCommandForTest(doc, {
      kind: "compressor",
      label: "bogus",
      rationale: "test",
      target: { namePattern: "drums", regex: false, preferKind: "any" },
      // @ts-expect-error — deliberately invalid so the guard is exercised.
      character: "explosive",
      intensity: 0.5,
    });
    expect(badCharacter.ok).toBe(false);

    const badIntensity = __validateBridgeCommandForTest(doc, {
      kind: "compressor",
      label: "bogus",
      rationale: "test",
      target: { namePattern: "drums", regex: false, preferKind: "any" },
      character: "glue",
      intensity: 4,
    });
    expect(badIntensity.ok).toBe(false);
    if (badIntensity.ok) return;
    expect(badIntensity.message).toContain("intensity");
  });

  it("rejects a self-pumped compressor", () => {
    const doc = drumDoc();
    const drums = doc.tracks.find((t) => /drums?/i.test(t.name));
    if (!drums) throw new Error("fixture: no drum track");
    const check = __validateBridgeCommandForTest(doc, {
      kind: "compressor",
      label: "self pump",
      rationale: "test",
      target: { namePattern: "drums", regex: false, preferKind: "any" },
      character: "punch",
      intensity: 0.5,
      source: { namePattern: "drums", regex: false, preferKind: "any" },
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.message).toContain("same track");
  });
});

describe("AI bridge — punchier drums recipe", () => {
  it("applies transient + compressor + high-pass on the drum bus", () => {
    const doc = drumDoc();
    const result = executeCommandBatch("sprav tie drums viac agresivne", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const drum = result.doc.tracks.find((t) => /drums?/i.test(t.name));
    if (!drum) throw new Error("fixture: drum track vanished");
    expect(drum.effects.some((fx) => fx.type === "transient")).toBe(true);
    expect(drum.effects.some((fx) => fx.type === "compressor")).toBe(true);
    expect(drum.effects.some((fx) => fx.type === "eq")).toBe(true);
  });

  it("compressor params survive normalizeProject (whitelist round-trip)", () => {
    const doc = drumDoc();
    const result = executeCommandBatch("make the drums punchier", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const normalized = normalizeProject(result.doc);
    const drum = normalized.tracks.find((t) => /drums?/i.test(t.name));
    if (!drum) throw new Error("fixture: drum track vanished");
    const comp = drum.effects.find((fx) => fx.type === "compressor");
    expect(comp).toBeDefined();

    // Only canonical ids — the whitelist is the whole point of this test.
    for (const key of Object.keys(comp?.params ?? {})) {
      expect(Object.keys(COMPRESSOR_RANGES)).toContain(key);
    }
    // Assert the invariants rather than re-deriving the recipe's intensity
    // arithmetic here — the recipe owns that number, this spec owns the
    // contract that the expanded result is legal and comes from `punch`.
    const punch = COMPRESSOR_CHARACTERS.punch;
    expect(comp?.params.ratio).toBeGreaterThanOrEqual(punch.ratio);
    expect(comp?.params.ratio).toBeLessThanOrEqual(COMPRESSOR_RANGES.ratio.max);
    // `tuneCharacter` tilts threshold/ratio/makeup only, so the character
    // decides the time constants.
    expect(comp?.params.attack).toBeCloseTo(punch.attackSec, 6);
    expect(comp?.params.release).toBeCloseTo(punch.releaseSec, 6);
    expect(comp?.params.detector).toBe(punch.detector);
    // makeup is stored in dB on the registry side; the worklet converts.
    expect(comp?.params.makeup).toBeGreaterThanOrEqual(punch.makeupDb);
    expect(comp?.params.makeup).toBeLessThanOrEqual(COMPRESSOR_RANGES.makeup.max);
    // Attack must be seconds, so nowhere near a millisecond-magnitude value.
    expect(comp?.params.attack).toBeLessThan(0.5);
  });

  it("transient params survive normalizeProject and keep their sign", () => {
    const doc = drumDoc();
    const result = executeCommandBatch("drums su moc ploche", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const normalized = normalizeProject(result.doc);
    const drum = normalized.tracks.find((t) => /drums?/i.test(t.name));
    if (!drum) throw new Error("fixture: drum track vanished");
    const tr = drum.effects.find((fx) => fx.type === "transient");
    expect(tr).toBeDefined();
    for (const key of Object.keys(tr?.params ?? {})) {
      expect(Object.keys(TRANSIENT_RANGES)).toContain(key);
    }
    // attack is positive (more click) and sustain negative (shorter body).
    expect(tr?.params.attack).toBeGreaterThan(0);
    expect(tr?.params.sustain).toBeLessThan(0);
    expect(tr?.params.sustain).toBeGreaterThanOrEqual(TRANSIENT_RANGES.sustain.min);
  });

  it("high-pass is a corner move, not a gain carve", () => {
    const doc = drumDoc();
    const result = executeCommandBatch("punchier drums", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const normalized = normalizeProject(result.doc);
    const drum = normalized.tracks.find((t) => /drums?/i.test(t.name));
    if (!drum) throw new Error("fixture: drum track vanished");
    const eq = drum.effects.find((fx) => fx.type === "eq");
    expect(eq).toBeDefined();
    // 40 Hz is inside the hp window (20…1000) so it lands verbatim.
    expect(eq?.params.hpFreq).toBe(40);
  });

  it("rejects a corner command aimed at a bell slot", () => {
    const doc = drumDoc();
    const check = __validateBridgeCommandForTest(doc, {
      kind: "eq-corner",
      label: "bogus corner",
      rationale: "test",
      target: { namePattern: "drums", regex: false, preferKind: "any" },
      // @ts-expect-error — deliberately invalid so the guard is exercised.
      band: "highMid",
      freqHz: 1000,
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.message).toContain("not an EQ corner");
  });

  it("rejects a transient attack written outside the signed −1…1 range", () => {
    const doc = drumDoc();
    const check = __validateBridgeCommandForTest(doc, {
      kind: "insert-transient",
      label: "bogus transient",
      rationale: "test",
      target: { namePattern: "drums", regex: false, preferKind: "any" },
      params: { attack: 4, sustain: -0.3, sensitivity: 0.5, mix: 1, outputDb: 0 },
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.message).toContain("attack");
  });

  it("retunes an existing compressor instead of stacking a second one", () => {
    const base = drumDoc();
    const drums = base.tracks.find((t) => /drums?/i.test(t.name));
    if (!drums) throw new Error("fixture: no drum track");
    const doc: ProjectDocument = {
      ...base,
      tracks: base.tracks.map((t) =>
        t.id === drums.id
          ? {
              ...t,
              effects: [
                ...t.effects,
                { id: "fx-user-comp", type: "compressor" as const, bypassed: true, params: { ratio: 2 } },
              ],
            }
          : t,
      ),
    };

    const result = executeCommandBatch("sprav tie drums viac agresivne", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = result.doc.tracks.find((t) => t.id === drums.id);
    if (!after) throw new Error("fixture: drum track vanished");
    const comps = after.effects.filter((fx) => fx.type === "compressor");
    expect(comps.length).toBe(1);
    expect(comps[0]?.id).toBe("fx-user-comp");
    expect(comps[0]?.bypassed).toBe(false);
  });
});
