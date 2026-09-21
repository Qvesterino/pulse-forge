import { AudioEngine } from "../audio-engine/AudioEngine";
import { curatedReadyWithin } from "../sample-library/curated";
import { userSamplesReadyWithin } from "../persistence/UserSampleRepository";
import type { SampleBank } from "../sample-library/factory";
import type { AutomationPoint, Pattern, PlayMode, ProjectDocument } from "../project-model/types";
import { BAR_TICKS, PPQ, STEP_TICKS, getActivePattern } from "../project-model/types";
import { drumHitsInWindow } from "../project-model/groove";
import { noteEventsInWindow } from "../project-model/events";
import { computeSceneIntensity } from "../project-model/intensity";
import { ensureWorkletsForDoc } from "../audio-worklets/loader";

export type ExportQuality = "live" | "studio";

export interface RenderOptions {
  mode: PlayMode;
  sampleRate: number;
  tailSeconds?: number;
  /**
   * Disable the project master stage for stem renders. Track, group and
   * return processing stay intact; only the final master gain / tonal /
   * glue / clipper / limiter stage is neutralized. The full mix should
   * still be exported separately because nonlinear master processing
   * cannot be reconstructed by summing isolated stems.
   * Defaults to true for backward compatibility.
   */
  masterProcessing?: boolean;
  /**
   * Global Live/Export quality switch. "studio" (default in the export UI)
   * bumps every PRISM instance to 8× saturation oversampling and every
   * default-tier VØID instance to the render tier for the duration of THIS
   * render — no realtime CPU budget offline, so the cleaner aliasing floor
   * and tails are free. "live" renders exactly what you hear, faster.
   * The document itself is never modified; bumps ride the runtime parameter
   * preview path. When set, it wins over the legacy per-plugin flags below.
   */
  quality?: ExportQuality;
  /**
   * Legacy per-plugin flags (kept for back-compat). Prefer `quality`.
   * When `quality` is set these are ignored.
   */
  fxeqRenderQuality?: boolean;
  /**
   * Legacy per-plugin flag (kept for back-compat). Prefer `quality`.
   * When `quality` is set this is ignored.
   */
  ozvenaRenderQuality?: boolean;
  /**
   * Cancellation for the PRE-RENDER phase (curated-layer wait, worklet load,
   * graph build, scheduling). An OfflineAudioContext render itself cannot be
   * aborted once `startRendering` is called — the signal is checked again
   * right before that point, so cancelling during the (possibly multi-second)
   * setup fails fast instead of rendering a buffer the caller throws away.
   */
  signal?: AbortSignal;
}

/** @throws AbortError when the export was cancelled during setup. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
}

/**
 * Resolve the effective per-plugin bump switches for one render. The global
 * `quality` switch wins when present; otherwise the legacy per-plugin flags
 * apply (absent = live tier, i.e. no bump — freeze/bounce/analysis paths
 * stay fast by default, the export UI opts into studio explicitly).
 */
export function resolveRenderQuality(
  options: Pick<RenderOptions, "quality" | "fxeqRenderQuality" | "ozvenaRenderQuality">,
): {
  fxeq: boolean;
  ozvena: boolean;
} {
  if (options.quality !== undefined) {
    const hq = options.quality === "studio";
    return { fxeq: hq, ozvena: hq };
  }
  return { fxeq: options.fxeqRenderQuality === true, ozvena: options.ozvenaRenderQuality === true };
}

/**
 * The VØID quality bump for one document: {trackId, fxId, paramId, value}
 * entries that the renderer feeds through engine.previewFxParam. Pure so the
 * export contract is testable without an audio context. Covers tracks and
 * return tracks (both resolve through previewFxParam); master-chain
 * instances keep their live tier.
 */
