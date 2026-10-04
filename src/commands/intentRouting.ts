/**
 * Intent routing: turn a parsed plan (exact ops, production intent) into commands.
 *
 * Target resolution here is STRICT — name or kind only, never a positional fallback. "Delete the
 * lead track" in a project without a lead must fail loudly rather than quietly remove whatever
 * sits at index 0. That rule is the reason this is its own module: it is the one place where being
 * helpful would mean being wrong.
 */
import type { Command } from "./types";
import type { DrumTrack, ProjectDocument, Track } from "../project-model/types";
import {
  planProductionActions,
  resolveProductionTargets,
  type ProductionAction,
  type ProductionIntent,
} from "../intent/production";
import { classifyPads } from "../assist/patternOps";
import { padsForFamily } from "../intent/pattern-verbs";
import type { ExactIntentPlan, ExactOp, ExactTarget } from "../intent/exact";
import { snapshot } from "./core";
import { trackEffectsOf } from "./docOps";
import { addEffect, createDrumTrack, createInstrumentTrack, deleteTrack, duplicateTrack } from "./tracks";
import { setBpm, setPadParams, setTrackParams } from "./project";
import { setProjectKey } from "./metadata";
import { setPatternLength } from "./patterns";
import { setGroove } from "./groove";
import { setMasterConfig } from "./master";
import { setBeatManglerSteps, setEffectParam } from "./effectParams";

/* ---------------- intent routing ---------------- */
/**
 * STRICT exact-target resolution for destructive/renaming/preset ops:
 * name-or-kind match only, NO positional fallback — "delete the lead track"
 * in a project without a lead must fail loudly, never delete
 * instruments[0] by index. Pad families and the mix are not lanes.
 */
export function resolveExactTargetTracks(doc: ProjectDocument, target: ExactTarget): string[] {
  if (target === "mix" || target === "kick" || target === "snare" || target === "hats") return [];
  if (target === "drums") return doc.tracks.filter((t) => t.kind === "drum").map((t) => t.id);
  const instruments = doc.tracks.filter(
    (t): t is import("../project-model/types").InstrumentTrack => t.kind === "instrument",
  );
  const matched = instruments.filter((t) => {
    if (target === "bass") return ["bass", "808", "logdrum"].includes(t.instrument) || /\bbass\b|\b808\b/i.test(t.name);
    if (target === "chords") return /\bchord|\bkeys?\b|\bpad\b/i.test(t.name) || t.instrument === "keys";
    return /\blead\b|\bsynth\b|\bpluck\b/i.test(t.name) || ["lead", "pluck", "spectral"].includes(t.instrument);
  });
  return matched.map((t) => t.id);
}

