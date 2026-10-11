import type { Command } from "./types";
import type { MacroMapping, ProjectDocument } from "../project-model/types";
import { clampEffectParam } from "../effects/definitions";
import { TWIST_CURVES_KIND } from "../effects/skrutka-curves";
import { twistSceneSlots, type TwistScenePair } from "../effects/skrutka-scene-pack";
import { sanitizeDeviceState } from "../project-model/schema";
import { trackEffectsOf, withTrackEffects } from "./docOps";
import { snapshot } from "./core";
import { uid } from "../shared/ids";

/**
 * TWIST SCENE PACK — apply a curated A/B pair as ONE undoable command.
 *
 * The command stores both snapshots on the effect's deviceState, sets the
 * MORPH base to the neutral midpoint and ensures the project carries the
 * scene-intensity binding: a `TWIST` macro whose intensity-sourced mapping
 * targets this effect's `morph` param.
 *
 * The engine applies an intensity fxParam mapping as an OFFSET of
 * `(max − min)/2 · bipolar · amount` around the base, so `morph = 0.5` with
 * `amount = 1` lands morph 0 at intensity 0 and morph 1 at intensity 1 —
 * intro scenes lean curve A, the drop lands curve B, with no lanes to draw.
 * The binding is idempotent: re-applying a pair (or another pair) never
 * duplicates the mapping.
 */

export const TWIST_SCENE_MACRO_NAME = "TWIST";

/** True when this effect's `morph` already rides the scene intensity. */
export function twistMorphIntensityBound(doc: ProjectDocument, trackId: string, fxId: string): boolean {
  return doc.macros.some((macro) =>
    macro.mappings.some(
      (mapping) =>
        mapping.source === "intensity" &&
        mapping.target?.kind === "fxParam" &&
        mapping.target.trackId === trackId &&
        mapping.target.fxId === fxId &&
        mapping.target.paramId === "morph",
    ),
  );
}

export function applyTwistScenePair(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  pair: TwistScenePair,
): Command {
  const fx = trackEffectsOf(doc, trackId).find((candidate) => candidate.id === fxId);
  if (!fx) throw new Error(`Effect ${fxId} not found`);
  if (fx.type !== "skrutka") throw new Error(`Effect ${fxId} is not TWIST`);
  const state = sanitizeDeviceState({ kind: TWIST_CURVES_KIND, data: { slots: twistSceneSlots(pair) } });
  if (!state) throw new Error(`Invalid TWIST scene pair ${pair.id}`);
  // The neutral midpoint: intensity [0..1] swings the base by ±(range/2).
  const morph = clampEffectParam("skrutka", "morph", 0.5);

  const hasBinding = twistMorphIntensityBound(doc, trackId, fxId);
  let macros = doc.macros;
  if (!hasBinding) {
    const mapping: MacroMapping = {
      id: uid("map"),
      trackId,
      param: "fxParam",
      amount: 1,
      source: "intensity",
      target: { kind: "fxParam", trackId, fxId, paramId: "morph" },
    };
    const index = doc.macros.findIndex((macro) => macro.name.trim().toUpperCase() === TWIST_SCENE_MACRO_NAME);
    if (index >= 0) {
      macros = doc.macros.map((macro, i) =>
        i === index ? { ...macro, mappings: [...macro.mappings, mapping] } : macro,
      );
    } else {
      macros = [...doc.macros, { id: uid("macro"), name: TWIST_SCENE_MACRO_NAME, value: 0.5, mappings: [mapping] }];
    }
  }

  const apply = (current: ProjectDocument): ProjectDocument => {
    const next = withTrackEffects(current, trackId, (effects) =>
      effects.map((effect) =>
        effect.id === fxId
          ? {
              ...effect,
              params: { ...effect.params, morph },
              deviceState: { kind: state.kind, data: { ...state.data } },
            }
          : effect,
      ),
    );
    return { ...next, macros };
  };

  const command = snapshot("applyTwistScenePair", `TWIST scene: ${pair.genre} — ${pair.label}`, doc, apply(doc));
  return { ...command, detail: hasBinding ? undefined : "MORPH now rides scene intensity" };
}
