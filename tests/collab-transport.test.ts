import { describe, expect, it } from "vitest";
import { Transport } from "../src/transport/Transport";
import {
  applyTransportState,
  captureTransportState,
  isSharedTransportState,
  shouldStartRemoteScheduler,
} from "../src/collab/transportSync";

/** Manual clock so anchors are exact. */
function manualClock() {
  let t = 0;
  return { now: () => t, advance: (sec: number) => (t += sec) };
}

/** Fake wall clock anchored to the manual clock (epoch arbitrary). */
const WALL0 = 1_700_000_000;

describe("shared transport sync", () => {
  it("a follower aligns to the leader's musical position at the same wall moment", () => {
    const leaderClock = manualClock();
    const leader = new Transport(leaderClock, 124);
    leader.play(1920); // anchor: tick 1920 @ wall WALL0
    const state = captureTransportState(leader, "leader", WALL0);

    // 2 s later on the follower's machine:
    const follower = new Transport(manualClock(), 90);
    applyTransportState(follower, state, WALL0 + 2);

    expect(follower.playing).toBe(true);
    expect(follower.bpm).toBe(124);
    // expected: 1920 + 2 s × (124 × 480 / 60) = 1920 + 1984 = 3904
    expect(follower.position).toBeCloseTo(3904, 0);
  });

  it("does not apply a local count-in when joining an already-playing leader", () => {
    const leader = new Transport(manualClock(), 124);
    leader.play(1920);
    const state = captureTransportState(leader, "leader", WALL0);

    const follower = new Transport(manualClock(), 124);
    follower.setCountIn(2);
    applyTransportState(follower, state, WALL0);

    expect(follower.position).toBeCloseTo(1920, 0);
  });

  it("a mid-jam joiner lands on the leader's CURRENT position, not the anchor", () => {
    const leaderClock = manualClock();
    const leader = new Transport(leaderClock, 120);
    leader.play(0);
    leaderClock.advance(10); // leader is 10 s into the jam
    const state = captureTransportState(leader, "leader", WALL0);

    const follower = new Transport(manualClock(), 120);
    applyTransportState(follower, state, WALL0 + 0.05); // pulse arrived 50 ms late
    // 10 s @ 120 BPM × 480 PPQ = 9600 ticks; the 50 ms latency is compensated
    expect(follower.position).toBeGreaterThan(9500);
    expect(follower.position).toBeLessThan(9750);
  });

  it("remote pause pauses at the remote tick; remote stop resets to 0", () => {
    const follower = new Transport(manualClock(), 124);
    follower.play(4800);

    applyTransportState(follower, { playing: false, anchorWall: WALL0, anchorTick: 7200, bpm: 124, by: "l", at: 1 }, WALL0);
    expect(follower.playing).toBe(false);
    expect(follower.position).toBe(7200);

    applyTransportState(follower, { playing: false, anchorWall: WALL0, anchorTick: 0, bpm: 124, by: "l", at: 2 }, WALL0);
    expect(follower.playing).toBe(false);
    expect(follower.position).toBe(0);
  });

  it("a playing follower re-anchors (does not restart) on a later pulse", () => {
    const follower = new Transport(manualClock(), 124);
    follower.play(0);
    applyTransportState(
      follower,
      { playing: true, anchorWall: WALL0, anchorTick: 9600, bpm: 124, by: "l", at: 1 },
      WALL0 + 1,
    );
    expect(follower.playing).toBe(true);
    // re-anchored to 9600 + 1 s of travel, NOT restarted from the pulse anchor
    expect(follower.position).toBeGreaterThan(9600);
    expect(follower.position).toBeLessThan(9600 + 1984 * 1.1);
  });

  it("capture→apply round-trip preserves the musical timeline", () => {
    const leaderClock = manualClock();
    const leader = new Transport(leaderClock, 100);
    leader.play(5000);
    leaderClock.advance(3);
    const state = captureTransportState(leader, "l", WALL0);

    const follower = new Transport(manualClock(), 60);
    applyTransportState(follower, state, WALL0);
    expect(follower.position).toBeCloseTo(leader.position, 0);
  });

  it("Transport.onGesture fires on play/pause/stop/seek with the post-change state", () => {
    const t = new Transport(manualClock(), 124);
    const gestures: string[] = [];
    t.onGesture = (tr) => gestures.push(`${tr.playing ? "play" : "paused"}@${Math.round(tr.position)}`);
    t.play(480);
    t.seek(960);
    t.pause();
    t.stop();
    expect(gestures).toEqual(["play@480", "play@960", "paused@960", "paused@0"]);
  });

  it("garbled pulses are ignored without throwing", () => {
    const t = new Transport(manualClock(), 124);
    expect(() =>
      applyTransportState(t, {
        playing: true,
        anchorWall: Number.NaN,
        anchorTick: Number.NaN,
        bpm: 124,
        by: "x",
        at: 1,
      }),
    ).not.toThrow();
    expect(t.playing).toBe(false);
  });

  it("rejects non-finite or out-of-range network fields before they reach Transport", () => {
    const t = new Transport(manualClock(), 124);
    t.play(960);
    const before = t.position;

    const invalid = [
      { playing: true, anchorWall: WALL0, anchorTick: 0, bpm: Number.NaN, by: "x", at: 1 },
      { playing: true, anchorWall: WALL0, anchorTick: Number.POSITIVE_INFINITY, bpm: 124, by: "x", at: 2 },
      { playing: true, anchorWall: WALL0, anchorTick: -1, bpm: 124, by: "x", at: 3 },
      { playing: true, anchorWall: WALL0, anchorTick: 0, bpm: 301, by: "x", at: 4 },
      { playing: "yes", anchorWall: WALL0, anchorTick: 0, bpm: 124, by: "x", at: 5 },
    ];

    for (const state of invalid) {
      expect(isSharedTransportState(state)).toBe(false);
      expect(() => applyTransportState(t, state as never, WALL0)).not.toThrow();
      expect(t.bpm).toBe(124);
      expect(t.position).toBeCloseTo(before, 6);
    }
  });

  it("accepts only complete, finite transport payloads", () => {
    expect(isSharedTransportState({
      playing: false,
      anchorWall: WALL0,
      anchorTick: 0,
      bpm: 124,
      by: "peer-1",
      at: WALL0 * 1000,
    })).toBe(true);
    expect(isSharedTransportState({ playing: false })).toBe(false);
  });

  it("starts the follower scheduler only for a paused → playing transition", () => {
    expect(shouldStartRemoteScheduler(false, true)).toBe(true);
    expect(shouldStartRemoteScheduler(true, true)).toBe(false);
    expect(shouldStartRemoteScheduler(true, false)).toBe(false);
    expect(shouldStartRemoteScheduler(false, false)).toBe(false);
  });
});
