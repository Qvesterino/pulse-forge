import type { Command } from "./types";
import type { ProjectDocument } from "../project-model/types";

/**
 * Freeze / Unfreeze: render a track to an AudioBuffer and swap the live
 * signal for it, so a heavy track stops costing CPU during playback.
 *
 * Both commands are the reason `execute` has to be functional. The render
 * that produces the buffer takes seconds, so the document can move on while
 * it runs — the command applies to whatever is current at dispatch time
 * and no-ops if the track was deleted in the meantime.
 */
// ---------------------------------------------------------------------------
// Freeze / Unfreeze
// ---------------------------------------------------------------------------

export function freezeTrack(
  doc: ProjectDocument,
  trackId: string,
  bufferId: string,
  durationSec: number,
  sampleRate: number,
): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  if (track.kind === "group") {
    // State-invariant guard: a frozen group is a persisted lie — the offline
    // renderer includes only the (source-less) group itself, so the buffer
    // is silence, nothing is saved, and the "FROZEN" state survives
    // save/load. Freeze the child tracks instead.
    throw new Error(`Group track ${track.name} cannot be frozen — freeze its child tracks instead`);
  }
  const label = `Freeze ${track.name}`;
  // Freeze is dispatched AFTER a seconds-long offline render — it must apply
  // to whatever document is current at dispatch time, not the snapshot taken
  // when rendering started (a snapshot silently reverts concurrent edits).
  let prevFrozen: ProjectDocument["tracks"][number]["frozen"] = undefined;
  return {
    type: "freezeTrack",
    label,
    execute: (d) => {
      if (!d.tracks.some((t) => t.id === trackId)) return d;
      prevFrozen = d.tracks.find((t) => t.id === trackId)?.frozen;
      return {
        ...d,
        tracks: d.tracks.map((t) => (t.id === trackId ? { ...t, frozen: { bufferId, durationSec, sampleRate } } : t)),
      };
    },
    undo: (d) => {
      if (!d.tracks.some((t) => t.id === trackId)) return d;
      return {
        ...d,
        tracks: d.tracks.map((t) => {
          if (t.id !== trackId) return t;
          if (prevFrozen === undefined) {
            const { frozen: _, ...rest } = t as any;
            return rest;
          }
          return { ...t, frozen: prevFrozen };
        }),
      };
    },
  };
}

export function unfreezeTrack(doc: ProjectDocument, trackId: string): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  const label = `Unfreeze ${track.name}`;
  let prevFrozen: ProjectDocument["tracks"][number]["frozen"] = undefined;
  return {
    type: "unfreezeTrack",
    label,
    execute: (d) => {
      if (!d.tracks.some((t) => t.id === trackId)) return d;
      prevFrozen = d.tracks.find((t) => t.id === trackId)?.frozen;
      return {
        ...d,
        tracks: d.tracks.map((t) => (t.id === trackId ? { ...t, frozen: undefined } : t)),
      };
    },
    undo: (d) => {
      if (!d.tracks.some((t) => t.id === trackId)) return d;
      return {
        ...d,
        tracks: d.tracks.map((t) => {
          if (t.id !== trackId) return t;
          if (prevFrozen === undefined) {
            const { frozen: _, ...rest } = t as any;
            return rest;
          }
          return { ...t, frozen: prevFrozen };
        }),
      };
    },
  };
}
