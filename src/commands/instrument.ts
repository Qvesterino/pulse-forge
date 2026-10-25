import type { Command } from "./types";
import type { InstrumentTrack, ProjectDocument } from "../project-model/types";
import { INSTRUMENT_META, clampInstrumentParam, defaultInstrumentParams } from "../instruments/definitions";
import type { InstrumentPreset } from "../presets/types";

/** Instrument parameters, sample selection and preset application. */
/* ---------------- instrument params ---------------- */

export function setInstrumentParam(doc: ProjectDocument, trackId: string, paramId: string, value: number): Command {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId);
  if (!track) throw new Error(`Instrument track ${trackId} not found`);
  const prev = track.params[paramId] ?? defaultInstrumentParams(track.instrument)[paramId];
  const clamped = clampInstrumentParam(track.instrument, paramId, value);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) =>
      t.kind === "instrument" && t.id === trackId ? { ...t, params: { ...t.params, [paramId]: v } } : t,
    ),
  });
  return {
    type: "setInstrumentParam",
    label: `Set ${INSTRUMENT_META[track.instrument].name} ${paramId}`,
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("id") === trackId) {
          (t.get("params") as any).set(paramId, clamped);
          break;
        }
      }
    },
  };
}

/**
 * Set SEVERAL instrument parameters as ONE undoable step.
 *
 * The KOPA editor drags a whole kick shape (a layer's length AND its level,
 * or the pitch envelope's amount AND its time) — a drag must land as ONE
 * undo action, not one per pointer move. This command owns that: it records
 * the previous value of every key it touches, so the undo restores exactly
 * what was there and nothing else.
 *
 * The values are clamped with the instrument's own definitions, so a drag
 * that overshoots writes the legal range — the same rule the single-param
 * command obeys.
 */
export function setInstrumentParams(
  doc: ProjectDocument,
  trackId: string,
  params: Record<string, number>,
  label = "Set parameters",
): Command {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId);
  if (!track) throw new Error(`Instrument track ${trackId} not found`);
  const defaults = defaultInstrumentParams(track.instrument);
  const prev: Record<string, number> = {};
  const next: Record<string, number> = {};
  for (const [key, raw] of Object.entries(params)) {
    const value = clampInstrumentParam(track.instrument, key, raw);
    if (!Number.isFinite(value)) continue;
    prev[key] = track.params[key] ?? defaults[key] ?? value;
    next[key] = value;
  }
  const apply = (d: ProjectDocument, values: Record<string, number>): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) =>
      t.kind === "instrument" && t.id === trackId ? { ...t, params: { ...t.params, ...values } } : t,
    ),
  });
  return {
    type: "setInstrumentParams",
    label: `${INSTRUMENT_META[track.instrument].name} — ${label}`,
    execute: (d) => apply(d, next),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("id") === trackId) {
          const yParams = t.get("params") as any;
          for (const [key, value] of Object.entries(next)) yParams.set(key, value);
          break;
        }
      }
    },
  };
}

export function setInstrumentSample(doc: ProjectDocument, trackId: string, assetId: string | null): Command {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId);
  if (!track) throw new Error(`Instrument track ${trackId} not found`);
  const prev = track.sampleId;
  const apply = (d: ProjectDocument, v: string | null): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) => (t.kind === "instrument" && t.id === trackId ? { ...t, sampleId: v } : t)),
  });
  return {
    type: "setInstrumentSample",
    label: `Set sample`,
    execute: (d) => apply(d, assetId),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("id") === trackId) {
          t.set("sampleId", assetId);
          break;
        }
      }
    },
  };
}

/**
 * Apply an instrument preset as a single undoable step: replaces the track's
 * parameters (instrument defaults overlaid with clamped preset overrides),
 * sampler sample, and preset id. Factory presets are intentionally sparse, so
 * omitted parameters must resolve to defaults rather than leaking the previous
 * patch into the newly selected sound.
 */
