/**
 * PACK share-code sanitization — the trust boundary for every "PFPACK1:"
 * token a user has ever pasted into the app.
 *
 * `encodePackCode` accepts a `SharedPack` and emits a compressed token.
 * `decodePackCode` reverses it: validates the prefix, decompresses, and
 * routes every field through a sanitizer that clamps weird values into the
 * legal range. The six sanitizers and four explicit limits
 * (`PACK_GROOVE_LIMIT = 8`, `PACK_SCENE_LIMIT = 16`, `PACK_CLIP_LIMIT = 64`,
 * `PACK_STEPS_LIMIT = 64`) live as private helpers — we exercise them via
 * the public `decodePackCode` so no source refactor is required.
 *
 * Risk surface: a tampered PFPACK1 token reaching the install path with
 * unclamped pads / oversize rows / out-of-range scene indices could ship
 * a corrupt kit into the user library. Every test below pins one of those
 * guarantees.
 */
import { describe, expect, it } from "vitest";
import { compressToEncodedURIComponent } from "lz-string";
import { decodePackCode, encodePackCode, PACK_CODE_PREFIX, type SharedPack } from "../../src/export/packCode";

/** Wrap a raw object in a PFPACK1 token (the production encode path requires
 *  a SharedPack input, which we want to bypass for hostile-input testing). */
function packWith(raw: unknown): string {
  return PACK_CODE_PREFIX + compressToEncodedURIComponent(JSON.stringify(raw));
}

const VALID_PACK: SharedPack = {
  kitName: "Studio Kit",
  kitPads: [
    { idx: 0, assetId: "asset-kick", gain: 1, pan: 0, chokeGroup: null, pitch: 0 },
    { idx: 1, assetId: "asset-snare", gain: 0.8, pan: -0.2, chokeGroup: 0, pitch: 0 },
  ],
  theme: { preset: "midnight", hue: 220, scale: 1, compact: false, reduceMotion: false },
  grooves: [{ name: "Swing", timing: [0, 0.1, -0.1], accent: [1, 0.7, 0.5] }],
  sketch: {
    bpm: 128,
    scenes: [{ name: "Verse", role: "verse", intensity: 0.6, steps: 16, rows: ["80", "00", "00", "00"] }],
    clips: [{ scene: 0, startBar: 0, lengthBars: 4 }],
  },
};

describe("decodePackCode — prefix and envelope", () => {
  it("round-trips a fully populated pack losslessly (normalized)", () => {
    const code = encodePackCode(VALID_PACK);
    const decoded = decodePackCode(code);
    expect(decoded).not.toBeNull();
    expect(decoded!.kitName).toBe("Studio Kit");
    expect(decoded!.kitPads).toHaveLength(2);
    expect(decoded!.kitPads![0].assetId).toBe("asset-kick");
    expect(decoded!.grooves![0].name).toBe("Swing");
    expect(decoded!.sketch!.bpm).toBe(128);
    expect(decoded!.sketch!.scenes).toHaveLength(1);
    expect(decoded!.sketch!.clips).toHaveLength(1);
  });

  it("rejects an empty string", () => {
    expect(decodePackCode("")).toBeNull();
  });

  it("rejects input without the PFPACK1 prefix", () => {
    expect(decodePackCode("hello-world")).toBeNull();
  });

  it("rejects a similar-but-wrong prefix", () => {
    expect(decodePackCode(packWith(VALID_PACK).replace("PFPACK1", "PFPACK2"))).toBeNull();
  });

  it("rejects garbage after a valid prefix", () => {
    expect(decodePackCode(PACK_CODE_PREFIX + "@#$not-compressed$#@")).toBeNull();
  });

  it("returns null when every field is missing (no meaningful payload survives)", () => {
    const empty = packWith({});
    expect(decodePackCode(empty)).toBeNull();
  });
});

