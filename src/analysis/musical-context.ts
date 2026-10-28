import { PPQ } from "../project-model/types";
import type {
  ArrangementAutomationClip,
  ArrangementClip,
  AudioClip,
  EffectInstance,
  MidiClip,
  Pattern,
  ProjectDocument,
  Track,
} from "../project-model/types";
import { ticksPerBar } from "../project-model/schema";
import { resolveAnalysisWindow, resolveClipSourceWindow } from "./contract";

export const MUSICAL_CONTEXT_SCHEMA = "kyx.musical-context" as const;
export const MUSICAL_CONTEXT_VERSION = 1 as const;
export const MUSICAL_CONTEXT_SAMPLE_RATE = 44_100;
export const MUSICAL_CONTEXT_MAX_BARS = 64;

const MAX_TRACKS = 24;
const MAX_CLIPS = 128;
const MAX_PATTERNS = 16;
const MAX_EVENTS_PER_LANE = 64;
const MAX_NOTE_EVENTS = 512;
const MAX_DRUM_HITS = 512;
const MAX_AUTOMATION_POINTS = 512;
const MAX_GOALS = 8;
const MAX_PREFERENCE_LENGTH = 240;
const MAX_EFFECTS_PER_CHAIN = 12;
const MAX_PARAMS_PER_EFFECT = 16;
const MAX_PADS_PER_TRACK = 64;
const MAX_SENDS_PER_TRACK = 32;

export type MusicalEvidenceKind = "project_fact" | "measurement" | "estimate" | "preference";

export interface MusicalEvidence {
  id: string;
  kind: MusicalEvidenceKind;
  claim: string;
  value: unknown;
  provenance: {
    source: "project_document" | "user_request" | "runtime_state" | "kyx_render_summary";
    path?: string;
    tool?: string;
    entityId?: string;
  };
  confidence: number | null;
  uncertainty: string | null;
  invalidatedBy: string[];
}

export interface MusicalContextRequest {
  startTick: number;
  endTick: number;
  trackIds: string[] | null;
  clipIds: string[];
  goals: string[];
  protectedElements: string[];
  renderScope: "master" | "tracks" | "all" | null;
}

export interface MusicalContextSnapshotV1 {
  schema: typeof MUSICAL_CONTEXT_SCHEMA;
  version: typeof MUSICAL_CONTEXT_VERSION;
  capturedAt: string;
  project: {
    id: string;
    name: string;
    schemaVersion: number;
    revision: number | null;
    revisionSource: "project_store" | "unavailable";
  };
  freshness: "current_at_capture" | "unknown" | "stale";
  scope: {
    startTick: number;
    endTick: number;
    startBar: number;
    endBar: number;
    barAligned: boolean;
    trackScope: "all_tracks" | "explicit_tracks" | "clips_and_dependencies";
    requestedTrackIds: string[];
    includedTrackIds: string[];
    requestedClipIds: string[];
    includedClipIds: string[];
    recordingActive: boolean;
  };
  time: {
    ppq: number;
    timeSignature: ProjectDocument["timeSignature"];
    projectBpm: number;
    tempoContext: Array<{ fromTick: number; toTick: number; bpm: number }>;
    startSec: number;
    endSec: number;
    renderedAudioRange: {
      coordinateSpace: "render_timeline";
      sampleRate: number;
      startSample: number;
      endSample: number;
      endExclusive: true;
    };
    alignmentCaveats: string[];
  };
  evidence: MusicalEvidence[];
  analysis: {
    status: "not_requested" | "measured" | "unavailable" | "stale";
    requestedScope: "master" | "tracks" | "all" | null;
    measuredScope?: "master" | "tracks" | "all" | "range" | "track-window";
    reason?: string;
  };
  assistantContract: {
    mode: "read_only_production_notes";
    citeEvidenceIds: true;
    answerShape: {
      maxFindings: 3;
      fields: string[];
    };
    rules: string[];
  };
  coverage: {
    tracksAvailable: number;
    tracksIncluded: number;
    clipsAvailable: number;
    clipsIncluded: number;
    patternsAvailable: number;
    patternsIncluded: number;
    truncated: boolean;
    omitted: {
      tracks: number;
      clips: number;
      patterns: number;
      noteEvents: number;
      drumHits: number;
      automationPoints: number;
      effectParams: number;
      effects: number;
      instrumentParams: number;
      pads: number;
      sends: number;
      returns: number;
      warpMarkers: number;
    };
  };
  limitations: string[];
}

export class MusicalContextInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicalContextInputError";
  }
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function stringList(value: unknown, label: string, maxItems: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new MusicalContextInputError(`${label} must be an array of at most ${maxItems} strings`);
  }
  const items = value.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (items.some((item) => item.length === 0 || item.length > MAX_PREFERENCE_LENGTH)) {
    throw new MusicalContextInputError(
      `${label} entries must be non-empty strings of at most ${MAX_PREFERENCE_LENGTH} characters`,
    );
  }
  return [...new Set(items)];
}

