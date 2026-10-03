import type { Command } from "./types";
import type { DrumPad, DrumTrack, ProjectDocument, Track } from "../project-model/types";
import { MAX_BPM, MIN_BPM } from "../project-model/schema";
import { setStepVelocityInPattern, withPad, withTrack } from "../project-model/transform";
import { clamp } from "../shared/ids";
import { getYDocHelpers } from "./yDocBridge";
import { snapshot } from "./core";

/**
 * Project-level commands and the pad / track parameter setters.
 *
 * This block sits at the bottom of the dependency graph: it reaches down into
 * the model helpers and up into nothing, so every other domain can import it
 * without a cycle.
 */
export function setProjectName(doc: ProjectDocument, name: string): Command {
  const prev = doc.name;
  return {
    type: "setProjectName",
    label: `Rename project to "${name}"`,
    execute: (d) => ({ ...d, name }),
    undo: (d) => ({ ...d, name: prev }),
    applyToYDoc: (yMap) => {
      yMap.set("name", name);
    },
  };
}

export function setBpm(doc: ProjectDocument, bpm: number): Command {
  const prev = doc.bpm;
  const value = clamp(bpm, MIN_BPM, MAX_BPM);
  return {
    type: "setBpm",
    label: `Set BPM to ${value}`,
    execute: (d) => ({ ...d, bpm: value }),
    undo: (d) => ({ ...d, bpm: prev }),
    applyToYDoc: (yMap) => {
      yMap.set("bpm", value);
    },
  };
}

export function toggleStep(doc: ProjectDocument, padId: string, stepIndex: number, defaultVelocity = 0.8): Command {
  const prev = doc.patterns.find((p) => p.id === doc.activePatternId)?.rows[padId]?.[stepIndex] ?? 0;
  const next = prev > 0 ? 0 : defaultVelocity;
  const patternId = doc.activePatternId;
  return {
    type: "toggleStep",
    label: prev > 0 ? `Remove step ${stepIndex + 1}` : `Add step ${stepIndex + 1}`,
    // Pin the pattern: undo stacks outlive pattern switches — resolving
    // against the apply-time active pattern made a step undo zero a step in
    // the WRONG pattern (see setStepVelocityInPattern / withTrackNotes).
    execute: (d) => setStepVelocityInPattern(d, patternId, padId, stepIndex, next),
    undo: (d) => setStepVelocityInPattern(d, patternId, padId, stepIndex, prev),
    applyToYDoc: (yMap) => {
      const helpers = getYDocHelpers();
      helpers?.yToggleStep(yMap, patternId, padId, stepIndex, defaultVelocity);
    },
  };
}

export function setStepVelocityCommand(
  doc: ProjectDocument,
  padId: string,
  stepIndex: number,
  velocity: number,
): Command {
  const prev = doc.patterns.find((p) => p.id === doc.activePatternId)?.rows[padId]?.[stepIndex] ?? 0;
  const patternId = doc.activePatternId;
  return {
    type: "setStepVelocity",
    label: `Set step ${stepIndex + 1} velocity`,
    execute: (d) => setStepVelocityInPattern(d, patternId, padId, stepIndex, velocity),
    undo: (d) => setStepVelocityInPattern(d, patternId, padId, stepIndex, prev),
    applyToYDoc: (yMap) => {
      const helpers = getYDocHelpers();
      helpers?.ySetStepVelocity(yMap, patternId, padId, stepIndex, velocity);
    },
  };
}

/**
 * REPLACE record mode: clear the active pattern's performed surfaces — drum
 * pad rows zero out, instrument-track note lists empty — in ONE undo step.
 * Non-performed surfaces (unknown pad ids / foreign note tracks) are left
 * untouched. Undo restores the previous rows + notes verbatim.
 */
export function prepareRecordPattern(doc: ProjectDocument): Command {
  const patternId = doc.activePatternId;
  const prev = doc.patterns.find((p) => p.id === patternId);
  const label = "Prepare pattern for recording";
  if (!prev) return { type: "prepareRecordPattern", label, execute: (d) => d, undo: (d) => d };
  const drumPadIds = new Set(doc.tracks.filter((t) => t.kind === "drum").flatMap((t) => t.pads.map((p) => p.id)));
  const instrumentTrackIds = new Set(doc.tracks.filter((t) => t.kind === "instrument").map((t) => t.id));
  const apply = (d: ProjectDocument): ProjectDocument => ({
    ...d,
    patterns: d.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const rows: Record<string, number[]> = {};
      for (const [padId, row] of Object.entries(p.rows)) {
        rows[padId] = drumPadIds.has(padId) ? row.map(() => 0) : [...row];
      }
      const notes: typeof p.notes = {};
      for (const [trackId, list] of Object.entries(p.notes ?? {})) {
        notes[trackId] = instrumentTrackIds.has(trackId) ? [] : list;
      }
      return { ...p, rows, notes };
    }),
  });
  const restore = (d: ProjectDocument): ProjectDocument => ({
    ...d,
    patterns: d.patterns.map((p) => (p.id === patternId ? { ...p, rows: prev.rows, notes: prev.notes ?? {} } : p)),
  });
  return { type: "prepareRecordPattern", label, execute: apply, undo: restore };
}

