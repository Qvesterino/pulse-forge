import { describe, expect, it } from "vitest";
import { autoMapVelocityLayers, parseSampleNote, parseSampleVelocity, rrGroupKey } from "../src/samples/autoMap";

describe("sampler auto keyzone/RR mapping", () => {
  it("parses note tokens in common file name shapes", () => {
    expect(parseSampleNote("kick_C2.wav")).toBe(36);
    expect(parseSampleNote("stab F#4.wav")).toBe(66);
    expect(parseSampleNote("Piano.C4.aif")).toBe(60);
    expect(parseSampleNote("keyDb3.flac")).toBe(49);
    expect(parseSampleNote("piano-c3.ogg")).toBe(48);
    expect(parseSampleNote("no-note-here.wav")).toBeNull();
  });

  it("parses explicit velocity tokens as normalized centers", () => {
    expect(parseSampleVelocity("piano_C4_v32.wav")).toBeCloseTo(32 / 127);
    expect(parseSampleVelocity("piano_C4_vel90-2.wav")).toBeCloseTo(90 / 127);
    expect(parseSampleVelocity("piano_C4_velocity127.aif")).toBe(1);
    expect(parseSampleVelocity("piano_C4.wav")).toBeNull();
    expect(parseSampleVelocity("piano_C4_v128.wav")).toBeNull();
  });

  it("strips trailing counters for RR group keys", () => {
    expect(rrGroupKey("snare-1.wav")).toBe(rrGroupKey("snare-2.wav"));
    expect(rrGroupKey("snare-1.wav")).not.toBe(rrGroupKey("snare-3_2.wav"));
  });

  it("spreads keyed samples across disjoint keyzones ordered by pitch", () => {
    const layers = autoMapVelocityLayers([
      { sampleId: "c", name: "piano_C4.wav" },
      { sampleId: "a", name: "piano A2.wav" },
      { sampleId: "e", name: "piano_E5.wav" },
    ]);
    expect(layers.length).toBe(3);
    // pitch order: A2 (45), C4 (60), E5 (76)
    expect(layers[0].minPitch).toBe(0);
    expect(layers[0].maxPitch).toBe(59);
    expect(layers[1].minPitch).toBe(60);
    expect(layers[1].maxPitch).toBe(75);
    expect(layers[2].minPitch).toBe(76);
    expect(layers[2].maxPitch).toBe(127);
    expect(layers.map((l) => l.sampleId)).toEqual(["a", "c", "e"]);
    expect(layers.map((l) => [l.minPitch, l.maxPitch])).toEqual([
      [0, 59],
      [60, 75],
      [76, 127],
    ]);
    // all velocity windows are full (no velocity switch between zones)
    for (const l of layers) {
      expect(l.min).toBe(0);
      expect(l.max).toBe(1);
    }
  });

  it("same note with counters becomes an RR group (overlapping windows)", () => {
    const layers = autoMapVelocityLayers([
      { sampleId: "r1", name: "clap_C4-1.wav" },
      { sampleId: "r2", name: "clap_C4-2.wav" },
      { sampleId: "r3", name: "clap_C4-3.wav" },
    ]);
    expect(layers.length).toBe(3);
    expect(new Set(layers.map((l) => l.sampleId))).toEqual(new Set(["r1", "r2", "r3"]));
    for (const l of layers) {
      expect(l.minPitch).toBe(0); // a lone zone covers the whole keyboard
      expect(l.maxPitch).toBe(127);
      expect(l.min).toBe(0);
      expect(l.max).toBe(1); // overlapping = engine round-robin
    }
  });

  it("maps explicit velocity centers into touching windows and keeps RR overlap", () => {
    const layers = autoMapVelocityLayers([
      { sampleId: "hard-2", name: "piano_C4_v96-2.wav" },
      { sampleId: "soft", name: "piano_C4_v32.wav" },
      { sampleId: "hard-1", name: "piano_C4_v96-1.wav" },
    ]);
    expect(layers).toHaveLength(3);
    expect(layers.map((l) => l.sampleId)).toEqual(["soft", "hard-1", "hard-2"]);
    expect(layers[0]).toMatchObject({ min: 0, max: (32 / 127 + 96 / 127) / 2, minPitch: 0, maxPitch: 127 });
    expect(layers[1]).toMatchObject({ min: (32 / 127 + 96 / 127) / 2, max: 1 });
    expect(layers[2]).toMatchObject({ min: layers[1].min, max: 1 });
  });

  it("uses stable unique layer ids for the same input", () => {
    const samples = [
      { sampleId: "a", name: "piano_C4_v40.wav" },
      { sampleId: "b", name: "piano_C4_v90.wav" },
    ];
    const first = autoMapVelocityLayers(samples);
    const second = autoMapVelocityLayers(samples);
    expect(first).toEqual(second);
    expect(new Set(first.map((layer) => layer.id)).size).toBe(first.length);
  });

  it("untagged samples fall back to full-range single layers", () => {
    const layers = autoMapVelocityLayers([
      { sampleId: "x", name: "fx-noise.wav" },
      { sampleId: "y", name: "thing.wav" },
    ]);
    expect(layers.length).toBe(2);
    expect(layers[0].minPitch).toBeUndefined();
    expect(layers[0].maxPitch).toBeUndefined();
  });

  it("empty input yields no layers", () => {
    expect(autoMapVelocityLayers([])).toEqual([]);
  });
});