export function applyExactIntentCommand(doc: ProjectDocument, plan: ExactIntentPlan): Command {
  let next = doc;
  const resolve = (target: string): string[] => {
    if (target === "mix") return [];
    if (target === "all") return next.tracks.map((t) => t.id);
    try {
      return resolveProductionTargets(next, [target as never]);
    } catch {
      return [];
    }
  };
  // Structural duplicate of project.ts's internal TrackParams: exporting it would push the
  // barrel's public surface to 234, and the type is structural, so restating it costs nothing.
  type TrackParamsPatch = Partial<Pick<Track, "name" | "gain" | "pan" | "mute" | "solo">>;
  const paramFor = (trackId: string, op: ExactOp): TrackParamsPatch | null => {
    const track = next.tracks.find((t) => t.id === trackId);
    if (!track || track.kind === "group") return null;
    if (op.kind === "mute") return { mute: op.value };
    if (op.kind === "solo") return { solo: op.value };
    if (op.kind === "pan") return { pan: Math.max(-1, Math.min(1, op.value as number)) };
    return null;
  };
  for (const op of plan.ops) {
    if (op.kind === "addTrack") {
      next = (op.trackKind === "drum" ? createDrumTrack(next) : createInstrumentTrack(next, op.instrument)).execute(
        next,
      );
      continue;
    }
    if (op.kind === "removeTrack") {
      const ids = resolveExactTargetTracks(next, op.target);
      if (ids.length === 0) throw new Error(`no track matches "${op.target}" — nothing to delete`);
      for (const id of ids) next = deleteTrack(next, id).execute(next);
      continue;
    }
    if (op.kind === "renameTrack") {
      const ids = resolveExactTargetTracks(next, op.target);
      if (ids.length === 0) throw new Error(`no track matches "${op.target}" — nothing to rename`);
      for (const id of ids) next = setTrackParams(next, id, { name: op.name }).execute(next);
      continue;
    }
    if (op.kind === "duplicateTrack") {
      const ids = resolveExactTargetTracks(next, op.target);
      if (ids.length === 0) throw new Error(`no track matches "${op.target}" — nothing to duplicate`);
      for (const id of ids) next = duplicateTrack(next, id).execute(next);
      continue;
    }
    if (op.kind === "tempo") {
      next = setBpm(next, op.bpm).execute(next);
      continue;
    }
    if (op.kind === "key") {
      next = setProjectKey(next, op.key).execute(next);
      continue;
    }
    if (op.kind === "patternLength") {
      next = setPatternLength(next, next.activePatternId, op.steps).execute(next);
      continue;
    }
    if (op.kind === "swing") {
      // Project-level groove swing — 0..100 percent → 0..1.
      next = setGroove(next, { swing: Math.max(0, Math.min(100, op.percent)) / 100 }).execute(next);
      continue;
    }
    if (op.kind === "patternLengthDelta") {
      // "4 bars longer" / "o 2 takty kratsie" — relative on the ACTIVE
      // pattern's current length (1 bar = 16 steps on the 4/4 grid).
      const current = next.patterns.find((p) => p.id === next.activePatternId)?.stepCount ?? 16;
      const target = Math.max(2, Math.min(128, current + op.bars * 16));
      next = setPatternLength(next, next.activePatternId, target).execute(next);
      continue;
    }
    if (op.kind === "gainDbAbsolute") {
      // "bass to -6 dB" / "basa na -6 dB" — SET the fader to the absolute
      // dBFS-equivalent multiplier (reads current state only for the clamp).
      if (op.target === "mix") {
        const targetMasterGain = Math.max(0, Math.min(1.5, Math.pow(10, op.absDb / 20)));
        next = setMasterConfig(next, { masterGain: targetMasterGain }).execute(next);
        continue;
      }
      for (const trackId of resolve(op.target)) {
        const track = next.tracks.find((t) => t.id === trackId);
        if (!track || track.kind === "group") continue;
        const targetGain = Math.max(0, Math.min(1.5, Math.pow(10, op.absDb / 20)));
        next = setTrackParams(next, trackId, { gain: targetGain }).execute(next);
      }
      continue;
    }
    if (op.kind === "gainDb") {
      // "the mix"/"master" is the MASTER FADER (doc.master.masterGain) — the
      // old mapping to tracks[0] boosted whatever happened to be the first
      // track (usually the drums), silently missing the master.
      if (op.target === "mix") {
        const masterGain = next.master?.masterGain ?? 1;
        const targetMasterGain = Math.max(0, Math.min(1.5, masterGain * Math.pow(10, op.deltaDb / 20)));
        next = setMasterConfig(next, { masterGain: targetMasterGain }).execute(next);
        continue;
      }
      for (const trackId of resolve(op.target)) {
        const track = next.tracks.find((t) => t.id === trackId);
        if (!track || track.kind === "group") continue;
        const targetGain = Math.max(0, Math.min(1.5, track.gain * Math.pow(10, op.deltaDb / 20)));
        next = setTrackParams(next, trackId, { gain: targetGain }).execute(next);
      }
      continue;
    }
    if (op.kind === "transpose") {
      // Melodic notes only — drums have no pitch. A named target that
      // resolves to nothing (or to drums only) fails LOUDLY: the old silent
      // no-op reported success while the notes never moved.
      const melodicIds = resolve(op.target).filter((id) => {
        const track = next.tracks.find((t) => t.id === id);
        return track?.kind === "instrument";
      });
      if (melodicIds.length === 0) {
        throw new Error(`no melodic track matches "${op.target}" — nothing to transpose`);
      }
      for (const track of next.tracks) {
        if (track.kind !== "instrument") continue;
        if (!melodicIds.includes(track.id)) continue;
        const pattern = next.patterns.find((p) => p.id === next.activePatternId);
        if (!pattern) continue;
        const notes = pattern.notes[track.id];
        if (!notes || notes.length === 0) continue;
        next = {
          ...next,
          patterns: next.patterns.map((p) =>
            p.id !== pattern.id
              ? p
              : {
                  ...p,
                  notes: {
                    ...p.notes,
                    [track.id]: notes.map((n) => ({ ...n, pitch: Math.max(0, Math.min(127, n.pitch + op.semitones)) })),
                  },
                },
          ),
        };
      }
      continue;
    }
    // Pad-family targets (hats/snare/kick) map to per-PAD params on the
    // drum track — "Pan the hats 20% right" is literally a pad-level op.
    const padFamily = op.target as string;
    if (padFamily === "hats" || padFamily === "snare" || padFamily === "kick") {
      const drum = next.tracks.find((t) => t.kind === "drum");
      if (!drum || drum.kind !== "drum") continue;
      const families = classifyPads(drum.pads);
      const familyPads =
        padFamily === "hats" ? families.hats : padFamily === "snare" ? families.snares : families.kicks;
      for (const pad of familyPads) {
        if (op.kind === "mute") {
          next = setPadParams(next, pad.id, { mute: op.value as boolean }).execute(next);
        } else if (op.kind === "solo") {
          next = setPadParams(next, pad.id, { solo: op.value as boolean }).execute(next);
        } else if (op.kind === "pan") {
          next = setPadParams(next, pad.id, { pan: Math.max(-1, Math.min(1, op.value as number)) }).execute(next);
        }
      }
      continue;
    }
    // MUTE/SOLO on the mix family = EVERY lane ("mute everything", "zapni
    // všetko") — the parser only sends mix here for mute/solo (pan and the
    // destructive ops decline it), and a per-track op on "the mix" used to
    // resolve to NOTHING, a silent no-op command that reported success.
    if ((op.kind === "mute" || op.kind === "solo") && op.target === "mix") {
      for (const track of next.tracks) {
        if (track.kind === "group") continue;
        const params = paramFor(track.id, op);
        if (params) next = setTrackParams(next, track.id, params).execute(next);
      }
      continue;
    }
    for (const trackId of resolve(op.target)) {
      const params = paramFor(trackId, op as ExactOp);
      if (params) next = setTrackParams(next, trackId, params).execute(next);
    }
  }
  return snapshot("applyExactIntent", plan.label, doc, next);
}