function clipRanges(doc: ProjectDocument): Map<string, { startTick: number; endTick: number; trackId?: string }> {
  const barTicks = ticksPerBar(doc);
  const ranges = new Map<string, { startTick: number; endTick: number; trackId?: string }>();
  const add = (id: string, startTick: number, endTick: number, trackId?: string) => {
    if (ranges.has(id)) throw new MusicalContextInputError(`clip id "${id}" is ambiguous in the project`);
    ranges.set(id, { startTick, endTick, ...(trackId ? { trackId } : {}) });
  };
  for (const clip of doc.arrangement.clips) {
    add(clip.id, clip.startBar * barTicks, (clip.startBar + clip.lengthBars) * barTicks);
  }
  for (const clip of doc.arrangement.midiClips ?? []) {
    add(clip.id, clip.startTick, clip.startTick + clip.lengthTicks, clip.trackId);
  }
  for (const clip of doc.arrangement.audioClips ?? []) {
    add(clip.id, clip.startBar * barTicks, (clip.startBar + clip.lengthBars) * barTicks, clip.trackId);
  }
  for (const clip of doc.arrangement.automationClips ?? []) {
    add(
      clip.id,
      clip.startTick,
      clip.startTick + clip.lengthTicks,
      clip.target.trackId === "master" ? undefined : clip.target.trackId,
    );
  }
  return ranges;
}

export function parseMusicalContextRequest(doc: ProjectDocument, raw: Record<string, unknown>): MusicalContextRequest {
  const hasBars = raw.fromBar !== undefined || raw.toBar !== undefined;
  const hasTicks = raw.startTick !== undefined || raw.endTick !== undefined;
  if (hasBars === hasTicks) {
    throw new MusicalContextInputError("provide exactly one range form: fromBar+toBar or startTick+endTick");
  }

  const barTicks = ticksPerBar(doc);
  let startTick: number;
  let endTick: number;
  if (hasBars) {
    if (
      !isSafeInt(raw.fromBar) ||
      !isSafeInt(raw.toBar) ||
      raw.fromBar < 1 ||
      raw.toBar < raw.fromBar ||
      raw.toBar > Math.floor(Number.MAX_SAFE_INTEGER / barTicks)
    ) {
      throw new MusicalContextInputError("bar range needs 1-based integer fromBar and toBar with toBar >= fromBar");
    }
    startTick = (raw.fromBar - 1) * barTicks;
    endTick = raw.toBar * barTicks;
  } else {
    if (!isSafeInt(raw.startTick) || !isSafeInt(raw.endTick) || raw.startTick < 0 || raw.endTick <= raw.startTick) {
      throw new MusicalContextInputError("tick range needs non-negative integer startTick and endTick > startTick");
    }
    startTick = raw.startTick;
    endTick = raw.endTick;
  }
  if (endTick - startTick > MUSICAL_CONTEXT_MAX_BARS * barTicks) {
    throw new MusicalContextInputError(`context range is limited to ${MUSICAL_CONTEXT_MAX_BARS} bars`);
  }

  const trackIds = raw.trackIds === undefined ? null : stringList(raw.trackIds, "trackIds", MAX_TRACKS);
  if (trackIds?.length === 0)
    throw new MusicalContextInputError("trackIds cannot be empty; omit it to include all tracks");
  const knownTracks = new Set(doc.tracks.map((track) => track.id));
  const unknownTracks = (trackIds ?? []).filter((id) => !knownTracks.has(id));
  if (unknownTracks.length > 0) throw new MusicalContextInputError(`unknown track id(s): ${unknownTracks.join(", ")}`);

  const clipIds = stringList(raw.clipIds, "clipIds", MAX_CLIPS);
  const ranges = clipRanges(doc);
  for (const id of clipIds) {
    const range = ranges.get(id);
    if (!range) throw new MusicalContextInputError(`unknown clip id "${id}"`);
    if (range.endTick <= startTick || range.startTick >= endTick) {
      throw new MusicalContextInputError(`clip "${id}" does not overlap the requested time range`);
    }
    if (trackIds && range.trackId && !trackIds.includes(range.trackId)) {
      throw new MusicalContextInputError(`clip "${id}" is not on a requested track`);
    }
  }

  const goals = stringList(raw.goals, "goals", MAX_GOALS);
  const protectedElements = stringList(raw.protectedElements, "protectedElements", MAX_GOALS);
  const renderScope = raw.renderScope;
  if (renderScope !== undefined && renderScope !== "master" && renderScope !== "tracks" && renderScope !== "all") {
    throw new MusicalContextInputError('renderScope must be "master", "tracks", or "all"');
  }

  return {
    startTick,
    endTick,
    trackIds,
    clipIds,
    goals,
    protectedElements,
    renderScope: (renderScope as MusicalContextRequest["renderScope"] | undefined) ?? null,
  };
}

function overlaps(start: number, end: number, from: number, to: number): boolean {
  return end > from && start < to;
}

