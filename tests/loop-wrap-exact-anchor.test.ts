import { describe, expect, it, vi } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { getDrumTrack } from "../src/project-model/types";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";
import { WarpManager } from "../src/audio-engine/warpManager";

/**
 * LOOP WRAP EXACT ANCHOR + FROZEN TRANSPORT TICK (audit 2026-10-31).
 *
 * Two residual risks from the audio hardening audit, now fixed:
 *
 * 1. LOOP WRAP JITTER: the wrap used to re-anchor the new iteration at the
 *    DETECTION instant (`seek(loopStart)` at tick time), consuming the
 *    detection overshoot (up to one 25 ms tick) as grid stretch — every
 *    post-wrap event landed late by the overshoot and the audible loop
 *    period was loopLength + overshoot, so wall-clock-paced frozen sources
 *    drifted from the transport iteration by iteration. The wrap is now
 *    ARMED when the planner window sees the boundary and committed through
 *    the 5 ms seam committer (tick fallback kept) with a RETROACTIVE exact
 *    anchor: the new iteration is anchored at the boundary's pre-computed
 *    audio time, so the loop lasts exactly its musical length and the grid
 *    after the seam is sample-exact. The commit overshoot's own ticks are
 *    late-fired as a sliver window (start grace), never dropped.
 *
 * 2. FROZEN SCENE-TEMPO PHASE: frozenPositionTickNow() extrapolated the
 *    restart anchor with doc.bpm, which drifts from the real playhead
 *    whenever the transport runs a scene-pinned BPM (Transport.bpm ≠
 *    doc.bpm) — a mid-play re-freeze then rehydrated at the wrong tick.
 *    The manager now reads the live transport tick when the engine wired
 *    one (services wires `engine.getTransportTick = () => transport.position`).
 */

function makeLoopHarness(bpm = 120) {
  const doc = createDefaultProject();
  const kick = getDrumTrack(doc).pads[0]!;
  // Dense pattern: a hit on EVERY step so the loop's downbeat (tick 0) is
  // always occupied and the sliver/no-double-fire assertions are meaningful.
  const rows = doc.patterns[0]!.rows[kick.id]!;
  for (let step = 0; step < rows.length; step++) rows[step] = 1;
  const events: Array<{ when: number; velocity: number }> = [];
  let audioTime = 10;
  const transport = new Transport({ now: () => audioTime }, bpm);
  const scheduler = new Scheduler({
    getProject: () => doc,
    getTransport: () => transport,
    getAudioTime: () => audioTime,
    getMode: () => "pattern",
    trigger: (_trackId: string, _pad: unknown, when: number, velocity: number) => {
      events.push({ when, velocity });
    },
    noteOn: () => {},
    metronomeClick: () => {},
    applyAutomation: () => {},
    applyPatternLaunch: () => {},
    getContextState: () => "running",
  });
  const tick = () => (scheduler as unknown as { tick: () => void }).tick();
  return {
    doc,
    events,
    scheduler,
    transport,
    tick,
    at: (t: number) => (audioTime = t),
    now: () => audioTime,
  };
}

/** 120 bpm, PPQ 480: 960 ticks per second; the loop below is exactly 1 s long. */
const LOOP_TICKS = 960;
const SPT = 1 / 960;

