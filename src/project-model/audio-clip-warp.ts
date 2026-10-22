/**
 * Query the source-buffer time mapped to an arrangement tick by an audio
 * clip's warp markers. Kept in the project-model layer so editing commands,
 * UI gestures, and the audio engine can share one deterministic mapping.
 */

/**
 * THE SOURCE-vs-WALL CONVERSION FACTOR — one owner for every caller.
 *
 * `offsetSec`, `trimStart` and `trimEnd` are positions in the ORIGINAL sample.
 * A gesture measured in WALL time (seconds on the timeline) becomes a source
 * position only after this conversion, and getting it wrong makes the clip
 * play a different region of its sample than the gesture asked for.
 *
 * There are TWO answers, one per stretch mode:
 *
 * - "resample" (the default): the clip plays the ORIGINAL buffer at
 *   `playbackRate = stretchRate`, so ONE WALL SECOND consumes `stretchRate`
 *   original seconds. The rate is also a SPEED change — a 220 Hz source at
 *   rate 0.5 arrives at 110 Hz.
 * - "stretch" (pitch-preserving): the clip plays a PRE-RENDERED buffer that is
 *   `original × stretchRate` long at `playbackRate = 1`, so ONE WALL SECOND
 *   consumes `1 / stretchRate` original seconds. The pitch is preserved.
 *
 * The engine's two branches (`triggerEngine.ts`: `playbackRate = rate` vs
 * `1 / rate`, and `timeScale = 1` vs `stretchRate`) are the authority.
 *
 * This rule was previously written out by hand in the split command
 * (`clipEditing.ts`) and in the stem renderer (`bounce.ts`). Two copies is one
 * copy too many: the trim and slip gestures were the third and fourth, and
 * they are the ones that were wrong. ONE owner, four callers.
 */
export function audioClipSourceSecondsPerWallSecond(clip: {
  stretchRate?: number;
  stretchMode?: "resample" | "stretch";
}): number {
  const rate = Math.min(4, Math.max(0.25, clip.stretchRate ?? 1));
  const preservingStretch = clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01;
  return preservingStretch ? 1 / rate : rate;
}

/**
 * HOW MUCH OF THE ORIGINAL SAMPLE A CLIP ACTUALLY PLAYS — the second half of
 * the source-vs-wall rule.
 *
 * `audioClipSourceSecondsPerWallSecond` converts wall time to source time; this
 * converts the clip's WALL LENGTH into the amount of source it consumes, capped
 * by the source that is actually left after the trims:
 *
 *     played = min(available, wall × factor)
 *
 * The engine plays exactly this. `audioClipPlayWindow` resolves
 * `bufferDuration = min(requested × playbackRate, maxDur)` in play-buffer
 * seconds; for the resample branch the play buffer IS the original (so
 * `bufferDuration` is source seconds) and for the pitch-preserving branch it is
 * the pre-rendered `original × rate` buffer (so the source consumed is
 * `bufferDuration / rate`). Both reduce to the formula above.
 *
 * WHY IT MATTERS. The waveform draws one window; the engine plays another.
 * When the clip is shorter than its source — which is exactly what a
 * right-edge trim produces, because `resizeAudioClip` rewrites `lengthBars`
 * only — a waveform that draws the whole remaining source shows material the
 * clip never plays. The picture and the sound disagree, and the envelope the
 * user trims against is not the envelope they hear.
 *
 * THE EXCEPTION. A forward-looping clip repeats its whole trimmed region for
 * the clip's wall length (`audioClipPlayWindow`: `loopingForward`), so all of
 * that source plays.
 */
export function audioClipPlayedSourceSec(
  clip: {
    offsetSec?: number;
    trimStart?: number;
    trimEnd?: number;
    stretchRate?: number;
    stretchMode?: "resample" | "stretch";
    loop?: boolean;
    reverse?: boolean;
  },
  sourceDurationSec: number,
  wallDurationSec: number,
): number {
  const finite = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const duration = Math.max(0, finite(sourceDurationSec));
  const offsetSec = Math.max(0, finite(clip.offsetSec));
  const trimStart = Math.max(0, finite(clip.trimStart));
  const trimEnd = Math.max(0, finite(clip.trimEnd));
  const available = Math.max(0, duration - offsetSec - trimStart - trimEnd);
  // Forward loop: the whole trimmed region repeats for the clip's wall length.
  if (clip.loop === true && clip.reverse !== true && available > 0.02) return available;
  const wall = Math.max(0, finite(wallDurationSec));
  return Math.min(available, wall * audioClipSourceSecondsPerWallSecond(clip));
}
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