function sumOmitted(value: unknown, key: string): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + sumOmitted(item, key), 0);
  if (value === null || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const own = typeof record[key] === "number" ? (record[key] as number) : 0;
  return own + Object.values(record).reduce((sum, item) => sum + sumOmitted(item, key), 0);
}

function selectAutomationPoints(
  points: readonly { tick: number; value: number; id?: string }[],
  fromTick: number,
  endTick: number,
  budget: { remaining: number },
): { points: typeof points; omitted: number } {
  const sorted = [...points].sort((left, right) => left.tick - right.tick);
  const before = [...sorted].reverse().find((point) => point.tick < fromTick);
  const after = sorted.find((point) => point.tick >= endTick);
  const inRange = sorted.filter((point) => point.tick >= fromTick && point.tick < endTick);
  const relevant = [...new Set([...(before ? [before] : []), ...inRange, ...(after ? [after] : [])])];
  const shown = relevant.slice(0, Math.min(MAX_EVENTS_PER_LANE, budget.remaining));
  budget.remaining -= shown.length;
  return { points: shown, omitted: Math.max(0, relevant.length - shown.length) };
}

function takeAutomationPoints<T extends { tick: number }>(
  points: readonly T[],
  budget: { remaining: number },
): { points: T[]; omitted: number } {
  const sorted = [...points].sort((left, right) => left.tick - right.tick);
  const shown = sorted.slice(0, Math.min(MAX_EVENTS_PER_LANE, budget.remaining));
  budget.remaining -= shown.length;
  return { points: shown, omitted: Math.max(0, sorted.length - shown.length) };
}

function effectSummary(effects: readonly EffectInstance[]) {
  const shown = effects.slice(0, MAX_EFFECTS_PER_CHAIN);
  return {
    effects: shown.map((effect) => {
      const params = Object.entries(effect.params);
      return {
        id: effect.id,
        type: effect.type,
        bypassed: effect.bypassed,
        params: Object.fromEntries(params.slice(0, MAX_PARAMS_PER_EFFECT)),
        omittedParams: Math.max(0, params.length - MAX_PARAMS_PER_EFFECT),
        sidechainTrackId: effect.sidechainTrackId ?? null,
        ...(effect.outputTrimDb === undefined ? {} : { outputTrimDb: effect.outputTrimDb }),
      };
    }),
    omittedEffects: Math.max(0, effects.length - MAX_EFFECTS_PER_CHAIN),
    omittedEffectParams: shown.reduce(
      (total, effect) => total + Math.max(0, Object.keys(effect.params).length - MAX_PARAMS_PER_EFFECT),
      0,
    ),
  };
}

