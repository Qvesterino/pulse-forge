import type { Command } from "./types";
import type {
  DrumTrack,
  EffectInstance,
  EffectType,
  GenerativeTrackConfig,
  InstrumentKind,
  InstrumentTrack,
  ProjectDocument,
  Track,
} from "../project-model/types";
import { DEFAULT_GATE_PATTERN } from "../project-model/modulators";
import { defaultParamsOf, EFFECT_META } from "../effects/definitions";
import {
  createDrumTrackModel,
  createGenerativeTrackModel,
  createGroupTrackModel,
  createInstrumentTrackModel,
  drumTracksOf,
  instrumentTracksOf,
  normalizeProject,
  sanitizeColor,
} from "../project-model/schema";
import { uid } from "../shared/ids";
import { getYDocHelpers } from "./yDocBridge";
import { trackEffectsOf, unlinkMarkersOfClips, withTrackEffects } from "./docOps";
import { snapshot } from "./core";

/**
 * Tracks and the effect-instance lifecycle that belongs to them.
 *
 * addEffect and its reference-cleanup helpers live here rather than in the effects module on
 * purpose: the effects module reaches UP into track CRUD (deleteTrack, duplicateTrack,
 * createDrumTrack), so if addEffect stayed over there the two would import each other. Track
 * creation owns the effect chain; the rest of the effects module owns what gets put on it.
 */ /* ---------------- tracks ---------------- */

export function createDrumTrack(doc: ProjectDocument): Command {
  const count = drumTracksOf(doc).length;
  const track = createDrumTrackModel(`Drums ${count + 1}`);
  const withTrack: ProjectDocument = { ...doc, tracks: [...doc.tracks, track] };
  const next = normalizeProject(withTrack);
  return snapshot("createDrumTrack", `Add track ${track.name}`, doc, next);
}

export function createInstrumentTrack(doc: ProjectDocument, kind: InstrumentKind): Command {
  const count = instrumentTracksOf(doc).filter((t) => t.instrument === kind).length + 1;
  const track = createInstrumentTrackModel(kind, count);
  const next: ProjectDocument = { ...doc, tracks: [...doc.tracks, track] };
  return snapshot("createInstrumentTrack", `Add track ${track.name}`, doc, next);
}

export function createGroupTrack(doc: ProjectDocument): Command {
  const count = doc.tracks.filter((t) => t.kind === "group").length;
  const track = createGroupTrackModel(`Group ${count + 1}`);
  const next: ProjectDocument = { ...doc, tracks: [...doc.tracks, track] };
  return snapshot("createGroupTrack", `Add group ${track.name}`, doc, next);
}

export function createGenerativeTrack(doc: ProjectDocument): Command {
  const count = doc.tracks.filter((t) => t.kind === "generative").length;
  const track = createGenerativeTrackModel(`Generative ${count + 1}`);
  const next = normalizeProject({ ...doc, tracks: [...doc.tracks, track] });
  return snapshot("createGenerativeTrack", `Add track ${track.name}`, doc, next);
}

export type GenerativeTrackConfigPatch = Partial<Omit<GenerativeTrackConfig, "macros">> & {
  macros?: Partial<GenerativeTrackConfig["macros"]>;
};

export function setGenerativeTrackConfig(
  doc: ProjectDocument,
  trackId: string,
  patch: GenerativeTrackConfigPatch,
): Command {
  const track = doc.tracks.find((candidate) => candidate.id === trackId && candidate.kind === "generative");
  if (!track) throw new Error(`Generative track ${trackId} not found`);
  const next: ProjectDocument = normalizeProject({
    ...doc,
    tracks: doc.tracks.map((candidate) =>
      candidate.id === trackId && candidate.kind === "generative"
        ? {
            ...candidate,
            generative: {
              ...candidate.generative,
              ...patch,
              macros: { ...candidate.generative.macros, ...(patch.macros ?? {}) },
            },
          }
        : candidate,
    ),
  });
  return snapshot("setGenerativeTrackConfig", `Edit ${track.name} generative config`, doc, next);
}

