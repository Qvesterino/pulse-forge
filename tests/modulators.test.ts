import { describe, expect, it } from "vitest";
import {
  DEFAULT_STEP_PATTERN,
  divisionTicks,
  modulatorEventsInRange,
  randomHoldValue,
  resolveLfoTarget,
  sanitizeLfo,
  sanitizeSteps,
} from "../src/project-model/modulators";
import type { Lfo } from "../src/project-model/types";
import { PPQ } from "../src/project-model/types";

const trackIds = new Set(["t1", "t2"]);

describe("modulator grid", () => {
  it("maps divisions to musical lengths in ticks", () => {
    expect(divisionTicks(0)).toBe(PPQ * 4); // 1/1 → full bar
    expect(divisionTicks(2)).toBe(PPQ); // 1/4
    expect(divisionTicks(4)).toBe(PPQ / 4); // 1/16
  });

  it("falls back to the legacy default for out-of-range divisions", () => {
    expect(divisionTicks(undefined)).toBe(divisionTicks(2));
    expect(divisionTicks(-5)).toBe(divisionTicks(0));
    expect(divisionTicks(99)).toBe(divisionTicks(4));
  });
});

describe("random S&H determinism", () => {
  it("is stateless per index — query order cannot change values", () => {
    const direct = randomHoldValue("lfo-test", "seed-42", 7);
    void randomHoldValue("lfo-test", "seed-42", 100);
    void randomHoldValue("lfo-test", "seed-42", 3);
    expect(randomHoldValue("lfo-test", "seed-42", 7)).toBe(direct);
  });

  it("diverges across seeds and stays bipolar", () => {
    expect(randomHoldValue("l", "a", 7)).not.toBe(randomHoldValue("l", "b", 7));
    for (let k = 0; k < 500; k++) {
      const value = randomHoldValue("l", "s", k);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("event streams", () => {
  const randomLfo: Lfo = {
    id: "r1",
    trackId: "t1",
    kind: "random",
    param: "gain",
    snh: "hold",
    rateMode: "sync",
    rateHz: 8,
    division: 3,
    amount: 0.4,
    seed: "s",
  };
  const glideRandom: Lfo = { ...randomLfo, id: "r2", snh: "glide" };
  const stepLfo: Lfo = {
    id: "s1",
    trackId: "t1",
    kind: "step",
    param: "gain",
    division: 3,
    glideSec: 0.02,
    amount: 0.6,
    steps: [0, 1, 0, -1],
  };

  it("anchors the current value at the window start, then emits boundaries", () => {
    const hold = divisionTicks(3); // PPQ (1/8 of a beat? division 3 → beats/cycle .5 → ticks 240)
    const events = modulatorEventsInRange(randomLfo, hold + 10, hold + hold * 3);
    expect(events[0].tick).toBe(hold + 10);
    expect(events[0].mode).toBe("set");
    const boundaries = events.slice(1);
    expect(boundaries.length).toBeGreaterThanOrEqual(2);
    for (const event of boundaries) {
      expect(event.tick % hold).toBe(0); // absolute grid alignment
      expect(event.value).toBeGreaterThanOrEqual(-1);
      expect(event.value).toBeLessThanOrEqual(1);
    }
  });

  it("hard holds emit set events; glide emits ramps", () => {
    const span = divisionTicks(randomLfo.division) * 3;
    const holds = modulatorEventsInRange(randomLfo, 0, span);
    const glides = modulatorEventsInRange(glideRandom, 0, span);
    expect(holds.every((e) => e.mode === "set")).toBe(true);
    expect(glides.filter((e) => e.mode === "ramp").length).toBeGreaterThan(0);
  });

  it("step sequences wrap modulo their length on a uniform grid", () => {
    const hold = divisionTicks(stepLfo.division);
    const events = modulatorEventsInRange(stepLfo, 0, hold * 6);
    const transitions = events.filter((e) => e.tick > 0);
    expect(transitions.length).toBe(6);
    transitions.forEach((event, index) => {
      expect(event.tick).toBe(hold * (index + 1));
      const expected = DEFAULT_STEP_PATTERN_N4[(index + 1) % 4];
      expect(event.value).toBeCloseTo(expected, 6);
    });
  });

  it("identical consecutive steps collapse (no redundant writes)", () => {
    const flat: Lfo = { ...stepLfo, id: "flat", steps: new Array(16).fill(0.25) };
    const events = modulatorEventsInRange(flat, 0, divisionTicks(flat.division) * 8);
    expect(events.length).toBe(1); // only the anchor
  });
});

const DEFAULT_STEP_PATTERN_N4 = [0, 1, 0, -1];

describe("sanitizers", () => {
  it("keeps valid osc entries untouched semantically", () => {
    const lfo: Lfo = {
      id: "a",
      trackId: "t1",
      param: "pan",
      wave: "square",
      rateMode: "sync",
      rateHz: 2,
      division: 2,
      amount: 0.3,
    };
    const cleaned = sanitizeLfo(lfo, trackIds);
    expect(cleaned).not.toBeNull();
    expect(cleaned!.kind).toBeUndefined();
    expect(cleaned!.param).toBe("pan");
    expect(cleaned!.wave).toBe("square");
  });

  it("drops entries with dangling tracks or malformed shapes", () => {
    expect(sanitizeLfo({ id: "x", trackId: "ghost" }, trackIds)).toBeNull();
    expect(sanitizeLfo(null, trackIds)).toBeNull();
    expect(sanitizeLfo(42, trackIds)).toBeNull();
  });

  it("clamps amounts, waves, rates and repairs missing kind-specific fields", () => {
    const cleaned = sanitizeLfo(
      {
        id: "b",
        trackId: "t1",
        kind: "osc",
        param: "nope",
        wave: "wobble",
        rateMode: "wat",
        rateHz: 999,
        division: 33,
        amount: 9,
      },
      trackIds,
    )!;
    expect(cleaned.param).toBe("gain");
    expect(cleaned.wave).toBe("sine");
    expect(cleaned.rateMode).toBe("sync");
    expect(cleaned.rateHz).toBe(30);
    expect(cleaned.division).toBe(4);
    expect(cleaned.amount).toBe(1);
  });

  it("envFollower self-heals dangling source to host track and clamps timings", () => {
    const cleaned = sanitizeLfo(
      {
        id: "c",
        trackId: "t1",
        kind: "envFollower",
        param: "gain",
        sourceTrackId: "ghost",
        attackMs: -50,
        releaseMs: 99999,
        sensitivity: 42,
        amount: 0.5,
      },
      trackIds,
    )!;
    expect(cleaned.sourceTrackId).toBe("t1");
    expect(cleaned.attackMs).toBe(1);
    expect(cleaned.releaseMs).toBe(2000);
    expect(cleaned.sensitivity).toBe(3);
  });

  it("random keeps stable fallback seed when seed is junk", () => {
    const cleaned = sanitizeLfo(
      { id: "d", trackId: "t1", kind: "random", param: "gain", snh: "nonsense", amount: 0.4 },
      trackIds,
    )!;
    expect(typeof cleaned.seed).toBe("string");
    expect(cleaned.seed!.length).toBeGreaterThan(0);
    const again = sanitizeLfo(cleaned, trackIds)!;
    expect(again.seed).toBe(cleaned.seed); // sanitizer is idempotent
  });

  it("step arrays snap to 8/16/32 lengths with clamped bipolar values", () => {
    const tiny = sanitizeSteps([1]);
    expect(tiny.length).toBe(8);
    const odd = sanitizeSteps(new Array(20).fill(7));
    expect(odd.length).toBe(16);
    for (const v of odd) expect(v).toBe(1);
    const big = sanitizeSteps(new Array(24).fill(-3));
    expect(big.length).toBe(32);
    expect(sanitizeSteps([])).toEqual(DEFAULT_STEP_PATTERN.slice(0, 16));
  });
});

describe("target resolution", () => {
  it("random/step honour explicit generic targets", () => {
    const target = { kind: "fxParam" as const, trackId: "t1", fxId: "fx9", paramId: "cutoff" };
    const lfo: Lfo = {
      id: "e",
      trackId: "t1",
      kind: "step",
      param: "pan",
      target,
      division: 3,
      glideSec: 0,
      amount: 0.5,
      steps: [],
    };
    expect(resolveLfoTarget(lfo)).toBe(target);
  });

  it("falls back to the native param selector otherwise", () => {
    const osc: Lfo = {
      id: "f",
      trackId: "t1",
      param: "pan",
      wave: "sine",
      rateMode: "sync",
      rateHz: 2,
      division: 2,
      amount: 0.3,
    };
    expect(resolveLfoTarget(osc)).toEqual({ kind: "trackPan", trackId: "t1" });
    const follower: Lfo = {
      id: "g",
      trackId: "t1",
      kind: "envFollower",
      param: "gain",
      sourceTrackId: "t1",
      attackMs: 12,
      releaseMs: 180,
      sensitivity: 1.5,
      amount: 0.5,
    };
    expect(resolveLfoTarget(follower)).toEqual({ kind: "trackGain", trackId: "t1" });
  });
});
