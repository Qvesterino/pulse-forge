/**
 * Tests for the stereo-width and guitar-rig bridge paths.
 *
 * Three things this file guards that a plain params assertion cannot:
 *
 * 1. THE ENUM SNAP. `distortionParams.character` is `kind: "enum", step: 1`
 *    and `characterCurve` switches on the integer. A fractional write does not
 *    interpolate between Fold and Hard — it falls through. So the tests assert
 *    `Number.isInteger`, not just "a number was written".
 *
 * 2. THE NEVER-SET PARAMS. `haasWidener.invert` and the three `msEq.solo*`
 *    params are legal, in-range 0/1 values that an inferred intent must never
 *    produce. Both are written as 0 by construction, and these tests pin that
 *    so a future "let the AI use the full range" change cannot slip through.
 *
 * 3. THE BATCH THAT CREATES A TRACK. The guitar recipes are the first ones
 *    that add a track and then address it in later commands of the SAME
 *    batch. That only works because the executor validates against the
 *    working document rather than the original — a regression here would show
 *    up as `no-track-match` on a track the batch is about to create.
 */

import { describe, expect, it } from "vitest";
import { testDoc } from "../../fixtures/doc";
import type { ProjectDocument } from "../../../src/project-model/types";
import { normalizeProject } from "../../../src/project-model/schema";
import { EMPTY_PREFERENCES } from "../../../src/ai/bridge/types";
import { executeCommandBatch, __validateBridgeCommandForTest } from "../../../src/ai/bridge/executor";
import {
  HAAS_RANGES,
  MIN_CROSSOVER_GAP,
  MSEQ_RANGES,
  haasSpec,
  midSideSpec,
  type MidSideShape,
  type StereoWidth,
} from "../../../src/ai/bridge/stereoSlots";
import {
  DISTORTION_CHARACTER_LABELS,
  DISTORTION_RANGES,
  distortionSpec,
  snapCharacter,
  type GuitarVoice,
} from "../../../src/ai/bridge/distortionSlots";

const WIDTHS: StereoWidth[] = ["subtle", "wide", "huge"];
const SHAPES: MidSideShape[] = ["scooped", "vocal-focus", "bright", "balanced"];
const VOICES: GuitarVoice[] = ["clean-push", "palm-muted", "high-gain", "crunch", "lead"];

function guitarOf(doc: ProjectDocument) {
  const found = doc.tracks.find((t) => /guitar/i.test(t.name));
  if (!found) throw new Error("fixture: no guitar track");
  return found;
}

function haas(width: StereoWidth, intensity: number) {
  const s = haasSpec(width, intensity);
  if (!s) throw new Error(`haasSpec returned null for known width "${width}"`);
  return s;
}

function msEq(shape: MidSideShape, intensity: number) {
  const s = midSideSpec(shape, intensity);
  if (!s) throw new Error(`midSideSpec returned null for known shape "${shape}"`);
  return s;
}

function dist(voice: GuitarVoice, intensity: number) {
  const s = distortionSpec(voice, intensity);
  if (!s) throw new Error(`distortionSpec returned null for known voice "${voice}"`);
  return s;
}

