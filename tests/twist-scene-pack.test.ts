import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { defaultParamsOf } from "../src/effects/registry";
import { EFFECT_META, clampEffectParam } from "../src/effects/definitions";
import { TWIST_CURVE_PARAM_IDS } from "../src/effects/skrutka-curves";
import {
  TWIST_SCENE_PACK,
  findTwistScenePair,
  twistSceneSlots,
  type TwistScenePair,
} from "../src/effects/skrutka-scene-pack";
import { applyTwistScenePair, twistMorphIntensityBound } from "../src/commands/twistScene";
import type { EffectInstance } from "../src/project-model/types";

/**
 * TWIST SCENE PACK (v2.5) — the A/B pairs and the one-command apply.
 *
 * The pack pairs must stay inside the rack parameter ranges (a pair is
 * written into deviceState and then morphed; an out-of-range value would be
 * clamped silently and the pair would lie about its sound), the A/B sides
 * must actually differ, and the apply command must land the snapshots, the
 * neutral MORPH base and exactly ONE scene-intensity binding — idempotently,
 * and undoable as a single step.
 */

function docWithTwist(): { doc: ReturnType<typeof testDoc>; trackId: string; fxId: string } {
  const doc = testDoc();
  const drum = doc.tracks.find((candidate) => candidate.kind === "drum")!;
  const fx: EffectInstance = {
    id: "fx-twist",
    type: "skrutka",
    bypassed: false,
    params: defaultParamsOf("skrutka"),
  };
  drum.effects = [fx];
  return { doc, trackId: drum.id, fxId: fx.id };
}

describe("TWIST scene pack — data", () => {
  it("ships unique, described pairs that only touch morphable params", () => {
    const ids = new Set<string>();
    for (const pair of TWIST_SCENE_PACK) {
      expect(ids.has(pair.id), `duplicate pair id ${pair.id}`).toBe(false);
      ids.add(pair.id);
      expect(pair.genre.length).toBeGreaterThan(0);
      expect(pair.label.length).toBeGreaterThan(0);
      expect(pair.description.length).toBeGreaterThan(20);
      for (const side of [pair.a, pair.b]) {
        for (const [paramId, value] of Object.entries(side)) {
          expect(TWIST_CURVE_PARAM_IDS, `${pair.id}.${paramId} is morphable`).toContain(paramId);
          const def = EFFECT_META.skrutka.params.find((param) => param.id === paramId)!;
          expect(def, `${pair.id}.${paramId} exists`).toBeDefined();
          expect(value, `${pair.id}.${paramId} within range`).toBeGreaterThanOrEqual(def.min);
          expect(value, `${pair.id}.${paramId} within range`).toBeLessThanOrEqual(def.max);
          expect(clampEffectParam("skrutka", paramId, value), `${pair.id}.${paramId} unclamped`).toBe(value);
        }
      }
    }
  });

  it("each pair's A and B differ in at least two parameters", () => {
    for (const pair of TWIST_SCENE_PACK) {
      let differing = 0;
      for (const id of TWIST_CURVE_PARAM_IDS) {
        const a = pair.a[id];
        const b = pair.b[id];
        if (a === undefined && b === undefined) continue;
        if (a !== b) differing++;
      }
      expect(differing, `${pair.id} A/B contrast`).toBeGreaterThanOrEqual(2);
    }
  });

  it("findTwistScenePair matches exact slots and declines anything else", () => {
    const pair = TWIST_SCENE_PACK[0]!;
    expect(findTwistScenePair(twistSceneSlots(pair))?.id).toBe(pair.id);
    const tweaked = twistSceneSlots(pair);
    tweaked.A.dispersion = (tweaked.A.dispersion ?? 0) + 0.05;
    expect(findTwistScenePair(tweaked)).toBeNull();
    expect(findTwistScenePair({ A: pair.a })).toBeNull();
    expect(findTwistScenePair(undefined)).toBeNull();
  });
});

describe("TWIST scene pack — apply command", () => {
  const pair: TwistScenePair = TWIST_SCENE_PACK.find((candidate) => candidate.id === "house-tight-liquid")!;

  it("stores both snapshots, sets the midpoint MORPH and binds intensity in ONE command", () => {
    const { doc, trackId, fxId } = docWithTwist();
    const command = applyTwistScenePair(doc, trackId, fxId, pair);
    const after = command.execute(doc);
    const fx = after.tracks.find((track) => track.id === trackId)!.effects.find((effect) => effect.id === fxId)!;
    expect(fx.deviceState?.kind).toBe("twist-curves-v1");
    const slots = fx.deviceState!.data.slots as Record<string, Record<string, number>>;
    expect(slots.A?.focusHz).toBe(pair.a.focusHz);
    expect(slots.B?.focusHz).toBe(pair.b.focusHz);
    expect(fx.params.morph).toBe(0.5);
    expect(twistMorphIntensityBound(after, trackId, fxId)).toBe(true);
    // Exactly one TWIST macro, one mapping, amount 1 (full 0..1 swing).
    const twistMacros = after.macros.filter((macro) => macro.name === "TWIST");
    expect(twistMacros).toHaveLength(1);
    const mapping = twistMacros[0]!.mappings.find((candidate) => candidate.target?.paramId === "morph");
    expect(mapping?.source).toBe("intensity");
    expect(mapping?.amount).toBe(1);
    // Undo restores the pre-apply document surface.
    const back = command.undo(after);
    const fxBack = back.tracks.find((track) => track.id === trackId)!.effects.find((effect) => effect.id === fxId)!;
    expect(fxBack.deviceState).toBeUndefined();
    expect(fxBack.params.morph).toBe(0);
    expect(twistMorphIntensityBound(back, trackId, fxId)).toBe(false);
    expect(back.macros).toHaveLength(doc.macros.length);
  });

  it("is idempotent across pair switches: the intensity binding never duplicates", () => {
    const { doc, trackId, fxId } = docWithTwist();
    const first = applyTwistScenePair(doc, trackId, fxId, pair).execute(doc);
    const secondPair = TWIST_SCENE_PACK.find((candidate) => candidate.id === "trap-center-shimmer")!;
    const second = applyTwistScenePair(first, trackId, fxId, secondPair).execute(first);
    const twistMacros = second.macros.filter((macro) => macro.name === "TWIST");
    expect(twistMacros).toHaveLength(1);
    expect(twistMacros[0]!.mappings.filter((mapping) => mapping.target?.paramId === "morph")).toHaveLength(1);
    const fx = second.tracks.find((track) => track.id === trackId)!.effects.find((effect) => effect.id === fxId)!;
    const slots = fx.deviceState!.data.slots as Record<string, Record<string, number>>;
    expect(slots.A?.field).toBe(secondPair.a.field);
    expect(slots.B?.field).toBe(secondPair.b.field);
  });

  it("refuses non-TWIST effects", () => {
    const { doc, trackId } = docWithTwist();
    const drum = doc.tracks.find((track) => track.id === trackId)!;
    drum.effects = [{ id: "fx-eq", type: "eq", bypassed: false, params: {} }];
    expect(() => applyTwistScenePair(doc, trackId, "fx-eq", pair)).toThrow(/not TWIST/);
  });
});