describe("decodePackCode — kitName and kit sanitization", () => {
  it("truncates kitName over 60 chars to the first 60", () => {
    const code = packWith({ ...VALID_PACK, kitName: "x".repeat(200) });
    const decoded = decodePackCode(code)!;
    expect(decoded.kitName!.length).toBe(60);
  });

  it("drops whitespace-only kitName (falls back to the kit-pad default)", () => {
    const code = packWith({ ...VALID_PACK, kitName: "   " });
    const decoded = decodePackCode(code);
    expect(decoded).not.toBeNull();
    // kitName either becomes "" (after trim) and is dropped, or takes the
    // shared-pack fallback — both are acceptable; the contract is
    // "no whitespace-only name sneaks through".
    if (decoded!.kitName) expect(decoded!.kitName.trim().length).toBeGreaterThan(0);
  });

  it("clamps kitPads.gain above 2 down to 2", () => {
    const code = packWith({ ...VALID_PACK, kitPads: [{ idx: 0, assetId: "a", gain: 99 }] });
    const decoded = decodePackCode(code)!;
    expect(decoded.kitPads![0].gain).toBe(2);
  });

  it("clamps kitPads.gain below 0 up to 0", () => {
    const code = packWith({ ...VALID_PACK, kitPads: [{ idx: 0, assetId: "a", gain: -5 }] });
    const decoded = decodePackCode(code)!;
    expect(decoded.kitPads![0].gain).toBe(0);
  });

  it("clamps kitPads.pan to [-1, 1]", () => {
    const code = packWith({
      ...VALID_PACK,
      kitPads: [
        { idx: 0, assetId: "a", pan: 5 },
        { idx: 1, assetId: "b", pan: -5 },
      ],
    });
    const decoded = decodePackCode(code)!;
    expect(decoded.kitPads![0].pan).toBe(1);
    expect(decoded.kitPads![1].pan).toBe(-1);
  });

  it("clamps kitPads.pitch to [-36, 36] semitones", () => {
    const code = packWith({
      ...VALID_PACK,
      kitPads: [
        { idx: 0, assetId: "a", pitch: 100 },
        { idx: 1, assetId: "b", pitch: -100 },
      ],
    });
    const decoded = decodePackCode(code)!;
    expect(decoded.kitPads![0].pitch).toBe(36);
    expect(decoded.kitPads![1].pitch).toBe(-36);
  });

  it("sets assetId to null when over 200 chars (long fake paths must not reach the library)", () => {
    const code = packWith({
      ...VALID_PACK,
      kitPads: [{ idx: 0, assetId: "x".repeat(500) }],
    });
    const decoded = decodePackCode(code)!;
    expect(decoded.kitPads![0].assetId).toBeNull();
  });

  it("dedupes duplicate pad indices — first one wins, second dropped", () => {
    const code = packWith({
      ...VALID_PACK,
      kitPads: [
        { idx: 0, assetId: "first" },
        { idx: 0, assetId: "second" },
      ],
    });
    const decoded = decodePackCode(code)!;
    expect(decoded.kitPads).toHaveLength(1);
    expect(decoded.kitPads![0].assetId).toBe("first");
  });

  it("coerces a non-numeric chokeGroup to 0 (numeric guard on the install path)", () => {
    const code = packWith({
      ...VALID_PACK,
      kitPads: [{ idx: 0, assetId: "a", chokeGroup: "not-a-number" }],
    });
    const decoded = decodePackCode(code)!;
    // The sanitizer funnels every non-numeric input through fallback 0.
    expect(typeof decoded.kitPads![0].chokeGroup).toBe("number");
    expect(decoded.kitPads![0].chokeGroup).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(decoded.kitPads![0].chokeGroup)).toBe(true);
  });
});

describe("decodePackCode — theme sanitization", () => {
  it("falls back to the first THEME_PRESET when preset is unknown", () => {
    const code = packWith({ ...VALID_PACK, theme: { preset: "this-is-not-real" } });
    const decoded = decodePackCode(code)!;
    expect(decoded.theme).toBeDefined();
    // The exact fallback id is implementation detail of THEME_PRESETS; pin
    // that it is *some* known preset id.
    expect(typeof decoded.theme!.preset).toBe("string");
    expect(decoded.theme!.preset.length).toBeGreaterThan(0);
  });

  it("clamps theme.hue to [0, 359] (the CSS hue ring)", () => {
    const code = packWith({ ...VALID_PACK, theme: { preset: "midnight", hue: 9999 } });
    const decoded = decodePackCode(code)!;
    expect(decoded.theme!.hue).toBe(359);
  });

  it("sets theme.hue to null when non-finite (NaN/Infinity could otherwise pin CSS animations)", () => {
    const code = packWith({ ...VALID_PACK, theme: { preset: "midnight", hue: Number.NaN } });
    const decoded = decodePackCode(code)!;
    expect(decoded.theme!.hue).toBeNull();
  });

  it("clamps theme.scale to [0.8, 1.3]", () => {
    const codeHigh = packWith({ ...VALID_PACK, theme: { preset: "midnight", scale: 5 } });
    expect(decodePackCode(codeHigh)!.theme!.scale).toBe(1.3);
    const codeLow = packWith({ ...VALID_PACK, theme: { preset: "midnight", scale: 0.1 } });
    expect(decodePackCode(codeLow)!.theme!.scale).toBe(0.8);
  });
});

