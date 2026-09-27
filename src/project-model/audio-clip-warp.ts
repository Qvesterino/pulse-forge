/**
 * Query the source-buffer time mapped to an arrangement tick by an audio
 * clip's warp markers. Kept in the project-model layer so editing commands,
 * UI gestures, and the audio engine can share one deterministic mapping.
 */
export interface WarpBufferTimeAtTickOptions {
  markers: ReadonlyArray<{ timeSec: number; tick: number }>;
  clipStartTick: number;
  clipTicks: number;
  /** Arrangement tick to query (absolute). */
  tick: number;
  /** Wall seconds per tick. */
  spt: number;
  /** Trimmed content window (secs, original-sample timeline). */
  contentStartSec: number;
  contentDurSec: number;
  stretchRate?: number;
  stretchMode?: "resample" | "stretch";
}

/** Realtime-safety cap shared by the map editor and both playback paths. */
export const MAX_AUDIO_CLIP_WARP_SEGMENTS = 64;

export interface ResolvedWarpPinPoint {
  /** Tick relative to the clip start. */
  relTick: number;
  /** Source-buffer position in seconds. */
  bufferTimeSec: number;
}

export interface ResolveWarpPinPointsOptions {
  markers: ReadonlyArray<{ timeSec: number; tick: number }>;
  clipStartTick: number;
  clipTicks: number;
  contentStartSec: number;
  contentDurSec: number;
}

/**
 * Normalize stored markers into the exact endpoint-complete, stable,
 * deduplicated, bounded point set used by the realtime/offline warp renderer.
 * A drag or edit command must query this same set or it can commit a boundary
 * that sounds different from the map the engine actually renders.
 */
export function resolveWarpPinPoints(opts: ResolveWarpPinPointsOptions): {
  points: ResolvedWarpPinPoint[];
  inRangeMarkerCount: number;
} | null {
  const { markers, clipStartTick, clipTicks, contentStartSec, contentDurSec } = opts;
  if (!Number.isFinite(clipStartTick) || !Number.isFinite(clipTicks) || clipTicks <= 0) return null;
  if (!Number.isFinite(contentStartSec) || !Number.isFinite(contentDurSec) || contentDurSec <= 0) return null;

  const contentEndSec = contentStartSec + contentDurSec;
  const pins: ResolvedWarpPinPoint[] = [{ relTick: 0, bufferTimeSec: contentStartSec }];
  let inRangeMarkerCount = 0;
  for (const marker of markers) {
    if (!Number.isFinite(marker.timeSec) || !Number.isFinite(marker.tick)) continue;
    const relTick = marker.tick - clipStartTick;
    if (relTick < 0 || relTick > clipTicks) continue;
    inRangeMarkerCount++;
    pins.push({
      relTick,
      bufferTimeSec: Math.min(contentEndSec, Math.max(contentStartSec, marker.timeSec)),
    });
  }
  pins.push({ relTick: clipTicks, bufferTimeSec: contentEndSec });

  const ordered = pins.map((point, index) => ({ point, index }));
  ordered.sort((a, b) => a.point.relTick - b.point.relTick || a.index - b.index);
  const deduped: ResolvedWarpPinPoint[] = [];
  for (const { point } of ordered) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(last.relTick - point.relTick) < 1e-9) deduped[deduped.length - 1] = point;
    else deduped.push(point);
  }

  if (deduped.length > MAX_AUDIO_CLIP_WARP_SEGMENTS + 1) {
    return {
      points: [...deduped.slice(0, MAX_AUDIO_CLIP_WARP_SEGMENTS), deduped[deduped.length - 1]!],
      inRangeMarkerCount,
    };
  }
  return { points: deduped, inRangeMarkerCount };
}

export function warpBufferTimeAtTick(opts: WarpBufferTimeAtTickOptions): number | null {
  const { clipStartTick, clipTicks, tick, spt, contentStartSec, contentDurSec } = opts;
  if (!Number.isFinite(clipStartTick) || !Number.isFinite(tick) || !Number.isFinite(clipTicks) || clipTicks <= 0)
    return null;
  if (!Number.isFinite(spt) || spt <= 0) return null;
  const rawRel = tick - clipStartTick;
  // Clip start bars can be fractional after a PCM-frame-aligned split. Their
  // tick conversion may differ by a few floating-point ulps at the exact
  // right edge; accept only that representational error, not a real overrun.
  const edgeToleranceTicks = 1e-7;
  if (rawRel < -edgeToleranceTicks || rawRel > clipTicks + edgeToleranceTicks) return null;
  const rel = Math.min(clipTicks, Math.max(0, rawRel));
  const contentEnd = contentStartSec + contentDurSec;
  const clampBuf = (v: number): number => Math.min(contentEnd, Math.max(contentStartSec, v));
  const resolved = resolveWarpPinPoints(opts);
  if (!resolved) return null;
  if (resolved.inRangeMarkerCount === 0) {
    const rate = Math.min(4, Math.max(0.25, opts.stretchRate ?? 1));
    const straight =
      opts.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01
        ? contentStartSec + (rel * spt) / rate
        : contentStartSec + rel * spt * rate;
    return clampBuf(straight);
  }
  for (let i = 0; i + 1 < resolved.points.length; i++) {
    const a = resolved.points[i]!;
    const b = resolved.points[i + 1]!;
    if (rel >= a.relTick && rel <= b.relTick) {
      const span = b.relTick - a.relTick;
      if (span <= 1e-9) return clampBuf(a.bufferTimeSec);
      const t = (rel - a.relTick) / span;
      return clampBuf(a.bufferTimeSec + (b.bufferTimeSec - a.bufferTimeSec) * t);
    }
  }
  return clampBuf(contentEnd);
}
