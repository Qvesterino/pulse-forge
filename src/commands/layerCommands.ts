import type { Command } from "./types";
import type { InstrumentTrack, ProjectDocument, SampleLayer } from "../project-model/types";
import { snapshot } from "./commands";

function sanitizeLayers(layers: unknown): SampleLayer[] {
  const raw = Array.isArray(layers) ? (layers as unknown[]) : [];
  const clean: SampleLayer[] = [];
  for (const item of raw) {
    const l = (item ?? {}) as Partial<SampleLayer> & Record<string, unknown>;
    const min = typeof l.min === "number" && Number.isFinite(l.min) ? Math.min(1, Math.max(0, l.min)) : NaN;
    const max = typeof l.max === "number" && Number.isFinite(l.max) ? Math.min(1, Math.max(0, l.max)) : NaN;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) continue;
    clean.push({
      id: typeof l.id === "string" && l.id ? l.id : `layer-${clean.length}`,
      sampleId: typeof l.sampleId === "string" ? l.sampleId : null,
      min,
      max,
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
): Command {
  const clean = sanitizeLayers(layers);
  const target = doc.tracks.find(
    (t): t is InstrumentTrack => t.id === trackId && t.kind === "instrument",
  );
  if (!target) throw new Error(`Instrument track ${trackId} not found`);
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) =>
      t.id === trackId && t.kind === "instrument"
        ? { ...t, velocityLayers: clean.length > 0 ? clean : undefined }
        : t,
    ),
  };
  return snapshot("setVelocityLayers", `Set ${clean.length} velocity layer${clean.length === 1 ? "" : "s"}`, doc, next);
}
