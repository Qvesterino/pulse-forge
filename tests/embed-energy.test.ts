import { describe, expect, it } from "vitest";
import {
  BRIGHT_LEVEL,
  DARK_LEVEL,
  applyEnergy,
  initialEnergyFromHash,
  energyFamilyOfTrack,
  energyGainFactor,
  energyVelocityFactor,
  energyWeights,
  hasAuthoredRig,
  parseEmbedCommand,
} from "../src/embed/energy";
import type { ProjectDocument } from "../src/project-model/types";

function fixtureDoc(): ProjectDocument {
  return {
    name: "Test Beat",
    bpm: 140,
    macros: [],
    scenes: [{ id: "sc1", name: "Drop", patternId: "p1", intensity: 0.7, role: "drop" }],
    patterns: [
      {
        id: "p1",
        name: "Drop",
        stepCount: 16,
        rows: { pad1: [1, 0.5, 0, 0.25] },
        notes: { "track-bass": [{ velocity: 0.9 }, { velocity: 1 }] },
      },
    ],
    tracks: [
      { id: "track-drum", kind: "drum", name: "Kit", gain: 1 },
      { id: "track-bass", kind: "instrument", instrument: "808", name: "808 Sub", gain: 1 },
      { id: "track-fx", kind: "instrument", instrument: "sampler", name: "FX Riser", gain: 1 },
      { id: "track-lead", kind: "instrument", instrument: "pluck", name: "Lead", gain: 1 },
      { id: "track-bus", kind: "group", name: "Drum Bus", gain: 1 },
    ],
  } as unknown as ProjectDocument;
}

function rigDoc(): ProjectDocument {
  const doc = fixtureDoc();
  return {
    ...doc,
    macros: [
      {
        id: "m1",
        value: 0.5,
        mappings: [{ id: "map1", trackId: "track-drum", param: "gain", amount: 0.5, source: "intensity" }],
      },
    ],
  } as unknown as ProjectDocument;
}

describe("embed energy — family classification", () => {
  it("classifies drum kinds, bass kinds, fx names and defaults", () => {
    expect(energyFamilyOfTrack({ kind: "drum", name: "Kit" })).toBe("drums");
    expect(energyFamilyOfTrack({ kind: "instrument", instrument: "drumsynth", name: "909" })).toBe("drums");
    expect(energyFamilyOfTrack({ kind: "instrument", instrument: "808", name: "Sub" })).toBe("bass");
    expect(energyFamilyOfTrack({ kind: "instrument", instrument: "sampler", name: "FX Riser" })).toBe("fx");
    expect(energyFamilyOfTrack({ kind: "instrument", instrument: "pluck", name: "Melody" })).toBe("lead");
    expect(energyFamilyOfTrack({ kind: "instrument", instrument: "keys", name: "Chords" })).toBe("harmony");
    expect(energyFamilyOfTrack({ kind: "group", name: "Drum Bus" })).toBe("other");
  });
});

describe("embed energy — gain + velocity curves", () => {
  it("keeps the skeleton audible at zero and rides the drop at one", () => {
    expect(energyGainFactor("drums", 0)).toBeGreaterThan(0);
    expect(energyGainFactor("drums", 1)).toBe(1);
    expect(energyGainFactor("fx", 0)).toBe(0);
    expect(energyGainFactor("fx", 1)).toBe(1);
    expect(energyGainFactor("drums", 0.5)).toBeGreaterThan(energyGainFactor("fx", 0.5));
    expect(energyVelocityFactor(1)).toBe(1);
    expect(energyVelocityFactor(0)).toBeLessThan(0.5);
  });
});