export function addToGroup(doc: ProjectDocument, trackId: string, groupId: string): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track || track.kind === "group") throw new Error(`Cannot add group to group`);
  const group = doc.tracks.find((t) => t.id === groupId && t.kind === "group");
  if (!group) throw new Error(`Group ${groupId} not found`);
  const prevGroupId = "groupId" in track ? track.groupId : undefined;
  const hadGroupId = prevGroupId !== undefined;
  // Joining a SOLOED group must inherit the solo: the engine keeps children
  // of a soloed group audible via the group gain, while the scheduler gates
  // pattern content on the track's OWN solo — without inheritance the track
  // previews live but its playback content stays silent.
  const inheritSolo = group.solo === true && track.solo !== true;
  const prevSolo = track.solo;
  return {
    type: "addToGroup",
    label: `Add ${track.name} to group`,
    execute: (d) => ({
      ...d,
      tracks: d.tracks.map((t) =>
        t.id === trackId && t.kind !== "group" ? { ...t, groupId, ...(inheritSolo ? { solo: true } : {}) } : t,
      ),
    }),
    undo: (d) => ({
      ...d,
      tracks: d.tracks.map((t) => {
        if (t.id !== trackId || t.kind === "group") return t;
        let restored = t;
        if (hadGroupId) restored = { ...restored, groupId: prevGroupId };
        else {
          const { groupId: _, ...rest } = restored as any;
          restored = rest;
        }
        if (inheritSolo) restored = { ...restored, solo: prevSolo };
        return restored;
      }),
    }),
  };
}

export function removeFromGroup(doc: ProjectDocument, trackId: string): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track || track.kind === "group") throw new Error(`Cannot remove group from group`);
  const prevGroupId = "groupId" in track ? track.groupId : undefined;
  if (prevGroupId === undefined) {
    return { type: "removeFromGroup", label: "Remove from group", execute: (d) => d, undo: (d) => d };
  }
  return {
    type: "removeFromGroup",
    label: `Remove ${track.name} from group`,
    execute: (d) => ({
      ...d,
      tracks: d.tracks.map((t) => (t.id === trackId && t.kind !== "group" ? { ...t, groupId: undefined } : t)),
    }),
    undo: (d) => ({
      ...d,
      tracks: d.tracks.map((t) => (t.id === trackId && t.kind !== "group" ? { ...t, groupId: prevGroupId } : t)),
    }),
  };
}

