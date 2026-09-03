import { describe, expect, it } from "vitest";
import { randomizeParams } from "../src/instruments/randomize";
import { INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";

describe("instrument randomize", () => {
  it("is deterministic per seed", () => {
    const cur = defaultInstrumentParams("analog");
    const a = randomizeParams("analog", cur, "deep", 42);
    const b = randomizeParams("analog", cur, "deep", 42);
    expect(a).toEqual(b);
  });

  it("never touches level/gain, keeps everything within registry bounds", () => {
    for (const kind of ["analog", "sampler", "wavetable", "bass", "drumsynth"] as const) {
      const cur = defaultInstrumentParams(kind);
      const out = randomizeParams(kind, cur, "deep", 7);
      expect(out.level).toBe(cur.level);
      if (kind === "sampler") {
        expect(out.gain).toBe(cur.gain);
        expect(out.root).toBe(cur.root);
      }
      for (const p of INSTRUMENT_DEFS[kind].params) {
        expect(out[p.id]).toBeGreaterThanOrEqual(p.min);
        expect(out[p.id]).toBeLessThanOrEqual(p.max);
      }
    }
  });

  it("mutate stays within ±12 % of range around the current values", () => {
    const cur = defaultInstrumentParams("analog");
    const out = randomizeParams("analog", cur, "mutate", 99);
    for (const p of INSTRUMENT_DEFS.analog.params) {
      if (p.options) {
        expect(out[p.id]).toBe(cur[p.id]); // options don't mutate
        continue;
      }
      const span = Math.abs(out[p.id] - cur[p.id]);
      expect(span).toBeLessThanOrEqual(0.121 * (p.max - p.min) + 1e-9);
    }
  });

  it("deep redraws options and log-scales cutoffs away from the extremes", () => {
    const cur = defaultInstrumentParams("analog");
    const draws = [3, 77, 512].map((seed) => randomizeParams("analog", cur, "deep", seed));
    // options re-roll between seeds
    const oscAs = new Set(draws.map((d) => d.oscA));
    expect(oscAs.size).toBeGreaterThan(1);
    // log-distributed cutoffs: median of a few draws sits well above the min
    const cutoffs = draws.map((d) => d.cutoff).sort((x, y) => x - y);
    expect(cutoffs[1]).toBeGreaterThan(INSTRUMENT_DEFS.analog.params.find((p) => p.id === "cutoff")!.min * 4);
  });
});
