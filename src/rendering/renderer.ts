import { AudioEngine } from "../audio-engine/AudioEngine";
import type { SampleBank } from "../sample-library/factory";
import type { AutomationPoint, Pattern, PlayMode, ProjectDocument } from "../project-model/types";
import { BAR_TICKS, PPQ, STEP_TICKS, getActivePattern } from "../project-model/types";
import { drumHitsInWindow } from "../project-model/groove";
import { noteEventsInWindow } from "../project-model/events";
import { ensureWorkletsForDoc } from "../audio-worklets/loader";

export interface RenderOptions {
  mode: PlayMode;
  sampleRate: number;
  tailSeconds?: number;
}

interface ClipWindow {
  pattern: Pattern;
  base: number;
  from: number;
  to: number;
  /** Scene tempo for this window (falls back to the project BPM). */
  bpm?: number;
  /** Owning scene (song mode only) — drives offline sceneAutomation rendering. */
  sceneId?: string;
}

export function computeRenderTicks(doc: ProjectDocument, mode: PlayMode): number {
  if (mode === "song") {
    const end = doc.arrangement.clips.reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0);
    if (end > 0) return end * BAR_TICKS;
  }
  return getActivePattern(doc).stepCount * STEP_TICKS;
}

function collectClipWindows(doc: ProjectDocument, mode: PlayMode): ClipWindow[] {
  if (mode === "song") {
    const windows: ClipWindow[] = [];
    for (const clip of [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar)) {
      const scene = doc.scenes.find((s) => s.id === clip.sceneId);
      if (!scene) continue;
      const pattern = doc.patterns.find((p) => p.id === scene.patternId);
      if (!pattern) continue;
      const base = clip.startBar * BAR_TICKS;
      windows.push({
        pattern,
        base,
        from: base,
        to: base + clip.lengthBars * BAR_TICKS,
        bpm: scene.bpm ?? doc.bpm,
        sceneId: clip.sceneId,
      });
    }
    if (windows.length > 0) return windows;
  }
  const pattern = getActivePattern(doc);
  const patternTicks = pattern.stepCount * STEP_TICKS;
  return [{ pattern, base: 0, from: 0, to: patternTicks, bpm: doc.bpm }];
}

export interface TempoSegment {
  from: number;
  to: number;
  bpm: number;
  /** Wall-clock time (seconds) at `from`. */
  startTime: number;
}

/**
 * Piecewise tick→seconds map for scene tempo lanes: every window runs at its
 * scene's BPM, gaps between windows run at the project BPM. Pure — the
 * offline render and its length computation both consume it.
 */
export function buildTempoMap(
  doc: ProjectDocument,
  windows: ClipWindow[],
): {
  segments: TempoSegment[];
  totalSeconds: number;
  timeAt: (tick: number) => number;
} {
  const docSpt = 60 / (doc.bpm * PPQ);
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  const segments: TempoSegment[] = [];
  let cursorTick = 0;
  let cursorTime = 0;
  for (const w of sorted) {
    if (w.from > cursorTick) {
      // Gap: project-tempo travel up to the window start.
      cursorTime += (w.from - cursorTick) * docSpt;
      cursorTick = w.from;
    }
    const bpm = w.bpm ?? doc.bpm;
    const spt = 60 / (bpm * PPQ);
    segments.push({ from: w.from, to: w.to, bpm, startTime: cursorTime });
    cursorTime += (w.to - w.from) * spt;
    cursorTick = Math.max(cursorTick, w.to);
  }
  const totalSeconds = cursorTime;
  const timeAt = (tick: number): number => {
    let seg: TempoSegment | null = null;
    for (const s of segments) {
      if (tick >= s.from && tick <= s.to) {
        seg = s;
        break;
      }
    }
    if (!seg) {
      // Outside every window: project-tempo travel from the nearest edge.
      const first = segments[0];
      const last = segments[segments.length - 1];
      if (tick < first.from) return tick * docSpt;
      return last.startTime + (tick - last.to) * docSpt;
    }
    return seg.startTime + (tick - seg.from) * (60 / (seg.bpm * PPQ));
  };
  return { segments, totalSeconds, timeAt };
}