export function applyInstrumentPreset(doc: ProjectDocument, trackId: string, preset: InstrumentPreset): Command {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId);
  if (!track) throw new Error(`Instrument track ${trackId} not found`);
  const prevParams = { ...track.params };
  const prevSample = track.sampleId;
  const prevPresetId = track.presetId ?? null;
  const prevLayers = track.velocityLayers ?? null;

  const nextParams: Record<string, number> = defaultInstrumentParams(track.instrument);
  for (const [key, value] of Object.entries(preset.params)) {
    nextParams[key] = clampInstrumentParam(track.instrument, key, value);
  }
  const nextSample = preset.sampleId !== undefined ? preset.sampleId : track.sampleId;
  const nextLayers = preset.velocityLayers !== undefined ? preset.velocityLayers : (track.velocityLayers ?? null);

  const apply = (
    d: ProjectDocument,
    params: Record<string, number>,
    sampleId: string | null,
    presetId: string | null,
    velocityLayers: import("../project-model/types").SampleLayer[] | null,
  ): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) => {
      if (t.kind !== "instrument" || t.id !== trackId) return t;
      // Copy the params map on every apply: the closure-owned next/prev maps
      // are shared by execute and every undo/redo cycle — inserting them by
      // reference would alias one mutable object across doc revisions.
      const next: InstrumentTrack = { ...t, params: { ...params }, sampleId, presetId };
      if (velocityLayers) next.velocityLayers = velocityLayers;
      else delete next.velocityLayers;
      return next;
    }),
  });
  return {
    type: "applyInstrumentPreset",
    label: `Apply preset "${preset.name}"`,
    execute: (d) => apply(d, nextParams, nextSample, preset.id, nextLayers),
    undo: (d) => apply(d, prevParams, prevSample, prevPresetId, prevLayers),
  };
}

/**
 * Apply a full instrument patch (e.g. a Patch Mutations tournament winner)
 * as ONE undoable step: replaces the track's parameter map wholesale, keeps
 * sample/velocity-layers, and clears the preset id — a mutated patch is no
 * longer the preset it started from. Mirrors `applyInstrumentPreset`'s
 * params handling: every incoming value is clamped, and the params map is
 * copied on every apply so undo/redo never alias a shared object.
 */
export function applyInstrumentPatch(
  doc: ProjectDocument,
  trackId: string,
  params: Record<string, number>,
  label = "Apply patch",
): Command {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId);
  if (!track) throw new Error(`Instrument track ${trackId} not found`);
  const prevParams = { ...track.params };
  const prevPresetId = track.presetId ?? null;

  const nextParams: Record<string, number> = { ...params };
  for (const key of Object.keys(nextParams)) {
    nextParams[key] = clampInstrumentParam(track.instrument, key, nextParams[key]!);
  }

  const apply = (d: ProjectDocument, patch: Record<string, number>, presetId: string | null): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) =>
      t.kind === "instrument" && t.id === trackId ? { ...t, params: { ...patch }, presetId } : t,
    ),
  });
  return {
    type: "applyInstrumentPatch",
    label: `${INSTRUMENT_META[track.instrument].name} — ${label}`,
    execute: (d) => apply(d, nextParams, null),
    undo: (d) => apply(d, prevParams, prevPresetId),
  };
}

/**
 * Apply a KOPA Forge plan to a KOPA track: the measured kick parameters
 * overlay the current patch as ONE undoable step (the CHORÁL
 * applyInstrumentPatch semantics — a forged patch is no longer the preset
 * it started from, so the preset id clears).
 */
export function forgeKickCommand(
  doc: ProjectDocument,
  trackId: string,
  plan: { params: Record<string, number>; rootMidi: number | null },
): Command {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  if (track.kind !== "instrument" || track.instrument !== "kopa") {
    throw new Error("Kick Forge applies to a KOPA track");
  }
  const prevParams = { ...track.params };
  const prevPresetId = track.presetId ?? null;
  const nextParams: Record<string, number> = { ...track.params };
  for (const [key, value] of Object.entries(plan.params)) {
    nextParams[key] = clampInstrumentParam(track.instrument, key, value);
  }
  const apply = (d: ProjectDocument, patch: Record<string, number>, presetId: string | null): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) =>
      t.kind === "instrument" && t.id === trackId ? { ...t, params: { ...patch }, presetId } : t,
    ),
  });
  return {
    type: "forgeKick",
    label: `Kick Forge — ${plan.rootMidi !== null ? `root MIDI ${plan.rootMidi}, ` : ""}fitted patch`,
    execute: (d) => apply(d, nextParams, null),
    undo: (d) => apply(d, prevParams, prevPresetId),
  };
}
