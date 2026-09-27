import type { Command } from "../commands/types";
import { addEffect, setBeatManglerSteps, setEffectParam, snapshot, trackEffectsOf } from "../commands/commands";
import { auditionDoc as makeAuditionDoc } from "./audition";
import { sceneRoleOf } from "../project-model/schema";
import { BAR_TICKS, STEP_TICKS, type ProjectDocument, type SceneRole } from "../project-model/types";
import { uid } from "../shared/ids";
import { planProductionActions, type ProductionAction, type ProductionIntent } from "./production";

export type SectionProductionOutcome =
  | {
      ok: true;
      command: Command;
      previewDoc: ProjectDocument;
      auditionDoc: ProjectDocument;
      pattern: ProjectDocument["patterns"][number];
      label: string;
    }
  | { ok: false; error: string };

function externallyModulated(doc: ProjectDocument, fxId: string): boolean {
  const targetsFx = (target: { fxId?: string } | undefined): boolean => target?.fxId === fxId;
  return (
    (doc.automation ?? []).some((lane) => targetsFx(lane.target)) ||
    (doc.lfos ?? []).some((lfo) => targetsFx(lfo.target)) ||
    (doc.macros ?? []).some((macro) => macro.mappings.some((mapping) => targetsFx(mapping.target))) ||
    (doc.midi?.ccMappings ?? []).some((mapping) => targetsFx(mapping.target)) ||
    targetsFx(doc.midi?.aftertouchTarget)
  );
}

/**
 * Reuse only an already isolated scene-FX instance. Its sole scene-automation
 * ownership must be this scene's wet/dry lane, so retuning it cannot alter
 * another section or a global/user modulation route.
 */
function isolatedEffectForScene(
  doc: ProjectDocument,
  action: ProductionAction,
  sceneId: string,
): { fxId: string; laneId: string } | null {
  for (const effect of trackEffectsOf(doc, action.trackId)) {
    if (effect.type !== action.type || effect.params.mix !== 0 || externallyModulated(doc, effect.id)) continue;
    const lanes = (doc.sceneAutomation ?? []).filter((lane) => lane.target.fxId === effect.id);
    if (
      lanes.length !== 1 ||
      lanes[0]?.sceneId !== sceneId ||
      lanes[0]?.target.kind !== "fxParam" ||
      lanes[0]?.target.trackId !== action.trackId ||
      lanes[0]?.target.paramId !== "mix"
    ) {
      continue;
    }
    return { fxId: effect.id, laneId: lanes[0].id };
  }
  return null;
}

/**
 * Build an audition-first, scene-local production edit. The new effect is
 * dry by default and becomes wet only inside the selected scene, preserving
 * existing track processing and global mix everywhere else.
 */
export function reviseSectionProduction(
  doc: ProjectDocument,
  targetRole: SceneRole,
  intent: ProductionIntent,
): SectionProductionOutcome {
  const sceneInPlaybackOrder = (doc.arrangement.clips ?? [])
    .slice()
    .sort((a, b) => a.startBar - b.startBar)
    .map((clip) => doc.scenes.find((candidate) => candidate.id === clip.sceneId))
    .find((candidate) => candidate && sceneRoleOf(candidate) === targetRole);
  const scene = sceneInPlaybackOrder;
  if (!scene) {
    const exists = doc.scenes.some((candidate) => sceneRoleOf(candidate) === targetRole);
    return {
      ok: false,
      error: exists
        ? `no arranged ${targetRole} section to audition`
        : `no ${targetRole} section in the project — build a song first`,
    };
  }
  const pattern = doc.patterns.find((candidate) => candidate.id === scene.patternId);
  if (!pattern) return { ok: false, error: `${scene.name} has no pattern` };

  try {
    const { actions, padAdjustments, plan } = planProductionActions(doc, intent);
    if (padAdjustments && padAdjustments.length > 0) {
      return {
        ok: false,
        error: "This production request changes pad gain globally and cannot be isolated to one scene",
      };
    }
    if (actions.length === 0 || actions.some((action) => typeof action.params.mix !== "number")) {
      return { ok: false, error: "This effect cannot be safely gated to a single scene" };
    }

    let next = doc;
    const nextSceneAutomation = [...(doc.sceneAutomation ?? [])];
    const auditionMixByFx = new Map<string, { trackId: string; mix: number }>();
    const clipBars = (doc.arrangement.clips ?? [])
      .filter((clip) => clip.sceneId === scene.id)
      .reduce((max, clip) => Math.max(max, clip.lengthBars), 0);
    const sectionEndTick = Math.max(pattern.stepCount * STEP_TICKS, clipBars * BAR_TICKS, STEP_TICKS);

    for (const action of actions) {
      const reusable = isolatedEffectForScene(next, action, scene.id);
      let fxId = reusable?.fxId;
      if (!fxId) {
        const add = addEffect(next, action.trackId, action.type);
        next = add.execute(next);
        fxId = add.effectId;
      }

      for (const [paramId, value] of Object.entries(action.params)) {
        if (paramId === "mix") continue;
        next = setEffectParam(next, action.trackId, fxId, paramId, value).execute(next);
      }
      if (action.volumeSteps || action.pitchSteps) {
        next = setBeatManglerSteps(next, action.trackId, fxId, {
          volume: action.volumeSteps,
          pitch: action.pitchSteps,
        }).execute(next);
      }
      next = setEffectParam(next, action.trackId, fxId, "mix", 0).execute(next);
      auditionMixByFx.set(fxId, { trackId: action.trackId, mix: action.params.mix });

      const points = [
        { tick: 0, value: action.params.mix },
        { tick: sectionEndTick, value: action.params.mix },
      ];
      if (reusable) {
        nextSceneAutomation.splice(
          nextSceneAutomation.findIndex((lane) => lane.id === reusable.laneId),
          1,
          {
            id: reusable.laneId,
            sceneId: scene.id,
            target: { kind: "fxParam", trackId: action.trackId, fxId, paramId: "mix" },
            points,
          },
        );
      } else {
        nextSceneAutomation.push({
          id: uid("sceneAuto"),
          sceneId: scene.id,
          target: { kind: "fxParam", trackId: action.trackId, fxId, paramId: "mix" },
          points,
        });
      }
    }

    const previewDoc = { ...next, sceneAutomation: nextSceneAutomation };
    const auditionBase = makeAuditionDoc(
      { ...previewDoc, patterns: previewDoc.patterns.filter((candidate) => candidate.id !== pattern.id) },
      pattern,
    );
    const auditionDoc = [...auditionMixByFx].reduce(
      (draft, [fxId, { trackId, mix }]) => setEffectParam(draft, trackId, fxId, "mix", mix).execute(draft),
      auditionBase,
    );
    const label = `${scene.name}: ${plan.summary}`;
    const command = snapshot("applySectionProduction", label, doc, previewDoc);
    return { ok: true, command, previewDoc, auditionDoc, pattern, label };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