/**
 * Strip frozen state for offline rendering. Frozen buffers are a LIVE
 * transport feature (bank + frozenBuffers) and are never populated offline;
 * rendering the unfrozen document reproduces each track's real processing
 * chain — which is exactly what the frozen buffer was rendered from.
 */
export function unfreezeDoc(doc: ProjectDocument): ProjectDocument {
  const hasFrozen = doc.tracks.some((t) => "frozen" in t && t.frozen);
  if (!hasFrozen) return doc;
  return {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (!("frozen" in t) || !t.frozen) return t;
      const { frozen: _frozen, ...rest } = t as unknown as Record<string, unknown>;
      return rest as unknown as typeof t;
    }),
  };
}

export async function renderProject(
  doc: ProjectDocument,
  bank: SampleBank,
  options: RenderOptions,
): Promise<AudioBuffer> {
  // Defect A06.D2 (browser compatibility hardening): feature-detect
  // OfflineAudioContext before constructing it. The shared-core
  // services path runs through the same renderer in worker contexts
  // (e.g. freeze / bounce / export) — a worker that lacks the
  // OfflineAudioContext constructor would throw a ReferenceError at
  // `new OfflineAudioContext(...)` and abort the export with a
  // confusing stack trace. Surface a stable, named error so the UI
  // can branch on `err.message` and show a clear "your browser does
  // not support offline rendering" hint instead.
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("OfflineAudioContext is not available in this environment — offline export is unsupported.");
  }
  const tail = options.tailSeconds ?? 2;
  const secondsPerTick = 60 / (doc.bpm * PPQ);
  const totalTicks = computeRenderTicks(doc, options.mode);
  const sampleRate = options.sampleRate;
  const pendingWindows = collectClipWindows(doc, options.mode);
  const tempoMap = buildTempoMap(doc, pendingWindows);
  const duration = (tempoMap.totalSeconds || totalTicks * secondsPerTick) + tail;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  // Load AudioWorklet processors into THIS offline context so bitcrusher
  // downsample and sidechain ducking render correctly (the fallbacks are
  // broken offline: WaveShaper has no state, setInterval never fires).
  // Vendored plugin modules (fxeq/ultina/ozvena) load only when the project
  // uses them. Never rejects — factories fall back gracefully when
  // unavailable.
  await ensureWorkletsForDoc(doc, ctx);

  const engine = new AudioEngine();
  engine.attachBank(bank);
  engine.useContext(ctx);
  // Render the UNFROZEN document. The offline path never populates
  // frozenBuffers (restartFrozenSources is live-transport-only), so a frozen
  // instrument track dropped every note and a frozen drum track rendered
  // dry — the frozen buffer itself was rendered from the track's real
  // chain, so live-chain rendering is the correct export content.
  engine.setProject(unfreezeDoc(doc));

  const timeAt = tempoMap.timeAt;
  const windows = pendingWindows;

  for (const window of windows) {
    scheduleDrums(doc, window, timeAt, engine);
    scheduleNotes(window, timeAt, 60 / ((window.bpm ?? doc.bpm) * PPQ), engine);
  }
  scheduleAutomation(doc, windows, timeAt, engine);
  // Scene automation lanes (release roadmap 1.2): live applies these per
  // window via applySceneAutomationLane; offline schedules the lane's exact
  // shape through each owning clip's window via the same tempo map.
  scheduleSceneAutomation(doc, windows, timeAt, engine);
  // Schedulable track modulators (random S&H / step) share the same window
  // sweep so offline exports match live playback deterministically.
  engine.scheduleModulatorsOffline(
    windows.map((w) => ({ from: w.from, to: w.to })),
    timeAt,
  );
  // AudioClips — schedule each clip's buffer segment through its track FX.
  // Reuses frozenPlaybackOffset tick→sec semantics so live==offline.
  if (doc.arrangement.audioClips) {
    for (const clip of doc.arrangement.audioClips) {
      const clipStartTick = clip.startBar * BAR_TICKS;
      const clipEndTick = clipStartTick + clip.lengthBars * BAR_TICKS;
      // Only schedule if clip overlaps the total render window
      if (clipEndTick <= 0 || clipStartTick >= totalTicks) continue;
      const when = timeAt(clipStartTick);
      // Wall-clock duration through the tempo map (scene BPM aware).
      const durationSec = timeAt(clipEndTick) - when;
      engine.triggerAudioClip(clip, when, durationSec);
    }
  }

  return ctx.startRendering();
}

