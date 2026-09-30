import type { AudioClip, ProjectDocument } from "../project-model/types";
import { BAR_TICKS, PPQ } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { hashString } from "../shared/rng";
import { phaseVocoderWarpChannel, warpRateEnvelope, type WarpRateInterval } from "./phase-vocoder";
import { renderWarpPreserveAsync } from "../audio-workers/warp-render-client";
import { MAX_AUDIO_CLIP_WARP_SEGMENTS, resolveWarpPinPoints } from "../project-model/audio-clip-warp";

/**
 * WarpManager — Wave 4e of the AudioEngine decomposition
 * (docs/AUDIOENGINE-DECOMPOSITION-PLAN.md).
 *
 * Owns everything cached/pre-rendered around AudioClips and frozen tracks:
 *
 *  - the time-stretch LRU (lazy `computeStretchedBuffer` results, 48 slots),
 *  - the pitch-preserving warp cache (phase-vocoder renders, 6 slots +
 *    in-flight claims + the invalidation epoch that orphans late renders),
 *  - frozen-track playback (looping BufferSources + the transport alignment
 *    anchor; panic tears them down, `restartFrozenSources` resurrects them).
 *
 * The engine keeps the trigger/scheduling paths (triggerAudioClip consults
 * the warp cache and warms on miss); this class is storage, jobs and
 * lifecycle. Cache invalidation rides the project id: buffers are only
 * meaningful within one bank/project generation, and context swaps never
 * survive here (AudioBuffers hold context-era memory).
 *
 * Facade law: this module never imports AudioEngine. Everything arrives as
 * getter closures in the deps. VERBATIM move from AudioEngine.ts — same
 * bodies, same LRU policies, same epoch semantics.
 */

/**
 * Time-stretch cache ceiling: 48 stretched variants ≈ bounded memory for a
 * realistic arrangement (same policy as the sampler's pitch cache).
 */
export const STRETCH_CACHE_LIMIT = 48;
/** Warp pre-render ceiling (expensive full-buffer phase-vocoder outputs). */
export const WARP_CACHE_LIMIT = 6;

export interface WarpManagerDeps {
  ctx: () => BaseAudioContext | null;
  doc: () => ProjectDocument | null;
  bank: () => SampleBank | null;
  trackInput: (trackId: string) => AudioNode | null;
}

export class WarpManager {
  // ── Frozen-track playback state ──
  private frozenBuffers = new Map<string, AudioBufferSourceNode>();
  private frozenBufferIds = new Map<string, string>();
  private frozenPlaying = false;
  private frozenAlign: { tick: number; ctxTime: number } | null = null;

  // ── Stretch + warp caches ──
  private stretchCache = new Map<string, AudioBuffer>();
  private stretchProjectId: string | null = null;
  private warpCache = new Map<string, AudioBuffer>();
  private warpInflight = new Set<string>();
  private warpEpoch = 0;

  constructor(private readonly deps: WarpManagerDeps) {}

  // ── Cache reads used by the engine's trigger paths ──

  getStretched(cacheKey: string): AudioBuffer | undefined {
    return this.stretchCache.get(cacheKey);
  }

  /** LRU touch + insert for the stretch cache (re-insert on hit, evict oldest). */
  storeStretched(cacheKey: string, buffer: AudioBuffer): void {
    if (this.stretchCache.has(cacheKey)) this.stretchCache.delete(cacheKey);
    else if (this.stretchCache.size >= STRETCH_CACHE_LIMIT) {
      const oldest = this.stretchCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.stretchCache.delete(oldest);
    }
    this.stretchCache.set(cacheKey, buffer);
  }

  getWarp(key: string): AudioBuffer | null {
    return this.warpCache.get(key) ?? null;
  }

  warpCacheKey(clip: AudioClip, wallSec: number): string {
    const pins = (clip.warpMarkers ?? []).map((m) => `${m.timeSec.toFixed(3)}@${Math.round(m.tick)}`).join(",");
    return `${clip.bufferId}|w${wallSec.toFixed(3)}|${hashString(pins).toString(36)}`;
  }

