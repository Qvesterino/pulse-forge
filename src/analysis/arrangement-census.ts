import { ticksPerBar } from "../project-model/schema";
import { STEP_TICKS, type Pattern, type ProjectDocument, type SceneRole } from "../project-model/types";

const MAX_CENSUS_CLIPS = 64;
const MAX_ENERGY_CLIPS = 16;
const MAX_REPEATED_GROUPS = 16;

export interface ArrangementPatternMetrics {
  patternBars: number;
  drumHits: number;
  drumHitsPerBar: number;
  melodicNotes: number;
  notesPerBar: number;
  pitchMin: number | null;
  pitchMax: number | null;
  velocityMean: number | null;
  velocityRange: [number, number] | null;
  velocityStdDev: number | null;
}

export interface ArrangementCensusClip {
  clipId: string;
  sceneId: string;
  sceneName: string;
  /** Only the explicitly authored scene role. No name-based role inference. */
  authoredRole: SceneRole | null;
  sourcePatternId: string | null;
  fingerprint: string | null;
  range: { startTick: number; endTick: number };
  metrics: ArrangementPatternMetrics | null;
  occurrenceCount: number;
  relationToPrevious: "same-content" | "different-content" | "unknown";
  changeFromPrevious: {
    drumHitsPerBar: number | null;
    notesPerBar: number | null;
    pitchSpan: number | null;
  } | null;
  energy?: {
    startSample: number;
    endSample: number;
    sampleRate: number;
    rmsDbfs: number;
    deltaRmsDbFromPrevious: number | null;
  };
}

export interface ArrangementCensus {
  analyzer: { name: "kyx-arrangement-census"; version: "1" };
  projectRevision: number | null;
  window: { startTick: number; endTick: number } | null;
  counts: {
    clipsInScope: number;
    clipsAnalyzed: number;
    uniquePatterns: number;
    repeatedGroups: number;
    repeatedOccurrences: number;
  };
  clips: ArrangementCensusClip[];
  repeatedPatterns: Array<{
    fingerprint: string;
    patternIds: string[];
    clipIds: string[];
    occurrences: number;
  }>;
  energy: {
    status: "measured" | "not-measured";
    reason?: "master-not-rendered";
    clipsMeasured: number;
    truncated: boolean;
  };
  truncated: boolean;
  caveats: string[];
}

interface CanonicalRow {
  trackIndex: number;
  padIndex: number;
  values: number[];
}

