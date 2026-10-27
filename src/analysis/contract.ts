import type { ProjectDocument } from "../project-model/types";
import { ticksPerBar } from "../project-model/schema";
import { arrangementSecondsBetweenTicks } from "../project-model/scene-time";

/**
 * AUDIO ANALYSIS CONTRACT (E-1, audio-perception audit §7/§14) — the one
 * envelope every analyzer result travels in, and the ONE ticks→samples
 * mapping analysis may use.
 *
 * The mapping is `arrangementSecondsBetweenTicks` (scene-time.ts) — the same
 * piecewise scene-pin/project-tempo integral playback and the offline tempo
 * map use — so an analysis window declared in ticks names exactly the
 * samples a render of that window contains. Analyzers must not derive
 * seconds any other way.
 *
 * The envelope carries what the audit flagged missing: project revision,
 * signal stage, algorithm identity+version, confidence, partial-reason, and
 * caveats that name the KNOWN alignment hazards instead of hiding them
 * (frozen playback's project-tempo mapping, absent revision in collab).
 *
 * Pure module: no DOM, no audio context, no I/O — vitest- and worker-safe.
 */

export type AnalysisScopeKind = "track" | "clip" | "bus" | "master";
export type AnalysisStage = "source" | "clip" | "track" | "bus" | "master";

export interface AnalysisScope {
  kind: AnalysisScopeKind;
  /** Track id (track scope), clip id (clip scope), bus id (bus scope). Absent for master. */
  id?: string;
}

export interface AudioAnalysisRequest {
  /** Document identity the request was computed against. */
  projectId: string;
  /**
   * The store revision the request was computed against. Absent means the
   * caller could not know it (e.g. a Yjs-backed store) — results carry the
   * `freshness-unknown` caveat and consumers must not treat them as fresh.
   */
  revision?: number;
  scope: AnalysisScope;
  /** Declared window on the ARRANGEMENT timeline, in ticks. */
  window: { startTick: number; endTick: number };
  stage: AnalysisStage;
  /** Which typed payload schema the caller expects (e.g. "mix-health"). */
  featureSet: string;
}

export interface AnalysisCaveat {
  code: "frozen-playback-uses-project-tempo" | "freshness-unknown" | "source-window-approximate";
  detail: string;
}

export interface AudioAnalysisResult<T = unknown> {
  request: AudioAnalysisRequest;
  algorithm: { name: string; version: string };
  /** Revision of the document the analysis actually ran on. */
  producedAtRevision?: number;
  alignment: {
    sampleRate: number;
    startSample: number;
    endSample: number;
    durationSec: number;
    /** The tempo segments the window crossed (scene pins included). */
    tempoContext: Array<{ fromTick: number; toTick: number; bpm: number }>;
  };
  /**
   * Clip scope only: where the window sits in the CLIP'S SOURCE, in source
   * seconds (trim included). Reverse/loop/warp clips set the
   * `source-window-approximate` caveat — v1 maps straight clips only.
   */
  sourceWindow?: { startSec: number; endSec: number };
  caveats: AnalysisCaveat[];
  confidence: number | null;
  payload: T;
  partial?: { reason: string };
}

export interface ResolvedWindow {
  startSec: number;
  endSec: number;
  startSample: number;
  endSample: number;
  tempoContext: Array<{ fromTick: number; toTick: number; bpm: number }>;
  caveats: AnalysisCaveat[];
}

/**
 * THE ticks→seconds→samples mapping. Uses the same spans playback and the
 * offline tempo map use; `Math.round` at the sample edge (±1 sample is the
 * contract's tolerance).
 */
export function resolveAnalysisWindow(
  doc: ProjectDocument,
  request: Pick<AudioAnalysisRequest, "window" | "revision" | "scope">,
  sampleRate: number,
): ResolvedWindow {
  const barUnitTicks = ticksPerBar(doc);
  const { startTick, endTick } = request.window;
  if (!(endTick > startTick)) throw new Error(`analysis window must be forward (got ${startTick}..${endTick})`);

  const startSec = arrangementSecondsBetweenTicks(doc.arrangement.clips, doc.scenes, 0, startTick, doc.bpm, barUnitTicks);
  const endSec = arrangementSecondsBetweenTicks(doc.arrangement.clips, doc.scenes, 0, endTick, doc.bpm, barUnitTicks);

  // The tempo segments the window crossed — from the same span builder the
  // integral uses, clipped to the window for the result's tempoContext.
  const barUnit = barUnitTicks;
  const spans = doc.arrangement.clips
    .filter((clip) => clip.lengthBars > 0)
    .map((clip) => ({
      fromTick: clip.startBar * barUnit,
      toTick: (clip.startBar + clip.lengthBars) * barUnit,
      bpm: clipSpanBpm(doc, clip),
    }))
    .filter((span) => span.toTick > span.fromTick && span.toTick > startTick && span.fromTick < endTick)
    .sort((a, b) => a.fromTick - b.fromTick);

  const caveats: AnalysisCaveat[] = [];
  if (request.revision === undefined) {
    caveats.push({
      code: "freshness-unknown",
      detail: "the request declared no revision — the result cannot be checked for freshness",
    });
  }
  const frozen = findFrozenIntersections(doc, request.scope, startTick, endTick);
  if (frozen) {
    caveats.push({
      code: "frozen-playback-uses-project-tempo",
      detail: `frozen track(s) ${frozen.join(", ")} align at project tempo during playback (warpManager.frozenPlaybackOffset) — a live-session window over them may mis-locate against scene pins`,
    });
  }

  return {
    startSec,
    endSec,
    startSample: Math.round(startSec * sampleRate),
    endSample: Math.round(endSec * sampleRate),
    tempoContext: spans,
    caveats,
  };
}

