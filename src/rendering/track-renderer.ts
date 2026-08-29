import type { ProjectDocument } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { renderProject, type RenderOptions } from "./renderer";

/**
 * Render a single track (or group) to an AudioBuffer.
 * Uses the filter-document approach: creates a stripped-down project with only
 * the target track (and its send returns + parent group) and feeds it to the
 * existing `renderProject()` renderer. This reuses 100% of the existing
 * offline rendering logic (groove engine, automation expansion, FX chains).
 *
 * Limitations:
 * - Sidechain compressor is skipped (setInterval-based, unreliable offline)
 * - Group tracks: include the group's gain/pan/FX in the frozen buffer
 * - Returns: include relevant return tracks so sends are captured
 */
export function renderTrack(
  doc: ProjectDocument,
  trackId: string,
  bank: SampleBank,
  options: RenderOptions,
): Promise<AudioBuffer> {
  const filtered = createFilteredDoc(doc, trackId);
  return renderProject(filtered, bank, options);
}

/**
 * Create a filtered ProjectDocument containing only the target track,
 * its parent group (if any), and return tracks it sends to.
 */
function createFilteredDoc(doc: ProjectDocument, trackId: string): ProjectDocument {
  const target = doc.tracks.find((t) => t.id === trackId);
  if (!target) throw new Error(`Track ${trackId} not found`);

  // Collect the target track + its parent group (if any)
  const trackIds = new Set<string>([trackId]);
  if (target.kind !== "group" && target.groupId) trackIds.add(target.groupId);

  // Collect return tracks that this track (or its group) sends to
  const sendReturnIds = new Set<string>();
  for (const id of trackIds) {
    const t = doc.tracks.find((tr) => tr.id === id);
    if (t && "sends" in t) {
      for (const returnId of Object.keys(t.sends)) {
        if ((t.sends as Record<string, number>)[returnId] > 0) {
          sendReturnIds.add(returnId);
        }
      }
    }
  }

  const filteredTracks = doc.tracks.filter((t) => trackIds.has(t.id));
  const filteredReturns = doc.returns.filter((r) => sendReturnIds.has(r.id));

  // Filter automation to only lanes targeting the frozen track or its group
  const filteredAutomation = doc.automation.filter((lane) => {
    if ("trackId" in lane.target) return trackIds.has(lane.target.trackId);
    return false;
  });

  // Filter LFOs to only those targeting the frozen track or its group
  const filteredLfos = doc.lfos.filter((lfo) => trackIds.has(lfo.trackId));

  // Filter audioClips to only those on the frozen track/group so bounced stems are self-contained
  const filteredAudioClips = (doc.arrangement.audioClips ?? []).filter((c) => trackIds.has(c.trackId));
  const filteredArrangement =
    filteredAudioClips.length > 0
      ? { ...doc.arrangement, clips: doc.arrangement.clips, audioClips: filteredAudioClips }
      : doc.arrangement;
  return {
    ...doc,
    tracks: filteredTracks,
    returns: filteredReturns,
    automation: filteredAutomation,
    lfos: filteredLfos,
    arrangement: filteredArrangement,
    // Flatten macros: apply static macro offsets during render (no live modulation)
    macros: [],
  };
}