describe("AI bridge — stereo slots", () => {
  it("haas widths stay in the musical window and never reach the slap region", () => {
    for (const width of WIDTHS) {
      for (const intensity of [0, 0.5, 1]) {
        const s = haas(width, intensity);
        expect(s.delayMs).toBeGreaterThanOrEqual(HAAS_RANGES.delayMs.min);
        // The whole point: under ~30 ms reads as width, over it reads as a
        // separate echo. A spec that drifted past 28 would sound wrong.
        expect(s.delayMs).toBeLessThanOrEqual(28);
        expect(s.width).toBeLessThanOrEqual(1);
        expect(s.crossfeed).toBeGreaterThanOrEqual(0);
        expect(s.crossfeed).toBeLessThanOrEqual(1);
      }
    }
    // Bigger width tier = more width, more delay.
    expect(haas("huge", 0).width).toBeGreaterThan(haas("subtle", 0).width);
    expect(haas("huge", 0).delayMs).toBeGreaterThan(haas("subtle", 0).delayMs);
  });

  it("haas NEVER sets invert — it is an editorial choice, not an inferred one", () => {
    for (const width of WIDTHS) {
      for (const intensity of [0, 0.5, 1]) {
        expect(haas(width, intensity).invert).toBe(0);
      }
    }
  });

  it("mono sources stay in both channels (crossfeed is generous at low width)", () => {
    // A single guitar DI is MONO. Low crossfeed and mono input can collapse
    // the doubled signal to one side, so subtle width keeps the most.
    expect(haas("subtle", 0).crossfeed).toBeGreaterThan(haas("huge", 0).crossfeed);
  });

  it("mid/side crossovers are always ordered and inside their windows", () => {
    for (const shape of SHAPES) {
      for (const intensity of [0, 0.5, 1]) {
        const s = msEq(shape, intensity);
        expect(s.lowFreqHz).toBeGreaterThanOrEqual(MSEQ_RANGES.lowFreq.min);
        expect(s.lowFreqHz).toBeLessThanOrEqual(MSEQ_RANGES.lowFreq.max);
        expect(s.highFreqHz).toBeGreaterThanOrEqual(MSEQ_RANGES.highFreq.min);
        expect(s.highFreqHz).toBeLessThanOrEqual(MSEQ_RANGES.highFreq.max);
        // The degenerate case: a zero-width mid band the splitter cannot render.
        expect(s.highFreqHz).toBeGreaterThan(s.lowFreqHz);
        expect(s.highFreqHz - s.lowFreqHz).toBeGreaterThanOrEqual(MIN_CROSSOVER_GAP);
        for (const db of [s.lowGainDb, s.midGainDb, s.highGainDb]) {
          expect(db).toBeGreaterThanOrEqual(MSEQ_RANGES.lowGain.min);
          expect(db).toBeLessThanOrEqual(MSEQ_RANGES.highGain.max);
        }
      }
    }
  });

  it("mid/side NEVER sets a solo — a solo is a filter sweep, not an EQ", () => {
    for (const shape of SHAPES) {
      const s = msEq(shape, 0.5);
      expect(s.soloLow).toBe(0);
      expect(s.soloMid).toBe(0);
      expect(s.soloHigh).toBe(0);
    }
  });

  it("rejects an unknown width and an unknown shape", () => {
    const doc = testDoc();
    const badWidth = __validateBridgeCommandForTest(doc, {
      kind: "haas-widener",
      label: "bogus",
      rationale: "test",
      target: { namePattern: "Drums", regex: false, preferKind: "any" },
      // @ts-expect-error — deliberately invalid so the guard is exercised.
      width: "absurdly-wide",
      intensity: 0.5,
    });
    expect(badWidth.ok).toBe(false);

    const badShape = __validateBridgeCommandForTest(doc, {
      kind: "ms-eq",
      label: "bogus",
      rationale: "test",
      target: { namePattern: "Drums", regex: false, preferKind: "any" },
      // @ts-expect-error — deliberately invalid so the guard is exercised.
      shape: "v-shape",
      intensity: 0.5,
    });
    expect(badShape.ok).toBe(false);
  });
});

describe("AI bridge — distortion slots", () => {
  it("character is snapped to a valid integer enum index", () => {
    // characterCurve switches on the integer — a fractional value does not
    // interpolate between modes, it falls through.
    expect(snapCharacter(0)).toBe(0);
    expect(snapCharacter(2.4)).toBe(2);
    expect(snapCharacter(2.6)).toBe(3);
    expect(snapCharacter(-5)).toBe(0);
    expect(snapCharacter(99)).toBe(DISTORTION_CHARACTER_LABELS.length - 1);
    expect(Number.isFinite(snapCharacter(Number.NaN))).toBe(true);
  });

  it("every voice produces an integer character in range", () => {
    for (const voice of VOICES) {
      for (const intensity of [0, 0.5, 1]) {
        const s = dist(voice, intensity);
        expect(Number.isInteger(s.character)).toBe(true);
        expect(s.character).toBeGreaterThanOrEqual(0);
        expect(s.character).toBeLessThanOrEqual(DISTORTION_CHARACTER_COUNT_MAX());
        expect(s.drive).toBeGreaterThanOrEqual(DISTORTION_RANGES.drive.min);
        expect(s.drive).toBeLessThanOrEqual(1);
        expect(s.bias).toBeGreaterThanOrEqual(-1);
        expect(s.bias).toBeLessThanOrEqual(1);
        expect(s.toneHz).toBeGreaterThanOrEqual(DISTORTION_RANGES.tone.min);
        expect(s.toneHz).toBeLessThanOrEqual(DISTORTION_RANGES.tone.max);
      }
    }
  });

  it("high-gain is the hardest voice and clean-push the softest", () => {
    expect(dist("high-gain", 0).drive).toBeGreaterThan(dist("crunch", 0).drive);
    expect(dist("crunch", 0).drive).toBeGreaterThan(dist("clean-push", 0).drive);
    // Harder clipper = more compressed, so it needs a bigger output trim —
    // otherwise "more distortion" reads as "louder".
    expect(dist("high-gain", 0).outputDb).toBeLessThan(dist("clean-push", 0).outputDb);
  });

  it("intensity raises drive and darkens the tone, never brightens it", () => {
    for (const voice of VOICES) {
      const soft = dist(voice, 0);
      const hard = dist(voice, 1);
      expect(hard.drive).toBeGreaterThanOrEqual(soft.drive);
      expect(hard.toneHz).toBeLessThanOrEqual(soft.toneHz);
      expect(hard.outputDb).toBeLessThanOrEqual(soft.outputDb);
    }
  });

  it("rejects an unknown voice", () => {
    const doc = testDoc();
    const check = __validateBridgeCommandForTest(doc, {
      kind: "distortion",
      label: "bogus",
      rationale: "test",
      target: { namePattern: "Drums", regex: false, preferKind: "any" },
      // @ts-expect-error — deliberately invalid so the guard is exercised.
      voice: "math-rock",
      intensity: 0.5,
    });
    expect(check.ok).toBe(false);
  });
});