export function ozvenaRenderQualityBumps(doc: ProjectDocument): {
  trackId: string;
  fxId: string;
  paramId: string;
  value: number;
}[] {
  const bumps: { trackId: string; fxId: string; paramId: string; value: number }[] = [];
  const containers = [...(doc.tracks ?? []), ...(doc.returns ?? [])];
  for (const track of containers) {
    for (const fx of track.effects ?? []) {
      if (fx.type !== "ozvena" || fx.bypassed) continue;
      const quality = fx.params?.["global.quality"] ?? 1;
      // Only the untouched default (standard) is automatic — an explicit
      // user choice of eco / high / render always wins.
      if (quality !== 1) continue;
      bumps.push({ trackId: track.id, fxId: fx.id, paramId: "global.quality", value: 3 });
    }
  }
  return bumps;
}

/**
 * The quality bump for one document: {trackId, fxId, paramId, value} entries
 * that the renderer feeds through engine.previewFxParam. Pure so the export contract
 * is testable without an audio context.
 */
export function fxeqRenderQualityBumps(doc: ProjectDocument): {
  trackId: string;
  fxId: string;
  paramId: string;
  value: number;
}[] {
  const bumps: { trackId: string; fxId: string; paramId: string; value: number }[] = [];
  for (const track of doc.tracks) {
    for (const fx of track.effects ?? []) {
      if (fx.type !== "fxeq" || fx.bypassed) continue;
      const rawBandCount = fx.params?.bandCount;
      const bands = Number.isFinite(rawBandCount) ? Math.max(2, Math.min(6, Math.round(rawBandCount))) : 6;
      for (let b = 1; b <= bands; b++) {
        bumps.push({ trackId: track.id, fxId: fx.id, paramId: `band${b}.quality`, value: 3 });
      }
    }
  }
  return bumps;
}

/**
 * The unified quality bump for one document: PRISM band-quality entries +
 * VØID render-tier entries that the renderer feeds through
 * engine.previewFxParam. Pure so the export contract is testable without an
 * audio context.
 */
export function renderQualityBumps(doc: ProjectDocument): {
  trackId: string;
  fxId: string;
  paramId: string;
  value: number;
}[] {
  return [...fxeqRenderQualityBumps(doc), ...ozvenaRenderQualityBumps(doc)];
}

/**
 * Roadmap O7 / 2026-09-19 audit: derive the render tail from the longest
 * VØID decay actually in the document instead of a fixed 2 s. VØID E3 hall
 * supports up to a 24 s T60 and the core reports it via getTailSamples();
 * a 2 s tail audibly truncates exactly the flagship use case (long hall
 * pads). Capped so a pathological decay cannot balloon an export: the
 * tail is the deepest reverb's time, bounded to [2, 12] s. Bypassed
 * instances and explicit 0 are ignored. Returns the fallback for documents
 * without a VØID reverb.
 */
export function resolveRenderTailSeconds(doc: ProjectDocument, fallback = 2): number {
  let maxMs = 0;
  const containers = [...(doc.tracks ?? []), ...(doc.returns ?? [])];
  for (const track of containers) {
    for (const fx of track.effects ?? []) {
      if (fx.type !== "ozvena" || fx.bypassed) continue;
      const g = fx.params?.["engines.e3.enabled"] ?? 1;
      const e3Time = g >= 0.5 ? (fx.params?.["engines.e3.time"] ?? 0) : 0;
      const e2g = fx.params?.["engines.e2.enabled"] ?? 1;
      const e2Time = e2g >= 0.5 ? (fx.params?.["engines.e2.time"] ?? 0) : 0;
      maxMs = Math.max(maxMs, e3Time, e2Time);
    }
  }
  if (maxMs <= 0) return fallback;
  // A T60 (amplitude −60 dB) leaves the last ~10% of its time below the
  // noise floor; 1.1x the decay plus a 0.5 s release is a faithful tail
  // without rendering the silent remainder in full.
  return Math.max(fallback, Math.min(12, (maxMs / 1000) * 1.1 + 0.5));
}

