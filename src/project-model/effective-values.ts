/**
 * The effective-value read model (audit S-5) — "the value in effect" beside
 * "the value the user set".
 *
 * The two are different numbers the moment an automation lane runs: the
 * document holds what the user committed, the DSP plays what the lane says.
 * Until now every surface read the document, so a channel could sit at 0.4
 * while the fader read 0.8 and the lane read 0.5 — no surface showed the
 * number that was actually in effect (audit F-10, §5.3 probe T4).
 *
 * This module is the ONE place that answers "what is in effect right now",
 * so a UI never re-derives the composition rule. It is pure: the document
 * plus a tick in, the effective value out.
 *
 * ## The composition rule is per DOMAIN
 *
 * This is the S-4 declaration the audit asks for, expressed where it is
 * needed rather than in a parallel registry:
 *
 * - `trackGain` — **MULTIPLY**. The lane writes its RAW value into the
 *   series `modAutoGain` stage (`automationBridge.ts:1191-1210`), and the
 *   track chain is `gain → modAutoGain → modAutoPan → modMacroGain`
 *   (`AudioEngine.ts:2016-2019`) — so the channel gain is fader × lane. The
 *   lane is a multiplier around unity 1.0 (measured: a new lane starts at
 *   the target default 1, and `automationReset()` restores 1), which is why
 *   the multiplier is the lane's value and not `1 + value`.
 * - every other target — **OVERRIDE**. The lane writes the ABSOLUTE value
 *   into the target's parameter (pan, an effect param, an instrument param),
 *   so the lane's value REPLACES the document value.
 *
 * ## What this does NOT include
 *
 * The macro stage (`modMacroGain`) and the modulator stage (`modAutoGain`
 * for a modulated target) are composed by the runtime, not by the document
 * (`automationBridge.ts:577-704`), and the runtime keeps no value snapshot the
 * UI could read. This model therefore reports the DOCUMENT + LANE composition
 * only. It never claims to be the absolute audible gain — a caller that wants
 * the macro factor has to say so.
 *
 * SCENE automation (`doc.sceneAutomation`) is a third writer to the same
 * targets: it is scene-relative, it is dispatched by the scheduler per
 * active clip window (`Scheduler.ts:1155-1163`), and it lands on the same
 * absolute writer. A project that automates a channel gain inside a SCENE
 * therefore plays a value this model does not report. Composing it needs
 * the scene-resolved playhead — a runtime fact, like the macro stage — so it
 * is named here rather than silently half-composed.
 */
import { valueAt } from "./automation";
import {
  automationTargetKey,
  canonicalizeDeprecatedTarget,
  clampTargetValue,
  targetEffectsOf,
  targetParamDef,
} from "./targets";
import { EFFECT_META } from "../effects/definitions";
import type { AutomationLane, AutomationTarget, ProjectDocument } from "./types";

/** Where an effective value comes from. */
export type EffectiveValueSource = "document" | "automation";

/** How a lane's value composes with the document value. */
export type AutomationComposition = "multiply" | "override";

export interface EffectiveValue {
  /** The value in effect at the queried tick — what the DSP plays. */
  value: number;
  /** The committed document value — what the user set. */
  documentValue: number;
  /** Which of the two is in effect. */
  source: EffectiveValueSource;
  /** TRUE when a lane overrides the document value. */
  automated: boolean;
  /**
   * The lane's value at the queried tick. For a `multiply` composition this
   * is the MULTIPLIER (1 = unity); for an `override` composition it is the
   * absolute value the lane writes. Absent when no lane is in effect.
   */
  laneValue?: number;
}

/** The composition rule for a target — see the module doc. */
export function automationComposition(target: AutomationTarget): AutomationComposition {
  return target.kind === "trackGain" ? "multiply" : "override";
}

/**
 * The deprecated alias ids that name this parameter (eq.lowMidGain is named
 * by the legacy eq.midGain).
 */
function deprecatedAliasesOf(doc: ProjectDocument, target: AutomationTarget): string[] {
  if (target.kind !== "fxParam" || !target.fxId || !target.paramId) return [];
  const effect = targetEffectsOf(doc, target.trackId).find((fx) => fx.id === target.fxId);
  if (!effect) return [];
  const meta = EFFECT_META[effect.type];
  if (!meta) return [];
  return meta.params.filter((param) => param.deprecated && param.aliasOf === target.paramId).map((param) => param.id);
}

/**
 * The lane that drives this target, if the project has one.
 *
 * `lanes` is passed in by callers that SUBSCRIBE to the lane slice — the
 * document's `automation` array changes without changing `doc.tracks`, so a
 * surface that only watched the tracks would show a stale value forever.
 */
