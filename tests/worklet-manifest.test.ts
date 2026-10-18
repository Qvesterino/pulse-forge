import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseWorkletManifest, workletFileUrl, type WorkletManifest } from "../src/audio-worklets/workletManifest";

const manifest: WorkletManifest = {
  version: 1,
  assets: {
    "core-worklet.js": "a".repeat(64),
    "fx-extra-worklet.js": "b".repeat(64),
  },
};

describe("worklet artifact versioning", () => {
  it("appends the content hash to the logical worklet URL", () => {
    expect(workletFileUrl("/core-worklet.js", manifest)).toBe(`/core-worklet.js?v=${"a".repeat(64)}`);
    expect(workletFileUrl("/fx-extra-worklet.js", manifest)).toBe(`/fx-extra-worklet.js?v=${"b".repeat(64)}`);
  });

  it("falls back to the unversioned URL when the manifest is absent or the bundle is unknown", () => {
    expect(workletFileUrl("/core-worklet.js", null)).toBe("/core-worklet.js");
    expect(workletFileUrl("/unknown-worklet.js", manifest)).toBe("/unknown-worklet.js");
  });

  it("rejects malformed manifests instead of producing cache-busting garbage", () => {
    expect(parseWorkletManifest(null)).toBeNull();
    expect(parseWorkletManifest({ version: 2, assets: {} })).toBeNull();
    expect(
      parseWorkletManifest({ version: 1, assets: { "core-worklet.js": "not-a-hash", "evil.js": "a".repeat(64) } }),
    ).toBeNull();
    expect(
      parseWorkletManifest({ version: 1, assets: { "core-worklet.js": "a".repeat(64), "evil.js": "b".repeat(64) } }),
    ).toEqual({ version: 1, assets: { "core-worklet.js": "a".repeat(64) } });
  });

  it("ships a manifest covering the core and lazy-extra bundles", () => {
    const shipped = parseWorkletManifest(
      JSON.parse(readFileSync(resolve(process.cwd(), "public/worklets-manifest.json"), "utf-8")),
    );
    expect(shipped).not.toBeNull();
    expect(Object.keys(shipped!.assets)).toEqual(
      expect.arrayContaining([
        "core-worklet.js",
        "bitcrusher-worklet.js",
        "fx-extra-worklet.js",
        "generative-player-worklet.js",
      ]),
    );
    for (const hash of Object.values(shipped!.assets)) expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
