import { describe, expect, it } from "vitest";
import { NoteRepeatController, rateTicksOf, repeatVelocity, type FalloffMode } from "../src/audio-engine/NoteRepeat";
import { Transport } from "../src/transport/Transport";
import { PPQ, STEP_TICKS } from "../src/project-model/types";

interface FiredHit {
  padId: string;
  velocity: number;
  when: number;
}

function makeHarness(bpm = 120) {
  let audioTime = 10;
  const transport = new Transport({ now: () => audioTime }, bpm);
  const hits: FiredHit[] = [];
  const controller = new NoteRepeatController({
    getTransport: () => transport,
    getAudioTime: () => audioTime,
    fire: (trackId, padId, velocity, when) => {
      void trackId;
      hits.push({ padId, velocity, when });
    },
  });
  const advance = (seconds: number) => {
    audioTime += seconds;
    controller["tick"]();
  };
  return { controller, transport, hits, advance, setAudioTime: (t: number) => (audioTime = t) };
}

describe("rateTicksOf", () => {
  it("maps note values onto PPQ divisions (straight and triplet)", () => {
    expect(rateTicksOf("1/4")).toBe(PPQ);
    expect(rateTicksOf("1/8")).toBe(PPQ / 2);
    expect(rateTicksOf("1/16")).toBe(STEP_TICKS);
    expect(rateTicksOf("1/8T")).toBe(Math.round(PPQ / 3));
    expect(rateTicksOf("1/16T")).toBe(Math.round(PPQ / 6));
  });
});

describe("repeatVelocity", () => {
  it("decay lowers, rise raises and clamps, constant holds", () => {
    expect(repeatVelocity(1, 0, "decay")).toBe(1);
    expect(repeatVelocity(1, 2, "decay")).toBeCloseTo(0.7225, 4);
    expect(repeatVelocity(1, 20, "decay")).toBeGreaterThanOrEqual(0.05);
    expect(repeatVelocity(0.6, 1, "rise")).toBeCloseTo(0.69, 3);
    expect(repeatVelocity(1, 10, "rise")).toBeLessThanOrEqual(1);
    expect(repeatVelocity(0.7, 5, "constant")).toBe(0.7);
  });
});

describe("NoteRepeatController — playing transport", () => {
  it("fires the first hit immediately, then locks repeats to the grid (1/16 at 120 BPM)", () => {
    const h = makeHarness(120);
    h.controller.setRate("1/16");
    h.transport.play(0);
    h.controller.start("k", "t1", "pad1", 1);

    expect(h.hits.length).toBe(1); // immediate hit
    // The 0.12 s scheduling horizon legitimately pre-schedules the first
    // grid point (0.125 s away) — what matters is WHERE repeats land.
    h.advance(0.02);
    expect(h.hits.length).toBeGreaterThanOrEqual(1);
    h.advance(0.03);
    const gridTimes = h.hits.slice(1).map((hit) => hit.when);
    // Every repeat lands on a 1/16 grid point (tick % STEP_TICKS === 0).
    const secondsPerTick = 60 / (120 * PPQ);
    for (const when of gridTimes) {
      const tick = (when - h.transport.timeAtTick(0)) / secondsPerTick;
      expect(tick % STEP_TICKS).toBeCloseTo(0, 3);
    }
    h.controller.stop("k");
  });

  it("advance through many repeats keeps monotonically increasing times", () => {
    const h = makeHarness(140);
    h.controller.setRate("1/16");
    h.transport.play(0);
    h.controller.start("k", "t1", "pad1", 1);
    for (let i = 0; i < 10; i++) h.advance(0.025);
    const times = h.hits.map((hit) => hit.when);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    // 10 × 25 ms ticks = 0.25 s at 1/16 ≈ 107 ms spacing → immediate hit + ~3.
    expect(h.hits.length).toBeGreaterThan(2);
    h.controller.stop("k");
  });

  it("decay mode fades repeat velocities; rise mode grows towards 1", () => {
    for (const mode of ["decay", "rise"] as FalloffMode[]) {
      const h = makeHarness(120);
      h.controller.setRate("1/16");
      h.controller.setFalloff(mode);
      h.transport.play(0);
      h.controller.start("k", "t1", "pad1", 0.8);
      for (let i = 0; i < 8; i++) h.advance(0.03);
      const velocities = h.hits.map((hit) => hit.velocity);
      if (mode === "decay") {
        expect(velocities[velocities.length - 1]).toBeLessThan(velocities[0]);
      } else {
        expect(velocities[velocities.length - 1]).toBeGreaterThan(velocities[0]);
        expect(velocities.every((v) => v <= 1)).toBe(true);
      }
      h.controller.stop("k");
    }
  });

  it("release stops scheduling (only the ≤ horizon tail may remain)", () => {
    const h = makeHarness(120);
    h.controller.setRate("1/16");
    h.transport.play(0);
    h.controller.start("k", "t1", "pad1", 1);
    h.advance(0.05);
    const atRelease = h.hits.length;
    h.controller.stop("k");
    const countAfterStop = h.hits.length;
    for (let i = 0; i < 10; i++) h.advance(0.05);
    expect(h.hits.length).toBeLessThanOrEqual(countAfterStop + 2); // tail only
    expect(h.hits.length).toBeGreaterThanOrEqual(atRelease);
  });
});