function clipSpanBpm(doc: ProjectDocument, clip: { sceneId: string }): number {
  const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
  const bpm = scene?.bpm;
  return bpm !== undefined && Number.isFinite(bpm) && bpm > 0 ? bpm : doc.bpm;
}

/** True when the scope's window covers audio on a frozen track (G-4 hazard). */
function findFrozenIntersections(
  doc: ProjectDocument,
  scope: AnalysisScope,
  startTick: number,
  endTick: number,
): string[] {
  const frozenTrackIds = new Set(doc.tracks.filter((t) => t.frozen?.bufferId).map((t) => t.id));
  if (frozenTrackIds.size === 0) return [];
  const relevant = doc.arrangement.audioClips ?? [];
  const hit = new Set<string>();
  for (const clip of relevant) {
    if (!frozenTrackIds.has(clip.trackId)) continue;
    if (scope.kind === "clip" && scope.id && clip.id !== scope.id) continue;
    if (scope.kind === "track" && scope.id && clip.trackId !== scope.id) continue;
    const from = clip.startBar * ticksPerBar(doc);
    const to = (clip.startBar + clip.lengthBars) * ticksPerBar(doc);
    if (to > startTick && from < endTick) hit.add(doc.tracks.find((t) => t.id === clip.trackId)?.name ?? clip.trackId);
  }
  return [...hit];
}

/**
 * Clip-scope source mapping: where does an arrangement window sit in the
 * clip's SOURCE? v1 maps STRAIGHT clips (no reverse/loop/warp/stretch
 * beyond 1) — anything else sets `source-window-approximate`.
 */
export function resolveClipSourceWindow(
  doc: ProjectDocument,
  clipId: string,
  window: { startTick: number; endTick: number },
): { startSec: number; endSec: number; caveats: AnalysisCaveat[] } {
  const clip = (doc.arrangement.audioClips ?? []).find((candidate) => candidate.id === clipId);
  if (!clip) throw new Error(`clip ${clipId} not found`);
  const barUnitTicks = ticksPerBar(doc);
  const caveats: AnalysisCaveat[] = [];
  if (clip.reverse || clip.loop || clip.stretchRate !== 1 || (clip.warpMarkers?.length ?? 0) > 0) {
    caveats.push({
      code: "source-window-approximate",
      detail: "reverse/loop/warp/stretch clips do not map arrangement→source linearly — v1 resolves straight clips only",
    });
  }
  const toSec = (tick: number): number =>
    arrangementSecondsBetweenTicks(doc.arrangement.clips, doc.scenes, 0, tick, doc.bpm, barUnitTicks);
  const clipStartTick = clip.startBar * barUnitTicks;
  const clipEndTick = (clip.startBar + clip.lengthBars) * barUnitTicks;
  const lo = Math.max(window.startTick, clipStartTick);
  const hi = Math.min(window.endTick, clipEndTick);
  if (hi <= lo) return { startSec: 0, endSec: 0, caveats };
  const intoStart = toSec(lo) - toSec(clipStartTick);
  const intoEnd = toSec(hi) - toSec(clipStartTick);
  return {
    startSec: clip.trimStart + intoStart,
    endSec: clip.trimStart + intoEnd,
    caveats,
  };
}

export interface AnalyzerDefinition<P> {
  name: string;
  version: string;
  featureSet: string;
  /** The pure analyzer core: window PCM in, typed payload out. */
  analyze: (channels: readonly Float32Array[], sampleRate: number, windowSec: { startSec: number; endSec: number }) => P;
  /** Optional confidence derived from the payload. */
  confidence?: (payload: P) => number | null;
}

/**
 * Wrap a pure analyzer so its result travels in the envelope. The caller
 * supplies the strip's FULL PCM (e.g. from `renderTrack`); the runner slices
 * the resolved window — analyzers never see unmapped audio.
 */
export function defineAnalyzer<P>(definition: AnalyzerDefinition<P>) {
  return {
    definition,
    run(
      doc: ProjectDocument,
      request: AudioAnalysisRequest,
      channels: readonly Float32Array[],
      sampleRate: number,
    ): AudioAnalysisResult<P> {
      const resolved = resolveAnalysisWindow(doc, request, sampleRate);
      const frameCount = resolved.endSample - resolved.startSample;
      if (frameCount <= 0) {
        return {
          request,
          algorithm: { name: definition.name, version: definition.version },
          producedAtRevision: request.revision,
          alignment: { ...resolved, sampleRate, durationSec: resolved.endSec - resolved.startSec },
          caveats: resolved.caveats,
          confidence: null,
          payload: undefined as P,
          partial: { reason: `resolved window is empty at ${sampleRate} Hz` },
        };
      }
      const sliced = channels.map((channel) => channel.slice(resolved.startSample, resolved.endSample));
      const payload = definition.analyze(sliced, sampleRate, {
        startSec: resolved.startSec,
        endSec: resolved.endSec,
      });
      return {
        request,
        algorithm: { name: definition.name, version: definition.version },
        producedAtRevision: request.revision,
        alignment: { ...resolved, sampleRate, durationSec: resolved.endSec - resolved.startSec },
        caveats: resolved.caveats,
        confidence: definition.confidence?.(payload) ?? null,
        payload,
      };
    },
  };
}