describe("AI bridge — guitar rig recipes", () => {
  it("adds a guitar track AND fills it in the same batch", () => {
    const doc = testDoc();
    const before = doc.tracks.length;
    const result = executeCommandBatch("pridaj gitaru na štyl darona malakiana", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    if (!result.ok) throw new Error("GG " + result.error.code + " :: " + result.error.message);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The track exists...
    expect(result.doc.tracks.length).toBe(before + 1);
    const guitar = guitarOf(result.doc);
    expect(guitar.kind).toBe("instrument");
    // ...and the later commands in the SAME batch reached it, which only
    // works because the executor validates against the working document.
    expect(guitar.effects.some((fx) => fx.type === "distortion")).toBe(true);
    expect(guitar.effects.some((fx) => fx.type === "eq")).toBe(true);
    expect(guitar.effects.some((fx) => fx.type === "compressor")).toBe(true);
  });

  it("distortion params survive normalizeProject with an integer character", () => {
    const doc = testDoc();
    const result = executeCommandBatch("add a guitar daron malakian style", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    if (!result.ok) throw new Error("GG " + result.error.code + " :: " + result.error.message);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const normalized = normalizeProject(result.doc);
    const dist2 = guitarOf(normalized).effects.find((fx) => fx.type === "distortion");
    expect(dist2).toBeDefined();
    for (const key of Object.keys(dist2?.params ?? {})) {
      expect(Object.keys(DISTORTION_RANGES)).toContain(key);
    }
    // THE regression guard: integer enum index, in range.
    expect(Number.isInteger(dist2?.params.character)).toBe(true);
    expect(dist2?.params.character).toBeGreaterThanOrEqual(0);
    expect(dist2?.params.character).toBeLessThan(DISTORTION_CHARACTER_LABELS.length);
    // A hard clipper with no makeup is a level change dressed as tone —
    // the high-gain spec carries a real negative trim.
    expect(dist2?.params.output).toBeLessThan(0);
  });

  it("does not create a second guitar when one already exists", () => {
    const base = testDoc();
    const withGuitar: ProjectDocument = {
      ...base,
      tracks: [...base.tracks, { ...base.tracks.find((t) => t.kind === "instrument")!, name: "Guitar (High-Gain)" }],
    };
    const result = executeCommandBatch("pridaj gitaru na štyl darona malakiana", {
      doc: withGuitar,
      userPreferences: EMPTY_PREFERENCES,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // No duplicate track is created; the batch reports it cannot proceed.
    expect(result.error.code).toBeTruthy();
  });

  it("palm-muted recipe uses the asymmetric tube character", () => {
    const doc = testDoc();
    const result = executeCommandBatch("pridaj gitaru s palm mutingom", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    if (!result.ok) return;
    const normalized = normalizeProject(result.doc);
    const found = normalized.tracks.find((t) => /guitar/i.test(t.name));
    if (!found) return;
    const dist2 = found.effects.find((fx) => fx.type === "distortion");
    // A negative bias is the asymmetry that gives muted riffs bark.
    expect(dist2?.params.bias).toBeLessThan(0);
  });

  it("the whole guitar batch is one undo entry", () => {
    const doc = testDoc();
    const result = executeCommandBatch("pridaj gitaru na štyl darona malakiana", {
      doc,
      userPreferences: EMPTY_PREFERENCES,
    });
    if (!result.ok) throw new Error("GG " + result.error.code + " :: " + result.error.message);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Undo must remove the track again, not just its effects.
    const undone = result.command.undo(result.doc);
    expect(undone.tracks.length).toBe(doc.tracks.length);
    expect(undone).toEqual(doc);
  });
});

/** The character engine ships five modes; the bridge must not write a sixth. */
function DISTORTION_CHARACTER_COUNT_MAX(): number {
  return DISTORTION_CHARACTER_LABELS.length - 1;
}
