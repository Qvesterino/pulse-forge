/**
 * `uid()` collision + determinism contract.
 *
 * Every project-model entity (track, pattern, scene, clip, automation lane,
 * layer) is keyed by a `uid(prefix)` string. Two failure modes matter and
 * neither is caught by a single-assertion unit test:
 *
 *   1. **Collision** — two live entities share an id. The first `find(t =>
 *      t.id === id)` in the store wins, so a collision silently mutates the
 *      wrong track instead of throwing. This is silent data corruption, and it
 *      only shows up as "the wrong thing got edited".
 *   2. **Cross-namespace collision** — `uid("track")` and `uid("scene")` are
 *      different namespaces on purpose, but a *shared* suffix leaking across
 *      them (e.g. a stubbed `crypto.randomUUID`) would let a track id resolve
 *      inside a scene lookup.
 *
 * The production path is `crypto.randomUUID()` (122 bits of entropy); the
 * fallback is `Math.random().toString(36).slice(2) + Date.now().toString(36)`.
 * In jsdom `crypto.randomUUID` exists, so the fallback is what needs an
 * explicit test — a browser without WebCrypto (very old Safari, some
 * embedded webviews) takes that branch and its weaker entropy is the actual
 * collision risk surface.
 *
 * The deterministic mode is pinned separately: it backs snapshot diffability
 * across test files, so a change to its format would churn unrelated golden
 * files. Both the format and the monotonic counter are asserted.
 */

import { afterEach, describe, expect, it } from "vitest";
import { clamp, resetDeterministicIds, uid, useDeterministicIds } from "../../src/shared/ids";

/** Run `fn` with `crypto.randomUUID` absent, exercising the fallback branch. */
function withoutCryptoUUID<T>(fn: () => T): T {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { ...original, randomUUID: undefined },
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: original });
  }
}

describe("shared/ids — collision contract", () => {
  it("emits 20 000 unique ids under the production crypto path", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(uid("track"));
    expect(seen.size).toBe(20_000);
  });

  it("emits 20 000 unique ids under the Math.random fallback path", () => {
    const seen = withoutCryptoUUID(() => {
      const ids = new Set<string>();
      for (let i = 0; i < 20_000; i++) ids.add(uid("scene"));
      return ids;
    });
    // 20 000 ids from a ~52-bit Math.random space. A collision here means the
    // fallback stopped randomising, which is a real corruption bug, not a
    // flake — the birthday bound puts the expected collision count near 0.
    expect(seen.size).toBe(20_000);
  });

  it("keeps namespaces distinct — a track id never equals a scene id", () => {
    const track = uid("track");
    const scene = uid("scene");
    expect(track).not.toBe(scene);
    expect(track.startsWith("track-")).toBe(true);
    expect(scene.startsWith("scene-")).toBe(true);
  });

  it("prefixes the id exactly once even for hyphenated namespaces", () => {
    // Prefixes in the codebase are bare (`track`, `scene`), but a future
    // namespace like `audio-clip` must not produce a raw id that itself
    // carries a dash the consumer might re-split on. crypto.randomUUID is
    // dash-separated, so the contract worth pinning is: the part after the
    // prefix is the raw id, verbatim.
    const id = uid("audio-clip");
    expect(id.startsWith("audio-clip-")).toBe(true);
    expect(id.slice("audio-clip-".length)).toBeTruthy();
  });

  it("survives a JSON round-trip without id collisions", () => {
    // Ids ride along in serialized project documents (share codes, IndexedDB
    // snapshots, y-websocket updates). A round-trip that collapsed two ids would
    // mean the encoder is lossy, not that the generator collided.
    const ids = Array.from({ length: 2000 }, () => uid("pattern"));
    const roundTripped = JSON.parse(JSON.stringify(ids)) as string[];
    expect(new Set(roundTripped).size).toBe(2000);
    expect(roundTripped).toEqual(ids);
  });
});

describe("shared/ids — deterministic mode", () => {
  const releases: Array<() => void> = [];

  afterEach(() => {
    while (releases.length) releases.pop()?.();
  });

  it("emits sequential zero-padded ids, sharing one counter across prefixes", () => {
    const release = useDeterministicIds();
    releases.push(release);
    resetDeterministicIds();
    expect(uid("pattern")).toBe("pattern-test-0000");
    expect(uid("pattern")).toBe("pattern-test-0001");
    expect(uid("track")).toBe("track-test-0002");
  });

  it("continues the counter past a reset instead of rewinding into burned ids", () => {
    const release = useDeterministicIds();
    releases.push(release);
    resetDeterministicIds();
    const first = [uid("p"), uid("p"), uid("p")];
    resetDeterministicIds(100);
    // The point of the reset is to shift the base, not to rewind into already
    // emitted ids — a fixture that emitted twice would otherwise collide.
    expect(uid("p")).toBe("p-test-0100");
    expect(uid("p")).toBe("p-test-0101");
    expect(first).toEqual(["p-test-0000", "p-test-0001", "p-test-0002"]);
  });

  it("grows past four digits without truncating", () => {
    const release = useDeterministicIds();
    releases.push(release);
    resetDeterministicIds(0xffff);
    expect(uid("x")).toBe("x-test-ffff");
    expect(uid("x")).toBe("x-test-10000");
  });

  it("restores random ids once the release function runs", () => {
    const release = useDeterministicIds();
    resetDeterministicIds();
    expect(uid("p")).toBe("p-test-0000");
    release();
    expect(uid("p")).not.toBe("p-test-0001");
  });

  it("numbers in base-36 so the suffix stays compact for long runs", () => {
    // Guards the padStart(4) contract against a decimal switch: base-36 holds
    // the suffix at 4 characters for the first 1 679 616 ids, decimal blows
    // past the field width at 10 000 and would churn every downstream snapshot.
    const release = useDeterministicIds();
    releases.push(release);
    resetDeterministicIds(0);
    for (let i = 0; i < 3; i++) uid("p");
    resetDeterministicIds(36);
    expect(uid("p")).toBe("p-test-0010");
  });
});

describe("shared/ids — clamp companion", () => {
  it("clamps into range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    expect(clamp(0, 0, 0)).toBe(0);
  });

  it("propagates NaN instead of silently returning a bound", () => {
    // Math.min/max propagate NaN, so a non-finite input leaves the parameter
    // poisoned downstream. Pinned as the *current* contract: a future
    // hardening pass has to make that choice deliberately.
    expect(clamp(Number.NaN, 0, 10)).toBeNaN();
  });

  it("does not throw on a reversed min/max range", () => {
    // Reversed bounds resolve deterministically under Math.min(max, …)
    // ordering. Not a crash, but a silent wrong value — pinned so the
    // behaviour stays visible if the ordering ever changes.
    expect(() => clamp(5, 10, 0)).not.toThrow();
    expect(clamp(5, 10, 0)).toBe(0);
  });
});
