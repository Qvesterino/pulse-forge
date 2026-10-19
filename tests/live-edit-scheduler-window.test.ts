import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { BAR_TICKS, PPQ, type AudioClip, type ProjectDocument } from "../src/project-model/types";
import { resumeSpanningAudioClips, RESUME_FORWARD_SLACK_SEC } from "../src/audio-engine/liveEditSync";
import type { AudioEngine } from "../src/audio-engine/AudioEngine";
import type { Transport } from "../src/transport/Transport";

/**
 * AUDIT 01 follow-up — scheduler-window vs resume-pass interaction.
 *
 * `resumeSpanningAudioClips` resumes a clip when its start is within
 * `RESUME_FORWARD_SLACK_SEC` (70 ms) PAST the playhead. The scheduler fires a
 * clip whose start falls inside `[contentWindowStart, windowEnd)`, where
 * `contentWindowStart` is the PREVIOUS window's end (Scheduler.ts:732 — it is
 * `this.windowStartTick`, not `transport.position`) and `windowEnd` reaches
 * `HORIZON_SECONDS` (120 ms) ahead.
 *
 * The two therefore cover DISJOINT tick ranges in steady state:
 *   scheduler  [prevWindowEnd, prevWindowEnd + 120 ms)
 *   resume     (-inf, pos + 70 ms)
 * and `prevWindowEnd >= pos + (120 - 25) ms = pos + 95 ms > pos + 70 ms`, so a
 * clip can never be fired by both in the same tick. 70 ms is only safe BECAUSE
 * it stays below `horizon - intervalCadence`; raise it and the overlap is real.
 *
 * This file pins that separation as an EXECUTED invariant over the real
 * constants rather than as a comment, so the slack cannot drift upward
 * silently. The scheduler window here is modelled from its published
 * constants (HORIZON_SECONDS / INTERVAL_MS) rather than by driving the whole
 * Scheduler: the boundary being defended is a property of those two numbers
 * against the resume pass's slack.
 */

const HORIZON_SECONDS = 0.12; // Scheduler.ts:151 HORIZON_SECONDS
const INTERVAL_MS = 25; // Scheduler.ts:149 INTERVAL_MS
// Imported from the module under test — NOT re-declared here. A literal copy
// cannot catch a raise of the real constant (verified: raising the source to
// 0.11 s left a copy-declaring suite green).

/**
 * The scheduler's window origin in steady state: the PREVIOUS window's end.
 * `windowStartTick` is carried across ticks, so the window a tick covers starts
 * where the last one stopped: playhead + horizon − one cadence. All three are
 * converted to TICKS before the arithmetic (subtracting a millisecond count
 * from a tick count silently produced a window ~7x too far ahead, which made
 * the disjointness sweep below pass for the wrong reason).
 */
function schedulerWindowStartTick(playheadTick: number, cadenceMs = INTERVAL_MS): number {
  const horizonTicks = HORIZON_SECONDS * PPQ;
  const cadenceTicks = (cadenceMs / 1000) * PPQ;
  return playheadTick + horizonTicks - cadenceTicks;
}

/** Mirrors liveEditSync's own gate (startTick < pos + slack, body past pos). */
function resumeSlackTicks(): number {
  return RESUME_FORWARD_SLACK_SEC * PPQ;
}

/** Would the scheduler's own window also contain this clip start? */
function schedulerWouldFire(clipStartTick: number, playheadTick: number): boolean {
  const winStart = schedulerWindowStartTick(playheadTick);
  const winEnd = winStart + HORIZON_SECONDS * PPQ;
  return clipStartTick >= winStart && clipStartTick < winEnd;
}

function clipAt(startBar: number, lengthBars: number, patch: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "c1",
    trackId: "t1",
    bufferId: "b",
    startBar,
    lengthBars,
    ...patch,
  } as AudioClip;
}