describe("embed energy — applyEnergy (generic transform)", () => {
  it("never mutates the input document", () => {
    const doc = fixtureDoc();
    const snapshot = JSON.stringify(doc);
    const dark = applyEnergy(doc, DARK_LEVEL);
    expect(dark).not.toBe(doc);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it("scales drum rows and note velocities toward ghosts at low energy", () => {
    const dark = applyEnergy(fixtureDoc(), DARK_LEVEL) as unknown as {
      patterns: Array<{ rows: Record<string, number[]>; notes: Record<string, Array<{ velocity: number }>> }>;
    };
    const f = energyVelocityFactor(DARK_LEVEL);
    expect(dark.patterns[0].rows.pad1[0]).toBeCloseTo(1 * f, 5);
    expect(dark.patterns[0].rows.pad1[3]).toBeCloseTo(0.25 * f, 5);
    expect(dark.patterns[0].notes["track-bass"][0].velocity).toBeCloseTo(0.9 * f, 5);
  });

  it("leaves velocities untouched at full energy", () => {
    const bright = applyEnergy(fixtureDoc(), BRIGHT_LEVEL) as unknown as {
      patterns: Array<{ rows: Record<string, number[]> }>;
    };
    expect(bright.patterns[0].rows.pad1).toEqual([1, 0.5, 0, 0.25]);
  });

  it("applies per-family gains and skips the group bus", () => {
    const dark = applyEnergy(fixtureDoc(), DARK_LEVEL) as unknown as {
      tracks: Array<{ id: string; gain: number }>;
    };
    const byId = Object.fromEntries(dark.tracks.map((t) => [t.id, t.gain]));
    expect(byId["track-drum"]).toBeCloseTo(energyGainFactor("drums", DARK_LEVEL), 5);
    expect(byId["track-bass"]).toBeCloseTo(energyGainFactor("bass", DARK_LEVEL), 5);
    expect(byId["track-fx"]).toBeCloseTo(energyGainFactor("fx", DARK_LEVEL), 5);
    expect(byId["track-bus"]).toBe(1);
  });

  it("clamps scaled velocities into 0..1", () => {
    const dark = applyEnergy(fixtureDoc(), DARK_LEVEL) as unknown as {
      patterns: Array<{ notes: Record<string, Array<{ velocity: number }>> }>;
    };
    for (const note of dark.patterns[0].notes["track-bass"]) {
      expect(note.velocity).toBeGreaterThanOrEqual(0);
      expect(note.velocity).toBeLessThanOrEqual(1);
    }
  });
});

describe("embed energy — authored rig rides its own rig", () => {
  it("pins scene intensity to the level and scales curves instead of touching velocities", () => {
    const doc = rigDoc();
    (doc.scenes[0] as { intensityCurve?: Array<{ offset: number; value: number }> }).intensityCurve = [
      { offset: 0, value: 0.4 },
      { offset: 1920, value: 1 },
    ];
    const dark = applyEnergy(doc, DARK_LEVEL) as unknown as {
      scenes: Array<{ intensity: number; intensityCurve: Array<{ value: number }> }>;
      patterns: Array<{ rows: Record<string, number[]> }>;
      tracks: Array<{ id: string; gain: number }>;
    };
    expect(dark.scenes[0].intensity).toBeCloseTo(DARK_LEVEL, 5);
    expect(dark.scenes[0].intensityCurve[0].value).toBeCloseTo(0.4 * DARK_LEVEL, 5);
    expect(dark.scenes[0].intensityCurve[1].value).toBeCloseTo(1 * DARK_LEVEL, 5);
    expect(dark.patterns[0].rows.pad1).toEqual([1, 0.5, 0, 0.25]);
    expect(dark.tracks[0].gain).toBe(1);
  });

  it("detects rigs from intensity mappings and curves, not from static intensity alone", () => {
    expect(hasAuthoredRig(fixtureDoc())).toBe(false);
    expect(hasAuthoredRig(rigDoc())).toBe(true);
    const curved = fixtureDoc();
    (curved.scenes[0] as { intensityCurve?: unknown[] }).intensityCurve = [{ offset: 0, value: 0.5 }];
    expect(hasAuthoredRig(curved)).toBe(true);
  });
});

describe("embed energy — crossfade weights", () => {
  it("maps the anchors exactly", () => {
    expect(energyWeights(0)[0]).toBe(1);
    expect(energyWeights(0)[1]).toBe(0);
    expect(energyWeights(0.5)[0]).toBeCloseTo(0, 12);
    expect(energyWeights(0.5)[1]).toBe(1);
    expect(energyWeights(0.5)[2]).toBe(0);
    expect(energyWeights(1)[0]).toBe(0);
    expect(energyWeights(1)[1]).toBeCloseTo(0, 12);
    expect(energyWeights(1)[2]).toBe(1);
  });

  it("crossfades only adjacent variants with an equal-power curve", () => {
    const [d, a] = energyWeights(0.25);
    expect(d).toBeCloseTo(Math.cos(Math.PI / 4), 5);
    expect(a).toBeCloseTo(Math.sin(Math.PI / 4), 5);
    expect(energyWeights(0.25)[2]).toBe(0);
    expect(energyWeights(0.75)[0]).toBe(0);
    // Constant total power across the blend.
    const [w0, w1] = energyWeights(0.3);
    expect(w0 * w0 + w1 * w1).toBeCloseTo(1, 5);
  });

  it("clamps out-of-range positions", () => {
    expect(energyWeights(-3)[0]).toBe(1);
    expect(energyWeights(9)[2]).toBe(1);
  });
});

describe("embed energy — deep-linked initial energy", () => {
  it("reads the e percent from the share hash", () => {
    expect(initialEnergyFromHash("#p=CODE&e=73")).toBeCloseTo(0.73, 6);
    expect(initialEnergyFromHash("#p=CODE&e=0")).toBe(0);
    expect(initialEnergyFromHash("#p=CODE&e=100")).toBe(1);
    expect(initialEnergyFromHash("#p=CODE&e=12.5")).toBeCloseTo(0.125, 6);
  });

  it("degrades to the authored default on junk — the URL never breaks the player", () => {
    expect(initialEnergyFromHash("#p=CODE")).toBe(0.5);
    expect(initialEnergyFromHash("#p=CODE&e=")).toBe(0.5);
    expect(initialEnergyFromHash("#p=CODE&e=loud")).toBe(0.5);
    expect(initialEnergyFromHash("#p=CODE&e=-40")).toBe(0);
    expect(initialEnergyFromHash("#p=CODE&e=999")).toBe(1);
    expect(initialEnergyFromHash("")).toBe(0.5);
  });
});

describe("embed energy — postMessage command parser", () => {
  it("parses the kyx:* namespace", () => {
    expect(parseEmbedCommand({ type: "kyx:energy", value: 0.7 })).toEqual({ kind: "energy", value: 0.7 });
    expect(parseEmbedCommand({ type: "kyx:play" })).toEqual({ kind: "play" });
    expect(parseEmbedCommand({ type: "kyx:pause" })).toEqual({ kind: "pause" });
    expect(parseEmbedCommand({ type: "kyx:toggle" })).toEqual({ kind: "toggle" });
    expect(parseEmbedCommand({ type: "kyx:seek", value: 0.5 })).toEqual({ kind: "seek", value: 0.5 });
    expect(parseEmbedCommand({ type: "kyx:get-state" })).toEqual({ kind: "getState" });
  });

  it("coerces numeric strings and rejects junk without throwing", () => {
    expect(parseEmbedCommand({ type: "kyx:energy", value: "0.3" })).toEqual({ kind: "energy", value: 0.3 });
    expect(parseEmbedCommand({ type: "kyx:energy" })).toBeNull();
    expect(parseEmbedCommand({ type: "kyx:energy", value: "loud" })).toBeNull();
    expect(parseEmbedCommand({ type: "webpack:ok" })).toBeNull();
    expect(parseEmbedCommand("hello")).toBeNull();
    expect(parseEmbedCommand(null)).toBeNull();
    expect(parseEmbedCommand(42)).toBeNull();
    expect(parseEmbedCommand(undefined)).toBeNull();
  });
});