type PadParams = Partial<
  Pick<
    DrumPad,
    | "name"
    | "assetId"
    | "gain"
    | "pan"
    | "pitch"
    | "mute"
    | "solo"
    | "chokeGroup"
    | "sliceStart"
    | "sliceEnd"
    | "sliceFadeIn"
    | "sliceFadeOut"
    | "sliceReverse"
    | "layers"
  >
>;

export interface PadSlice {
  start: number;
  end: number;
  fadeIn?: number;
  fadeOut?: number;
  reverse?: boolean;
}

/**
 * Chop a sample onto the drum track's pads (chop-beats). Each slice becomes
 * one pad referencing the source asset with a [start, end) region — no
 * buffer copies, reload-safe, and undoable as one gesture.
 */
export function sliceToPads(
  doc: ProjectDocument,
  trackId: string,
  assetId: string,
  slices: PadSlice[],
  sourceName = "Chop",
): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track || track.kind !== "drum") throw new Error(`Drum track ${trackId} not found`);
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.id !== trackId || t.kind !== "drum") return t;
      return {
        ...t,
        pads: t.pads.map((pad, index) => {
          const slice = slices[index];
          if (!slice) return pad;
          return {
            ...pad,
            assetId,
            sliceStart: slice.start,
            sliceEnd: slice.end,
            sliceFadeIn: slice.fadeIn ?? 0,
            sliceFadeOut: slice.fadeOut ?? 0,
            sliceReverse: slice.reverse ?? false,
            name: `${sourceName} ${String(index + 1).padStart(2, "0")}`,
          };
        }),
      };
    }),
  };
  return snapshot("sliceToPads", `Chop ${slices.length} slices to pads`, doc, next);
}

export function setPadParams(doc: ProjectDocument, padId: string, params: PadParams): Command {
  // The pad must be resolved across ALL drum tracks — projects routinely
  // carry several (user-creatable). Scoping the lookup to the first drum
  // track made both the undo baseline and the collab fast path silently
  // miss pads living on later tracks.
  let current: import("../project-model/types").DrumPad | undefined;
  for (const t of doc.tracks) {
    if (t.kind !== "drum") continue;
    const pad = t.pads.find((p) => p.id === padId);
    if (pad) {
      current = pad;
      break;
    }
  }
  const prev = { ...current } as PadParams;
  // `layers` is ALWAYS present in the undo baseline (possibly undefined), so
  // the "an explicitly-undefined key clears the field" rule below can undo an
  // add: Object.entries drops undefined values, so a baseline that simply
  // lacks the key would leave the added set in place forever.
  prev.layers = current?.layers;
  const apply = (d: ProjectDocument, values: PadParams): ProjectDocument =>
    withPad(d, padId, (pad) => {
      const next = { ...pad, ...values };
      // Assigning a different source must not leave the old source's region
      // attached to the new asset.
      if (values.assetId !== undefined && values.assetId !== pad.assetId) {
        delete next.sliceStart;
        delete next.sliceEnd;
        delete next.sliceFadeIn;
        delete next.sliceFadeOut;
        delete next.sliceReverse;
      }
      // An explicit `layers: undefined` clears the set (spread would leave the
      // stale value in place — the undo of "add layers" needs a real delete).
      if (values.layers === undefined && "layers" in values) delete next.layers;
      return next;
    });
  return {
    type: "setPadParams",
    label: `Edit pad ${padId}`,
    execute: (d) => apply(d, params),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      outer: for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("kind") !== "drum") continue;
        const pads = t.get("pads") as any;
        for (let j = 0; j < pads.length; j++) {
          if (pads.get(j).get("id") === padId) {
            const target = pads.get(j);
            const sourceChanged = params.assetId !== undefined && params.assetId !== target.get("assetId");
            for (const [k, v] of Object.entries(params)) {
              if (v !== undefined) target.set(k, v);
            }
            // `layers` is authoritative per apply (see the note on `prev`):
            // Object.entries cannot express "delete", so handle it explicitly.
            if ("layers" in params) {
              if (params.layers !== undefined) target.set("layers", params.layers);
              else target.delete("layers");
            }
            if (sourceChanged) {
              for (const key of ["sliceStart", "sliceEnd", "sliceFadeIn", "sliceFadeOut", "sliceReverse"])
                target.delete(key);
            }
            break outer;
          }
        }
      }
    },
  };
}