export function deleteTrack(doc: ProjectDocument, trackId: string): Command {
  if (doc.tracks.length <= 1) throw new Error("Cannot delete the last track");
  const target = doc.tracks.find((t) => t.id === trackId);
  if (!target) throw new Error(`Track ${trackId} not found`);
  const removedPadIds = new Set(target.kind === "drum" ? target.pads.map((p) => p.id) : []);
  // When deleting a group, orphan its children (remove groupId)
  const isGroup = target.kind === "group";
  // Automation/modulation routed at the deleted track would dangle: the
  // engine skips them silently, but the lanes would live in every save until
  // the next reload's normalize pass dropped them. Remove them with the track.
  const automation = doc.automation?.filter((lane) => lane.target.trackId !== trackId);
  const lfos = doc.lfos?.filter((lfo) => lfo.trackId !== trackId && lfo.target?.trackId !== trackId);
  const sceneAutomation = doc.sceneAutomation?.filter((lane) => lane.target.trackId !== trackId);
  const macros = doc.macros?.map((macro) => ({
    ...macro,
    mappings: macro.mappings.filter((m) => m.trackId !== trackId && m.target?.trackId !== trackId),
  }));
  // Audio clips routed at the track would orphan: the engine skips them, but
  // the dead references would persist in every save until the next reload's
  // normalize pass dropped them. Remove them with the track (same contract
  // as the automation lanes above).
  const audioClips = doc.arrangement.audioClips?.filter((clip) => clip.trackId !== trackId);
  // Markers linked to the track's audio clips are cross-references held by
  // other entities — clear them here, inside the command, not in the
  // post-apply normalize (same contract as the sidechain/MIDI cleanup below).
  const unlinkedMarkers = unlinkMarkersOfClips(
    doc.markers,
    new Set((doc.arrangement.audioClips ?? []).filter((clip) => clip.trackId === trackId).map((clip) => clip.id)),
  );
  // Cross-references HELD BY OTHER ENTITIES must be removed here, inside the
  // command — NOT left for the post-apply normalize pass. normalizeProject
  // prunes dangling sidechainTrackId / MIDI CC targets / aftertouch targets
  // / drum-note mappings outside the captured forward/backward deltas, so an
  // undo of delete-track could never restore them: the user's sidechain
  // routing and MIDI mappings were silently and permanently destroyed by
  // Ctrl+Z. Cleaning them here makes the removal part of `next`, and the
  // backward delta restores them together with the track.
  const stripSidechain = (effects: (typeof doc.tracks)[number]["effects"]) =>
    effects.map((e) => (e.sidechainTrackId === trackId ? { ...e, sidechainTrackId: undefined } : e));
  const midi = doc.midi;
  const next: ProjectDocument = {
    ...doc,
    ...(unlinkedMarkers !== undefined ? { markers: unlinkedMarkers } : {}),
    tracks: doc.tracks
      .filter((t) => t.id !== trackId)
      .map((t) => {
        if (isGroup && t.kind !== "group" && t.groupId === trackId)
          return { ...t, groupId: undefined, effects: stripSidechain(t.effects) };
        if ("effects" in t) return { ...t, effects: stripSidechain(t.effects) };
        return t;
      }),
    returns: doc.returns.map((r) => ({ ...r, effects: stripSidechain(r.effects) })),
    ...(midi
      ? {
          midi: {
            ...midi,
            ccMappings: midi.ccMappings.filter((m) => m.target?.trackId !== trackId),
            drumNoteMap: midi.drumNoteMap.filter((m) => !removedPadIds.has(m.padId)),
            ...(midi.aftertouchTarget?.trackId === trackId ? { aftertouchTarget: undefined } : {}),
          },
        }
      : {}),
    patterns: doc.patterns.map((pattern) => ({
      ...pattern,
      rows: Object.fromEntries(Object.entries(pattern.rows).filter(([padId]) => !removedPadIds.has(padId))),
      notes: Object.fromEntries(Object.entries(pattern.notes ?? {}).filter(([tid]) => tid !== trackId)),
    })),
    arrangement: {
      ...doc.arrangement,
      ...(doc.arrangement.audioClips ? { audioClips } : {}),
    },
    ...(doc.automation ? { automation } : {}),
    ...(doc.lfos ? { lfos } : {}),
    ...(doc.sceneAutomation ? { sceneAutomation } : {}),
    ...(doc.macros ? { macros } : {}),
  };
  const command = snapshot("deleteTrack", `Delete track ${target.name}`, doc, next);
  const detail = cleanupDetail(doc, next);
  return detail ? { ...command, detail } : command;
}

