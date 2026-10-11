import type { Command } from "./types";
import type { MacroMapping, ProjectDocument } from "../project-model/types";
import { EFFECT_META, clampEffectParam } from "../effects/definitions";
import { KOREN_SCENE_KIND } from "../effects/koren-scene";
// Type-only: the pack DATA stays in the lazy panel chunk — the eager command
// barrel must not drag the whole scene pack into the boot graph.
import type { KorenScenePair } from "../effects/koren-scene-pack";
import { sanitizeDeviceState } from "../project-model/schema";
import { trackEffectsOf, withTrackEffects } from "./docOps";
import { snapshot } from "./core";
import { uid } from "../shared/ids";

/**
 * GROW SCENE PACK — apply a curated A/B pair as ONE undoable command.
 *
 * GROW has no DSP-side morph scalar (unlike TWIST), so the pair materializes
 * through the engine's own modulation law: every differing param gets the
 * MIDPOINT written as its live base plus an intensity-sourced mapping with
 * `amount = (b − a) / (max − min)`. The engine applies an intensity fxParam
 * mapping as an offset of `(max − min)/2 · bipolar · amount` around the base
 * (`bipolar = intensity·2 − 1`), so intensity 0 resolves exactly to side A
 * and intensity 1 exactly to side B. Stepped ids (CHARACTER, RANGE, RETRIG)
 * switch at their rounding boundary mid-swing — the DSP rounds.
 *
 * The command owns the effect's scene-intensity binding: any pre-existing
 * intensity mapping that targets this effect is rewritten (never stacked —
 * two offset mappings to the same param would double the swing), while
 * macro-sourced mappings are left untouched. The binding is idempotent:
 * re-applying a pair (or switching pairs) never duplicates anything.
 */

export const KOREN_SCENE_MACRO_NAME = "GROW";

/** True when this effect already rides the scene intensity. */
export function korenSceneIntensityBound(doc: ProjectDocument, trackId: string, fxId: string): boolean {
  return doc.macros.some((macro) =>
    macro.mappings.some(
      (mapping) =>
        mapping.source === "intensity" &&
        mapping.target?.kind === "fxParam" &&
        mapping.target.trackId === trackId &&
        mapping.target.fxId === fxId,
    ),
  );
}

export function applyKorenScenePair(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  pair: KorenScenePair,
): Command {
  const fx = trackEffectsOf(doc, trackId).find((candidate) => candidate.id === fxId);
  if (!fx) throw new Error(`Effect ${fxId} not found`);
  if (fx.type !== "bassHarmonic") throw new Error(`Effect ${fxId} is not GROW`);
  const state = sanitizeDeviceState({
    kind: KOREN_SCENE_KIND,
    data: { slots: { A: { ...pair.a }, B: { ...pair.b } } },
  });
  if (!state) throw new Error(`Invalid GROW scene pair ${pair.id}`);

  // Base = midpoint, amount = (b − a)/span: the engine's symmetric offset law
  // then lands side A at intensity 0 and side B at intensity 1 exactly.
  const bases: Record<string, number> = {};
  const bindings: MacroMapping[] = [];
  for (const id of new Set([...Object.keys(pair.a), ...Object.keys(pair.b)])) {
    const def = EFFECT_META.bassHarmonic.params.find((param) => param.id === id);
    if (!def || def.max === def.min) continue;
    const a = clampEffectParam("bassHarmonic", id, pair.a[id] ?? def.default);
    const b = clampEffectParam("bassHarmonic", id, pair.b[id] ?? def.default);
    bases[id] = clampEffectParam("bassHarmonic", id, (a + b) / 2);
    if (Math.abs(b - a) > 1e-6) {
      bindings.push({
        id: uid("map"),
        trackId,
        param: "fxParam",
        amount: Math.max(-1, Math.min(1, (b - a) / (def.max - def.min))),
        source: "intensity",
        target: { kind: "fxParam", trackId, fxId, paramId: id },
      });
    }
  }

  const hadBinding = korenSceneIntensityBound(doc, trackId, fxId);
  let macros = doc.macros.map((macro) => ({
    ...macro,
    mappings: macro.mappings.filter(
      (mapping) =>
        !(
          mapping.source === "intensity" &&
          mapping.target?.kind === "fxParam" &&
          mapping.target.trackId === trackId &&
          mapping.target.fxId === fxId
        ),
    ),
  }));
  if (bindings.length > 0) {
    const index = macros.findIndex((macro) => macro.name.trim().toUpperCase() === KOREN_SCENE_MACRO_NAME);
    if (index >= 0) {
      macros = macros.map((macro, i) =>
        i === index ? { ...macro, mappings: [...macro.mappings, ...bindings] } : macro,
      );
    } else {
      macros = [...macros, { id: uid("macro"), name: KOREN_SCENE_MACRO_NAME, value: 0.5, mappings: bindings }];
    }
  }

  const apply = (current: ProjectDocument): ProjectDocument => {
    const next = withTrackEffects(current, trackId, (effects) =>
      effects.map((effect) =>
        effect.id === fxId
          ? {
              ...effect,
              params: { ...effect.params, ...bases },
              deviceState: { kind: state.kind, data: { ...state.data } },
            }
          : effect,
      ),
    );
    return { ...next, macros };
  };

  const command = snapshot("applyKorenScenePair", `GROW scene: ${pair.genre} — ${pair.label}`, doc, apply(doc));
  return { ...command, detail: hadBinding ? undefined : "GROW now rides scene intensity" };
}