function trackEvidence(track: Track, doc: ProjectDocument) {
  const groupId = "groupId" in track ? (track.groupId ?? null) : null;
  const group = groupId ? doc.tracks.find((candidate) => candidate.id === groupId && candidate.kind === "group") : null;
  const allSends = Object.entries(track.sends)
    .filter(([, amount]) => amount !== 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const sends = allSends.slice(0, MAX_SENDS_PER_TRACK).map(([returnId, amount]) => ({
    returnId,
    returnName: doc.returns.find((item) => item.id === returnId)?.name ?? null,
    amount,
  }));
  const base = {
    id: track.id,
    name: track.name,
    kind: track.kind,
    gain: track.gain,
    pan: track.pan,
    mute: track.mute,
    solo: track.solo,
    route: groupId ? { kind: "group", groupId, groupName: group?.name ?? null } : { kind: "master" },
    sends,
    omittedSends: Math.max(0, allSends.length - MAX_SENDS_PER_TRACK),
    ...effectSummary(track.effects),
  };
  if (track.kind === "instrument") {
    return {
      ...base,
      instrument: track.instrument,
      params: Object.fromEntries(Object.entries(track.params).slice(0, 48)),
      omittedInstrumentParams: Math.max(0, Object.keys(track.params).length - 48),
      inputInsert: track.inputInsert
        ? { mode: track.inputInsert.mode, ...effectSummary(track.inputInsert.effects) }
        : null,
    };
  }
  if (track.kind === "drum") {
    return {
      ...base,
      pads: track.pads
        .slice(0, MAX_PADS_PER_TRACK)
        .map((pad) => ({ id: pad.id, name: pad.name, mute: pad.mute, gain: pad.gain, pan: pad.pan })),
      omittedPads: Math.max(0, track.pads.length - MAX_PADS_PER_TRACK),
      inputInsert: track.inputInsert
        ? { mode: track.inputInsert.mode, ...effectSummary(track.inputInsert.effects) }
        : null,
    };
  }
  if (track.kind === "generative") {
    return { ...base, providerId: track.generative.providerId, modelId: track.generative.modelId };
  }
  return base;
}

function patternEvidence(
  pattern: Pattern,
  doc: ProjectDocument,
  trackIds: ReadonlySet<string>,
  budget: { noteEventsLeft: number; drumHitsLeft: number },
) {
  let omittedNoteEvents = 0;
  let omittedDrumHits = 0;
  const noteLanes = Object.entries(pattern.notes)
    .filter(([trackId]) => trackIds.has(trackId))
    .map(([trackId, events]) => {
      const shownCount = Math.min(events.length, MAX_EVENTS_PER_LANE, budget.noteEventsLeft);
      omittedNoteEvents += Math.max(0, events.length - shownCount);
      budget.noteEventsLeft -= shownCount;
      return {
        trackId,
        eventCount: events.length,
        timebase: "pattern_local_ticks" as const,
        events: events.slice(0, shownCount).map((event) => ({
          id: event.id,
          pitch: event.pitch,
          startTick: event.start,
          durationTicks: event.duration,
          velocity: event.velocity,
        })),
      };
    });
  const drumRows = Object.entries(pattern.rows)
    .filter(([padId]) =>
      doc.tracks.some(
        (track) => track.kind === "drum" && trackIds.has(track.id) && track.pads.some((pad) => pad.id === padId),
      ),
    )
    .map(([padId, values]) => {
      const hits = values.flatMap((velocity, step) => (velocity > 0 ? [{ step, velocity }] : []));
      const shownCount = Math.min(hits.length, MAX_EVENTS_PER_LANE, budget.drumHitsLeft);
      omittedDrumHits += Math.max(0, hits.length - shownCount);
      budget.drumHitsLeft -= shownCount;
      const owner = doc.tracks.find((track) => track.kind === "drum" && track.pads.some((pad) => pad.id === padId));
      const pad = owner?.kind === "drum" ? owner.pads.find((item) => item.id === padId) : undefined;
      return { padId, padName: pad?.name ?? null, hitCount: hits.length, hits: hits.slice(0, shownCount) };
    });
  return {
    id: pattern.id,
    name: pattern.name,
    stepCount: pattern.stepCount,
    timebase: "pattern_local_ticks; clip phase and repeat map it into the arrangement",
    noteLanes,
    drumRows,
    ...(pattern.phrasePlan
      ? { phrasePlan: pattern.phrasePlan.slice(0, 32), omittedPhraseBars: Math.max(0, pattern.phrasePlan.length - 32) }
      : {}),
    omittedNoteEvents,
    omittedDrumHits,
  };
}

function evidence(
  id: string,
  kind: MusicalEvidenceKind,
  claim: string,
  value: unknown,
  provenance: MusicalEvidence["provenance"],
  uncertainty: string | null = null,
  invalidatedBy = ["project_revision"],
): MusicalEvidence {
  return {
    id,
    kind,
    claim,
    value,
    provenance,
    confidence: kind === "project_fact" ? 1 : null,
    uncertainty,
    invalidatedBy,
  };
}

export function buildMusicalContextSnapshot(
  doc: ProjectDocument,
  request: MusicalContextRequest,
  options: { revision: number | null; recordingActive: boolean; capturedAt?: string },
): MusicalContextSnapshotV1 {
  const barTicks = ticksPerBar(doc);
  const range = { startTick: request.startTick, endTick: request.endTick };
  const barStart = Math.floor(request.startTick / barTicks) + 1;
  const barEnd = Math.max(barStart, Math.ceil(request.endTick / barTicks));
  const aligned = request.startTick % barTicks === 0 && request.endTick % barTicks === 0;
  const analysisWindow = resolveAnalysisWindow(
    doc,
    { window: range, scope: { kind: "master" } },
    MUSICAL_CONTEXT_SAMPLE_RATE,
  );
  if (!Number.isSafeInteger(analysisWindow.startSample) || !Number.isSafeInteger(analysisWindow.endSample)) {
    throw new MusicalContextInputError("requested range exceeds safe rendered-sample coordinates");
  }
  const allClipRanges = clipRanges(doc);
  const requestedTrackIds =
    request.trackIds ??
    (request.clipIds.length === 0
      ? doc.tracks.map((track) => track.id)
      : request.clipIds.some((id) => allClipRanges.get(id)?.trackId === undefined)
        ? doc.tracks.map((track) => track.id)
        : [
            ...new Set(
              request.clipIds.map((id) => allClipRanges.get(id)?.trackId).filter((id): id is string => Boolean(id)),
            ),
          ]);
  const requestedTrackSet = new Set(requestedTrackIds);
  const selectedClipSet = new Set(request.clipIds);
  const includedClipIds = [...allClipRanges.entries()]
    .filter(([id, value]) => {
      if (request.clipIds.length > 0 && !selectedClipSet.has(id)) return false;
      if (!overlaps(value.startTick, value.endTick, request.startTick, request.endTick)) return false;
      return value.trackId === undefined || requestedTrackSet.has(value.trackId);
    })
    .map(([id]) => id);
  const visibleClipIds = includedClipIds.slice(0, MAX_CLIPS);
  const includedClipSet = new Set(visibleClipIds);

  const includedTrackSet = new Set(requestedTrackIds);
  for (const trackId of [...includedTrackSet]) {
    const track = doc.tracks.find((item) => item.id === trackId);
    if (track && "groupId" in track && track.groupId) includedTrackSet.add(track.groupId);
    if (track?.kind === "group") {
      for (const child of doc.tracks) {
        if ("groupId" in child && child.groupId === track.id) includedTrackSet.add(child.id);
      }
    }
  }
  const includedTracks = doc.tracks.filter((track) => includedTrackSet.has(track.id));
  const shownTracks = includedTracks.slice(0, MAX_TRACKS);
  const shownTrackSet = new Set(shownTracks.map((track) => track.id));

  const sceneClips = doc.arrangement.clips
    .filter((clip) => includedClipSet.has(clip.id))
    .slice(0, MAX_CLIPS)
    .map((clip: ArrangementClip) => {
      const scene = doc.scenes.find((item) => item.id === clip.sceneId);
      return {
        id: clip.id,
        sceneId: clip.sceneId,
        sceneName: scene?.name ?? null,
        authoredRole: scene?.role ?? null,
        startTick: clip.startBar * barTicks,
        endTick: (clip.startBar + clip.lengthBars) * barTicks,
        startBar: clip.startBar + 1,
        lengthBars: clip.lengthBars,
        patternId: scene?.patternId ?? null,
        locked: clip.locked === true,
      };
    });
  const midiClips = (doc.arrangement.midiClips ?? [])
    .filter((clip) => includedClipSet.has(clip.id))
    .slice(0, MAX_CLIPS)
    .map((clip: MidiClip) => ({
      id: clip.id,
      trackId: clip.trackId,
      patternId: clip.patternId,
      startTick: clip.startTick,
      endTick: clip.startTick + clip.lengthTicks,
      phaseOffsetTicks: clip.phaseOffsetTicks ?? 0,
      muted: clip.muted === true,
      locked: clip.locked === true,
    }));
  const audioClips = (doc.arrangement.audioClips ?? [])
    .filter((clip) => includedClipSet.has(clip.id))
    .slice(0, MAX_CLIPS)
    .map((clip: AudioClip) => {
      const source = resolveClipSourceWindow(doc, clip.id, range);
      return {
        id: clip.id,
        trackId: clip.trackId,
        bufferId: clip.bufferId,
        startTick: clip.startBar * barTicks,
        endTick: (clip.startBar + clip.lengthBars) * barTicks,
        startBar: clip.startBar + 1,
        lengthBars: clip.lengthBars,
        sourceOffsetSec: clip.offsetSec,
        trimStartSec: clip.trimStart,
        trimEndSec: clip.trimEnd,
        gain: clip.gain,
        fadeInSec: clip.fadeIn,
        fadeOutSec: clip.fadeOut,
        ...(clip.pitchSemitones === undefined ? {} : { pitchSemitones: clip.pitchSemitones }),
        ...(clip.sourceChannel === undefined ? {} : { sourceChannel: clip.sourceChannel }),
        sourceWindowSec: { start: source.startSec, end: source.endSec },
        sourceMappingCaveats: source.caveats.map((item) => item.detail),
        stretchRate: clip.stretchRate,
        stretchMode: clip.stretchMode ?? "resample",
        reverse: clip.reverse,
        loop: clip.loop === true,
        warpMarkers: (clip.warpMarkers ?? []).slice(0, MAX_EVENTS_PER_LANE),
        omittedWarpMarkers: Math.max(0, (clip.warpMarkers?.length ?? 0) - MAX_EVENTS_PER_LANE),
        loopPhaseOffsetSec: clip.loopPhaseOffsetSec ?? 0,
        takeGroupId: clip.takeGroupId ?? null,
        takeId: clip.takeId ?? null,
        muted: clip.muted === true,
        locked: clip.locked === true,
      };
    });
  const automationBudget = { remaining: MAX_AUTOMATION_POINTS };
  const automationClips = (doc.arrangement.automationClips ?? [])
    .filter((clip) => includedClipSet.has(clip.id))
    .slice(0, MAX_CLIPS)
    .map((clip: ArrangementAutomationClip) => {
      const pointSelection = takeAutomationPoints(clip.points, automationBudget);
      return {
        id: clip.id,
        target: clip.target,
        linkedTargets: clip.linkedTargets ?? [],
        startTick: clip.startTick,
        endTick: clip.startTick + clip.lengthTicks,
        muted: clip.muted === true,
        locked: clip.locked === true,
        points: pointSelection.points,
        omittedPoints: pointSelection.omitted,
      };
    });

  const scenePatternIds = sceneClips.map((clip) => clip.patternId).filter((id): id is string => typeof id === "string");
  const patternIds = new Set([
    ...scenePatternIds,
    ...midiClips.map((clip) => clip.patternId),
    ...(scenePatternIds.length + midiClips.length === 0 &&
    doc.arrangement.clips.length === 0 &&
    (doc.arrangement.audioClips?.length ?? 0) === 0 &&
    (doc.arrangement.midiClips?.length ?? 0) === 0
      ? [doc.activePatternId]
      : []),
  ]);
  const patterns = [...patternIds]
    .map((id) => doc.patterns.find((pattern) => pattern.id === id))
    .filter((pattern): pattern is Pattern => pattern !== undefined);
  const patternBudget = { noteEventsLeft: MAX_NOTE_EVENTS, drumHitsLeft: MAX_DRUM_HITS };
  const shownPatterns = patterns
    .slice(0, MAX_PATTERNS)
    .map((pattern) => patternEvidence(pattern, doc, shownTrackSet, patternBudget));
  const omittedNoteEvents = shownPatterns.reduce((total, pattern) => total + pattern.omittedNoteEvents, 0);
  const omittedDrumHits = shownPatterns.reduce((total, pattern) => total + pattern.omittedDrumHits, 0);

  const selectedAutomationLanes = doc.automation
    .filter((lane) => shownTrackSet.has(lane.target.trackId) || lane.target.trackId === "master")
    .map((lane) => {
      const pointSelection = selectAutomationPoints(lane.points, request.startTick, request.endTick, automationBudget);
      return { id: lane.id, target: lane.target, points: pointSelection.points, omittedPoints: pointSelection.omitted };
    })
    .filter((lane) => lane.points.length > 0);
  const sceneIds = new Set(sceneClips.map((clip) => clip.sceneId));
  const sceneAutomation = doc.sceneAutomation
    .filter(
      (lane) =>
        sceneIds.has(lane.sceneId) && (shownTrackSet.has(lane.target.trackId) || lane.target.trackId === "master"),
    )
    .map((lane) => {
      const pointSelection = takeAutomationPoints(lane.points, automationBudget);
      return {
        id: lane.id,
        sceneId: lane.sceneId,
        target: lane.target,
        points: pointSelection.points,
        omittedPoints: pointSelection.omitted,
      };
    });
  const omittedAutomationPoints =
    sumOmitted(automationClips, "omittedPoints") +
    sumOmitted(selectedAutomationLanes, "omittedPoints") +
    sumOmitted(sceneAutomation, "omittedPoints");
  const markers = doc.markers
    .filter((marker) => marker.tick >= request.startTick && marker.tick < request.endTick)
    .map((marker) => ({ id: marker.id, name: marker.name, type: marker.type, tick: marker.tick }));
  const transitions = (doc.arrangement.transitions ?? []).filter(
    (transition) => includedClipSet.has(transition.fromClipId) || includedClipSet.has(transition.toClipId),
  );
  const takeGroupIds = new Set(audioClips.map((clip) => clip.takeGroupId).filter((id): id is string => Boolean(id)));
  const takeGroups = (doc.arrangement.takeGroups ?? []).filter((group) => takeGroupIds.has(group.id));
  const includedReturns = doc.returns
    .filter((item) => shownTracks.some((track) => Object.keys(track.sends).includes(item.id)))
    .slice(0, 32);
  const trackFacts = shownTracks.map((track) => trackEvidence(track, doc));
  const returnFacts = includedReturns.map((item) => ({
    id: item.id,
    name: item.name,
    gain: item.gain,
    ...effectSummary(item.effects),
  }));
  const masterFacts = {
    masterGain: doc.master.masterGain,
    ceilingDb: doc.master.ceilingDb,
    limiterEnabled: doc.master.limiterEnabled,
    clipperEnabled: doc.master.clipperEnabled,
    ...effectSummary(doc.master.effects),
  };
  const omittedEffects = sumOmitted([trackFacts, returnFacts, masterFacts], "omittedEffects");
  const omittedEffectParams = sumOmitted([trackFacts, returnFacts, masterFacts], "omittedEffectParams");
  const omittedInstrumentParams = sumOmitted(trackFacts, "omittedInstrumentParams");
  const omittedPads = sumOmitted(trackFacts, "omittedPads");
  const omittedSends = sumOmitted(trackFacts, "omittedSends");
  const omittedReturns = Math.max(
    0,
    doc.returns.filter((item) => shownTracks.some((track) => Object.keys(track.sends).includes(item.id))).length -
      includedReturns.length,
  );
  const omittedWarpMarkers = audioClips.reduce((total, clip) => total + clip.omittedWarpMarkers, 0);
  const output = {
    schema: MUSICAL_CONTEXT_SCHEMA,
    version: MUSICAL_CONTEXT_VERSION,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    project: {
      id: doc.id,
      name: doc.name,
      schemaVersion: doc.schemaVersion,
      revision: options.revision,
      revisionSource: options.revision === null ? "unavailable" : "project_store",
    },
    freshness: options.revision === null ? "unknown" : "current_at_capture",
    scope: {
      startTick: request.startTick,
      endTick: request.endTick,
      startBar: barStart,
      endBar: barEnd,
      barAligned: aligned,
      trackScope:
        request.clipIds.length > 0 ? "clips_and_dependencies" : request.trackIds ? "explicit_tracks" : "all_tracks",
      requestedTrackIds: request.trackIds ?? [],
      includedTrackIds: shownTracks.map((track) => track.id),
      requestedClipIds: request.clipIds,
      includedClipIds: visibleClipIds,
      recordingActive: options.recordingActive,
    },
    time: {
      ppq: PPQ,
      timeSignature: doc.timeSignature,
      projectBpm: doc.bpm,
      tempoContext: analysisWindow.tempoContext,
      startSec: analysisWindow.startSec,
      endSec: analysisWindow.endSec,
      renderedAudioRange: {
        coordinateSpace: "render_timeline",
        sampleRate: MUSICAL_CONTEXT_SAMPLE_RATE,
        startSample: analysisWindow.startSample,
        endSample: analysisWindow.endSample,
        endExclusive: true,
      },
      alignmentCaveats: analysisWindow.caveats.map((item) => item.detail),
    },
    evidence: [
      evidence(
        "project.metadata",
        "project_fact",
        "Authored project tempo, meter, key and groove",
        {
          bpm: doc.bpm,
          timeSignature: doc.timeSignature,
          key: doc.key ?? null,
          groove: doc.groove ?? null,
        },
        { source: "project_document", path: "bpm,timeSignature,key,groove" },
      ),
      evidence(
        "project.timeline-range",
        "project_fact",
        "Tempo-aware tick, second and rendered-sample mapping for the requested range",
        {
          startTick: request.startTick,
          endTick: request.endTick,
          startSec: analysisWindow.startSec,
          endSec: analysisWindow.endSec,
          tempoContext: analysisWindow.tempoContext,
          renderedAudioRange: {
            coordinateSpace: "render_timeline",
            sampleRate: MUSICAL_CONTEXT_SAMPLE_RATE,
            startSample: analysisWindow.startSample,
            endSample: analysisWindow.endSample,
            endExclusive: true,
          },
        },
        { source: "project_document", path: "arrangement.clips,scenes,timeSignature" },
        analysisWindow.caveats.length > 0 ? analysisWindow.caveats.map((item) => item.detail).join(" ") : null,
        ["project_revision", "tempo_map"],
      ),
      evidence(
        "request.scope",
        "preference",
        "User-selected range and track/clip scope for this review",
        {
          startTick: request.startTick,
          endTick: request.endTick,
          trackIds: request.trackIds,
          clipIds: request.clipIds,
        },
        { source: "user_request", path: "range,trackIds,clipIds" },
        null,
        ["next_user_request"],
      ),
      {
        id: "runtime.recording-state",
        kind: "measurement",
        claim: "Current microphone recording state",
        value: options.recordingActive,
        provenance: { source: "runtime_state", path: "isMicRecordingActive" },
        confidence: 1,
        uncertainty: null,
        invalidatedBy: ["recording_state_change"],
      },
      evidence(
        "project.tracks-routing-effects",
        "project_fact",
        "Selected tracks, gain/pan, routing, sends and inserted effects",
        {
          tracks: trackFacts,
          returns: returnFacts,
          master: masterFacts,
        },
        { source: "project_document", path: "tracks,returns,master" },
      ),
      evidence(
        "project.arrangement-window",
        "project_fact",
        "Authored clips, markers, take groups and transitions intersecting the requested range",
        { sceneClips, midiClips, audioClips, automationClips, markers, takeGroups, transitions },
        { source: "project_document", path: "arrangement,markers" },
      ),
      evidence(
        "project.pattern-content",
        "project_fact",
        "Authored pattern-local note events, drum hits and phrase labels used by clips in scope",
        { patterns: shownPatterns },
        { source: "project_document", path: "patterns" },
        "Pattern events use pattern-local ticks; clip phase and repetition map them to arrangement time.",
      ),
      evidence(
        "project.automation-window",
        "project_fact",
        "Authored automation lanes and scene automation affecting the requested range",
        { lanes: selectedAutomationLanes, sceneAutomation },
        { source: "project_document", path: "automation,sceneAutomation,arrangement.automationClips" },
      ),
      ...(doc.producerBrief?.facts?.length
        ? [
            evidence(
              "project.saved-creative-brief",
              "preference",
              "Explicitly saved project creative preferences",
              { version: doc.producerBrief.version, facts: doc.producerBrief.facts },
              { source: "project_document", path: "producerBrief.facts" },
              null,
              ["producer_brief_edit", "project_revision"],
            ),
          ]
        : []),
      ...request.goals.map((goal, index) =>
        evidence(
          `request.goal.${index + 1}`,
          "preference",
          "User-stated production goal for this request",
          goal,
          { source: "user_request", path: "goals" },
          null,
          ["next_user_request"],
        ),
      ),
      ...request.protectedElements.map((item, index) =>
        evidence(
          `request.protected.${index + 1}`,
          "preference",
          "User-stated element to preserve",
          item,
          { source: "user_request", path: "protectedElements" },
          null,
          ["next_user_request"],
        ),
      ),
    ],
    analysis: {
      status: request.renderScope === null ? "not_requested" : "unavailable",
      requestedScope: request.renderScope,
      ...(request.renderScope === null ? {} : { reason: "render analysis has not run" }),
    },
    assistantContract: {
      mode: "read_only_production_notes",
      citeEvidenceIds: true,
      answerShape: {
        maxFindings: 3,
        fields: [
          "observation",
          "interpretation",
          "evidenceIds",
          "affectedTracksAndRange",
          "optionsAndTradeoffs",
          "confidence",
          "listenForInAB",
        ],
      },
      rules: [
        "Separate project facts, measurements, estimates and user preferences; cite the evidence id for each claim.",
        "Return at most three prioritized findings. For each, separate observation from interpretation, name affected tracks and ticks, cite evidence ids, give up to two options with tradeoffs, state confidence, and say what to listen for in A/B.",
        "Offer listening or arrangement options with their tradeoffs; do not claim that a subjective goal was achieved from metrics alone.",
        "Treat kick/bass collision risk as an estimate, not confirmed audible masking.",
        "If freshness is stale or unknown, say so and request a fresh context before proposing changes.",
        "If coverage is truncated or an analysis is unavailable, state the gap and do not infer through it.",
        "This workflow is read-only: do not call mutation tools as part of the review.",
      ],
    },
    coverage: {
      tracksAvailable: includedTracks.length,
      tracksIncluded: shownTracks.length,
      clipsAvailable: includedClipIds.length,
      clipsIncluded: visibleClipIds.length,
      patternsAvailable: patterns.length,
      patternsIncluded: shownPatterns.length,
      truncated:
        includedTracks.length > shownTracks.length ||
        includedClipIds.length > MAX_CLIPS ||
        patterns.length > shownPatterns.length ||
        omittedNoteEvents > 0 ||
        omittedDrumHits > 0 ||
        omittedAutomationPoints > 0 ||
        omittedEffects > 0 ||
        omittedEffectParams > 0 ||
        omittedInstrumentParams > 0 ||
        omittedPads > 0 ||
        omittedSends > 0 ||
        omittedReturns > 0 ||
        omittedWarpMarkers > 0,
      omitted: {
        tracks: Math.max(0, includedTracks.length - shownTracks.length),
        clips: Math.max(0, includedClipIds.length - MAX_CLIPS),
        patterns: Math.max(0, patterns.length - shownPatterns.length),
        noteEvents: omittedNoteEvents,
        drumHits: omittedDrumHits,
        automationPoints: omittedAutomationPoints,
        effectParams: omittedEffectParams,
        effects: omittedEffects,
        instrumentParams: omittedInstrumentParams,
        pads: omittedPads,
        sends: omittedSends,
        returns: omittedReturns,
        warpMarkers: omittedWarpMarkers,
      },
    },
    limitations: [
      "This packet reports project facts and scoped measurements; it does not infer that spectral overlap is audible masking or that a section label is correct.",
      "Rendered sample positions are timeline frames at 44.1 kHz, not source-file sample positions. Source audio mapping is approximate for reverse, loop, stretch or warp clips.",
      ...(options.revision === null
        ? [
            "This transport cannot expose a project revision; do not cache this packet or treat later work as revision-verified.",
          ]
        : []),
      ...(options.recordingActive
        ? ["Audio recording is active; no edit proposal should target the live recording session."]
        : []),
    ],
  } satisfies MusicalContextSnapshotV1;

  return output;
}

export function musicalContextSummary(snapshot: MusicalContextSnapshotV1): string {
  const counts = snapshot.evidence.reduce<Record<MusicalEvidenceKind, number>>(
    (result, item) => ({ ...result, [item.kind]: result[item.kind] + 1 }),
    { project_fact: 0, measurement: 0, estimate: 0, preference: 0 },
  );
  const revision = snapshot.project.revision === null ? "unknown" : String(snapshot.project.revision);
  const samples = snapshot.time.renderedAudioRange;
  const renderState =
    snapshot.analysis.status === "measured" ? ` · render ${snapshot.analysis.status}/${snapshot.freshness}` : "";
  return [
    `Musical context v${snapshot.version} · ${snapshot.project.name} (${snapshot.project.id}) · revision ${revision}/${snapshot.freshness}`,
    `Bars ${snapshot.scope.startBar}–${snapshot.scope.endBar} · ticks ${snapshot.scope.startTick}–${snapshot.scope.endTick} · ${snapshot.time.timeSignature.numerator}/${snapshot.time.timeSignature.denominator} at ${snapshot.time.projectBpm} BPM · ${samples.endSample - samples.startSample} timeline samples @ ${samples.sampleRate} Hz${renderState}`,
    `Evidence: ${counts.project_fact} project facts, ${counts.measurement} measurements, ${counts.estimate} estimates, ${counts.preference} preferences${snapshot.coverage.truncated ? ` · truncated (${JSON.stringify(snapshot.coverage.omitted)})` : ""}`,
    ...(snapshot.analysis.status === "unavailable" && snapshot.analysis.reason
      ? [`Render analysis unavailable: ${snapshot.analysis.reason}`]
      : []),
  ].join("\n");
}
