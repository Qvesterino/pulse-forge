/**
 * Modulation precedence — WHO may write a device parameter, and who wins.
 *
 * An effect parameter has ONE `AudioParam` (`deviceLookup.ts:59-93`). Every
 * modulation source that points at it writes into that same parameter:
 *
 * - an **automation lane** writes the lane's ABSOLUTE value
 *   (`automationBridge.ts:1191` → `:1209`),
 * - a **scheduled modulator** (random/step LFO) writes `base + halfRange·value`
 *   (`:1139-1140`),
 * - a **macro** writes `base + halfRange·bipolar·amount` (`:673`),
 * - a **MIDI CC** writes the clamped CC value (`:1426`).
 *
 * Before ADR 0067 they were four writers on one parameter and the audible
 * result was decided by the order in which their writes happened to land
 * (audit F-11) — the macro's contribution was dropped silently, and a macro
 * move was audible for up to one scheduler window (25 ms) before the lane
 * overwrote it.
 *
 * The contract this module declares: **automation > modulator > macro >
 * midiCC**. A source may write a target only when it is not outranked by
 * the source that owns it.
 *
 * ## What is NOT covered
 *
 * - **Track gain/pan** keep their own modulation buses (`modAutoGain` for the
 *   lane, `modMacroGain` for the macro) and compose multiplicatively — they
 *   never shared a parameter, so they never needed a precedence.
 * - **Audio-rate oscillators** (`kind: "osc"`) are CONNECTED into the target
 *   parameter (`automationBridge.ts:506`) — they add to the parameter's value
 *   instead of replacing it, so they compose with the macro instead of
 *   fighting it. Only the modulators that write an ABSOLUTE value conflict:
 *   the scheduled ones (random/step) and an env follower that could not be
 *   wired audio-rate.
 * - **Scene packs** pin a PAIR of effect parameters and re-assert the pair on
 *   every sync; splitting the pair by a per-parameter precedence would break
 *   its atomicity, so the pair write stays outside the gate (the scheduler
 *   still rewrites the lane on top of it).
 */
import { lfoKind, resolveLfoTarget } from "./modulators";
import { automationTargetKey, canonicalizeDeprecatedTarget } from "./targets";
import type { AutomationTarget, ProjectDocument } from "./types";

/** The modulation sources that write into a shared device parameter. */
export type ModulationSource = "automation" | "modulator" | "macro" | "midiCC";

/**
 * The precedence, HIGHEST FIRST: an automation lane beats a modulator, a
 * modulator beats a macro, a macro beats a MIDI CC.
 *
 * This matches the industry norm (Ableton / Logic: recorded automation
 * overrides a CC mapping on the same parameter) and the audit's smallest safe
 * repair (F-11: "define an explicit precedence and apply it in one place").
 */
export const MODULATION_PRECEDENCE: readonly ModulationSource[] = ["automation", "modulator", "macro", "midiCC"];

/** Rank of a source — 0 is the highest (automation). */
export function modulationSourceRank(source: ModulationSource): number {
  const index = MODULATION_PRECEDENCE.indexOf(source);
  return index < 0 ? MODULATION_PRECEDENCE.length : index;
}

/**
 * TRUE when `source` may write a target owned by `owner`.
 *
 * Equal ranks mean "same class" — the macro class composes its own mappings
 * into one delta before it writes, so a macro never blocks another macro.
 */
export function sourceOutranks(source: ModulationSource, owner: ModulationSource): boolean {
  return modulationSourceRank(source) <= modulationSourceRank(owner);
}

/** Only fx/inst parameters share one parameter between sources. */
export function isSharedDeviceTarget(target: AutomationTarget): boolean {
  return target.kind === "fxParam" || target.kind === "instParam";
}

/** The canonical key of a target — deprecated param aliases resolve to one id. */
export function modulationTargetKey(doc: ProjectDocument, target: AutomationTarget): string {
  return automationTargetKey(canonicalizeDeprecatedTarget(doc, target));
}

/**
 * Device targets driven by AUTOMATION: project lanes, scene lanes and
 * arrangement automation clips.
 *
 * A lane without points is skipped — the automation writer skips it too
 * (`automationBridge.ts:1245`), so it must not claim ownership either.
 */
export function automationOwnedTargets(doc: ProjectDocument): Set<string> {
  const out = new Set<string>();
  const add = (target: AutomationTarget): void => {
    if (!isSharedDeviceTarget(target)) return;
    out.add(modulationTargetKey(doc, target));
  };
  for (const lane of doc.automation ?? []) {
    if (lane.points.length === 0) continue;
    add(lane.target);
  }
  for (const lane of doc.sceneAutomation ?? []) {
    if (lane.points.length === 0) continue;
    add(lane.target);
  }
  for (const clip of doc.arrangement?.automationClips ?? []) {
    if (clip.muted) continue;
    if (clip.points.length === 0) continue;
    add(clip.target);
    for (const linked of clip.linkedTargets ?? []) add(linked);
  }
  return out;
}

/**
 * Device targets driven by a SCHEDULED modulator (random / step LFO).
 *
 * These write an absolute value every scheduler window, so they conflict with
 * the macro. Audio-rate oscillators are excluded on purpose — they are
 * connected into the parameter and add to it.
 */
export function scheduledModulatorTargets(doc: ProjectDocument): Set<string> {
  const out = new Set<string>();
  for (const lfo of doc.lfos ?? []) {
    const kind = lfoKind(lfo);
    if (kind !== "random" && kind !== "step") continue;
    const target = resolveLfoTarget(lfo);
    if (!isSharedDeviceTarget(target)) continue;
    out.add(modulationTargetKey(doc, target));
  }
  return out;
}

/** Device targets mapped by a macro mapping (any source: macro, intensity, legacy CC). */
export function macroMappedTargets(doc: ProjectDocument): Set<string> {
  const out = new Set<string>();
  for (const macro of doc.macros ?? []) {
    for (const mapping of macro.mappings ?? []) {
      if (!mapping.target) continue;
      if (!isSharedDeviceTarget(mapping.target)) continue;
      out.add(modulationTargetKey(doc, mapping.target));
    }
  }
  return out;
}

/** The three ownership sets, computed once for a whole document. */
export interface ModulationOwnership {
  automation: Set<string>;
  modulator: Set<string>;
  macro: Set<string>;
}

/** Precompute the ownership sets — one pass instead of one per target. */
export function modulationOwnership(doc: ProjectDocument): ModulationOwnership {
  return {
    automation: automationOwnedTargets(doc),
    modulator: scheduledModulatorTargets(doc),
    macro: macroMappedTargets(doc),
  };
}

/**
 * The source that OWNS a target — the highest-priority source declared in the
 * document, or `null` when nothing drives it.
 *
 * This is the declared ownership (what the project says), not a runtime
 * snapshot: it is what the UI discloses next to a macro mapping and what the
 * engine's gate consults. MIDI CC is never an owner — a CC is a live input,
 * not a declared source; it is the LOWEST source, so it yields to everything.
 */
export function modulationOwner(
  doc: ProjectDocument,
  target: AutomationTarget,
  ownership: ModulationOwnership = modulationOwnership(doc),
): ModulationSource | null {
  if (!isSharedDeviceTarget(target)) return null;
  const key = modulationTargetKey(doc, target);
  if (ownership.automation.has(key)) return "automation";
  if (ownership.modulator.has(key)) return "modulator";
  if (ownership.macro.has(key)) return "macro";
  return null;
}