function scheduleDrums(
  doc: ProjectDocument,
  window: ClipWindow,
  timeAt: (tick: number) => number,
  engine: AudioEngine,
): void {
  // Shared groove engine — export swings/humanizes/rolls exactly like playback.
  for (const hit of drumHitsInWindow(doc, window.pattern, window.base, window.from, window.to)) {
    engine.trigger(hit.trackId, hit.pad, timeAt(hit.tick), hit.velocity, hit.locks);
  }
}

function scheduleNotes(
  window: ClipWindow,
  timeAt: (tick: number) => number,
  secondsPerTick: number,
  engine: AudioEngine,
): void {
  const { base, from, to } = window;
  for (const event of noteEventsInWindow(window.pattern, base, from, to)) {
    // FL slide note: glide from previous non-slide note's end (live==offline)
    const slideFrom = event.slideFrom;
    const step = Math.floor((event.tick - base) / 120);
    const metaLocks = (window.pattern as any).stepMeta?.[event.trackId]?.[step]?.locks as
      Partial<Record<import("../project-model/types").StepLockKey, number>> | undefined;
    const noteLocks = (event.note as any).locks as
      Partial<Record<import("../project-model/types").StepLockKey, number>> | undefined;
    const locks = noteLocks ?? metaLocks;
    engine.noteOn(
      event.trackId,
      event.note.pitch,
      event.note.velocity,
      timeAt(event.tick),
      event.note.duration * secondsPerTick,
      slideFrom?.tick,
      slideFrom?.pitch,
      locks,
      // Glide origin from the SAME tempo map — the engine's doc.bpm fallback
      // desyncs slides under scene tempo (parity with the live scheduler).
      slideFrom ? timeAt(slideFrom.tick) : undefined,
    );
  }
}

/**
 * Offline rendering of `doc.sceneAutomation` (release roadmap 1.2). Lane
 * points are scene-relative; each clip window owned by the lane's scene
 * receives the lane's exact shape — boundary values at both window edges
 * (interpolated exactly like the live applySceneAutomationLane) plus every
 * interior point — written through the same tempo-map `timeAt` the project
 * automation uses. Clips of the same scene chain continuously (the end value
 * of one window equals the start value of the next). Pattern-mode fallback
 * windows carry no sceneId and are skipped, matching live song-mode-only
 * semantics.
 */