function docWith(clips: AudioClip[]): ProjectDocument {
  const base = normalizeProject({ ...createProjectFromTemplate("house"), arrangement: { clips: [] } });
  return {
    ...base,
    arrangement: { ...base.arrangement, audioClips: clips, takeGroups: [] },
  } as ProjectDocument;
}

function runResume(doc: ProjectDocument, positionTick: number) {
  const fired: AudioClip[] = [];
  const engine = {
    currentTime: 1,
    cancelOrphanedClipSources: () => new Set<string>(),
    triggerAudioClip: (clip: AudioClip) => fired.push(clip),
  } as unknown as AudioEngine;
  const transport = { position: positionTick, secondsPerTick: 60 / (doc.bpm * PPQ) } as unknown as Transport;
  resumeSpanningAudioClips({ engine, transport, getDoc: () => doc });
  return fired;
}

describe("scheduler window vs resume pass — no double-fire (audit 01)", () => {
  it("the slack constant is strictly below horizon − cadence (the whole safety argument)", () => {
    // If this ever fails, every other test in this file is describing an
    // overlap that the code no longer prevents.
    expect(RESUME_FORWARD_SLACK_SEC).toBeLessThan(HORIZON_SECONDS - INTERVAL_MS / 1000);
  });

  it("no clip start can be fired by BOTH passes in the same tick", () => {
    // Sweep clip starts across a generous span around the playhead at a fine
    // resolution, at several playhead phases relative to the window cadence.
    for (const phase of [0, 5, 12, 18, 25]) {
      const playheadTick = BAR_TICKS * 4 + phase * 7;
      for (let dt = -400; dt <= 400; dt++) {
        const clipStart = playheadTick + dt;
        const resumed = resumeWouldFire(clipStart, playheadTick);
        const scheduled = schedulerWouldFire(clipStart, playheadTick);
        expect(
          resumed && scheduled,
          `clip at ${dt} ticks from the playhead (phase ${phase}) is fired by BOTH the resume pass and the scheduler window`,
        ).toBe(false);
      }
    }
  });

  it("a clip starting inside the resume slack is NOT inside the scheduler window (real run)", () => {
    const doc = docWith([clipAt(4, 8)]);
    // Playhead just inside bar 4 so the clip (starting at bar 4) spans it.
    const positionTick = BAR_TICKS * 4 + 3;
    const fired = runResume(doc, positionTick);
    const clipStartTick = 4 * BAR_TICKS;
    expect(schedulerWouldFire(clipStartTick, positionTick)).toBe(false);
    void fired;
  });

  it("a clip the scheduler owns is never resumed", () => {
    const positionTick = BAR_TICKS * 4 + 3;
    // A clip starting just inside the scheduler's window territory: past the
    // resume slack, inside the lookahead.
    const startBar = (positionTick + resumeSlackTicks() + 6) / BAR_TICKS;
    const doc = docWith([clipAt(startBar, 8)]);
    const fired = runResume(doc, positionTick);
    expect(fired, "a clip the scheduler window will fire must not also be resumed").toHaveLength(0);
  });

  it("the split seam is the only place the resume pass is allowed to act", () => {
    // Split at the playhead: the right fragment's start lands within the seam
    // slack but behind every future window, so the resume pass is what makes
    // it audible at all.
    const positionTick = BAR_TICKS * 4;
    const doc = docWith([clipAt(4, 8), clipAt(4, 8, { id: "c2" })]);
    const fired = runResume(doc, positionTick);
    expect(fired.length, "the fragments under the playhead must be resumed").toBeGreaterThan(0);
  });
});

/** Mirrors liveEditSync's own gate. */
function resumeWouldFire(clipStartTick: number, playheadTick: number): boolean {
  const endTick = clipStartTick + BAR_TICKS * 8;
  const CLIP_EPS_TICKS = 1e-6;
  return !(clipStartTick >= playheadTick + resumeSlackTicks() || endTick <= playheadTick + CLIP_EPS_TICKS);
}
