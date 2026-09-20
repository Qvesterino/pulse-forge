import { describe, it, expect } from "vitest";
import { nextSeed, seedAt, jitterControls, pickStyle, throwDice } from "../src/shared/dice";
import type { IntentControls } from "../src/intent/types";
import {
  applyDiceFxToDoc,
  clearDiceFx,
  DEFAULT_DICE_LOCKS,
  DICE_FX_CARDS,
  diceFxInstanceId,
  pickDiceFx,
} from "../src/intent/dice";
import { createProjectFromTemplate } from "../src/project-model/templates";

describe("dice core", () => {
  it("nextSeed is deterministic", () => {
    expect(nextSeed("abc")).toBe(nextSeed("abc"));
    expect(nextSeed("abc", "dice")).toBe(nextSeed("abc", "dice"));
  });
  it("nextSeed varies with salt and input", () => {
    expect(nextSeed("abc")).not.toBe(nextSeed("abc", "other"));
    expect(nextSeed("abc")).not.toBe(nextSeed("xyz"));
  });
  it("nextSeed produces 6-char base36", () => {
    for (let i = 0; i < 20; i++) {
      const s = nextSeed(`seed-${i}`);
      expect(s).toMatch(/^[0-9a-z]{6}$/);
    }
  });
  it("seedAt advances deterministically", () => {
    expect(seedAt("root", 0)).toBe("root");
    expect(seedAt("root", 1)).toBe(nextSeed("root"));
    expect(seedAt("root", 3)).toBe(nextSeed(nextSeed(nextSeed("root"))));
    // 100-step chain is stable
    const chain: string[] = ["start"];
    for (let i = 0; i < 100; i++) chain.push(nextSeed(chain[chain.length - 1]));
    expect(seedAt("start", 100)).toBe(chain[chain.length - 1]);
  });
  it("jitterControls is identity at 0", () => {
    const base: IntentControls = { ghostWeight: 0.3, microWeight: 0.2, velocityVariation: 0.3, temperature: 1.0 };
    expect(jitterControls("seed", base, 0)).toEqual(base);
  });
  it("jitterControls stays in bounds at amount=1", () => {
    const base: IntentControls = { ghostWeight: 0.5, microWeight: 0.5, velocityVariation: 0.5, temperature: 1.0 };
    for (let i = 0; i < 50; i++) {
      const j = jitterControls(`seed-${i}`, base, 1);
      expect(j.ghostWeight).toBeGreaterThanOrEqual(0);
      expect(j.ghostWeight).toBeLessThanOrEqual(1);
      expect(j.microWeight).toBeGreaterThanOrEqual(0);
      expect(j.microWeight).toBeLessThanOrEqual(1);
      expect(j.velocityVariation).toBeGreaterThanOrEqual(0);
      expect(j.velocityVariation).toBeLessThanOrEqual(1);
      expect(j.temperature).toBeGreaterThanOrEqual(0.2);
      expect(j.temperature).toBeLessThanOrEqual(2);
    }
  });
  it("jitterControls is deterministic", () => {
    const base: IntentControls = { ghostWeight: 0.3, microWeight: 0.2, velocityVariation: 0.3, temperature: 1.0 };
    expect(jitterControls("hello", base, 0.5)).toEqual(jitterControls("hello", base, 0.5));
    expect(jitterControls("hello", base, 0.5)).not.toEqual(jitterControls("world", base, 0.5));
  });
  it("pickStyle is deterministic and valid", () => {
    const s1 = pickStyle("seed1", "house", null);
    const s2 = pickStyle("seed1", "house", null);
    expect(s1).toBe(s2);
    if (s1) expect(typeof s1).toBe("string");
  });
  it("throwDice value in range and deterministic", () => {
    const a = throwDice("seedA", 6);
    const b = throwDice("seedA", 6);
    expect(a.value).toBe(b.value);
    expect(a.value).toBeGreaterThanOrEqual(1);
    expect(a.value).toBeLessThanOrEqual(6);
    expect(a.nextSeed).toBe(nextSeed("seedA", `throw:${a.value}`));
  });
});

describe("DICE FX cards", () => {
  it("selects a stable card per seed and respects the FX lock", () => {
    const seed = Array.from({ length: 1000 }, (_, i) => `dice-${i}`).find((value) => pickDiceFx(value, DEFAULT_DICE_LOCKS));
    expect(seed).toBeDefined();
    const card = pickDiceFx(seed!, DEFAULT_DICE_LOCKS);
    expect(card).not.toBeNull();
    expect(pickDiceFx(seed!, DEFAULT_DICE_LOCKS)).toEqual(card);
    expect(pickDiceFx(seed!, { ...DEFAULT_DICE_LOCKS, fx: true })).toBeNull();
  });

  it("replaces only its managed slot on the target drum track and clears without touching user FX", () => {
    const source = createProjectFromTemplate("house");
    const drum = source.tracks.find((track) => track.kind === "drum");
    expect(drum).toBeDefined();
    if (!drum || drum.kind !== "drum") return;
    const secondDrum = { ...drum, id: "drum-secondary", name: "Secondary drums", effects: [] };
    const userFx = { id: "user-eq", type: "eq" as const, bypassed: false, params: { lowGain: 1 } };
    const doc = {
      ...source,
      tracks: source.tracks.map((track) => (track.id === drum.id ? { ...track, effects: [userFx] } : track)).concat(secondDrum),
    };

    const first = applyDiceFxToDoc(doc, DICE_FX_CARDS[0], drum.id);
    const firstDrum = first.tracks.find((track) => track.id === drum.id);
    const untouchedDrum = first.tracks.find((track) => track.id === secondDrum.id);
    expect(firstDrum?.effects).toHaveLength(2);
    expect(firstDrum?.effects[0]).toEqual(userFx);
    expect(firstDrum?.effects[1].id).toBe(diceFxInstanceId(DICE_FX_CARDS[0]));
    expect(untouchedDrum?.effects).toEqual([]);

    const replaced = applyDiceFxToDoc(first, DICE_FX_CARDS[1], drum.id);
    expect(replaced.tracks.find((track) => track.id === drum.id)?.effects).toHaveLength(2);
    expect(replaced.tracks.find((track) => track.id === drum.id)?.effects[1].id).toBe(diceFxInstanceId(DICE_FX_CARDS[1]));

    const cleared = clearDiceFx(replaced, drum.id);
    expect(cleared.tracks.find((track) => track.id === drum.id)?.effects).toEqual([userFx]);
    expect(cleared.tracks.find((track) => track.id === secondDrum.id)?.effects).toEqual([]);
  });

  it("is a no-op when the target drum track is missing", () => {
    const project = createProjectFromTemplate("house");
    const doc = { ...project, tracks: project.tracks.filter((track) => track.kind !== "drum") };
    expect(applyDiceFxToDoc(doc, DICE_FX_CARDS[0])).toBe(doc);
    expect(clearDiceFx(doc)).toBe(doc);
  });
});
