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
    tracks: d.tracks.map((t) =>
      // Copy the params map on every apply: the closure-owned next/prev maps
      // are shared by execute and every undo/redo cycle — inserting them by
      // reference would alias one mutable object across doc revisions.
      t.kind === "instrument" && t.id === trackId
        ? { ...t, params: { ...params }, sampleId, presetId, ...(velocityLayers ? { velocityLayers } : {}) }
        : t,
    ),
  });
  return {
    type: "applyInstrumentPreset",
    label: `Apply preset "${preset.name}"`,
    execute: (d) => apply(d, nextParams, nextSample, preset.id, nextLayers),
    undo: (d) => apply(d, prevParams, prevSample, prevPresetId, prevLayers),
  };
}