export function scheduleSceneAutomation(
  doc: ProjectDocument,
  windows: ClipWindow[],
  timeAt: (tick: number) => number,
  engine: AudioEngine,
): void {
  const lanes = doc.sceneAutomation;
  if (!lanes || lanes.length === 0 || windows.length === 0) return;
  const valueAtLocal = (points: AutomationPoint[], tick: number): number => {
    if (tick <= points[0].tick) return points[0].value;
    if (tick >= points[points.length - 1].tick) return points[points.length - 1].value;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (tick >= a.tick && tick <= b.tick) {
        const span = b.tick - a.tick;
        if (span <= 0) return a.value;
        const t = (tick - a.tick) / span;
        return a.value + (b.value - a.value) * t;
      }
    }
    return points[points.length - 1].value;
  };
  for (const lane of lanes) {
    if (lane.points.length === 0) continue;
    for (const window of windows) {
      if (window.sceneId !== lane.sceneId) continue;
      const fromLocal = Math.max(0, window.from - window.base);
      const toLocal = window.to - window.base;
      if (toLocal <= fromLocal) continue;
      // Boundary values first, then every interior lane point.
      const expanded: AutomationPoint[] = [
        { tick: window.from, value: valueAtLocal(lane.points, fromLocal) },
        { tick: window.to, value: valueAtLocal(lane.points, toLocal) },
      ];
      for (const point of lane.points) {
        const absoluteTick = window.base + point.tick;
        if (absoluteTick > window.from && absoluteTick < window.to) {
          expanded.push({ tick: absoluteTick, value: point.value });
        }
      }
      expanded.sort((a, b) => a.tick - b.tick);
      switch (lane.target.kind) {
        case "trackGain":
          engine.scheduleTrackAutomation(lane.target.trackId, "gain", expanded, timeAt);
          break;
        case "trackPan":
          engine.scheduleTrackAutomation(lane.target.trackId, "pan", expanded, timeAt);
          break;
        case "fxParam": {
          if (!lane.target.fxId) break;
          engine.scheduleDeviceAutomation(
            lane.target.trackId,
            "fx",
            lane.target.fxId,
            lane.target.paramId,
            expanded,
            timeAt,
          );
          break;
        }
        case "instParam":
          engine.scheduleDeviceAutomation(
            lane.target.trackId,
            "inst",
            undefined,
            lane.target.paramId,
            expanded,
            timeAt,
          );
          break;
      }
    }
  }
}

function scheduleAutomation(
  doc: ProjectDocument,
  windows: ClipWindow[],
  timeAt: (tick: number) => number,
  engine: AudioEngine,
): void {
  if (doc.automation.length === 0 || windows.length === 0) return;
  for (const lane of doc.automation) {
    if (lane.points.length === 0) continue;
    const expanded = expandAutomationAcrossWindows(lane.points, windows);
    if (expanded.length === 0) continue;
    switch (lane.target.kind) {
      case "trackGain":
        engine.scheduleTrackAutomation(lane.target.trackId, "gain", expanded, timeAt);
        break;
      case "trackPan":
        engine.scheduleTrackAutomation(lane.target.trackId, "pan", expanded, timeAt);
        break;
      case "fxParam": {
        if (!lane.target.fxId) break;
        engine.scheduleDeviceAutomation(
          lane.target.trackId,
          "fx",
          lane.target.fxId,
          lane.target.paramId,
          expanded,
          timeAt,
        );
        break;
      }
      case "instParam": {
        engine.scheduleDeviceAutomation(lane.target.trackId, "inst", undefined, lane.target.paramId, expanded, timeAt);
        break;
      }
    }
  }
}

/**
 * Expand pattern-relative automation points across all pattern cycles that fall
 * inside each render window.
 *
 * In the project model, FX and instrument parameter automation lanes are
 * authored in pattern-relative tick space. During offline rendering the
 * scheduler has to translate those points to absolute song ticks, otherwise
 * the parameter would only ever be set in the first pattern cycle and the
 * looping behaviour of the realtime scheduler would be lost in the export.
 *
 * This is the same approach the realtime `applyAutomation` uses internally
 * (`valueAt(points, relOf(tick))`), but pre-expanded so it can drive
 * `scheduleDeviceAutomation` which plans individual automation events.
 */
export function expandAutomationAcrossWindows(points: AutomationPoint[], windows: ClipWindow[]): AutomationPoint[] {
  const expanded: AutomationPoint[] = [];
  for (const window of windows) {
    const patternTicks = window.pattern.stepCount * STEP_TICKS;
    const windowTicks = window.to - window.from;
    if (patternTicks <= 0 || windowTicks <= 0) continue;
    const cycles = Math.max(1, Math.ceil(windowTicks / patternTicks));
    for (let cycle = 0; cycle < cycles; cycle++) {
      const cycleBase = window.from + cycle * patternTicks;
      for (const point of points) {
        const absoluteTick = cycleBase + point.tick;
        if (absoluteTick >= window.to) continue;
        expanded.push({ tick: absoluteTick, value: point.value });
      }
    }
  }
  return expanded;
}
