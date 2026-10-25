import type { ProjectDocument } from "../project-model/types";
import { targetTrackIds } from "./semantics/target-resolution";
import { MIX_TARGET_IDS, type MixTargetId } from "./semantics/target-registry";

/**
 * Deictic track references ("this track", "the selected channel", "túto
 * stopu") have no family word for the deterministic router to resolve. The UI
 * owns the selection, so it can rewrite the reference to the ONE mix target
 * that resolves exactly to the selected track before routing.
 *
 * The rewrite is deliberately conservative: a family that resolves to more
 * than one track is NOT used, because "this track" must never silently fan out
 * to its siblings. When no exact single-track family exists the sentence is
 * left untouched and the router clarifies.
 */
const DEICTIC_TRACK =
  /\b(?:this|that|the selected|the current|selected|current)\s+(?:track|channel|lane)\b|\b(?:túto|tejto|vybranú|aktuálnu)\s+(?:stopu|stope|track)\b/i;

export interface SelectedTrackRewrite {
  text: string;
  target: MixTargetId | null;
  rewritten: boolean;
}

export function rewriteSelectedTrackReference(
  text: string,
  doc: ProjectDocument,
  selectedTrackId: string | null | undefined,
): SelectedTrackRewrite {
  if (!selectedTrackId || !DEICTIC_TRACK.test(text)) {
    return { text, target: null, rewritten: false };
  }
  if (!doc.tracks.some((track) => track.id === selectedTrackId)) {
    return { text, target: null, rewritten: false };
  }
  const target = MIX_TARGET_IDS.find((candidate) => {
    const ids = targetTrackIds(doc, [candidate]);
    return ids.length === 1 && ids[0] === selectedTrackId;
  });
  if (!target) return { text, target: null, rewritten: false };
  return { text: text.replace(DEICTIC_TRACK, `the ${target}`), target, rewritten: true };
}