export interface ClipWindow {  pattern: Pattern;
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
    // Audio clips can sit past the last scene clip (outro vocals, ad-libs).
    // Duration must cover them or they are silently truncated/dropped from
    // the export while live playback plays them fine.
    const audioEnd = (doc.arrangement.audioClips ?? []).reduce(
      (max, c) => Math.max(max, c.startBar + c.lengthBars),
      0,
    );
    const total = Math.max(end, audioEnd);
    if (total > 0) return total * BAR_TICKS;
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
  throwIfAborted(options.signal);
  // Curated factory layer (same-id override, memoized per bank): exports wait
  // briefly for the curated sound so "what you hear is what you export" —
  // after the timeout the synthesized fallback renders (offline installs).
  await curatedReadyWithin(bank, 2000);
  throwIfAborted(options.signal);
  // User samples (recorded takes, imports): same bounded readiness. Without
  // this a render started before the boot restore finishes silently drops
  // `user.*` buffers — and a freeze would persist that silence permanently.
  await userSamplesReadyWithin(bank, 4000);
  throwIfAborted(options.signal);
  const tail = options.tailSeconds ?? resolveRenderTailSeconds(doc);
  const secondsPerTick = 60 / (doc.bpm * PPQ);
  const totalTicks = computeRenderTicks(doc, options.mode);
  const sampleRate = options.sampleRate;
  const pendingWindows = collectClipWindows(doc, options.mode);
  const tempoMap = buildTempoMap(doc, pendingWindows);
  // Duration must reach the LAST RENDERED TICK, not just the last clip
  // window's end: with audio clips past the final scene clip, totalSeconds
  // stops short and the OfflineAudioContext cuts them off.
  const duration =
    (tempoMap.segments.length > 0 ? tempoMap.timeAt(totalTicks) : totalTicks * secondsPerTick) + tail;
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
  const renderDoc = unfreezeDoc(doc);
  if (options.masterProcessing === false) {
    // Transfer stems are intended to be rebalanced in another DAW. Preserve
    // each source's instrument, channel, group and return processing, but do
    // not bake the same nonlinear master chain onto every isolated render.
    // Keep this on a fresh document object: export must never mutate the
    // user's live project or its serialized master settings.
    engine.setProject({
      ...renderDoc,
      master: {
        ...renderDoc.master,
        masterGain: 1,
        limiterEnabled: false,
        clipperEnabled: false,
        tapeEnabled: false,
        msEnabled: false,
        msMidGain: 0,
        msSideGain: 0,
        glueEnabled: false,
        bassMonoEnabled: false,
        tiltDb: 0,
      },
    });
  } else {
    engine.setProject(renderDoc);
  }

  // Global Live/Export quality switch (opt-in): push the runtime quality
  // bumps AFTER the project sync so they win over the document values
  // without mutating them. Legacy per-plugin flags keep working through the
  // same resolver.
  {
    const resolved = resolveRenderQuality(options);
    if (resolved.fxeq) {
      for (const bump of fxeqRenderQualityBumps(doc)) {
        engine.previewFxParam(bump.trackId, bump.fxId, bump.paramId, bump.value);
      }
    }
    if (resolved.ozvena) {
      for (const bump of ozvenaRenderQualityBumps(doc)) {
        engine.previewFxParam(bump.trackId, bump.fxId, bump.paramId, bump.value);
      }
    }
  }

  const timeAt = tempoMap.timeAt;
  const windows = pendingWindows;
  // Scene intensity is a modulation source. Schedule its resolved values on
  // the offline timeline before notes/automation so exports follow the same
  // scene curve that the live scheduler feeds into the engine.
  engine.scheduleSceneIntensity(buildSceneIntensityPoints(doc, windows, totalTicks), timeAt);