export function duplicateTrack(doc: ProjectDocument, trackId: string): Command {
  const target = doc.tracks.find((t) => t.id === trackId);
  if (!target) throw new Error(`Track ${trackId} not found`);
  const cloneId = uid("track");
  let clone: Track;
  if (target.kind === "drum") {
    clone = {
      ...target,
      id: cloneId,
      name: `${target.name} copy`,
      pads: target.pads.map((p) => ({ ...p, id: uid("pad"), chokeGroup: p.chokeGroup })),
      effects: target.effects.map((fx) => ({
        ...fx,
        id: uid("fx"),
        params: { ...fx.params },
        ...(fx.steps ? { steps: [...fx.steps] } : {}),
        ...(fx.sidechainTrackId ? { sidechainTrackId: fx.sidechainTrackId } : {}),
      })),
      sends: { ...target.sends },
      ...(target.groupId ? { groupId: target.groupId } : {}),
      ...(target.color ? { color: target.color } : {}),
    };
    // Remove frozen state on clone
    if ((clone as unknown as Record<string, unknown>).frozen)
      delete (clone as unknown as Record<string, unknown>).frozen;
  } else if (target.kind === "instrument") {
    clone = {
      ...target,
      id: cloneId,
      name: `${target.name} copy`,
      params: { ...target.params },
      effects: target.effects.map((fx) => ({
        ...fx,
        id: uid("fx"),
        params: { ...fx.params },
        ...(fx.steps ? { steps: [...fx.steps] } : {}),
        ...(fx.sidechainTrackId ? { sidechainTrackId: fx.sidechainTrackId } : {}),
      })),
      sends: { ...target.sends },
      ...(target.groupId ? { groupId: target.groupId } : {}),
      ...(target.color ? { color: target.color } : {}),
      ...(target.presetId ? { presetId: target.presetId } : {}),
    };
    if ((clone as unknown as Record<string, unknown>).frozen)
      delete (clone as unknown as Record<string, unknown>).frozen;
    // Clear midiOutput to avoid duplicate MIDI routing collision
    if ((clone as InstrumentTrack).midiOutput) delete (clone as InstrumentTrack).midiOutput;
  } else {
    clone = {
      ...target,
      id: cloneId,
      name: `${target.name} copy`,
      effects: target.effects.map((fx) => ({
        ...fx,
        id: uid("fx"),
        params: { ...fx.params },
        ...(fx.steps ? { steps: [...fx.steps] } : {}),
        ...(fx.sidechainTrackId ? { sidechainTrackId: fx.sidechainTrackId } : {}),
      })),
      sends: { ...target.sends },
      ...(target.color ? { color: target.color } : {}),
    };
    if ((clone as unknown as Record<string, unknown>).frozen)
      delete (clone as unknown as Record<string, unknown>).frozen;
  }
  const idx = doc.tracks.findIndex((t) => t.id === trackId);
  const tracks = [...doc.tracks];
  tracks.splice(idx + 1, 0, clone);
  let next: ProjectDocument = { ...doc, tracks };
  // Duplicate pattern rows/notes for the new drum track's pads
  if (target.kind === "drum") {
    const padIdMap = new Map<string, string>();
    (target as DrumTrack).pads.forEach((p, i) => padIdMap.set(p.id, (clone as DrumTrack).pads[i].id));
    next = {
      ...next,
      patterns: next.patterns.map((pat) => {
        const newRows: Record<string, number[]> = { ...pat.rows };
        for (const [oldId, newId] of padIdMap) if (pat.rows[oldId]) newRows[newId] = [...pat.rows[oldId]];
        // stepMeta clone
        let newMeta = pat.stepMeta ? { ...pat.stepMeta } : undefined;
        if (newMeta) {
          for (const [oldId, newId] of padIdMap) if (newMeta[oldId]) newMeta[newId] = { ...newMeta[oldId] };
        }
        return { ...pat, rows: newRows, ...(newMeta ? { stepMeta: newMeta } : {}) };
      }),
    };
  }
  next = normalizeProject(next);
  return snapshot("duplicateTrack", `Duplicate track ${target.name}`, doc, next);
}