describe("loop wrap exact anchor (audit 2026-10-31)", () => {
  it("anchors the new iteration at the boundary's PRE-COMPUTED audio time (tick-cadence fallback)", () => {
    const h = makeLoopHarness();
    h.transport.setLoop(true, 0, LOOP_TICKS);
    h.transport.play(0);
    h.at(10);
    h.tick(); // window [0, 115.2] — pre-boundary
    // Ideal seam audio time: play anchored tick 0 at t=10 → tick 960 at 11.0.
    // Cross the boundary and let the next tick commit the wrap.
    h.at(11.02);
    h.tick();
    // The retroactive anchor points at the seam instant, NOT the detection
    // instant (the old code anchored at 11.02 — a 20 ms grid stretch).
    expect(h.transport.timeMapAnchorTime).toBeCloseTo(11.0, 9);
    expect(h.transport.timeMapAnchorTick).toBe(0);
    // Position is CONTINUOUS: the playhead is exactly the overshoot past the
    // loop start — no time was lost or gained at the seam.
    expect(h.transport.position).toBeCloseTo((11.02 - 11.0) / SPT, 6);
    // The next iteration's boundary is sample-exact: 11.0 + 1.0 = 12.0 (the
    // old code produced 12.02 — the stretch compounded iteration by iteration).
    expect(h.transport.timeAtTick(LOOP_TICKS)).toBeCloseTo(12.0, 9);
  });

  it("keeps the loop period EXACTLY its musical length across consecutive wraps", () => {
    const h = makeLoopHarness();
    h.transport.setLoop(true, 0, LOOP_TICKS);
    h.transport.play(0);
    h.at(10);
    h.tick();
    h.at(11.03);
    h.tick(); // wrap 1 → anchor 11.0
    expect(h.transport.timeMapAnchorTime).toBeCloseTo(11.0, 9);
    h.at(12.04);
    h.tick(); // wrap 2 → anchor 12.0 (exactly one musical second later)
    expect(h.transport.timeMapAnchorTime).toBeCloseTo(12.0, 9);
    h.at(13.05);
    h.tick(); // wrap 3 → anchor 13.0
    expect(h.transport.timeMapAnchorTime).toBeCloseTo(13.0, 9);
  });

  it("late-fires the commit overshoot's sliver: the loop downbeat sounds exactly once", () => {
    const h = makeLoopHarness();
    h.transport.setLoop(true, 0, LOOP_TICKS);
    h.transport.play(0);
    h.at(10);
    h.tick();
    const before = h.events.length;
    h.at(11.02);
    h.tick(); // wrap: the sliver schedules [loopStart, position] with the start grace
    const after = h.events.slice(before);
    // The downbeat (pattern tick 0, ideal time 11.0) fired through the sliver.
    const downbeats = after.filter((e) => Math.abs(e.when - 11.0) < 1e-6);
    expect(downbeats).toHaveLength(1);
    // And nothing fired twice: every scheduled `when` in the wrap tick is unique.
    const whens = after.map((e) => e.when);
    expect(new Set(whens).size).toBe(whens.length);
    // The next tick continues from the sliver's end — no re-fire of the downbeat.
    const mid = h.events.length;
    h.at(11.08);
    h.tick();
    expect(h.events.slice(mid).filter((e) => Math.abs(e.when - 11.0) < 1e-6)).toHaveLength(0);
  });

  it("commits through the 5 ms seam committer (fast path) with the same exact anchor", () => {
    vi.useFakeTimers();
    try {
      const h = makeLoopHarness();
      h.transport.setLoop(true, 0, LOOP_TICKS);
      h.transport.play(0);
      h.at(10);
      h.scheduler.start(); // start() ticks once; boundary not in horizon yet
      // Boundary inside the horizon → the wrap arms and the seam committer wakes.
      h.at(10.9);
      h.tick();
      // Not crossed yet — the committer must not jump the gun.
      vi.advanceTimersByTime(5);
      expect(h.transport.timeMapAnchorTime).toBeCloseTo(10.0, 9);
      // Crossed → the 5 ms committer commits with the exact anchor.
      h.at(11.002);
      vi.advanceTimersByTime(5);
      expect(h.transport.timeMapAnchorTime).toBeCloseTo(11.0, 9);
      expect(h.scheduler.stats.wrapFastCommits).toBe(1);
      h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a seek between arm and boundary cancels the stale wrap; the next seam anchors on the NEW map", () => {
    const h = makeLoopHarness();
    h.transport.setLoop(true, 0, LOOP_TICKS);
    h.transport.play(0);
    h.at(10);
    h.tick();
    h.at(10.9);
    h.tick(); // arms with boundaryTime 11.0 (pre-seek map)
    // Seek while playing: the armed boundary belongs to the old map now.
    h.at(10.95);
    h.transport.seek(500);
    h.scheduler.resync();
    h.at(11.05);
    h.tick(); // position ≈ 596 — no wrap yet; the seam re-arms on the post-seek map
    // New ideal boundary: the seek anchored tick 500 at 10.95 → tick 960 at:
    const expectedBoundary = 10.95 + (LOOP_TICKS - 500) * SPT;
    h.at(expectedBoundary + 0.02);
    h.tick();
    expect(h.transport.timeMapAnchorTime).toBeCloseTo(expectedBoundary, 8);
  });

  it("a playhead BEFORE loopStart keeps plain seek semantics (future anchor clamps to now)", () => {
    const h = makeLoopHarness();
    h.transport.setLoop(true, 480, 480 + LOOP_TICKS);
    h.transport.play(100);
    h.at(10);
    h.tick();
    // position 100 < loopStart 480: the FIRST tick pulls the playhead to the
    // loop start. boundaryTime (tick 1440) is in the FUTURE here, so the
    // exact-anchor guard clamps it to the clock — a plain jump to loopStart
    // anchored at NOW, not a retroactive anchor into the future.
    expect(h.transport.timeMapAnchorTime).toBeCloseTo(10.0, 9);
    expect(h.transport.position).toBe(480);
  });
});

// ---------------------------------------------------------------------------
// Frozen tracks under a scene-pinned BPM
// ---------------------------------------------------------------------------

function fakeFrozenHarness(bpm: number, getTransportTick?: () => number) {
  let currentTime = 5;
  const ctx = {
    get currentTime() {
      return currentTime;
    },
    createBufferSource: () => {
      const source: {
        started: number | null;
        buffer: unknown;
        loop: boolean;
        connect: () => void;
        stop: () => void;
        disconnect: () => void;
        start: (when?: number) => void;
      } = {
        started: null,
        buffer: null,
        loop: false,
        connect: () => {},
        stop: () => {},
        disconnect: () => {},
        start: (when?: number) => {
          source.started = when ?? currentTime;
        },
      };
      return source;
    },
  } as unknown as BaseAudioContext;
  const doc = { bpm, tracks: [{ id: "t1", frozen: { bufferId: "fz1" } }] };
  const bank = { get: (id: string) => (id === "fz1" ? { duration: 4 } : null) };
  const manager = new WarpManager({
    ctx: () => ctx,
    doc: () => doc as never,
    bank: () => bank as never,
    trackInput: () => ({ disconnect: () => {} }) as unknown as AudioNode,
    ...(getTransportTick ? { getTransportTick } : {}),
  });
  return { manager, advance: (sec: number) => (currentTime += sec) };
}

describe("frozen transport tick under scene tempo (audit 2026-10-31)", () => {
  it("reads the LIVE transport tick when the engine wired one — no doc.bpm drift", () => {
    const h = fakeFrozenHarness(120, () => 234.5);
    h.manager.restartFrozenSources(100);
    // The transport ran a scene at a different BPM for a while; the real
    // playhead is at 234.5 — the estimate must return exactly that, not the
    // doc.bpm extrapolation of the restart anchor.
    h.advance(3);
    expect(h.manager.frozenPositionTickNow()).toBe(234.5);
  });

  it("falls back to the doc.bpm extrapolation when no transport reader is wired", () => {
    const h = fakeFrozenHarness(120);
    h.manager.restartFrozenSources(100);
    h.advance(2);
    // 100 ticks + 2 s at 120 bpm = 100 + 2 * (120/60) * 480 = 2020.
    expect(h.manager.frozenPositionTickNow()).toBeCloseTo(2020, 6);
  });

  it("restart anchors still record the restart tick for the fallback path", () => {
    const h = fakeFrozenHarness(120);
    h.manager.restartFrozenSources(100);
    // No transport reader, no elapsed time → the restart anchor itself.
    expect(h.manager.frozenPositionTickNow()).toBe(100);
  });
});