/**
 * VERIFICATION READ-BACK for exact ops — the resulting state read from the
 * post-execution document ("bpm 124→140", "Drums mute=true", "bass→sub bass").
 * Lives beside the applier because it shares resolveExactTargetTracks and
 * the op vocabulary; keeping the intent module import-free of command values
 * preserves the acyclic layering.
 */
export function exactReadback(before: ProjectDocument, after: ProjectDocument, plan: ExactIntentPlan): string {
  const fmt = (value: number): number => Math.round(value * 100) / 100;
  const entries: string[] = [];
  for (const op of plan.ops) {
    if (op.kind === "tempo") {
      if (before.bpm !== after.bpm) entries.push(`bpm ${before.bpm}→${after.bpm}`);
    } else if (op.kind === "key") {
      if (before.key !== after.key) entries.push(`key ${after.key}`);
    } else if (op.kind === "patternLength") {
      const steps = after.patterns.find((p) => p.id === after.activePatternId)?.stepCount;
      if (steps != null) entries.push(`length ${steps}`);
    } else if (op.kind === "addTrack") {
      const added = after.tracks[after.tracks.length - 1];
      if (added) entries.push(`+ ${added.name}`);
    } else if (op.kind === "removeTrack") {
      if (resolveExactTargetTracks(after, op.target).length === 0) entries.push(`${op.target} track removed ✓`);
    } else if (op.kind === "renameTrack") {
      if (after.tracks.some((t) => t.name === op.name)) entries.push(`→ "${op.name}"`);
    } else if (op.kind === "duplicateTrack") {
      const delta = after.tracks.length - before.tracks.length;
      if (delta > 0) entries.push(`+${delta} track`);
    } else if (op.kind === "gainDb" || op.kind === "gainDbAbsolute") {
      if (op.target === "mix") {
        entries.push(`master ${fmt(before.master.masterGain)}→${fmt(after.master.masterGain)}`);
      } else {
        for (const id of resolveExactTargetTracks(before, op.target)) {
          const b = before.tracks.find((t) => t.id === id)?.gain;
          const a = after.tracks.find((t) => t.id === id)?.gain;
          if (b != null && a != null && b !== a) entries.push(`gain ${fmt(b)}→${fmt(a)}`);
        }
      }
    } else if (op.kind === "patternLengthDelta") {
      const steps = after.patterns.find((p) => p.id === after.activePatternId)?.stepCount;
      if (steps != null)
        entries.push(
          `length ${before.patterns.find((p) => p.id === before.activePatternId)?.stepCount ?? "?"}→${steps}`,
        );
    } else if (op.kind === "swing") {
      const b = Math.round((before.groove?.swing ?? 0) * 100);
      const a = Math.round((after.groove?.swing ?? 0) * 100);
      if (b !== a) entries.push(`swing ${b}%→${a}%`);
    } else if (op.kind === "transpose") {
      // Verified against the ACTIVE pattern's notes: the entry fires only
      // when a resolved track's pitch actually moved by the requested amount.
      for (const id of resolveExactTargetTracks(before, op.target)) {
        const b = before.patterns.find((p) => p.id === before.activePatternId)?.notes[id]?.[0]?.pitch;
        const a = after.patterns.find((p) => p.id === after.activePatternId)?.notes[id]?.[0]?.pitch;
        if (b != null && a != null && a - b === op.semitones) {
          entries.push(`transpose ${op.semitones > 0 ? "+" : ""}${op.semitones} st ✓`);
          break;
        }
      }
    } else if (op.target === "kick" || op.target === "snare" || op.target === "hats") {
      // pad-family mute/solo/pan — report the family flag
      const drum = after.tracks.find((t): t is DrumTrack => t.kind === "drum");
      if (drum) {
        const families = classifyPads(drum.pads);
        const familyPads =
          op.target === "hats" ? families.hats : op.target === "snare" ? families.snares : families.kicks;
        if (op.kind === "mute" && familyPads.length > 0) entries.push(`${op.target} mute=${familyPads[0].mute}`);
        if (op.kind === "solo" && familyPads.length > 0) entries.push(`${op.target} solo=${familyPads[0].solo}`);
        if (op.kind === "pan" && familyPads.length > 0) entries.push(`${op.target} pan=${fmt(familyPads[0].pan)}`);
      }
    } else {
      for (const id of resolveExactTargetTracks(before, op.target)) {
        const a = after.tracks.find((t) => t.id === id);
        if (!a) continue;
        if (op.kind === "mute" && a.mute) entries.push(`${a.name} mute ✓`);
        if (op.kind === "solo" && a.solo) entries.push(`${a.name} solo ✓`);
        if (op.kind === "pan") entries.push(`${a.name} pan=${fmt(a.pan)}`);
      }
    }
  }
  if (entries.length > 4) return `${entries.slice(0, 4).join(", ")} +${entries.length - 4}`;
  return entries.join(", ");
}

