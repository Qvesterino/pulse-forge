/**
 * Pad-level edits: drop the project-local slice edit from a pad, and chop a sample across a drum
 * track's pads.
 *
 * Resetting a slice keeps the pad's asset and clears only the edit, so a pad that was chopped and
 * then re-sliced returns to the plain sample without re-assigning anything. Chopping is the
 * destructive direction: it maps the source's slices onto the pads the track actually has, which may
 * be fewer than the source has slices, and can lay down a pattern with one hit per slice. Both the
 * pad rewrite and the pattern creation are folded into a single snapshot, so a chop that fails
 * half-way leaves nothing behind - there is no state where the pads changed and the pattern did not.
 */
import { type PadSlice, sliceToPads } from "./project";
import type { Command } from "./types";
import type { DrumTrack, ProjectDocument } from "../project-model/types";
import { withPad } from "../project-model/transform";
import { createPatternForDoc } from "../project-model/schema";
import { snapshot } from "./core";

/* ---------------- pad ops ---------------- */

/** Remove the project-local slice edit from a pad while keeping its asset. */
export function resetPadSlice(doc: ProjectDocument, padId: string): Command {
  const pad = doc.tracks.flatMap((t) => (t.kind === "drum" ? t.pads : [])).find((p) => p.id === padId);
  if (!pad) throw new Error(`Pad ${padId} not found`);
  const next = withPad(doc, padId, (current) => {
    const clean = { ...current };
    delete clean.sliceStart;
    delete clean.sliceEnd;
    delete clean.sliceFadeIn;
    delete clean.sliceFadeOut;
    delete clean.sliceReverse;
    return clean;
  });
  return snapshot("resetPadSlice", `Reset slice on ${pad.name}`, doc, next);
}

export interface ChopSampleOptions {
  trackId: string;
  assetId: string;
  sourceName: string;
  slices: PadSlice[];
  createPattern: boolean;
}

/** Atomically map a source's first 16 slices and optionally create a pattern. */
export function chopSampleToPads(doc: ProjectDocument, options: ChopSampleOptions): Command {
  const track = doc.tracks.find((t): t is DrumTrack => t.id === options.trackId && t.kind === "drum");
  if (!track) throw new Error(`Drum track ${options.trackId} not found`);
  const fit = options.slices.slice(0, track.pads.length);
  let next = sliceToPads(doc, options.trackId, options.assetId, fit, options.sourceName).execute(doc);

  if (options.createPattern) {
    const pattern = createPatternForDoc(next, `${options.sourceName} Chop`, 16);
    const rows = { ...pattern.rows };
    fit.forEach((_, index) => {
      const pad = track.pads[index];
      if (!pad) return;
      const row = [...(rows[pad.id] ?? new Array<number>(16).fill(0))];
      row[index] = 0.9;
      rows[pad.id] = row;
    });
    const choppedPattern = { ...pattern, rows };
    next = {
      ...next,
      patterns: [...next.patterns, choppedPattern],
      activePatternId: choppedPattern.id,
    };
  }

  return snapshot(
    "chopSampleToPads",
    options.createPattern ? `Chop ${fit.length} slices + create pattern` : `Chop ${fit.length} slices to pads`,
    doc,
    next,
  );
}
