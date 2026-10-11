import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { defaultParamsOf } from "../src/effects/registry";
import { EFFECT_META, clampEffectParam } from "../src/effects/definitions";
import { KOREN_SCENE_KIND } from "../src/effects/koren-scene";
import {
  KOREN_SCENE_PACK,
  findKorenScenePair,
  korenSceneSlots,
  type KorenScenePair,
} from "../src/effects/koren-scene-pack";
import { applyKorenScenePair, korenSceneIntensityBound } from "../src/commands/korenScene";
import { sanitizeDeviceState } from "../src/project-model/schema";
import type { EffectInstance } from "../src/project-model/types";

/**
 * GROW SCENE PACK — the A/B pairs and the one-command apply.
 *
 * The pairs must stay inside the rack parameter ranges (out-of-range values
 * would be clamped silently and the pair would lie), both sides must carry
 * the SAME param ids (the apply command derives base/amount per id from the
 * two sides), stepped ids must hold integers (their switch happens at the
 * DSP rounding boundary mid-swing, not by interpolation), and the apply must
 * land midpoint bases + exact endpoint mappings — idempotently and as ONE
 * undo step.
 */

function docWithGrow(): { doc: ReturnType<typeof testDoc>; trackId: string; fxId: string } {
  const doc = testDoc();
  const drum = doc.tracks.find((candidate) => candidate.kind === "drum")!;
  const fx: EffectInstance = {
    id: "fx-grow",
    type: "bassHarmonic",
    bypassed: false,
    params: defaultParamsOf("bassHarmonic"),
  };
  drum.effects = [fx];
  return { doc, trackId: drum.id, fxId: fx.id };
}

const STEPPED_KINDS = new Set(["enum", "discrete", "toggle"]);

describe("GROW scene pack — data", () => {
  it("ships unique, described pairs that only touch GROW params within range", () => {
    const ids = new Set<string>();
    for (const pair of KOREN_SCENE_PACK) {
      expect(ids.has(pair.id), `duplicate pair id ${pair.id}`).toBe(false);
      ids.add(pair.id);
      expect(pair.genre.length).toBeGreaterThan(0);
      expect(pair.label.length).toBeGreaterThan(0);
      expect(pair.description.length).toBeGreaterThan(20);
      for (const side of [pair.a, pair.b]) {
        for (const [paramId, value] of Object.entries(side)) {
          const def = EFFECT_META.bassHarmonic.params.find((param) => param.id === paramId);
          expect(def, `${pair.id}.${paramId} exists`).toBeDefined();
          expect(value, `${pair.id}.${paramId} within range`).toBeGreaterThanOrEqual(def!.min);
          expect(value, `${pair.id}.${paramId} within range`).toBeLessThanOrEqual(def!.max);
          expect(clampEffectParam("bassHarmonic", paramId, value), `${pair.id}.${paramId} unclamped`).toBe(value);
          if (STEPPED_KINDS.has(def!.kind ?? "")) {
            expect(Number.isInteger(value), `${pair.id}.${paramId} stepped id holds an integer`).toBe(true);
          }
        }
      }
    }
  });

  it("each pair carries the same ids on both sides and differs in at least two", () => {
    for (const pair of KOREN_SCENE_PACK) {
      const aIds = Object.keys(pair.a).sort();
      const bIds = Object.keys(pair.b).sort();
      expect(aIds, `${pair.id} A/B key parity`).toEqual(bIds);
      let differing = 0;
      for (const id of aIds) {
        if (pair.a[id] !== pair.b[id]) differing++;
      }
      expect(differing, `${pair.id} A/B contrast`).toBeGreaterThanOrEqual(2);
    }
  });

  it("findKorenScenePair matches exact slots and declines anything else", () => {
    const pair = KOREN_SCENE_PACK[0]!;
    expect(findKorenScenePair(korenSceneSlots(pair))?.id).toBe(pair.id);
    const tweaked = korenSceneSlots(pair);
    tweaked.A.drive = (tweaked.A.drive ?? 0) + 0.05;
    expect(findKorenScenePair(tweaked)).toBeNull();
    expect(findKorenScenePair({ A: pair.a })).toBeNull();
    expect(findKorenScenePair(undefined)).toBeNull();
  });

  it("sanitizeDeviceState clamps known ids and drops unknown ones", () => {
    const state = sanitizeDeviceState({
      kind: KOREN_SCENE_KIND,
      data: { slots: { A: { drive: 9, focusHz: 500, junk: 1, nan: Number.NaN }, B: null } },
    });
    expect(state).toBeDefined();
    expect(state!.kind).toBe(KOREN_SCENE_KIND);
    const slots = state!.data.slots as Record<string, Record<string, number> | undefined>;
    expect(slots.A?.drive).toBe(1);
    expect(slots.A?.focusHz).toBe(220);
    expect(slots.A?.junk).toBeUndefined();
    expect(slots.A?.nan).toBeUndefined();
    expect(slots.B).toBeUndefined();
    // Hostile blobs drop entirely.
    expect(sanitizeDeviceState({ kind: KOREN_SCENE_KIND, data: {} })).toBeUndefined();
    expect(sanitizeDeviceState({ kind: KOREN_SCENE_KIND, data: { slots: [] } })).toBeUndefined();
  });
});

