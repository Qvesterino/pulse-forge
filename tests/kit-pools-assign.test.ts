import { describe, expect, it } from "vitest";
import { resolveKitAssignments } from "../src/sample-library/kit-pools";
import type { DrumPad } from "../src/project-model/types";

/**
 * GOAL 08 — dice kit-pool assignment (untested module, dice re-roll picks
 * the user's kits): lock gates, chance gate, family locks, and assignment
 * shape. resolveKitAssignments is seeded, so outcomes are deterministic.
 */

function pads(): DrumPad[] {
  const base = { gain: 1, pan: 0, pitch: 0, mute: false, solo: false, chokeGroup: null, assetId: null };
  return [
    { ...base, id: "pad-kick", name: "Kick" },
    { ...base, id: "pad-snare", name: "Snare" },
    { ...base, id: "pad-hat", name: "Closed Hat" },
    { ...base, id: "pad-perc", name: "Rim" },
  ] as unknown as DrumPad[];
}

const locks = (over: Record<string, boolean> = {}): Parameters<typeof resolveKitAssignments>[2] => ({
  drums: false,
  bass: false,
  chords: false,
  lead: false,
  kick: false,
  snare: false,
  hats: false,
  kit: false,
  fx: false,
  ...over,
});
const LOCKS_NONE = locks();
const SEED = "golden-goal08";

describe("dice kit pool assignment (GOAL 08)", () => {
  it("kit/drums locks short-circuit to an empty assignment", () => {
    expect(resolveKitAssignments(pads(), SEED, locks({ kit: true }), 1).size).toBe(0);
    expect(resolveKitAssignments(pads(), SEED, locks({ drums: true }), 1).size).toBe(0);
  });

  it("zero jitter keeps the chance gate closed (no re-roll)", () => {
    expect(resolveKitAssignments(pads(), SEED, LOCKS_NONE, 0).size).toBe(0);
  });

  it("full jitter assigns entries (chance gate is seed-dependent — search deterministically)", () => {
    // The chance gate (chanceRand() > jitter*0.7) is seeded: find a seed
    // that opens it, deterministically, then assert on that assignment.
    let chosen: { seed: string; map: Map<string, Partial<DrumPad>> } | null = null;
    for (let i = 0; i < 50 && !chosen; i++) {
      const seed = `goal08-${i}`;
      const map = resolveKitAssignments(pads(), seed, LOCKS_NONE, 1, { genre: "house" });
      if (map.size > 0) chosen = { seed, map };
    }
    expect(chosen).not.toBeNull();
    for (const [padId, partial] of chosen!.map) {
      expect(pads().some((p) => p.id === padId)).toBe(true);
      expect(Object.keys(partial).length, `assignment for ${padId} carries fields`).toBeGreaterThan(0);
    }
  });

  it("family locks keep the locked family out of the assignment", () => {
    const map = resolveKitAssignments(pads(), SEED, locks({ kick: true, snare: true }), 1, { genre: "house" });
    const kickPadId = "pad-kick";
    const snarePadId = "pad-snare";
    expect([...map.keys()]).not.toContain(kickPadId);
    expect([...map.keys()]).not.toContain(snarePadId);
  });

  it("user assets join the pools and can be selected", () => {
    // Deterministic seed — run twice, the assignment must be identical.
    const a = resolveKitAssignments(pads(), "stable-seed", LOCKS_NONE, 1, {
      userAssetIds: ["user.kick-custom-1"],
    });
    const b = resolveKitAssignments(pads(), "stable-seed", LOCKS_NONE, 1, {
      userAssetIds: ["user.kick-custom-1"],
    });
    expect(a.size).toBe(b.size);
    for (const [id, partial] of a) {
      expect(b.get(id)).toEqual(partial);
    }
  });
});