export function setTrackColor(doc: ProjectDocument, trackId: string, color: string | null): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  const clean = color ? sanitizeColor(color) : undefined;
  if (color && !clean) throw new Error("Invalid color (use #rrggbb)");
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.id !== trackId) return t;
      if (!clean) {
        const { color: _c, ...rest } = t as unknown as Record<string, unknown>;
        return rest as unknown as Track;
      }
      return { ...t, color: clean } as unknown as Track;
    }),
  };
  return snapshot("setTrackColor", color ? `Set ${track.name} color` : `Clear ${track.name} color`, doc, next);
}
/** Pad colour override (CSS hex) — recolours the pad UI; null clears. */
/** Pad sample loop: on + region (absolute seconds in the sample). */
export function setPadLoop(
  doc: ProjectDocument,
  trackId: string,
  padId: string,
  on: boolean,
  startSec = 0,
  endSec = 0,
): Command {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum" && t.id === trackId);
  if (!track) throw new Error(`Drum track ${trackId} not found`);
  if (!track.pads.some((p) => p.id === padId)) throw new Error(`Pad ${padId} not found`);
  if (on && (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec - startSec < 0.005)) {
    throw new Error("Loop region too short (min 5 ms)");
  }
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.id !== trackId || t.kind !== "drum") return t;
      const drum = t as DrumTrack;
      return {
        ...drum,
        pads: drum.pads.map((p) =>
          p.id === padId
            ? {
                ...p,
                sliceLoop: on,
                sliceLoopStart: on ? Math.max(0, startSec) : undefined,
                sliceLoopEnd: on ? Math.max(0, endSec) : undefined,
              }
            : p,
        ),
      };
    }),
  };
  return snapshot(
    "setPadLoop",
    on ? `Pad loop ${startSec.toFixed(2)}–${endSec.toFixed(2)}s` : "Pad loop off",
    doc,
    next,
  );
}
export function setPadColor(doc: ProjectDocument, trackId: string, padId: string, color: string | null): Command {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum" && t.id === trackId);
  if (!track) throw new Error(`Drum track ${trackId} not found`);
  if (!track.pads.some((p) => p.id === padId)) throw new Error(`Pad ${padId} not found`);
  const clean = color ? sanitizeColor(color) : undefined;
  if (color && !clean) throw new Error("Invalid color (use #rrggbb)");
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.id !== trackId || t.kind !== "drum") return t;
      const drum = t as DrumTrack;
      return {
        ...drum,
        pads: drum.pads.map((p) => {
          if (p.id !== padId) return p;
          if (!clean) {
            const { color: _c, ...rest } = p as unknown as Record<string, unknown>;
            return rest as unknown as typeof p;
          }
          return { ...p, color: clean };
        }),
      };
    }),
  };
  return snapshot("setPadColor", color ? "Set pad colour" : "Clear pad colour", doc, next);
}

export function setGroupCollapsed(doc: ProjectDocument, groupId: string, collapsed: boolean): Command {
  const track = doc.tracks.find((t) => t.id === groupId);
  if (!track || track.kind !== "group") throw new Error(`Group ${groupId} not found`);
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) =>
      t.id === groupId ? ({ ...t, collapsed } as import("../project-model/types").GroupTrack) : t,
    ),
  };
  return snapshot("setGroupCollapsed", collapsed ? `Fold ${track.name}` : `Unfold ${track.name}`, doc, next);
}

export function setGroupMute(doc: ProjectDocument, groupId: string, mute: boolean): Command {
  const group = doc.tracks.find((t) => t.id === groupId && t.kind === "group");
  if (!group) throw new Error(`Group ${groupId} not found`);
  const memberCount = doc.tracks.filter((t) => t.kind !== "group" && t.groupId === groupId).length;
  // Write ONLY the group: the engine's soloAudibility silences members
  // through the group record, so the old member cascade was pure state
  // destruction — un-muting the group resurrected members the user had
  // individually muted before the group mute.
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => (t.id === groupId ? { ...t, mute } : t)),
  };
  return snapshot("setGroupMute", `${mute ? "Mute" : "Unmute"} ${group.name} (+${memberCount})`, doc, next);
}

export function setGroupSolo(doc: ProjectDocument, groupId: string, solo: boolean): Command {
  const group = doc.tracks.find((t) => t.id === groupId && t.kind === "group");
  if (!group) throw new Error(`Group ${groupId} not found`);
  const memberCount = doc.tracks.filter((t) => t.kind !== "group" && t.groupId === groupId).length;
  // Group-only write — same reasoning as setGroupMute above (soloAudibility
  // reads soloedGroups / groupsWithSoloedChild straight from the group).
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => (t.id === groupId ? { ...t, solo } : t)),
  };
  return snapshot("setGroupSolo", `${solo ? "Solo" : "Un-solo"} ${group.name} (+${memberCount})`, doc, next);
}