  /** Background warp render into the cache (worker when worthwhile). */
  warmWarp(clip: AudioClip, wallSec: number): void {
    const job = this.buildWarpJob(clip, wallSec);
    if (!job) return;
    if (this.warpCache.has(job.key) || this.warpInflight.has(job.key)) return;
    const epoch = this.warpEpoch;
    const warmCtx = this.deps.ctx();
    this.warpInflight.add(job.key);
    const channels: Float32Array[] = [];
    for (let c = 0; c < job.src.numberOfChannels; c++) channels.push(Float32Array.from(job.src.getChannelData(c)));
    // Audit 12 D1: ALWAYS release the in-flight claim — a rejected render
    // (worker onerror falling into a throwing runSync) used to leave the key
    // claimed forever, silently starving every later re-warm of this clip
    // into repitch fallback for the rest of the session.
    renderWarpPreserveAsync(channels, job.sampleRate, job.intervals, job.outLen)
      .catch((error) => {
        console.warn("[audio-engine] background warp render failed:", error);
        return null;
      })
      .then((rendered) => {
        this.warpInflight.delete(job.key);
        if (!rendered) return;
        const ctx = this.deps.ctx();
        if (rendered.length === 0 || this.warpEpoch !== epoch || !ctx || ctx !== warmCtx) return;
        try {
          const buf = ctx.createBuffer(rendered.length, job.outLen, job.sampleRate);
          rendered.forEach((ch, i) => {
            if (i < buf.numberOfChannels) buf.getChannelData(i).set(ch.subarray(0, job.outLen));
          });
          this.storeWarpBuffer(job.key, buf);
        } catch {
          /* context died mid-render */
        }
      });
  }

  /**
   * Synchronous pitch-preserving warp render (offline/export path — no
   * realtime pressure). Result is cached, so the live trigger hitting the
   * same wall length plays the identical buffer.
   */
  precomputeWarpSync(clip: AudioClip, wallSec: number): AudioBuffer | null {
    const ctx = this.deps.ctx();
    const job = this.buildWarpJob(clip, wallSec);
    if (!ctx || !job) return null;
    const hit = this.warpCache.get(job.key);
    if (hit) return hit;
    try {
      const rateAt = warpRateEnvelope(job.intervals);
      const buf = ctx.createBuffer(job.src.numberOfChannels, job.outLen, job.sampleRate);
      for (let c = 0; c < job.src.numberOfChannels; c++) {
        buf
          .getChannelData(c)
          .set(phaseVocoderWarpChannel(job.src.getChannelData(c), job.sampleRate, rateAt, job.outLen));
      }
      this.storeWarpBuffer(job.key, buf);
      return buf;
    } catch {
      return null;
    }
  }

  /**
   * Project-tempo estimate for UI-driven prewarming (the exact wall follows
   * the scene tempo at trigger; a tempo-mismatched key simply misses and
   * re-warms). Called after warp edits so the next play is already exact.
   */
  warmWarpForClip(clip: AudioClip): void {
    const bpm = this.deps.doc()?.bpm;
    if (!bpm || !(bpm > 0)) return;
    this.warmWarp(clip, (clip.lengthBars * BAR_TICKS * 60) / (bpm * PPQ));
  }

  /** Clear the time-stretch buffer cache (project swap). */
  clearStretchCache(): void {
    this.stretchCache.clear();
  }

  /** Clear pitch-preserving warp renders (project swap / bank rebuild). */
  clearWarpCache(): void {
    this.warpCache.clear();
    this.warpInflight.clear();
  }

  /**
   * Project-swap invalidation: stretch/warp buffers are only meaningful
   * within one project generation. Returns true when the project actually
   * changed (the engine also clears missedAssets in that case).
   */
  syncProjectId(projectId: string): boolean {
    if (this.stretchProjectId === projectId) return false;
    this.stretchProjectId = projectId;
    this.clearStretchCache();
    this.clearWarpCache();
    this.warpEpoch++;
    return true;
  }

  /** Context-swap invalidation: context-era buffers never survive a swap. */
  invalidateForContextSwap(): void {
    this.stretchCache.clear();
    this.clearWarpCache();
    this.warpEpoch++;
  }