  for (const window of windows) {
    // Tempo-synced runtimes (texture SYNC delay, granular rate sync, LFO
    // syncs) must see this window's scene tempo BEFORE its notes are
    // scheduled — the live scheduler flips them at the seam boundary, so
    // per-window parity keeps SYNC'd material aligned with the transport.
    // `when` schedules the change at the window's own start time: without it
    // every push wrote at ctx.currentTime (=0 offline) and the LAST window's
    // BPM won for tempo-synced FX across the whole export.
    engine.setEffectiveBpm(window.bpm ?? null, timeAt(window.from));
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
  // Reuses frozenPlaybackOffset tick→sec semantics so live==offline. SONG
  // MODE ONLY: the live scheduler plays audioClips exclusively in the song
  // branch, so a pattern-mode export must not include arrangement audio the
  // user never hears in pattern playback.
  if (options.mode === "song" && doc.arrangement.audioClips) {
    for (const clip of doc.arrangement.audioClips) {
      const clipStartTick = clip.startBar * BAR_TICKS;
      const clipEndTick = clipStartTick + clip.lengthBars * BAR_TICKS;
      // Only schedule if clip overlaps the total render window
      if (clipEndTick <= 0 || clipStartTick >= totalTicks) continue;
      const when = timeAt(clipStartTick);
      // Wall-clock duration through the tempo map (scene BPM aware).
      const durationSec = timeAt(clipEndTick) - when;
      // Pitch-preserving warp (stretch + pins): pre-render synchronously with
      // the same core the live worker uses, so the export is sample-exact
      // with a warmed live cache.
      if ((clip.warpMarkers?.length ?? 0) > 0 && clip.stretchMode === "stretch" && !clip.reverse && !clip.loop) {
        engine.precomputeWarpSync(clip, durationSec);
      }
      engine.triggerAudioClip(clip, when, durationSec);
    }
  }

  // Last cancellation window before the un-abortable render begins.
  throwIfAborted(options.signal);
  // Release the engine's sample-added subscription: the shared bank outlives
  // this throwaway engine, and an unconsumed closure would retain every
  // discarded render engine (one per export/stem/bounce).
  try {
    return await ctx.startRendering();
  } finally {
    engine.detachBank();
  }
}

/** Build the intensity signal shared by offline rendering and its tests. */
export function buildSceneIntensityPoints(
  doc: ProjectDocument,
  windows: ClipWindow[],
  totalTicks: number,
): Array<{ tick: number; value: number }> {
  const points: Array<{ tick: number; value: number }> = [{ tick: 0, value: 0.7 }];
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  for (let index = 0; index < sorted.length; index++) {
    const window = sorted[index];
    if (window.from > (index === 0 ? 0 : sorted[index - 1].to)) {
      points.push({ tick: window.from, value: 0.7 });
    }
    const scene = window.sceneId
      ? doc.scenes.find((candidate) => candidate.id === window.sceneId)
      : doc.scenes.find((candidate) => candidate.patternId === window.pattern.id);
    if (!scene) {
      points.push({ tick: window.from, value: 0.7 }, { tick: window.to, value: 0.7 });
      continue;
    }

    if (window.sceneId) {
      points.push({ tick: window.from, value: computeSceneIntensity(scene, window.base, window.from) });
      for (const curvePoint of scene.intensityCurve ?? []) {
        const absoluteTick = window.base + curvePoint.offset;
        if (absoluteTick > window.from && absoluteTick < window.to) {
          points.push({ tick: absoluteTick, value: computeSceneIntensity(scene, window.base, absoluteTick) });
        }
      }
      points.push({ tick: window.to, value: computeSceneIntensity(scene, window.base, window.to) });
    } else {
      // Pattern-mode live playback intentionally uses the scene's static
      // intensity; a curve belongs to an arrangement clip context.
      const value = Number.isFinite(scene.intensity) ? Math.max(0, Math.min(1, scene.intensity)) : 0.7;
      points.push({ tick: window.from, value }, { tick: window.to, value });
    }

    const next = sorted[index + 1];
    if (!next || next.from > window.to) points.push({ tick: window.to, value: 0.7 });
  }
  if (Number.isFinite(totalTicks) && totalTicks > 0) points.push({ tick: totalTicks, value: 0.7 });

  // At clip boundaries the later point is authoritative (the next scene wins
  // at its exact start). Keep the timeline monotonic and deterministic.
  const deduped: Array<{ tick: number; value: number }> = [];
  for (const point of points.sort((a, b) => a.tick - b.tick)) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.tick === point.tick) previous.value = point.value;
    else deduped.push(point);
  }
  return deduped;
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
