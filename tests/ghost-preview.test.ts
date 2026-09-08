import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostPreviewPlayer } from "../src/audio-engine/GhostPreviewPlayer";
import { createDefaultProject } from "../src/project-model/schema";
import { getDrumTrack, BAR_TICKS, STEP_TICKS } from "../src/project-model/types";
import type { Pattern, ProjectDocument } from "../src/project-model/types";

/**
 * GhostPreviewPlayer (dice/pattern auditioning) had zero direct coverage:
 * it builds a THROWAWAY document (pattern appended + pads patched from a
 * candidate kit) and schedules it against a private transport. The risky
 * contracts are isolation (the live doc must never mutate), timer cleanup,
 * past-hit skipping after a clock jump, and the 1-bar loop wrap.
 */

function makeEngine() {
  return {
    currentTime: 0,
    transportStarted: vi.fn(),
    ensureContext: vi.fn(),
    trigger: vi.fn(),
    noteOn: vi.fn(),
  };
}

/** Pattern clone with only the kick's steps 0 and 15 active. */
function kickOnlyPattern(doc: ProjectDocument): Pattern {
  const track = getDrumTrack(doc);
  const kick = track.pads[0];
  const base = doc.patterns[0];
  const rows: Pattern["rows"] = {};
  for (const p of track.pads) rows[p.id] = new Array(base.stepCount).fill(0);
  rows[kick.id][0] = 0.9;
  rows[kick.id][15] = 0.8;
  return { ...base, rows, notes: {} } as Pattern;
}

describe("GhostPreviewPlayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auditions without mutating the live document", () => {
    const doc = createDefaultProject();
    const before = JSON.parse(JSON.stringify(doc));
    const engine = makeEngine();
    const player = new GhostPreviewPlayer(engine as never, {} as never, () => doc);
    const pattern = kickOnlyPattern(doc);

    player.play(pattern);
    vi.advanceTimersByTime(200);
    player.stop();

    expect(JSON.parse(JSON.stringify(doc))).toEqual(before);
  });

  it("schedules the first window's hits into the engine", () => {
    const doc = createDefaultProject();
    const engine = makeEngine();
    const player = new GhostPreviewPlayer(engine as never, {} as never, () => doc);
    const track = getDrumTrack(doc);
    const kick = track.pads[0];
    const pattern = kickOnlyPattern(doc);
    const spt = 60 / (doc.bpm * 480);

    player.play(pattern);
    // play() ticks immediately: window [0, tickAt(0.12)) covers step 0.
    expect(engine.trigger).toHaveBeenCalledTimes(1);
    const [trackId, pad, when, velocity] = engine.trigger.mock.calls[0];
    expect(trackId).toBe(track.id);
    expect(pad.id).toBe(kick.id);
    // when = timeAtTick(0) + 5 ms scheduling pad.
    expect(when).toBeCloseTo(0.005, 5);
    expect(velocity).toBeCloseTo(0.9, 5);
    expect(engine.noteOn).not.toHaveBeenCalled();
    expect(spt).toBeGreaterThan(0); // sanity: expected-time math below uses spt
    player.stop();
  });

  it("stop() kills the scheduling interval — no zombie triggers afterwards", () => {
    const doc = createDefaultProject();
    const engine = makeEngine();
    const player = new GhostPreviewPlayer(engine as never, {} as never, () => doc);
    player.play(kickOnlyPattern(doc));
    expect(player.isPlaying).toBe(true);
    engine.trigger.mockClear();

    player.stop();
    expect(player.isPlaying).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(engine.trigger).not.toHaveBeenCalled();
  });

  it("skips hits whose time is already past after a clock jump, then re-anchors after the wrap", () => {
    const doc = createDefaultProject();
    const engine = makeEngine();
    const player = new GhostPreviewPlayer(engine as never, {} as never, () => doc);
    const pattern = kickOnlyPattern(doc);
    const step15Sec = 15 * STEP_TICKS * (60 / (doc.bpm * 480));
    const loopSec = BAR_TICKS * (60 / (doc.bpm * 480));

    player.play(pattern); // fires step 0 at ~0.005 s
    expect(engine.trigger).toHaveBeenCalledTimes(1);
    engine.trigger.mockClear();

    // Jump the clock past step 15 (still inside loop 1) — a window covering
    // step 15 would schedule it in the past, which must be skipped.
    engine.currentTime = step15Sec + 0.5;
    vi.advanceTimersByTime(25);
    // The wrap re-anchors tick 0 at "now", so step 0 of loop 2 fires…
    expect(engine.trigger).toHaveBeenCalledTimes(1);
    const [, , when] = engine.trigger.mock.calls[0];
    // …at the CURRENT time (+5 ms pad), not at its original loop-1 slot.
    expect(when).toBeGreaterThanOrEqual(engine.currentTime - 0.002);
    // …and the past step-15 hit was never delivered.
    const whens = engine.trigger.mock.calls.map((c) => c[2] as number);
    expect(whens.some((w) => Math.abs(w - step15Sec - 0.005) < 0.01)).toBe(false);
    expect(loopSec).toBeGreaterThan(0);
    player.stop();
  });

  it("kit assignment patches reach the engine while the live pads stay untouched", () => {
    const doc = createDefaultProject();
    const engine = makeEngine();
    const player = new GhostPreviewPlayer(engine as never, {} as never, () => doc);
    const track = getDrumTrack(doc);
    const kick = track.pads[0];
    const liveAsset = kick.assetId;
    const pattern = kickOnlyPattern(doc);

    player.play(pattern, {
      kitAssignments: new Map([[kick.id, { assetId: "user.preview" }]]),
    });
    expect(engine.trigger).toHaveBeenCalledTimes(1);
    const [, pad] = engine.trigger.mock.calls[0];
    expect(pad.assetId).toBe("user.preview");
    // The live document's pad was not patched in place.
    expect(kick.assetId).toBe(liveAsset);
    player.stop();
  });
});
