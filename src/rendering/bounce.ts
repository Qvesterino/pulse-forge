import { buildStemProject } from "./stems";
import { buildTempoMap, type ClipWindow } from "./renderer";
import type { ProjectDocument } from "../project-model/types";
import { BAR_TICKS } from "../project-model/types";

/**
 * Real bounce: offline-render the selected tracks (with their FX, groups,
 * sends) for a time-range zone and hand back a doc that renders EXACTLY that
 * zone as bar 0.
 *
 * Surgery rules:
 *  - tracks: stem filter (selected + parent groups), mutes preserved
 *  - scene clips overlapping the zone are kept and clipped zone-relative —
 *    a pattern restarts from step 0 at its clip start, which is what a
 *    bounce of that clip alone would sound like
 *  - audio clips overlapping the zone keep sample-exact alignment via
 *    offsetSec (audio is absolute, unlike patterns)
 *  - transitions/markers are dropped: they reference the original clip ids
 *    and carry no audio
 */
export interface BounceZone {
  startBar: number;
  lengthBars: number;
}

export function buildBounceZoneDoc(doc: ProjectDocument, trackIds: string[], zone: BounceZone): ProjectDocument {
  if (trackIds.length === 0) throw new Error("Select at least one track to bounce");
  const zoneStartTick = zone.startBar * BAR_TICKS;
  const zoneEndTick = zoneStartTick + Math.max(0.25, zone.lengthBars) * BAR_TICKS;
  const stemDoc = buildStemProject(doc, (t) => trackIds.includes(t.id));

  const zoneRelativeClips: ProjectDocument["arrangement"]["clips"] = [];
  const zoneRelativeAudio: NonNullable<ProjectDocument["arrangement"]["audioClips"]> = [];
  // Audio offsets are source-time values. When a zone starts inside a scene
  // with a scene-specific BPM, converting the head trim with doc.bpm shifts
  // the source window. Reuse the renderer's piecewise tempo map so bounce,
  // offline export and scene playback agree at tempo seams.
  const tempoMap = buildTempoMap(doc, bounceTempoWindows(doc));
  for (const clip of stemDoc.arrangement.clips) {
    const clipStart = clip.startBar * BAR_TICKS;
    const clipEnd = clipStart + clip.lengthBars * BAR_TICKS;
    const overlapStart = Math.max(clipStart, zoneStartTick);
    const overlapEnd = Math.min(clipEnd, zoneEndTick);
    if (overlapEnd - overlapStart < BAR_TICKS * 0.25) continue;
    zoneRelativeClips.push({
      ...clip,
      startBar: (overlapStart - zoneStartTick) / BAR_TICKS,
      lengthBars: (overlapEnd - overlapStart) / BAR_TICKS,
    });
  }
  for (const clip of stemDoc.arrangement.audioClips ?? []) {
    const clipStart = clip.startBar * BAR_TICKS;
    const clipEnd = clipStart + clip.lengthBars * BAR_TICKS;
    const overlapStart = Math.max(clipStart, zoneStartTick);
    const overlapEnd = Math.min(clipEnd, zoneEndTick);
    if (overlapEnd - overlapStart < BAR_TICKS * 0.25) continue;
    const headTrimSec = Math.max(0, tempoMap.timeAt(overlapStart) - tempoMap.timeAt(clipStart));
    zoneRelativeAudio.push({
      ...clip,
      startBar: (overlapStart - zoneStartTick) / BAR_TICKS,
      lengthBars: (overlapEnd - overlapStart) / BAR_TICKS,
      offsetSec: (clip.offsetSec ?? 0) + headTrimSec,
      fadeIn: overlapStart <= clipStart ? clip.fadeIn : 0,
      fadeOut: overlapEnd >= clipEnd ? clip.fadeOut : 0,
    });
  }
  if (zoneRelativeClips.length === 0 && zoneRelativeAudio.length === 0) {
    throw new Error("Nothing to bounce — the zone has no scene or audio content");
  }

  return {
    ...stemDoc,
    arrangement: {
      ...stemDoc.arrangement,
      clips: zoneRelativeClips,
      audioClips: zoneRelativeAudio,
      transitions: [],
    },
    markers: [],
  };
}