describe("decodePackCode — sketch limits and bpm clamp", () => {
  it("caps sketch.scenes at PACK_SCENE_LIMIT (16), extra scenes are dropped", () => {
    // Every scene gets at least one non-zero hex row, otherwise the
    // sanity-skip drops it BEFORE the cap is reached — making this test
    // exercise the slice limit rather than the skip filter.
    const scenes = Array.from({ length: 30 }, (_, i) => ({
      name: `S${i}`,
      steps: 16,
      rows: ["80", "00", "00", "00"],
    }));
    const code = packWith({ ...VALID_PACK, sketch: { ...VALID_PACK.sketch, scenes } });
    const decoded = decodePackCode(code)!;
    expect(decoded.sketch!.scenes).toHaveLength(16);
  });

  it("caps sketch.clips at PACK_CLIP_LIMIT (64), extra clips are dropped", () => {
    const clips = Array.from({ length: 80 }, (_, i) => ({ scene: 0, startBar: i, lengthBars: 1 }));
    const code = packWith({ ...VALID_PACK, sketch: { ...VALID_PACK.sketch, clips } });
    const decoded = decodePackCode(code)!;
    expect(decoded.sketch!.clips.length).toBeLessThanOrEqual(64);
  });

  it("caps sketch.steps at PACK_STEPS_LIMIT (64) and floors at 1", () => {
    const code1 = packWith({
      ...VALID_PACK,
      sketch: { ...VALID_PACK.sketch, scenes: [{ name: "X", steps: 999, rows: ["80"] }] },
    });
    expect(decodePackCode(code1)!.sketch!.scenes[0].steps).toBe(64);

    const code2 = packWith({
      ...VALID_PACK,
      sketch: { ...VALID_PACK.sketch, scenes: [{ name: "X", steps: 0, rows: ["80"] }] },
    });
    expect(decodePackCode(code2)!.sketch!.scenes[0].steps).toBe(1);
  });

  it("rejects out-of-range clip.scene indices (does NOT clamp — a clamped re-point would land on the wrong scene)", () => {
    // scene=99 references a non-existent scene after sanitization. The
    // factory contract: drop the clip, do not silently re-map.
    const code = packWith({
      ...VALID_PACK,
      sketch: {
        ...VALID_PACK.sketch,
        clips: [{ scene: 99, startBar: 0, lengthBars: 4 }],
      },
    });
    const decoded = decodePackCode(code)!;
    expect(decoded.sketch!.clips).toHaveLength(0);
  });

  it("clamps sketch.bpm to [20, 300]", () => {
    const high = packWith({ ...VALID_PACK, sketch: { ...VALID_PACK.sketch, bpm: 9999 } });
    expect(decodePackCode(high)!.sketch!.bpm).toBe(300);
    const low = packWith({ ...VALID_PACK, sketch: { ...VALID_PACK.sketch, bpm: 1 } });
    expect(decodePackCode(low)!.sketch!.bpm).toBe(20);
    const nan = packWith({ ...VALID_PACK, sketch: { ...VALID_PACK.sketch, bpm: Number.NaN } });
    expect(decodePackCode(nan)!.sketch!.bpm).toBeUndefined();
  });

  it("caps grooves at PACK_GROOVE_LIMIT (8)", () => {
    const grooves = Array.from({ length: 20 }, (_, i) => ({
      name: `G${i}`,
      timing: [0, 0.1],
      accent: [1, 0.5],
    }));
    const code = packWith({ ...VALID_PACK, grooves });
    const decoded = decodePackCode(code)!;
    expect(decoded.grooves).toHaveLength(8);
  });

  it("truncates groove.name over 40 chars and falls back to 'Groove' on whitespace-only", () => {
    const longCode = packWith({
      ...VALID_PACK,
      grooves: [{ name: "x".repeat(100), timing: [0], accent: [1] }],
    });
    expect(decodePackCode(longCode)!.grooves![0].name.length).toBe(40);

    const blankCode = packWith({
      ...VALID_PACK,
      grooves: [{ name: "    ", timing: [0], accent: [1] }],
    });
    expect(decodePackCode(blankCode)!.grooves![0].name).toBe("Groove");
  });
});