  // ── Frozen-track playback ──

  isFrozen(trackId: string): boolean {
    return this.frozenBuffers.has(trackId);
  }

  get frozenActive(): boolean {
    return this.frozenPlaying;
  }

  /**
   * Start (or restart) looping frozen-track sources aligned to the transport.
   * Called when playback starts, on seek while playing, and right after a
   * fresh freeze during playback. This is the single creation path for frozen
   * sources — panic() (pause/stop/seek) tears them down, this resurrects them,
   * so frozen tracks can never end up permanently silent.
   */
  restartFrozenSources(positionTick: number): void {
    const ctx = this.deps.ctx();
    const doc = this.deps.doc();
    if (!ctx || !doc) return;
    this.frozenPlaying = true;
    this.frozenAlign = { tick: Math.max(0, positionTick), ctxTime: ctx.currentTime };
    for (const track of doc.tracks) {
      if (!("frozen" in track) || !track.frozen) continue;
      const existing = this.frozenBuffers.get(track.id);
      if (existing) {
        try {
          existing.stop();
        } catch {
          /* already stopped */
        }
        try {
          existing.disconnect();
        } catch {
          /* already disconnected */
        }
        this.frozenBuffers.delete(track.id);
        this.frozenBufferIds.delete(track.id);
      }
      const buffer = this.deps.bank()?.get(track.frozen.bufferId);
      const nodes = this.deps.trackInput(track.id);
      if (!buffer || !nodes) continue; // restore pending — next sync picks it up
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(nodes);
      source.start(ctx.currentTime + 0.005, frozenPlaybackOffset(positionTick, doc.bpm, buffer.duration));
      this.frozenBuffers.set(track.id, source);
      this.frozenBufferIds.set(track.id, track.frozen.bufferId);
    }
  }

  /** Is this track's frozen source still serving the SAME freeze buffer? */
  hasFrozenBuffer(trackId: string, bufferId: string): boolean {
    return this.frozenBuffers.has(trackId) && this.frozenBufferIds.get(trackId) === bufferId;
  }

  /** Current transport tick estimate for frozen-loop alignment. */
  frozenPositionTickNow(): number {
    if (!this.frozenAlign || !this.deps.ctx() || !this.deps.doc()) return 0;
    const elapsed = Math.max(0, this.deps.ctx()!.currentTime - this.frozenAlign.ctxTime);
    return this.frozenAlign.tick + elapsed * (this.deps.doc()!.bpm / 60) * PPQ;
  }

  disposeFrozenSource(id: string): void {
    const source = this.frozenBuffers.get(id);
    if (source) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.frozenBuffers.delete(id);
    this.frozenBufferIds.delete(id);
  }