export function createReturnTrack(doc: ProjectDocument, name?: string): Command {
  const baseName = name?.trim() || `Return ${doc.returns.length + 1}`;
  const ret: import("../project-model/types").ReturnTrack = {
    id: uid("return"),
    kind: "return",
    name: baseName,
    gain: 0.9,
    effects: [],
  };
  const next: ProjectDocument = { ...doc, returns: [...doc.returns, ret] };
  return snapshot("createReturnTrack", `Add return ${baseName}`, doc, next);
}

export function addEffectToTracks(doc: ProjectDocument, trackIds: string[], type: EffectType): Command {
  if (trackIds.length === 0) throw new Error("Select at least one track");
  const unique = [...new Set(trackIds)];
  for (const id of unique)
    if (!doc.tracks.some((t) => t.id === id) && !doc.returns.some((r) => r.id === id))
      throw new Error(`Track ${id} not found`);
  let next: ProjectDocument = doc;
  for (const id of unique) {
    const isReturn = doc.returns.some((r) => r.id === id);
    if (isReturn) {
      const fx: EffectInstance = { id: uid("fx"), type, bypassed: false, params: defaultParamsOf(type) };
      if (type === "stepGate") fx.steps = [...DEFAULT_GATE_PATTERN];
      if (type === "stutter") fx.steps = Array.from({ length: 16 }, () => 1);
      next = { ...next, returns: next.returns.map((r) => (r.id === id ? { ...r, effects: [...r.effects, fx] } : r)) };
    } else {
      next = addEffect(next, id, type).execute(next);
    }
  }
  return snapshot("addEffectToTracks", `Add ${EFFECT_META[type].name} to ${unique.length} tracks`, doc, next);
}

/**
 * Batch-bypass / batch-enable every instance of `type` on the given tracks —
 * ONE command, one undo step (never a silent half-state).
 */
export function setEffectBypassOnTracks(
  doc: ProjectDocument,
  trackIds: string[],
  type: EffectType,
  bypassed: boolean,
): Command {
  if (trackIds.length === 0) throw new Error("Select at least one track");
  const unique = new Set(trackIds);
  const apply = (d: ProjectDocument): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) =>
      unique.has(t.id) && "effects" in t
        ? { ...t, effects: (t.effects as EffectInstance[]).map((f) => (f.type === type ? { ...f, bypassed } : f)) }
        : t,
    ),
    returns: d.returns.map((r) =>
      unique.has(r.id) ? { ...r, effects: r.effects.map((f) => (f.type === type ? { ...f, bypassed } : f)) } : r,
    ),
  });
  const touched = apply(doc);
  const count =
    doc.tracks
      .filter((t) => unique.has(t.id) && "effects" in t)
      .reduce((n, t) => n + (t.effects as EffectInstance[]).filter((f) => f.type === type).length, 0) +
    doc.returns
      .filter((r) => unique.has(r.id))
      .reduce((n, r) => n + r.effects.filter((f) => f.type === type).length, 0);
  if (count === 0) throw new Error(`No ${EFFECT_META[type].name} instances on the selected tracks`);
  return snapshot(
    "setEffectBypassOnTracks",
    `${bypassed ? "Bypass" : "Enable"} ${EFFECT_META[type].name} on ${unique.size} tracks`,
    doc,
    touched,
  );
}

