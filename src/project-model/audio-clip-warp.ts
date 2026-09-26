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

export function warpBufferTimeAtTick(opts: WarpBufferTimeAtTickOptions): number | null {
  const { markers, clipStartTick, clipTicks, tick, spt, contentStartSec, contentDurSec } = opts;
  if (!Number.isFinite(clipTicks) || clipTicks <= 0) return null;
  if (!Number.isFinite(spt) || spt <= 0) return null;
  if (!Number.isFinite(contentStartSec) || !Number.isFinite(contentDurSec) || contentDurSec <= 0) return null;
  const rawRel = tick - clipStartTick;
  // Clip start bars can be fractional after a PCM-frame-aligned split. Their
  // tick conversion may differ by a few floating-point ulps at the exact
  // right edge; accept only that representational error, not a real overrun.
  const edgeToleranceTicks = 1e-7;
  if (rawRel < -edgeToleranceTicks || rawRel > clipTicks + edgeToleranceTicks) return null;
  const rel = Math.min(clipTicks, Math.max(0, rawRel));
  const contentEnd = contentStartSec + contentDurSec;
  const clampBuf = (v: number): number => Math.min(contentEnd, Math.max(contentStartSec, v));
  const pins: { rel: number; buf: number }[] = [{ rel: 0, buf: contentStartSec }];
  let inRange = 0;
  for (const marker of markers) {
    if (!Number.isFinite(marker.timeSec) || !Number.isFinite(marker.tick)) continue;
    const markerRel = marker.tick - clipStartTick;
    if (markerRel < 0 || markerRel > clipTicks) continue;
    inRange++;
    pins.push({ rel: markerRel, buf: clampBuf(marker.timeSec) });
  }
  pins.push({ rel: clipTicks, buf: contentEnd });
  pins.sort((a, b) => a.rel - b.rel);
  if (inRange === 0) {
    const rate = Math.min(4, Math.max(0.25, opts.stretchRate ?? 1));
    const straight =
      opts.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01
        ? contentStartSec + (rel * spt) / rate
        : contentStartSec + rel * spt * rate;
    return clampBuf(straight);
  }
  for (let i = 0; i + 1 < pins.length; i++) {
    const a = pins[i];
    const b = pins[i + 1];
    if (rel >= a.rel && rel <= b.rel) {
      const span = b.rel - a.rel;
      if (span <= 1e-9) return clampBuf(a.buf);
      const t = (rel - a.rel) / span;
      return clampBuf(a.buf + (b.buf - a.buf) * t);
    }
  }
  return clampBuf(contentEnd);
}