export function setPadSynth(
  doc: ProjectDocument,
  padId: string,
  synth: import("../project-model/types").DrumSynthConfig | null,
): Command {
  const nextDoc: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.kind !== "drum") return t;
      return {
        ...t,
        pads: t.pads.map((p) => {
          if (p.id !== padId) return p;
          const next: any = { ...p, synth: synth ? { ...synth } : null };
          // When switching to synth, clear sample to avoid confusion
          if (synth) {
            next.assetId = null;
            delete next.sliceStart;
            delete next.sliceEnd;
            delete next.sliceFadeIn;
            delete next.sliceFadeOut;
            delete next.sliceReverse;
          }
          return next;
        }),
      };
    }),
  };
  // Delta snapshot, not a whole-doc pin: this command is dispatched from
  // React commit callbacks with a render-captured doc — `execute: () => nextDoc`
  // would replace the ENTIRE document with the stale build and silently
  // revert any edit that landed between render and commit (live MIDI notes,
  // collab fallback). The delta applies only the pad change to the live doc.
  return snapshot("setPadSynth", synth ? `Set ${synth.type} synth` : "Clear synth", doc, nextDoc);
}

/** Assign (or clear) the MPC-style per-pad LFO on one drum pad. */
export function setPadMod(
  doc: ProjectDocument,
  padId: string,
  mod: import("../project-model/types").PadMod | null,
): Command {
  let found = false;
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.kind !== "drum") return t;
      const drum = t as DrumTrack;
      if (!drum.pads.some((p) => p.id === padId)) return t;
      found = true;
      return {
        ...drum,
        pads: drum.pads.map((p) => (p.id === padId ? { ...p, mod: mod ? { ...mod } : null } : p)),
      };
    }),
  };
  if (!found) throw new Error(`Pad ${padId} not found`);
  return snapshot("setPadMod", mod ? `Pad LFO → ${mod.target}` : "Pad LFO off", doc, next);
}

type TrackParams = Partial<Pick<Track, "name" | "gain" | "pan" | "mute" | "solo">>;

export function setTrackParams(doc: ProjectDocument, trackId: string, params: TrackParams): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  // Clamp at the boundary (normalize clamps too, but this command is also
  // the collab/YDoc path): gain [0,1.5], pan [-1,1], booleans strict.
  const safe: TrackParams = {
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.gain !== undefined
      ? { gain: Number.isFinite(params.gain) ? Math.min(1.5, Math.max(0, params.gain)) : track.gain }
      : {}),
    ...(params.pan !== undefined
      ? { pan: Number.isFinite(params.pan) ? Math.min(1, Math.max(-1, params.pan)) : track.pan }
      : {}),
    ...(params.mute !== undefined ? { mute: params.mute === true } : {}),
    ...(params.solo !== undefined ? { solo: params.solo === true } : {}),
  };
  // Drop fields equal to the current value — a fader click without drag or
  // a double-click reset otherwise pushed no-op undo entries (the track
  // spread always builds a new object, so the store's identity guard fired).
  const effective: TrackParams = {};
  for (const [k, v] of Object.entries(safe)) {
    if (v !== undefined && v !== (track as unknown as Record<string, unknown>)[k]) {
      (effective as Record<string, unknown>)[k] = v;
    }
  }
  if (Object.keys(effective).length === 0) {
    return { type: "setTrackParams", label: "Edit track", execute: (d) => d, undo: (d) => d };
  }
  const prev: TrackParams = Object.fromEntries(
    Object.keys(effective).map((k) => [k, (track as unknown as Record<string, unknown>)[k]]),
  );
  const apply = (d: ProjectDocument, values: TrackParams): ProjectDocument =>
    withTrack(d, trackId, (t) => ({ ...t, ...values }));
  return {
    type: "setTrackParams",
    label: `Edit track ${track.name}`,
    execute: (d) => apply(d, effective),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i) as any;
        if (t.get("id") === trackId) {
          for (const [k, v] of Object.entries(effective)) {
            if (v !== undefined) t.set(k, v);
          }
          break;
        }
      }
    },
  };
}