/** Batch-remove every instance of `type` from the given tracks — one command. */
export function removeEffectFromTracks(doc: ProjectDocument, trackIds: string[], type: EffectType): Command {
  if (trackIds.length === 0) throw new Error("Select at least one track");
  const unique = new Set(trackIds);
  const apply = (d: ProjectDocument): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) =>
      unique.has(t.id) && "effects" in t
        ? { ...t, effects: (t.effects as EffectInstance[]).filter((f) => f.type !== type) }
        : t,
    ),
    returns: d.returns.map((r) => (unique.has(r.id) ? { ...r, effects: r.effects.filter((f) => f.type !== type) } : r)),
  });
  const touched = apply(doc);
  // Audit 05 D1: collect the removed instances' owner|fxId keys and prune
  // their automation/LFO/macro/MIDI references inside the command (see
  // stripDanglingEffectReferences) — otherwise undo lost the routings.
  const removedKeys = new Set<string>();
  for (const t of doc.tracks) {
    if (!unique.has(t.id) || !("effects" in t)) continue;
    for (const f of t.effects as EffectInstance[]) if (f.type === type) removedKeys.add(`${t.id}|${f.id}`);
  }
  for (const r of doc.returns) {
    if (!unique.has(r.id)) continue;
    for (const f of r.effects) if (f.type === type) removedKeys.add(`${r.id}|${f.id}`);
  }
  const pruned = stripDanglingEffectReferences(touched, removedKeys);
  const removed =
    doc.tracks
      .filter((t) => unique.has(t.id) && "effects" in t)
      .reduce((n, t) => n + (t.effects as EffectInstance[]).filter((f) => f.type === type).length, 0) +
    doc.returns
      .filter((r) => unique.has(r.id))
      .reduce((n, r) => n + r.effects.filter((f) => f.type === type).length, 0);
  if (removed === 0) throw new Error(`No ${EFFECT_META[type].name} instances on the selected tracks`);
  const command = snapshot(
    "removeEffectFromTracks",
    `Remove ${EFFECT_META[type].name} from ${unique.size} tracks`,
    doc,
    pruned,
  );
  const detail = cleanupDetail(doc, pruned);
  return detail ? { ...command, detail } : command;
}

/** Clear SOLO on every track and group — one command, one undo. */
export function clearAllSolos(doc: ProjectDocument): Command {
  const apply = (d: ProjectDocument): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) => (t.solo ? { ...t, solo: false } : t)),
  });
  const touched = apply(doc);
  const count = doc.tracks.filter((t) => t.solo).length;
  if (count === 0) throw new Error("Nothing is soloed");
  return snapshot("clearAllSolos", `Clear solo on ${count} tracks`, doc, touched);
}

/** Clear MUTE on every track and group — one command, one undo. */
export function clearAllMutes(doc: ProjectDocument): Command {
  const apply = (d: ProjectDocument): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) => (t.mute ? { ...t, mute: false } : t)),
  });
  const touched = apply(doc);
  const count = doc.tracks.filter((t) => t.mute).length;
  if (count === 0) throw new Error("Nothing is muted");
  return snapshot("clearAllMutes", `Clear mute on ${count} tracks`, doc, touched);
}

/* ---------------- effects ---------------- */

export function addEffect(
  doc: ProjectDocument,
  trackId: string,
  type: EffectType,
  insertAt?: number,
): Command & { readonly effectId: string } {
  const fx: EffectInstance = { id: uid("fx"), type, bypassed: false, params: defaultParamsOf(type) };
  if (type === "stepGate") fx.steps = [...DEFAULT_GATE_PATTERN];
  if (type === "stutter") fx.steps = Array.from({ length: 16 }, () => 1);
  const initialEffects = trackEffectsOf(doc, trackId);
  const insertionIndex =
    insertAt === undefined ? initialEffects.length : Math.max(0, Math.min(initialEffects.length, Math.floor(insertAt)));
  return {
    type: "addEffect",
    label: `Add ${EFFECT_META[type].name}`,
    effectId: fx.id,
    execute: (d) =>
      withTrackEffects(d, trackId, (effects) => {
        const next = [...effects];
        next.splice(Math.max(0, Math.min(next.length, insertionIndex)), 0, fx);
        return next;
      }),
    undo: (d) => withTrackEffects(d, trackId, (effects) => effects.filter((f) => f.id !== fx.id)),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i) as any;
        if (t.get("id") === trackId) {
          const effects = t.get("effects") as any;
          const fxMap = getYDocHelpers()?.createYMap?.() as any;
          if (!fxMap) return;
          fxMap.set("id", fx.id);
          fxMap.set("type", fx.type);
          fxMap.set("bypassed", false);
          const params = getYDocHelpers()?.createYMap?.() as any;
          if (!params) return;
          fxMap.set("params", params);
          for (const [k, v] of Object.entries(fx.params)) params.set(k, v);
          if (fx.steps) fxMap.set("steps", [...fx.steps]);
          effects.insert(Math.max(0, Math.min(effects.length, insertionIndex)), [fxMap]);
          break;
        }
      }
    },
  };
}