describe("GROW scene pack — apply command", () => {
  const pair: KorenScenePair = KOREN_SCENE_PACK.find((candidate) => candidate.id === "drill-phone-growl")!;

  it("writes midpoint bases, exact endpoint mappings and ONE binding in ONE command", () => {
    const { doc, trackId, fxId } = docWithGrow();
    const command = applyKorenScenePair(doc, trackId, fxId, pair);
    const after = command.execute(doc);
    const fx = after.tracks.find((track) => track.id === trackId)!.effects.find((effect) => effect.id === fxId)!;
    expect(fx.deviceState?.kind).toBe("koren-scene-v1");
    const slots = fx.deviceState!.data.slots as Record<string, Record<string, number>>;
    expect(slots.A?.drive).toBe(pair.a.drive);
    expect(slots.B?.character).toBe(pair.b.character);
    expect(korenSceneIntensityBound(after, trackId, fxId)).toBe(true);

    const macros = after.macros.filter((macro) => macro.name === "GROW");
    expect(macros).toHaveLength(1);
    const mappings = macros[0]!.mappings.filter((mapping) => mapping.target?.fxId === fxId);
    const differing = Object.keys(pair.a).filter((id) => pair.a[id] !== pair.b[id]);
    expect(mappings).toHaveLength(differing.length);

    for (const id of differing) {
      const def = EFFECT_META.bassHarmonic.params.find((param) => param.id === id)!;
      const a = pair.a[id]!;
      const b = pair.b[id]!;
      const base = (a + b) / 2;
      expect(fx.params[id], `${id} base is the midpoint`).toBeCloseTo(base, 9);
      const mapping = mappings.find((candidate) => candidate.target?.paramId === id)!;
      expect(mapping.source).toBe("intensity");
      expect(mapping.amount).toBeCloseTo((b - a) / (def.max - def.min), 9);
      // The engine's offset law: base ± span/2 · amount resolves the endpoints.
      const half = ((def.max - def.min) / 2) * mapping.amount;
      expect(base - half, `${id} intensity 0 lands A`).toBeCloseTo(a, 9);
      expect(base + half, `${id} intensity 1 lands B`).toBeCloseTo(b, 9);
    }

    const back = command.undo(after);
    const fxBack = back.tracks.find((track) => track.id === trackId)!.effects.find((effect) => effect.id === fxId)!;
    expect(fxBack.deviceState).toBeUndefined();
    expect(fxBack.params.drive).toBe(defaultParamsOf("bassHarmonic").drive);
    expect(korenSceneIntensityBound(back, trackId, fxId)).toBe(false);
    expect(back.macros).toHaveLength(doc.macros.length);
  });

  it("rewrites instead of stacking across pair switches", () => {
    const { doc, trackId, fxId } = docWithGrow();
    const first = applyKorenScenePair(doc, trackId, fxId, pair).execute(doc);
    const secondPair = KOREN_SCENE_PACK.find((candidate) => candidate.id === "dnb-sub-reese")!;
    const second = applyKorenScenePair(first, trackId, fxId, secondPair).execute(first);
    const macros = second.macros.filter((macro) => macro.name === "GROW");
    expect(macros).toHaveLength(1);
    expect(macros[0]!.mappings.filter((mapping) => mapping.target?.fxId === fxId)).toHaveLength(
      Object.keys(secondPair.a).filter((id) => secondPair.a[id] !== secondPair.b[id]).length,
    );
    const fx = second.tracks.find((track) => track.id === trackId)!.effects.find((effect) => effect.id === fxId)!;
    const slots = fx.deviceState!.data.slots as Record<string, Record<string, number>>;
    expect(slots.A?.harmonics).toBe(secondPair.a.harmonics);
    expect(slots.B?.harmonics).toBe(secondPair.b.harmonics);
  });

  it("takes over a hand-made intensity mapping for the same effect", () => {
    const { doc, trackId, fxId } = docWithGrow();
    const seeded = {
      ...doc,
      macros: [
        ...doc.macros,
        {
          id: "macro-hand",
          name: "MY KNOB",
          value: 0.5,
          mappings: [
            {
              id: "map-hand",
              trackId,
              param: "fxParam",
              amount: 0.3,
              source: "intensity" as const,
              target: { kind: "fxParam" as const, trackId, fxId, paramId: "presence" },
            },
          ],
        },
      ],
    };
    const after = applyKorenScenePair(seeded, trackId, fxId, pair).execute(seeded);
    const hand = after.macros.find((macro) => macro.id === "macro-hand")!;
    expect(hand.mappings.filter((mapping) => mapping.target?.fxId === fxId)).toHaveLength(0);
    const grow = after.macros.find((macro) => macro.name === "GROW")!;
    expect(grow.mappings.filter((mapping) => mapping.target?.fxId === fxId).length).toBeGreaterThan(0);
  });

  it("refuses non-GROW effects", () => {
    const { doc, trackId } = docWithGrow();
    const drum = doc.tracks.find((track) => track.id === trackId)!;
    drum.effects = [{ id: "fx-eq", type: "eq", bypassed: false, params: {} }];
    expect(() => applyKorenScenePair(doc, trackId, "fx-eq", pair)).toThrow(/not GROW/);
  });
});