  /**
   * Hard dispose of every frozen source (context swap / panic paths).
   * `stopAt` mirrors AudioBufferSourceNode.stop(): the live panic passes
   * ctx.currentTime for an immediate stop; the context swap stops now.
   */
  disposeAllFrozen(stopAt?: number): void {
    for (const source of this.frozenBuffers.values()) {
      try {
        if (stopAt !== undefined) source.stop(stopAt);
        else source.stop();
      } catch {
        /* already stopped */
      }
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.frozenBuffers.clear();
    this.frozenBufferIds.clear();
    this.frozenPlaying = false;
    this.frozenAlign = null;
  }

  // ── Warp job core ──

  /**
   * Shared sync core for warp renders: bank buffer → repitch segments →
   * pitch-preserving rate envelope → render job. Used by the synchronous
   * offline path and (for its cheap prefix) by the async live warmer.
   * The warp map fully determines timing here — stretchRate is bypassed
   * (pins capture the geometry; a pin placed at the straight-playback
   * position reproduces the legacy rate).
   */
  private buildWarpJob(
    clip: AudioClip,
    wallSec: number,
  ): {
    key: string;
    src: AudioBuffer;
    intervals: WarpRateInterval[];
    outLen: number;
    sampleRate: number;
  } | null {
    const ctx = this.deps.ctx();
    const src = this.deps.bank()?.get(clip.bufferId);
    if (!ctx || !src) return null;
    const markers = clip.warpMarkers ?? [];
    if (markers.length === 0 || clip.reverse || clip.loop) return null;
    if (clip.stretchMode !== "stretch") return null;
    if (!Number.isFinite(wallSec) || wallSec <= 0) return null;
    const clipTicks = clip.lengthBars * BAR_TICKS;
    if (!(clipTicks > 0)) return null;
    const spt = wallSec / clipTicks;
    const { playOffset, contentDur } = audioClipPlayWindow(clip, src.duration, Infinity, 1);
    const segs = buildWarpSegments({
      markers,
      clipStartTick: clip.startBar * BAR_TICKS,
      clipTicks,
      spt,
      contentStartSec: playOffset,
      contentDurSec: contentDur,
    });
    if (!segs) return null;
    const intervals = segs.map((s) => ({
      startSec: s.startTick * spt,
      endSec: s.endTick * spt,
      rate: Math.min(
        4,
        Math.max(0.25, ((s.endTick - s.startTick) * spt) / Math.max(1e-6, s.bufEndSec - s.bufStartSec)),
      ),
    }));
    return {
      key: this.warpCacheKey(clip, wallSec),
      src,
      intervals,
      outLen: Math.max(1, Math.round(wallSec * ctx.sampleRate)),
      sampleRate: ctx.sampleRate,
    };
  }

  private storeWarpBuffer(key: string, buf: AudioBuffer): void {
    if (this.warpCache.has(key)) this.warpCache.delete(key);
    else if (this.warpCache.size >= WARP_CACHE_LIMIT) {
      const oldest = this.warpCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.warpCache.delete(oldest);
    }
    this.warpCache.set(key, buf);
  }
}

/** Realtime-safety cap: one trigger schedules at most this many sources. */
export const MAX_WARP_SEGMENTS = MAX_AUDIO_CLIP_WARP_SEGMENTS;

/**
 * One repitch-warp segment: play play-buffer seconds [bufStartSec, bufEndSec]
 * across clip-relative ticks [startTick, endTick] at constant `rate`.
 */
export interface WarpSegment {
  startTick: number;
  endTick: number;
  bufStartSec: number;
  bufEndSec: number;
  rate: number;
}

/**
 * Build a piecewise-constant-rate warp map from AudioClip warp markers.
 * Each marker pins a sample time (sec, original-sample timeline) to an
 * arrangement tick; the full trimmed content is mapped across the full clip
 * (start pin + end pin are forced), linearly interpolated between pins —
 * FL/Slicex-style repitch warp (pitch follows time, no phase vocoder).
 *
 * Returns null when warp cannot/should not apply (no in-range markers,
 * degenerate geometry) — callers fall back to the legacy single source.
 * Pure and deterministic: live playback and offline render share it.
 */
export function buildWarpSegments(opts: {
  markers: ReadonlyArray<{ timeSec: number; tick: number }>;
  clipStartTick: number;
  clipTicks: number;
  /** Wall seconds per tick (average across the clip). */
  spt: number;
  /** Play-buffer window (secs): trimmed content start + full trimmed length. */
  contentStartSec: number;
  contentDurSec: number;
}): WarpSegment[] | null {
  const { clipStartTick, clipTicks, spt, contentStartSec, contentDurSec } = opts;
  if (!Number.isFinite(clipStartTick) || !Number.isFinite(clipTicks) || clipTicks <= 0) return null;
  if (!Number.isFinite(spt) || spt <= 0) return null;
  if (!Number.isFinite(contentStartSec) || !Number.isFinite(contentDurSec) || contentDurSec <= 0) return null;
  const resolved = resolveWarpPinPoints(opts);
  if (!resolved || resolved.inRangeMarkerCount === 0) return null;
  // The shared resolver has already rejected maps with no in-range markers.
  const segs: WarpSegment[] = [];
  for (let i = 0; i + 1 < resolved.points.length && segs.length < MAX_WARP_SEGMENTS; i++) {
    const a = resolved.points[i]!;
    const b = resolved.points[i + 1]!;
    const dTick = b.relTick - a.relTick;
    const dBuf = b.bufferTimeSec - a.bufferTimeSec;
    // Degenerate: zero time span or frozen/reversed buffer direction —
    // BufferSource cannot hold or play backwards in a forward warp.
    if (dTick <= 1e-9 || dBuf <= 0.0005) continue;
    const rate = dBuf / (dTick * spt);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    segs.push({
      startTick: a.relTick,
      endTick: b.relTick,
      bufStartSec: a.bufferTimeSec,
      bufEndSec: b.bufferTimeSec,
      rate,
    });
  }
  return segs.length > 0 ? segs : null;
}

/**
 * Tick position → seconds inside a frozen loop (mod buffer duration).
 * (VERBATIM move from AudioEngine.ts; re-exported there for consumers.)
 */
export function frozenPlaybackOffset(positionTick: number, bpm: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const seconds = (Math.max(0, positionTick) / PPQ) * (60 / Math.max(1, bpm));
  return seconds % durationSec;
}

/**
 * Resolve an AudioClip's playback window inside the (possibly stretched)
 * play buffer. `offsetSec`/`trimStart`/`trimEnd` are seconds in the ORIGINAL
 * sample; `timeScale` converts them into the play buffer's timeline (1 for
 * resample mode, the stretch rate for pre-stretched buffers). Pure — shared
 * reasoning for live playback and offline render.
 *
 * `contentDur` is the full trimmed content length (before capping to the
 * requested clip length) — the loop region for `clip.loop` texture beds.
 */
export function audioClipPlayWindow(
  clip: import("../project-model/types").AudioClip,
  playBufferDurationSec: number,
  requestedDurationSec: number,
  timeScale: number,
): {
  /** Wall-clock duration after source-window limits are applied. */
  duration: number;
  /** Duration argument for AudioBufferSourceNode.start(), in buffer seconds. */
  bufferDuration: number;
  /** Source playhead position passed to start(). */
  playOffset: number;
  /** Trimmed content length in play-buffer seconds. */
  contentDur: number;
  /** Loop region endpoints in play-buffer seconds. */
  loopStart: number;
  loopEnd: number;
} {
  const offset = Math.max(0, ((clip.offsetSec ?? 0) + (clip.trimStart ?? 0)) * timeScale);
  const trimEnd = Math.max(0, (clip.trimEnd ?? 0) * timeScale);
  const maxDur = Math.max(0.01, playBufferDurationSec - offset - trimEnd);
  const rate = Math.min(4, Math.max(0.25, clip.stretchRate ?? 1));
  const preStretched = clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01 && timeScale !== 1;
  const playbackRate = preStretched ? 1 : rate;
  const bufferDuration = Math.min(Math.max(0, requestedDurationSec * playbackRate), maxDur);
  const loopStart = offset;
  const loopEnd = Math.min(playBufferDurationSec, offset + maxDur);
  const loopContentDur = Math.max(0, loopEnd - loopStart);
  const loopingForward = clip.loop === true && clip.reverse !== true && loopContentDur > 0.02;
  const duration = loopingForward ? requestedDurationSec : bufferDuration / playbackRate;
  let playOffset: number;
  if (loopingForward) {
    const sourceLoopDur = loopContentDur / timeScale;
    const phase = Math.max(0, Number.isFinite(clip.loopPhaseOffsetSec) ? clip.loopPhaseOffsetSec! : 0);
    const wrappedPhase = sourceLoopDur > 0 ? phase % sourceLoopDur : 0;
    playOffset = loopStart + wrappedPhase * timeScale;
  } else if (clip.reverse) {
    // Pitch-preserving reverse uses a physically reversed stretched buffer;
    // resample reverse uses the original buffer and a negative playbackRate.
    playOffset = preStretched
      ? Math.max(0, playBufferDurationSec - offset - bufferDuration)
      : Math.min(playBufferDurationSec, offset + bufferDuration);
  } else {
    playOffset = offset;
  }
  return { duration, bufferDuration, playOffset, contentDur: maxDur, loopStart, loopEnd };
}