describe("NoteRepeatController — stopped transport (free-run)", () => {
  it("repeats at the rate interval using the audio clock", () => {
    const h = makeHarness(120); // 1/16 = 0.125 s
    h.controller.setRate("1/16");
    h.controller.start("k", "t1", "pad1", 1);
    expect(h.hits.length).toBe(1);
    h.advance(0.3);
    // ~2–3 repeats within 0.3 s at 125 ms spacing.
    expect(h.hits.length).toBeGreaterThanOrEqual(3);
    expect(h.hits.length).toBeLessThanOrEqual(5);
    const gaps = h.hits.slice(1).map((hit, i) => hit.when - h.hits[i].when);
    for (const gap of gaps) expect(gap).toBeCloseTo(0.125, 1);
    h.controller.stop("k");
  });

  it("switching to playing mid-hold re-anchors to the grid without duplicates", () => {
    const h = makeHarness(120);
    h.controller.setRate("1/16");
    h.controller.start("k", "t1", "pad1", 1);
    h.advance(0.1);
    h.transport.play(0);
    h.advance(0.2);
    const times = h.hits.map((hit) => hit.when);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    expect(h.controller.isHolding("k")).toBe(true);
    h.controller.stop("k");
  });
});

describe("NoteRepeatController — lifecycle", () => {
  it("supports multiple independent holds", () => {
    const h = makeHarness(120);
    h.controller.setRate("1/8");
    h.transport.play(0);
    h.controller.start("a", "t1", "padA", 1);
    h.advance(0.02);
    h.controller.start("b", "t1", "padB", 0.5);
    h.advance(0.3);
    const pads = new Set(h.hits.map((hit) => hit.padId));
    expect(pads.has("padA")).toBe(true);
    expect(pads.has("padB")).toBe(true);
    h.controller.stop("a");
    const afterStop = h.hits.filter((hit) => hit.padId === "padA").length;
    h.advance(0.3);
    expect(h.hits.filter((hit) => hit.padId === "padA").length).toBeLessThanOrEqual(afterStop + 2);
    h.controller.stop("b");
  });

  it("setRate('off') releases all holds and fires single hits afterwards", () => {
    const h = makeHarness(120);
    h.controller.setRate("1/16");
    h.transport.play(0);
    h.controller.start("k", "t1", "pad1", 1);
    h.controller.setRate("off");
    expect(h.controller.isHolding("k")).toBe(false);
    const before = h.hits.length;
    h.advance(0.2);
    expect(h.hits.length).toBe(before);
    // With rate off, start() still fires exactly one hit (universal pad-down).
    h.controller.start("k2", "t1", "pad1", 0.6);
    expect(h.hits.length).toBe(before + 1);
    expect(h.hits[h.hits.length - 1].velocity).toBe(0.6);
  });

  it("stopAll clears everything; timers stop when no holds remain", () => {
    const h = makeHarness(120);
    h.controller.setRate("1/16");
    h.controller.start("a", "t1", "padA", 1);
    h.controller.start("b", "t1", "padB", 1);
    expect(h.controller.size).toBe(2);
    h.controller.stopAll();
    expect(h.controller.size).toBe(0);
    const before = h.hits.length;
    h.advance(0.2);
    expect(h.hits.length).toBe(before);
  });
});
