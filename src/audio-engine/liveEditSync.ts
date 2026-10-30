import { audioClipsForPlayback } from "../project-model/audio-takes";
import { arrangementSecondsBetweenTicks } from "../project-model/scene-time";
import { ticksPerBar } from "../project-model/schema";
import type { AudioClip, ProjectDocument } from "../project-model/types";
import type { AudioEngine } from "./AudioEngine";
import type { Transport } from "../transport/Transport";

/**
 * LIVE-EDITING SYNC — what the engine must do when the document changes (or
 * the playhead jumps) WHILE PLAYING.
 *
 * The scheduler re-plans from the new document at its next 25 ms window and
 * never re-fires anything behind it, so two hazards are left to this layer:
 *
 *  1. ORPHANED SOUND. One-shot sources already committed to the WebAudio
 *     clock ring to their originally scheduled stop — a deleted or moved
 *     multi-bar clip kept sounding for seconds after the edit. The engine's
 *     cancelOrphanedClipSources() de-click-cancels every clip source whose
 *     clip vanished or whose timeline geometry changed, and reports the ids
 *     that still legitimately sound.
 *
 *  2. UNSOUNDED PRESENT. The scheduler only triggers a clip when its START
 *     tick enters a scheduling window. A clip whose body SPANS the playhead
 *     — after a seek into its middle, after play-from-position, or after a
 *     doc edit restored/moved/split one over the playhead — has its start
 *     behind every future window and would stay silent forever. This module
 *     resumes those clips from the playhead with the correct source offset.
 *
 * Resume scope mirrors triggerAudioClip's own resume gate (linear forward
 * clips only): reverse, looping, warp-pinned and time-stretched clips are
 * skipped — cancelling orphans still applies to them, but a mid-body resume
 * would need per-mode source-position math that does not exist yet, so they
 * stay silent until their next natural trigger rather than risk wrong audio.
 *
 * The whole pipeline is shared by services.ts (doc changes, seek, play) and
 * the browser live-editing pass, so the verified path IS the shipped path.
 */

/**
 * Ticks the resume pass reaches past the playhead to catch split seams.
 *
 * Exported so the double-fire guard is tested against the REAL value rather
 * than a copy: this number is only safe because it stays below the scheduler's
 * `HORIZON_SECONDS` minus its tick cadence (120 ms − 25 ms = 95 ms). A test
 * that re-declares the literal silently drifts and cannot catch a raise.
 */
export const RESUME_FORWARD_SLACK_SEC = 0.07;
/** Geometry epsilon for "tick sits exactly on the playhead". */
const CLIP_EPS_TICKS = 1e-6;

export interface LiveEditSyncDeps {
  engine: AudioEngine;
  transport: Transport;
  /** The CURRENT document (post-change). Passed in so collab stores work too. */
  getDoc: () => ProjectDocument;
}

/**
 * Doc changed while playing: flush orphaned clip sources, then resume every
 * clip that now spans the playhead and is not already sounding. Pair with
 * engine.setProject(newDoc) BEFORE this call and restartFrozenSources()
 * after (frozen tracks are an independent, position-preserving path).
 */
export function syncDocChangeWhilePlaying(deps: LiveEditSyncDeps): void {
  const survivors = deps.engine.cancelOrphanedClipSources();
  resumeSpanningAudioClips({ ...deps, skipIds: survivors });
}

/**
 * Resume every linear forward AudioClip whose body spans the current
 * playhead. Used after a seek, after play-from-position, and as the second
 * half of syncDocChangeWhilePlaying.
 *
 * `skipIds` lists clips whose sources are still sounding with unchanged
 * geometry (the survivors returned by cancelOrphanedClipSources) — they need
 * no resume and re-triggering them would double the audio.
 *
 * The forward slack exists for the split-at-playhead seam: the right
 * fragment's start tick lands within a hair of the playhead, behind every
 * future scheduler window, so it must be resumed here rather than left to
 * the window planner. 70 ms stays safely below the scheduler's minimum
 * future-window distance from the playhead (~120 ms horizon − ≤25 ms tick
 * cadence ≥ 95 ms), so a clip the planner is about to fire can never be
 * double-fired here.
 */
export function resumeSpanningAudioClips(
  deps: LiveEditSyncDeps & { skipIds?: ReadonlySet<string>; forwardSlackSec?: number },
): void {
  const doc = deps.getDoc();
  const arrangement = doc?.arrangement;
  const pos = deps.transport.position;
  // Tolerant to minimal documents (test harnesses mock the store with bare
  // objects — services.seek runs on every playing seek whatever they hold).
  if (!doc || !arrangement || !Number.isFinite(pos) || pos <= 0) return;
  const barUnit = ticksPerBar(doc);
  // Default slack: the split-seam/doc-edit path, where the scheduler's window
  // start sits ~95 ms AHEAD of the playhead so nothing in the slack can be
  // double-fired. Callers whose next scheduler window starts AT the playhead
  // (services seek/play, collab follow — right after resync()/start()) must
  // pass 0: there the window planner is about to fire every clip starting at
  // or after the playhead, and resuming them here too is an audible flam.
  const slackSec = deps.forwardSlackSec ?? RESUME_FORWARD_SLACK_SEC;
  const slackTicks = deps.transport.secondsPerTick * slackSec;
  const when = deps.engine.currentTime + 0.005;
  const scenes = doc.scenes ?? [];
  const projectBpm = Number.isFinite(doc.bpm) && (doc.bpm as number) > 0 ? (doc.bpm as number) : 120;
  const clips = arrangement.clips ?? [];
  for (const clip of audioClipsForPlayback(arrangement)) {
    const startTick = clip.startBar * barUnit;
    const endTick = (clip.startBar + clip.lengthBars) * barUnit;
    // Strictly spanning, or starting within the seam slack: anything starting
    // later belongs to the scheduler's window planner.
    if (startTick >= pos + slackTicks || endTick <= pos + CLIP_EPS_TICKS) continue;
    if (deps.skipIds?.has(clip.id)) continue;
    const rate = Math.min(4, Math.max(0.25, clip.stretchRate ?? 1));
    if (clip.reverse || clip.loop === true || (clip.warpMarkers?.length ?? 0) > 0) continue;
    if (clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01) continue;
    const elapsedSec = Math.max(0, arrangementSecondsBetweenTicks(clips, scenes, startTick, pos, projectBpm, barUnit));
    const remainingSec = arrangementSecondsBetweenTicks(clips, scenes, pos, endTick, projectBpm, barUnit);
    if (!Number.isFinite(remainingSec) || remainingSec <= 0.01) continue;
    const resumed: AudioClip = {
      ...clip,
      startBar: pos / barUnit,
      lengthBars: (endTick - pos) / barUnit,
      offsetSec: Math.max(0, (clip.offsetSec ?? 0) + elapsedSec * rate),
    };
    // The 4th argument is triggerAudioClip's resume offset: it advances the
    // fade-envelope progress to where the source had reached, exactly like
    // the live take-audition resume (ADR 0015).
    deps.engine.triggerAudioClip(resumed, when, remainingSec, elapsedSec);
  }
}