/**
 * Audit 05 D1: remove the effect AND every cross-reference HELD BY OTHER
 * ENTITIES (automation lanes, LFOs, scene automation, macro mappings, MIDI
 * CC/aftertouch targets) — inside the command, so the undo delta restores
 * them together with the device. The post-apply normalize pass prunes
 * dangling targets, so leaving them outside the delta meant Ctrl+Z brought
 * the device back while its routings were permanently gone (the exact
 * deleteTrack bug class).
 */
/**
 * Consequence note for the command toast (audit: silent fixes must be seen):
 * how many automation/modulation references a command cleaned up beyond what
 * the user asked for. Pure before/after counts — 0 means "nothing extra
 * happened" and the toast stays single-line.
 */
export function countReferenceCleanups(before: ProjectDocument, after: ProjectDocument): number {
  let count = 0;
  count += Math.max(0, (before.automation?.length ?? 0) - (after.automation?.length ?? 0));
  count += Math.max(0, (before.sceneAutomation?.length ?? 0) - (after.sceneAutomation?.length ?? 0));
  count += Math.max(0, (before.lfos?.length ?? 0) - (after.lfos?.length ?? 0));
  const beforeMappings = before.macros?.reduce((n, m) => n + m.mappings.length, 0) ?? 0;
  const afterMappings = after.macros?.reduce((n, m) => n + m.mappings.length, 0) ?? 0;
  count += Math.max(0, beforeMappings - afterMappings);
  count += Math.max(0, (before.midi?.ccMappings.length ?? 0) - (after.midi?.ccMappings.length ?? 0));
  if (before.midi?.aftertouchTarget && !after.midi?.aftertouchTarget) count += 1;
  return count;
}

export function cleanupDetail(before: ProjectDocument, after: ProjectDocument): string | undefined {
  const cleaned = countReferenceCleanups(before, after);
  return cleaned > 0 ? `${cleaned} automation/modulation reference${cleaned === 1 ? "" : "s"} cleaned up` : undefined;
}

export function stripDanglingEffectReferences(doc: ProjectDocument, removed: Set<string>): ProjectDocument {
  const keyOf = (target: import("../project-model/types").AutomationTarget | undefined | null): string =>
    target?.fxId ? `${String(target.trackId)}|${String(target.fxId)}` : "";
  const automation = doc.automation?.filter((lane) => !removed.has(keyOf(lane.target)));
  const sceneAutomation = doc.sceneAutomation?.filter((lane) => !removed.has(keyOf(lane.target)));
  const lfos = doc.lfos?.filter((lfo) => !removed.has(keyOf(lfo.target)));
  const macros = doc.macros?.map((macro) => ({
    ...macro,
    mappings: macro.mappings.filter((mapping) => !removed.has(keyOf(mapping.target))),
  }));
  const aftertouchGone = doc.midi?.aftertouchTarget ? removed.has(keyOf(doc.midi.aftertouchTarget)) : false;
  return {
    ...doc,
    ...(automation ? { automation } : {}),
    ...(lfos ? { lfos } : {}),
    ...(sceneAutomation ? { sceneAutomation } : {}),
    ...(macros ? { macros } : {}),
    ...(doc.midi
      ? {
          midi: {
            ...doc.midi,
            ccMappings: doc.midi.ccMappings.filter((mapping) => !removed.has(keyOf(mapping.target))),
            ...(aftertouchGone ? { aftertouchTarget: undefined } : {}),
          },
        }
      : {}),
  };
}
