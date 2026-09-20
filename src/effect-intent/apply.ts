import type { Command } from "../commands/types";
import { snapshot } from "../commands/commands";
import { targetEffectsOf, targetOwner } from "../project-model/targets";
import type { EffectInstance, ProjectDocument, ReturnTrack, Track } from "../project-model/types";
import { EFFECT_DEFS, clampEffectParam } from "../effects/registry";
import { canonicalEffectIntentJson } from "./canonical";
import { effectParameterSchemaFingerprint } from "./catalog";
import { effectIntentTargetStateHash, planEffectIntent } from "./planner";
import type { EffectChangeProposal } from "./types";

function locateEffect(doc: ProjectDocument, proposal: EffectChangeProposal): EffectInstance | undefined {
  return targetEffectsOf(doc, proposal.target.trackId).find((effect) => effect.id === proposal.target.fxId);
}

function replaceOwnerEffects<T extends Track | ReturnTrack>(owner: T, fxId: string, params: Record<string, number>): T {
  return {
    ...owner,
    effects: owner.effects.map((effect) => (effect.id === fxId ? { ...effect, params: { ...params } } : effect)),
  } as T;
}

function withEffectParams(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  params: Record<string, number>,
): ProjectDocument {
  const owner = targetOwner(doc, trackId);
  if (!owner) throw new Error("Effect proposal target no longer exists");
  if (doc.tracks.some((track) => track.id === trackId)) {
    return {
      ...doc,
      tracks: doc.tracks.map((track) => (track.id === trackId ? replaceOwnerEffects(track, fxId, params) : track)),
    };
  }
  return {
    ...doc,
    returns: doc.returns.map((ret) => (ret.id === trackId ? replaceOwnerEffects(ret, fxId, params) : ret)),
  };
}

function applyProposalToDocument(
  doc: ProjectDocument,
  proposal: EffectChangeProposal,
  selectedParamIds?: readonly string[],
): ProjectDocument {
  const effect = locateEffect(doc, proposal);
  if (!effect) throw new Error("Effect proposal target no longer exists");
  if (effect.type !== proposal.target.effectType) throw new Error("Effect proposal target type changed");
  if (effectParameterSchemaFingerprint(effect) !== proposal.targetSchemaId) {
    throw new Error("Effect proposal target schema is stale; regenerate it from the current device schema");
  }
  if (effectIntentTargetStateHash(effect) !== proposal.baseStateHash)
    throw new Error("Effect proposal is stale; regenerate it from the current device state");
  if (proposal.changes.length === 0) throw new Error("Effect proposal has no parameter changes");

  // Proposals are data, not authority. Re-run the deterministic planner from
  // the canonical intent and require an exact match so a future AI provider
  // cannot smuggle arbitrary parameter values through the apply boundary.
  const expected = planEffectIntent(doc, proposal.target, proposal.intent);
  if (
    expected.status !== "ready" ||
    canonicalEffectIntentJson(expected.proposal) !== canonicalEffectIntentJson(proposal)
  ) {
    throw new Error("Effect proposal does not match the validated deterministic plan");
  }

  const expectedIds = new Set(expected.proposal.changes.map((change) => change.paramId));
  const requestedIds = selectedParamIds ?? proposal.changes.map((change) => change.paramId);
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
    throw new Error("Effect proposal must include at least one selected parameter");
  }
  const selectedIds = new Set<string>();
  for (const paramId of requestedIds) {
    if (typeof paramId !== "string" || !expectedIds.has(paramId)) {
      throw new Error(`Unsupported parameter selection in effect proposal: ${String(paramId)}`);
    }
    if (selectedIds.has(paramId)) throw new Error(`Duplicate parameter selection in effect proposal: ${paramId}`);
    selectedIds.add(paramId);
  }

  const nextParams = { ...effect.params };
  const changedIds = new Set<string>();
  for (const change of proposal.changes) {
    if (!selectedIds.has(change.paramId)) continue;
    if (changedIds.has(change.paramId)) throw new Error(`Duplicate parameter in effect proposal: ${change.paramId}`);
    changedIds.add(change.paramId);
    const def = EFFECT_DEFS[effect.type].params.find((param) => param.id === change.paramId);
    if (!def) throw new Error(`Unsupported effect parameter in proposal: ${change.paramId}`);
    const current = effect.params[change.paramId] ?? def.default;
    if (current !== change.before) throw new Error(`Effect proposal is stale at parameter ${change.paramId}`);
    if (change.after === change.before)
      throw new Error(`Effect proposal contains a no-op change for ${change.paramId}`);
    if (!Number.isFinite(change.after)) throw new Error(`Invalid non-finite proposal value for ${change.paramId}`);
    const clamped = clampEffectParam(effect.type, change.paramId, change.after);
    if (clamped !== change.after)
      throw new Error(`Proposal value for ${change.paramId} is outside the effect's valid range`);
    nextParams[change.paramId] = change.after;
  }

  const next = withEffectParams(doc, proposal.target.trackId, proposal.target.fxId, nextParams);
  if (next === doc) return doc;
  return next;
}

/** Build one stale-guarded, undoable command for the approved proposal. */
export function applyEffectIntentProposal(
  doc: ProjectDocument,
  proposal: EffectChangeProposal,
  selectedParamIds?: readonly string[],
): Command {
  // Validate eagerly for a useful error at the caller boundary.
  const selection = selectedParamIds ? [...selectedParamIds] : undefined;
  const next = applyProposalToDocument(doc, proposal, selection);
  if (next === doc)
    return {
      type: "applyEffectIntentProposal",
      label: "Apply FX intent",
      execute: (current) => current,
      undo: (current) => current,
    };
  const selectedCount = selection?.length ?? proposal.changes.length;
  const suffix =
    selectedCount < proposal.changes.length ? ` (${selectedCount} z ${proposal.changes.length} parametrov)` : "";
  const delta = snapshot("applyEffectIntentProposal", `FX intent: ${proposal.summary}${suffix}`, doc, next);
  return {
    ...delta,
    execute: (current) => {
      // ProjectStore and YDocStore both invoke execute synchronously with the
      // current document. Re-check there too so a delayed command cannot land
      // on a newer target state.
      const validated = applyProposalToDocument(current, proposal, selection);
      if (validated === current) return current;
      return delta.execute(current);
    },
  };
}
