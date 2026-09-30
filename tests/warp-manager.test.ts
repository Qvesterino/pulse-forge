import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WarpManager, STRETCH_CACHE_LIMIT, WARP_CACHE_LIMIT } from "../src/audio-engine/warpManager";
import type { WarpManagerDeps } from "../src/audio-engine/warpManager";
import { frozenPlaybackOffset } from "../src/audio-engine/warpManager";

/**
 * Wave 4e (AudioEngine decomposition) — WarpManager pins.
 *
 * The stretch LRU, the pitch-preserving warp pre-render cache (with
 * in-flight claims + the invalidation epoch) and frozen-track playback
 * moved verbatim out of AudioEngine.ts. Load-bearing invariants: the
 * facade law, both LRU policies, the project-swap/context-swap
 * invalidation contracts, and the frozen single-creation-path law.
 */

const MANAGER = resolve(process.cwd(), "src/audio-engine/warpManager.ts");
const ENGINE = resolve(process.cwd(), "src/audio-engine/AudioEngine.ts");

function makeDeps(overrides: Partial<WarpManagerDeps> = {}): WarpManagerDeps {
  return {
    ctx: () => null,
    doc: () => null,
    bank: () => null,
    trackInput: () => null,
    ...overrides,
  };
}

describe("WarpManager (Wave 4e)", () => {
  it("facade law: never imports AudioEngine", () => {
    const src = readFileSync(MANAGER, "utf8");
    expect(/from\s+"\.\/AudioEngine"/.test(src)).toBe(false);
    expect(/from\s+"[^"]*audio-engine\/AudioEngine"/.test(src)).toBe(false);
  });

  it("stretch LRU: re-insert refreshes, oldest evicted at the limit", () => {
    const mgr = new WarpManager(makeDeps());
    const buf = {} as AudioBuffer;
    for (let i = 0; i < STRETCH_CACHE_LIMIT; i++) mgr.storeStretched(`k${i}`, buf);
    expect(mgr.getStretched("k0")).toBeDefined(); // full, k0 oldest
    mgr.storeStretched("k0", buf); // re-insert refreshes k0 to newest
    mgr.storeStretched("k-new", buf); // evicts k1 (oldest), not k0
    expect(mgr.getStretched("k0")).toBeDefined();
    expect(mgr.getStretched("k1")).toBeUndefined();
    expect(mgr.getStretched("k-new")).toBeDefined();
  });

  it("syncProjectId invalidates caches + bumps the epoch ONLY on a real change", () => {
    const mgr = new WarpManager(makeDeps());
    expect(mgr.syncProjectId("p1")).toBe(true);
    expect(mgr.syncProjectId("p1")).toBe(false); // same project — no invalidation
    expect(mgr.syncProjectId("p2")).toBe(true);
  });

  it("invalidateForContextSwap clears caches and orphans in-flight renders via the epoch", () => {
    const src = readFileSync(MANAGER, "utf8");
    expect(src).toMatch(/invalidateForContextSwap\(\): void \{[^}]*stretchCache\.clear\(\)[^}]*warpEpoch\+\+/s);
  });

  it("frozen sources: single creation path + hard dispose with stopAt", () => {
    const src = readFileSync(MANAGER, "utf8");
    // restartFrozenSources is the ONLY place that creates frozen BufferSources.
    const createCount = (src.match(/createBufferSource\(\)/g) ?? []).length;
    expect(createCount).toBe(1);
    expect(src).toMatch(/disposeAllFrozen\(stopAt\?: number\)/);
  });

  it("engine keeps the surface as delegates (no stale cache fields)", () => {
    const src = readFileSync(ENGINE, "utf8");
    for (const marker of [
      "restartFrozenSources(positionTick: number): void {\n    this.warpManager.restartFrozenSources(positionTick);",
      "precomputeWarpSync(clip: AudioClip, wallSec: number): AudioBuffer | null {\n    return this.warpManager.precomputeWarpSync(clip, wallSec);",
      "warmWarpForClip(clip: AudioClip): void {\n    this.warpManager.warmWarpForClip(clip);",
      "this.warpManager.invalidateForContextSwap();",
      "this.warpManager.syncProjectId(target.id)",
    ]) {
      expect(src.includes(marker), `missing: ${marker}`).toBe(true);
    }
    for (const gone of [
      "private stretchCache = new Map",
      "private warpCache = new Map",
      "private warpInflight = new Set",
      "private warpEpoch = 0",
      "private frozenBuffers = new Map",
    ]) {
      expect(src.includes(gone), `stale engine field: ${gone}`).toBe(false);
    }
  });

  it("frozenPlaybackOffset math survived the move (re-export contract)", () => {
    expect(frozenPlaybackOffset(0, 120, 10)).toBe(0);
    expect(frozenPlaybackOffset(960, 120, 10)).toBeCloseTo(1, 6);
    expect(frozenPlaybackOffset(2880, 120, 2)).toBeCloseTo(1, 6); // 3.0 s wraps to 1.0 s in a 2 s loop
    expect(frozenPlaybackOffset(0, 120, 0)).toBe(0);
  });

  it("cache limits unchanged (pinned constants)", () => {
    expect(STRETCH_CACHE_LIMIT).toBe(48);
    expect(WARP_CACHE_LIMIT).toBe(6);
  });
});