export interface AudioClipConsolidationPlan {
  /** Ephemeral project containing only the selected audio material, rendered dry. */
  project: ProjectDocument;
  trackId: string;
  startBar: number;
  lengthBars: number;
}

/**
 * Build a dry, isolated render project for consolidating selected clips.
 * Source clips and take lanes remain in the real project; this project exists
 * only to sum their clip-level gain/fades/stretch/warp and timeline placement
 * into one buffer. Track/group/master processing is intentionally excluded so
 * the consolidated clip does not run through those processors twice.
 */
export function buildAudioClipConsolidationDoc(doc: ProjectDocument, clipIds: string[]): AudioClipConsolidationPlan {
  const ids = new Set(clipIds);
  const sourceClips = (doc.arrangement.audioClips ?? []).filter((clip) => ids.has(clip.id));
  if (ids.size < 2 || sourceClips.length !== ids.size) {
    throw new Error("Select at least 2 existing audio clips to consolidate");
  }

  const first = sourceClips[0];
  if (!first) throw new Error("No audio clips selected");
  if (sourceClips.some((clip) => clip.trackId !== first.trackId)) {
    throw new Error("Consolidate requires clips on the same track");
  }
  if (sourceClips.some((clip) => clip.takeGroupId !== first.takeGroupId || clip.takeId !== first.takeId)) {
    throw new Error("Consolidate clips from one take lane at a time");
  }

  const startBar = Math.min(...sourceClips.map((clip) => clip.startBar));
  const endBar = Math.max(...sourceClips.map((clip) => clip.startBar + clip.lengthBars));
  const lengthBars = endBar - startBar;
  if (!Number.isFinite(startBar) || !Number.isFinite(lengthBars) || lengthBars < 0.25) {
    throw new Error("Consolidation range must be at least 1/4 bar");
  }

  const track = doc.tracks.find((candidate) => candidate.id === first.trackId);
  if (!track) throw new Error(`Track ${first.trackId} not found`);
  const takeGroups = first.takeGroupId
    ? (doc.arrangement.takeGroups ?? []).filter((group) => group.id === first.takeGroupId)
    : [];
  if (first.takeGroupId && (!first.takeId || takeGroups.length !== 1 || takeGroups[0]?.trackId !== first.trackId)) {
    throw new Error("Selected audio clips have invalid take-lane metadata");
  }

  const sourceDoc: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: sourceClips,
      takeGroups: takeGroups.map((group) => ({ ...group, activeTakeId: first.takeId! })),
    },
  };
  const zoneDoc = buildBounceZoneDoc(sourceDoc, [track.id], { startBar, lengthBars });
  const dryTracks = zoneDoc.tracks.map((candidate) => ({
    ...candidate,
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
    sends: {},
  }));

  return {
    project: {
      ...zoneDoc,
      patterns: zoneDoc.patterns.map((pattern) => ({ ...pattern, rows: {}, notes: {} })),
      tracks: dryTracks,
      returns: [],
      automation: [],
      sceneAutomation: [],
    },
    trackId: track.id,
    startBar,
    lengthBars,
  };
}

function bounceTempoWindows(doc: ProjectDocument): ClipWindow[] {
  return doc.arrangement.clips.flatMap((clip) => {
    const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
    const pattern = scene ? doc.patterns.find((candidate) => candidate.id === scene.patternId) : undefined;
    if (!scene || !pattern) return [];
    const base = clip.startBar * BAR_TICKS;
    return [
      {
        pattern,
        base,
        from: base,
        to: base + clip.lengthBars * BAR_TICKS,
        bpm: scene.bpm ?? doc.bpm,
        sceneId: scene.id,
      },
    ];
  });
}
