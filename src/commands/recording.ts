import { snapshot } from "./core";
import type { Command } from "./types";
import type { ProjectDocument } from "../project-model/types";

/**
 * Arm a track for recording — the track a recorded take lands on.
 *
 * The arm used to be local React state inside the arrangement panel, which
 * made the recording family the one family the command palette could not
 * reach: nothing could arm a track, script it, or undo it. It is a PROJECT
 * fact — where a take lands is part of the song, exactly like the selected
 * Live Set — so it lives in the document and moves through the ordinary
 * command path.
 *
 * The capture SESSION's own state (second channel, extra input routes, take
 * mode, punch/loop flags, recorder status) deliberately does NOT live here:
 * it describes a running capture rather than a song, so it must not be
 * persisted and must not be undoable.
 */
export function setRecordingArm(doc: ProjectDocument, trackId: string): Command {
  const armed = trackId || undefined;
  const current = doc.recording?.armedTrackId;
  const track = doc.tracks.find((t) => t.id === trackId);
  // An unchanged arm must not push an undo frame that does nothing.
  if (current === armed) {
    return snapshot("setRecordingArm", "Arm recording", doc, doc);
  }
  const next: ProjectDocument = {
    ...doc,
    recording: { ...(doc.recording ?? {}), armedTrackId: armed },
  };
  return snapshot(
    "setRecordingArm",
    armed ? `Arm ${track?.name ?? trackId} for recording` : "Disarm recording",
    doc,
    next,
  );
}