export function automationLaneFor(
  doc: ProjectDocument,
  target: AutomationTarget,
  lanes: readonly AutomationLane[] = doc.automation,
): AutomationLane | undefined {
  const canonical = canonicalizeDeprecatedTarget(doc, target);
  const key = automationTargetKey(canonical);
  // Fast path: the lane names the canonical id.
  const direct = lanes.find((lane) => automationTargetKey(lane.target) === key);
  if (direct) return direct;
  // Legacy path: the lane names a DEPRECATED ALIAS of the canonical param
  // (eq.midGain → eq.lowMidGain). Old documents keep their lanes after an
  // alias stops being a valid target, and the value transfers 1:1 because the
  // commands already remap writes through the same pair. The alias list is
  // only computed when the direct scan missed, so the common case (no lane)
  // costs one scan.
  const aliases = deprecatedAliasesOf(doc, canonical);
  if (aliases.length === 0) return undefined;
  return lanes.find(
    (lane) =>
      lane.target.kind === "fxParam" &&
      lane.target.trackId === canonical.trackId &&
      lane.target.fxId === canonical.fxId &&
      aliases.includes(lane.target.paramId ?? ""),
  );
}

/** The committed document value for a target, or `null` when it cannot be read. */
export function documentValueFor(doc: ProjectDocument, target: AutomationTarget): number | null {
  const track = doc.tracks.find((candidate) => candidate.id === target.trackId);
  if (!track) return null;
  if (target.kind === "trackGain") return track.gain;
  if (target.kind === "trackPan") return track.pan;
  if (target.kind === "instParam") {
    if (track.kind !== "instrument" || !target.paramId) return null;
    const value = track.params[target.paramId];
    return typeof value === "number" ? value : null;
  }
  if (!target.fxId || !target.paramId || !("effects" in track)) return null;
  const effect = track.effects.find((candidate) => candidate.id === target.fxId);
  if (!effect) return null;
  const value = effect.params[target.paramId];
  return typeof value === "number" ? value : null;
}

/**
 * The value in effect for a target at a tick.
 *
 * With no lane (or an empty one) nothing overrides the document value: the
 * caller gets the document value back, with `source: "document"`.
 */
export function effectiveParamValue(
  doc: ProjectDocument,
  target: AutomationTarget,
  tick: number,
  lanes: readonly AutomationLane[] = doc.automation,
): EffectiveValue {
  // A deprecated alias resolves to its canonical id first: the document holds
  // the canonical id, so the def, the document value and the lane all have to
  // be looked up under it.
  const canonical = canonicalizeDeprecatedTarget(doc, target);
  const documentValue = documentValueFor(doc, canonical);
  const def = targetParamDef(doc, canonical);
  const lane = automationLaneFor(doc, canonical, lanes);
  const hasLane = lane !== undefined && lane.points.length > 0 && def !== null;
  if (!hasLane || documentValue === null) {
    return {
      value: documentValue ?? 0,
      documentValue: documentValue ?? 0,
      source: "document",
      automated: false,
    };
  }

  // The lane's value at this tick, clamped to the target's authoritative
  // range — the same clamp the DSP writer applies, so the readout cannot
  // show a number the engine would never play.
  const laneValue = clampTargetValue(doc, canonical, valueAt(lane.points, tick, def.default));

  if (automationComposition(canonical) === "multiply") {
    return { value: documentValue * laneValue, documentValue, source: "automation", automated: true, laneValue };
  }
  return { value: laneValue, documentValue, source: "automation", automated: true, laneValue };
}

/**
 * The composed channel gain of a track — the fader × the volume lane.
 *
 * This is the number F-10 measured: a fader at 0.8 with a lane at 0.5 plays
 * at 0.4, and before this model no surface showed the 0.4.
 */
export function composedTrackGain(
  doc: ProjectDocument,
  trackId: string,
  tick: number,
  lanes: readonly AutomationLane[] = doc.automation,
): EffectiveValue {
  return effectiveParamValue(doc, { kind: "trackGain", trackId }, tick, lanes);
}

/**
 * The values IN EFFECT for a set of effect parameters, at one tick.
 *
 * Only the parameters an automation lane actually drives are returned. An
 * absent parameter means "no lane drives it" — the document value IS the value
 * in effect — so the caller can use the map itself as the "these knobs are
 * under automation" answer.
 *
 * The effect parameter lane OVERRIDES the document value (the lane writes the
 * absolute value into the parameter), so the effective value is the lane's
 * value, not a composition of the two.
 */
export function effectParamEffectiveValues(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  paramIds: readonly string[],
  tick: number,
  lanes: readonly AutomationLane[] = doc.automation,
): Record<string, number> {
  const effective: Record<string, number> = {};
  for (const paramId of paramIds) {
    const value = effectiveParamValue(doc, { kind: "fxParam", trackId, fxId, paramId }, tick, lanes);
    if (value.automated) effective[paramId] = value.value;
  }
  return effective;
}