interface CanonicalNote {
  trackIndex: number;
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

interface CanonicalMeta {
  trackIndex: number;
  padIndex: number;
  steps: Array<{ step: number; meta: Record<string, number> }>;
}

function stableNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hashCanonicalContent(value: string): string {
  // Two independent 32-bit hash lanes make a compact UUID-free fingerprint.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function canonicalPattern(doc: ProjectDocument, pattern: Pattern): string {
  const padLocations = new Map<string, { trackIndex: number; padIndex: number }>();
  const instrumentLocations = new Map<string, number>();
  let drumIndex = 0;
  let instrumentIndex = 0;
  for (const track of doc.tracks) {
    if (track.kind === "drum") {
      track.pads.forEach((pad, padIndex) => padLocations.set(pad.id, { trackIndex: drumIndex, padIndex }));
      drumIndex += 1;
    } else if (track.kind === "instrument") {
      instrumentLocations.set(track.id, instrumentIndex);
      instrumentIndex += 1;
    }
  }

  const rows: CanonicalRow[] = Object.entries(pattern.rows ?? {})
    .map(([padId, values]) => {
      const location = padLocations.get(padId) ?? { trackIndex: -1, padIndex: -1 };
      return { ...location, values: values.map(stableNumber) };
    })
    .sort(
      (a, b) =>
        a.trackIndex - b.trackIndex ||
        a.padIndex - b.padIndex ||
        compareText(JSON.stringify(a.values), JSON.stringify(b.values)),
    );

  const notes: CanonicalNote[] = [];
  for (const [trackId, trackNotes] of Object.entries(pattern.notes ?? {})) {
    const trackIndex = instrumentLocations.get(trackId) ?? -1;
    for (const note of trackNotes) {
      notes.push({
        trackIndex,
        pitch: stableNumber(note.pitch),
        start: stableNumber(note.start),
        duration: stableNumber(note.duration),
        velocity: stableNumber(note.velocity),
      });
    }
  }
  notes.sort(
    (a, b) =>
      a.trackIndex - b.trackIndex ||
      a.start - b.start ||
      a.pitch - b.pitch ||
      a.duration - b.duration ||
      a.velocity - b.velocity,
  );

  const stepMeta: CanonicalMeta[] = [];
  for (const [padId, steps] of Object.entries(pattern.stepMeta ?? {})) {
    const location = padLocations.get(padId) ?? { trackIndex: -1, padIndex: -1 };
    stepMeta.push({
      ...location,
      steps: Object.entries(steps)
        .map(([step, meta]) => {
          const canonical: Record<string, number> = {};
          for (const key of ["probability", "ratchet", "microtiming"] as const) {
            if (meta[key] !== undefined) canonical[key] = stableNumber(meta[key] as number);
          }
          return { step: Number(step), meta: canonical };
        })
        .sort((a, b) => a.step - b.step),
    });
  }
  stepMeta.sort((a, b) => a.trackIndex - b.trackIndex || a.padIndex - b.padIndex);
  return JSON.stringify({ stepCount: pattern.stepCount, rows, notes, stepMeta });
}

function patternMetrics(doc: ProjectDocument, pattern: Pattern, barTicks: number): ArrangementPatternMetrics {
  const patternBars = Math.max(1, (Math.max(1, pattern.stepCount) * STEP_TICKS) / barTicks);
  const drumPadIds = new Set(
    doc.tracks.filter((track) => track.kind === "drum").flatMap((track) => track.pads.map((pad) => pad.id)),
  );
  let drumHits = 0;
  for (const [padId, steps] of Object.entries(pattern.rows ?? {})) {
    if (!drumPadIds.has(padId)) continue;
    drumHits += steps.reduce((count, value) => count + (Number.isFinite(value) && value > 0 ? 1 : 0), 0);
  }
  const notes = Object.values(pattern.notes ?? {}).flat();
  const velocities = notes.map((note) => note.velocity).filter(Number.isFinite);
  let pitchMin: number | null = null;
  let pitchMax: number | null = null;
  for (const note of notes) {
    if (Number.isFinite(note.pitch)) {
      pitchMin = pitchMin === null ? note.pitch : Math.min(pitchMin, note.pitch);
      pitchMax = pitchMax === null ? note.pitch : Math.max(pitchMax, note.pitch);
    }
  }
  const velocityMean =
    velocities.length > 0 ? velocities.reduce((sum, value) => sum + value, 0) / velocities.length : null;
  let velocityMin = Number.POSITIVE_INFINITY;
  let velocityMax = Number.NEGATIVE_INFINITY;
  for (const velocity of velocities) {
    velocityMin = Math.min(velocityMin, velocity);
    velocityMax = Math.max(velocityMax, velocity);
  }
  const velocityRange = velocities.length > 0 ? ([velocityMin, velocityMax] as [number, number]) : null;
  const velocityStdDev =
    velocityMean === null
      ? null
      : Math.sqrt(velocities.reduce((sum, value) => sum + (value - velocityMean) ** 2, 0) / velocities.length);

  return {
    patternBars: stableNumber(patternBars),
    drumHits,
    drumHitsPerBar: stableNumber(drumHits / patternBars),
    melodicNotes: notes.length,
    notesPerBar: stableNumber(notes.length / patternBars),
    pitchMin,
    pitchMax,
    velocityMean: velocityMean === null ? null : stableNumber(velocityMean),
    velocityRange: velocityRange === null ? null : [stableNumber(velocityRange[0]), stableNumber(velocityRange[1])],
    velocityStdDev: velocityStdDev === null ? null : stableNumber(velocityStdDev),
  };
}

function metricDelta(current: number | null, previous: number | null): number | null {
  return current === null || previous === null ? null : stableNumber(current - previous);
}

/**
 * Read-only, UUID-independent census of the clips in an arrangement window.
 * Fingerprints describe core pattern events, not the complete sound: effects,
 * instrument patches, automation, audio clips, and clip phase are excluded.
 */
export function analyzeArrangementCensus(
  doc: ProjectDocument,
  window: { startTick: number; endTick: number } | null = null,
  projectRevision: number | null = null,
): ArrangementCensus {
  const barTicks = ticksPerBar(doc);
  const patternById = new Map(doc.patterns.map((pattern) => [pattern.id, pattern]));
  const sceneById = new Map(doc.scenes.map((scene) => [scene.id, scene]));
  const inScope = doc.arrangement.clips
    .flatMap((clip) => {
      if (
        !Number.isSafeInteger(clip.startBar) ||
        !Number.isSafeInteger(clip.lengthBars) ||
        clip.startBar < 0 ||
        clip.lengthBars <= 0
      ) {
        return [];
      }
      const sourceStart = clip.startBar * barTicks;
      const sourceEnd = sourceStart + clip.lengthBars * barTicks;
      const startTick = window ? Math.max(sourceStart, window.startTick) : sourceStart;
      const endTick = window ? Math.min(sourceEnd, window.endTick) : sourceEnd;
      if (endTick <= startTick) return [];

      const scene = sceneById.get(clip.sceneId);
      const pattern = scene ? patternById.get(scene.patternId) : undefined;
      return [
        {
          clipId: clip.id,
          sceneId: clip.sceneId,
          sceneName: scene?.name ?? "Unknown scene",
          authoredRole: scene?.role ?? null,
          sourcePatternId: pattern?.id ?? null,
          range: { startTick, endTick },
        },
      ];
    })
    .sort(
      (a, b) =>
        a.range.startTick - b.range.startTick || a.range.endTick - b.range.endTick || compareText(a.clipId, b.clipId),
    );

  const patternCache = new Map<string, { fingerprint: string; metrics: ArrangementPatternMetrics }>();
  const capped = inScope.slice(0, MAX_CENSUS_CLIPS).map((clip) => {
    const pattern = clip.sourcePatternId ? patternById.get(clip.sourcePatternId) : undefined;
    let analyzedPattern = pattern ? patternCache.get(pattern.id) : undefined;
    if (pattern && !analyzedPattern) {
      analyzedPattern = {
        fingerprint: hashCanonicalContent(canonicalPattern(doc, pattern)),
        metrics: patternMetrics(doc, pattern, barTicks),
      };
      patternCache.set(pattern.id, analyzedPattern);
    }
    return {
      ...clip,
      fingerprint: analyzedPattern?.fingerprint ?? null,
      metrics: analyzedPattern?.metrics ?? null,
      occurrenceCount: 1,
      relationToPrevious: "unknown" as const,
      changeFromPrevious: null,
    };
  });
  const occurrenceCounts = new Map<string, number>();
  const groupValues = new Map<string, { fingerprint: string; patternIds: Set<string>; clipIds: string[] }>();
  for (const clip of capped) {
    if (!clip.fingerprint || !clip.sourcePatternId) continue;
    occurrenceCounts.set(clip.fingerprint, (occurrenceCounts.get(clip.fingerprint) ?? 0) + 1);
    const group = groupValues.get(clip.fingerprint) ?? {
      fingerprint: clip.fingerprint,
      patternIds: new Set<string>(),
      clipIds: [],
    };
    group.patternIds.add(clip.sourcePatternId);
    group.clipIds.push(clip.clipId);
    groupValues.set(clip.fingerprint, group);
  }

  const clips: ArrangementCensusClip[] = capped.map((clip, index) => {
    const previous = capped[index - 1];
    const previousMetrics = previous?.metrics;
    const currentMetrics = clip.metrics;
    return {
      ...clip,
      occurrenceCount: clip.fingerprint ? (occurrenceCounts.get(clip.fingerprint) ?? 1) : 1,
      relationToPrevious:
        !previous || !clip.fingerprint || !previous.fingerprint
          ? "unknown"
          : previous.fingerprint === clip.fingerprint
            ? "same-content"
            : "different-content",
      changeFromPrevious:
        !previousMetrics || !currentMetrics
          ? null
          : {
              drumHitsPerBar: metricDelta(currentMetrics.drumHitsPerBar, previousMetrics.drumHitsPerBar),
              notesPerBar: metricDelta(currentMetrics.notesPerBar, previousMetrics.notesPerBar),
              pitchSpan: metricDelta(
                currentMetrics.pitchMin === null || currentMetrics.pitchMax === null
                  ? null
                  : currentMetrics.pitchMax - currentMetrics.pitchMin,
                previousMetrics.pitchMin === null || previousMetrics.pitchMax === null
                  ? null
                  : previousMetrics.pitchMax - previousMetrics.pitchMin,
              ),
            },
    };
  });

  const repeatedPatterns = [...groupValues.values()]
    .filter((group) => group.clipIds.length > 1)
    .sort((a, b) => b.clipIds.length - a.clipIds.length || compareText(a.fingerprint, b.fingerprint));
  const repeatedOccurrences = repeatedPatterns.reduce((sum, group) => sum + group.clipIds.length, 0);

  return {
    analyzer: { name: "kyx-arrangement-census", version: "1" },
    projectRevision,
    window,
    counts: {
      clipsInScope: inScope.length,
      clipsAnalyzed: clips.length,
      uniquePatterns: new Set(clips.map((clip) => clip.fingerprint).filter((value): value is string => value !== null))
        .size,
      repeatedGroups: repeatedPatterns.length,
      repeatedOccurrences,
    },
    clips,
    repeatedPatterns: repeatedPatterns.slice(0, MAX_REPEATED_GROUPS).map((group) => ({
      fingerprint: group.fingerprint,
      patternIds: [...group.patternIds].sort(),
      clipIds: group.clipIds,
      occurrences: group.clipIds.length,
    })),
    energy: {
      status: "not-measured",
      reason: "master-not-rendered",
      clipsMeasured: 0,
      truncated: inScope.length > MAX_ENERGY_CLIPS,
    },
    truncated: inScope.length > MAX_CENSUS_CLIPS || repeatedPatterns.length > MAX_REPEATED_GROUPS,
    caveats: [
      "A repeated fingerprint means the UUID-free core pattern events match; it does not prove the rendered audio is identical or that repetition is undesirable.",
      "Instrument and drum timbres, effects, automation, audio/MIDI clips, groove application, and clip phase are not fingerprinted.",
      "Only explicitly stored scene roles are shown; a missing role is not inferred from the scene name.",
    ],
  };
}

export interface EnergyBuffer {
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Add per-clip master RMS evidence using sample windows resolved by the caller's tempo-map contract. */
export function measureArrangementCensusEnergy(
  census: ArrangementCensus,
  buffer: EnergyBuffer,
  resolveSamples: (startTick: number, endTick: number) => { startSample: number; endSample: number },
): ArrangementCensus {
  const clips = census.clips.slice(0, MAX_ENERGY_CLIPS);
  let previousRmsDbfs: number | null = null;
  const measured = clips.map((clip) => {
    const sampleWindow = resolveSamples(clip.range.startTick, clip.range.endTick);
    const startSample = Math.max(0, sampleWindow.startSample);
    let bufferLength = Number.POSITIVE_INFINITY;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      bufferLength = Math.min(bufferLength, buffer.getChannelData(channel).length);
    }
    const endSample = Math.min(bufferLength, sampleWindow.endSample);
    if (endSample <= startSample || buffer.numberOfChannels === 0) return clip;
    let sumSquares = 0;
    let sampleCount = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = startSample; index < endSample; index += 1) {
        const sample = data[index] ?? 0;
        sumSquares += sample * sample;
        sampleCount += 1;
      }
    }
    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
    const rmsDbfs = stableNumber(20 * Math.log10(Math.max(rms, 1e-8)));
    const deltaRmsDbFromPrevious = previousRmsDbfs === null ? null : stableNumber(rmsDbfs - previousRmsDbfs);
    previousRmsDbfs = rmsDbfs;
    return { ...clip, energy: { ...sampleWindow, sampleRate: buffer.sampleRate, rmsDbfs, deltaRmsDbFromPrevious } };
  });
  return {
    ...census,
    clips: census.clips.map((clip, index) => measured[index] ?? clip),
    energy: {
      status: "measured",
      clipsMeasured: measured.filter((clip) => clip.energy !== undefined).length,
      truncated: census.clips.length > MAX_ENERGY_CLIPS || census.counts.clipsInScope > MAX_ENERGY_CLIPS,
    },
  };
}