/**
 * Production Intent (KYX_PRODUCTION_INTENT_ENGINE_MASTER.md Phase 1+2):
/**
 * Production Intent (KYX_PRODUCTION_INTENT_ENGINE_MASTER.md Phase 1+2):
 * compile a deterministic production plan — concept × target → effect ops —
 * into ONE undoable command group. Effects that already exist on the target
 * track are adjusted in place; missing ones are added with the planned
 * params. This is the commit path for "make the bass deeper" style requests;
 * the language layer never touches AudioNodes directly.
 */
/**
 * Shared fold for production ACTIONS: existing same-type effects are
 * re-tuned in place, missing ones added; beatMangler envelopes ride the
 * same fold. Used by applyProductionIntentCommand, the track-scoped goal
 * path (FX add popover) and the generation-side FX flow.
 */
function foldProductionActions(doc: ProjectDocument, actions: ProductionAction[]): ProjectDocument {
  let next = doc;
  for (const action of actions) {
    const existing = trackEffectsOf(next, action.trackId).find((f) => f.type === action.type);
    if (!existing) {
      const add = addEffect(next, action.trackId, action.type);
      next = add.execute(next);
    }
  }
  for (const action of actions) {
    const instance = trackEffectsOf(next, action.trackId).find((f) => f.type === action.type);
    if (!instance) continue;
    for (const [paramId, value] of Object.entries(action.params)) {
      const param = setEffectParam(next, action.trackId, instance.id, paramId, value);
      next = param.execute(next);
    }
    // beatMangler envelope rides with the same plan action so one production
    // intent stays ONE undo step even when it plants step envelopes.
    if (action.volumeSteps || action.pitchSteps) {
      const steps = setBeatManglerSteps(next, action.trackId, instance.id, {
        volume: action.volumeSteps,
        pitch: action.pitchSteps,
      });
      next = steps.execute(next);
    }
  }
  return next;
}

