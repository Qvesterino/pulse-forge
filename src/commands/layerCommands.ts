import type { Command } from "./types";
import type { InstrumentTrack, ProjectDocument, SampleLayer } from "../project-model/types";
import type { RandomizeMode } from "../instruments/randomize";
import { randomizeParams } from "../instruments/randomize";
import { snapshot } from "./commands";

function sanitizeLayers(layers: unknown): SampleLayer[] {
  const raw = Array.isArray(layers) ? (layers as unknown[]) : [];
  const clean: SampleLayer[] = [];
  for (const item of raw) {
    const l = (item ?? {}) as Partial<SampleLayer> & Record<string, unknown>;
    const min = typeof l.min === "number" && Number.isFinite(l.min) ? Math.min(1, Math.max(0, l.min)) : NaN;
    const max = typeof l.max === "number" && Number.isFinite(l.max) ? Math.min(1, Math.max(0, l.max)) : NaN;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) continue;
    const minPitch =
      typeof l.minPitch === "number" && Number.isFinite(l.minPitch)
        ? Math.round(Math.min(127, Math.max(0, l.minPitch)))
        : undefined;
    const maxPitch =
      typeof l.maxPitch === "number" && Number.isFinite(l.maxPitch)
        ? Math.round(Math.min(127, Math.max(0, l.maxPitch)))
        : undefined;
    clean.push({
      id: typeof l.id === "string" && l.id ? l.id : `layer-${clean.length}`,
      sampleId: typeof l.sampleId === "string" ? l.sampleId : null,
      min,
      max,
      ...(minPitch !== undefined && maxPitch !== undefined && minPitch <= maxPitch ? { minPitch, maxPitch } : {}),
    });
  }
  return clean;
}

/**
 * Replace a sampler track's velocity/round-robin layers. Empty array clears
 * the layers (back to classic single-sample mode via `sampleId`). Undo
 * restores the previous layer set.
 */
export function setVelocityLayersCommand(
  doc: ProjectDocument,
  trackId: string,
  layers: unknown,
  /** Optional sampler fallback to change atomically with the layer set. */
  fallbackSampleId?: string | null,
): Command {
  const clean = sanitizeLayers(layers);
  const target = doc.tracks.find(
    (t): t is InstrumentTrack => t.id === trackId && t.kind === "instrument",
  );
  if (!target) throw new Error(`Instrument track ${trackId} not found`);
  if (target.instrument !== "sampler") throw new Error(`Velocity layers require a sampler track`);
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) =>
      t.id === trackId && t.kind === "instrument"
        ? {
            ...t,
            velocityLayers: clean.length > 0 ? clean : undefined,
            ...(fallbackSampleId !== undefined ? { sampleId: fallbackSampleId } : {}),
          }
        : t,
    ),
  };
  return snapshot(
    "setVelocityLayers",
    `${fallbackSampleId !== undefined ? "Apply" : "Set"} ${clean.length} velocity layer${clean.length === 1 ? "" : "s"}`,
    doc,
    next,
  );
}

/**
 * Randomize an instrument track's parameters with musical constraints.
 * mode "mutate" nudges ±12 % of range around current values, "deep" redraws
 * the whole patch (log-distributed cutoffs, options re-rolled). Level/gain
 * and the sampler root are never touched. Seeded — undo/redo is exact.
 */
export function randomizeInstrumentCommand(
  doc: ProjectDocument,
  trackId: string,
  mode: RandomizeMode,
  seed: number,
): Command {
  const target = doc.tracks.find((t): t is InstrumentTrack => t.id === trackId && t.kind === "instrument");
  if (!target) throw new Error(`Instrument track ${trackId} not found`);
  const next = randomizeParams(target.instrument, target.params, mode, seed);
  const label = mode === "mutate" ? `Mutate ${target.name}` : `Deep randomize ${target.name}`;
  return snapshot("randomizeInstrument", label, doc, {
    ...doc,
    tracks: doc.tracks.map((t) =>
      t.kind === "instrument" && t.id === trackId ? { ...t, params: next, presetId: null } : t,
    ),
  });
}
