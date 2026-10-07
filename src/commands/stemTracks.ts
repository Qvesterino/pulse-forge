import type { Command } from "./types";
import type { ProjectDocument } from "../project-model/types";
import type { StemRole } from "../mcp/stem-mastering";
import { addAudioClip } from "./audioClips";
import { createGroupTrackModel, createInstrumentTrackModel } from "../project-model/schema";
import { snapshot } from "./core";

/**
 * STEM TRACK IMPORT — the last mile of the separation→mastering flow: turn
 * separated stem buffers into project lanes so the mastering family can work
 * on them (kyx_master op:stems matches lanes by role name). One audio clip
 * per stem placed at bar 0 on a track named after its role, all lanes routed
 * into one "STEMS" bus — a ready-to-master group. Everything folds into ONE
 * undoable snapshot. Pure command-layer composition; the caller (separation
 * panel / MCP) hands over bufferIds, this module never touches audio.
 */

export interface StemTrackSpec {
  role: StemRole;
  bufferId: string;
  durationSec: number;
}

const ROLE_LABEL: Record<StemRole, string> = {
  vocals: "Vocals",
  drums: "Drums",
  bass: "Bass",
  other: "Other",
};

export function addStemTracksCommand(doc: ProjectDocument, stems: StemTrackSpec[]): Command {
  if (stems.length === 0) throw new Error("no stems given");
  const bpm = doc.bpm || 124;
  let next = doc;
  const group = createGroupTrackModel("STEMS");
  next = { ...next, tracks: [...next.tracks, group] };
  for (const spec of stems) {
    if (!spec.bufferId) throw new Error(`stem "${spec.role}" is missing a bufferId`);
    if (!Number.isFinite(spec.durationSec) || spec.durationSec <= 0)
      throw new Error(`stem "${spec.role}" has a non-finite duration`);
    const track = createInstrumentTrackModel("sampler", next.tracks.length);
    next = { ...next, tracks: [...next.tracks, { ...track, name: ROLE_LABEL[spec.role], groupId: group.id }] };
    // Clip length in bars, rounded up to cover the full buffer.
    const secPerBar = (4 * 60) / bpm;
    const lengthBars = Math.max(1, Math.ceil(spec.durationSec / secPerBar));
    next = addAudioClip(next, track.id, spec.bufferId, 0, lengthBars).execute(next);
  }
  return snapshot("addStemTracks", `Import ${stems.length} stem lane(s) into STEMS bus`, doc, next);
}