// Exported for effectParams' offline fold and for the barrel body; deliberately NOT re-exported by
// the barrel, because it was internal before this split and re-exporting would grow the surface.
export function foldProductionIntent(doc: ProjectDocument, intent: ProductionIntent): ProjectDocument {
  const { plan } = planProductionActions(doc, intent);
  return foldProductionActions(doc, plan.actions);
}

/**
 * Fold production FX chains into a doc WITHOUT wrapping in a command -
 * ghost documents (candidate audition renders the FX the candidate would
 * install) and other offline previews. The live project is never touched.
 *
 * This lives beside the fold it calls rather than with the effect parameters, so the dependency
 * between these two modules stays one-way: intent routing knows about effect params, not the
 * reverse.
 */
export function foldFxIntoDoc(doc: ProjectDocument, fx: ProductionIntent): ProjectDocument {
  return foldProductionIntent(doc, fx);
}

export function applyProductionIntentCommand(doc: ProjectDocument, intent: ProductionIntent): Command {
  const { plan, padAdjustments } = planProductionActions(doc, intent);
  let next = foldProductionIntent(doc, intent);
  // ELEMENT-LEVEL (vibe-code wave): pad-family targets get per-pad GAIN
  // adjustments on the drum track — "kick more knock" hits the kick pads'
  // gain, not a track-wide effect. Folded into the SAME snapshot.
  for (const adjustment of padAdjustments ?? []) {
    const drumTrack = next.tracks.find((t): t is DrumTrack => t.kind === "drum");
    if (!drumTrack) break;
    const familyPads = padsForFamily(drumTrack.pads, adjustment.family);
    for (const pad of familyPads) {
      const boosted = Math.round(Math.max(0.05, Math.min(1.5, pad.gain * adjustment.factor)) * 100) / 100;
      if (boosted === pad.gain) continue;
      next = setPadParams(next, pad.id, { gain: boosted }).execute(next);
    }
  }
  // Production intents are deterministic — undo restores the exact previous
  // chain state, and a redo replays the same folded operations.
  return snapshot("applyProductionIntent", plan.label, doc, next);
}

/**
 * Production goal scoped to ONE track (FX add popover: "deeper" typed on an
 * open track folds its planner actions onto THAT track only). Throws with a
 * hint when the concept resolves elsewhere — the popover surfaces it, the
 * INTENT panel stays the whole-mix entry.
 */
export function applyProductionIntentToTrackCommand(
  doc: ProjectDocument,
  trackId: string,
  intent: ProductionIntent,
): Command {
  const { plan } = planProductionActions(doc, intent);
  const scoped = plan.actions.filter((action) => action.trackId === trackId);
  if (scoped.length === 0) {
    throw new Error(`That goal targets other tracks — try the INTENT panel or pick a device here`);
  }
  const next = foldProductionActions(doc, scoped);
  return snapshot("applyProductionIntent", plan.label, doc, next);
}
