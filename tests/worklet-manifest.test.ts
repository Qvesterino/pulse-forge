import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
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

  // The manifest's ONLY job is to be the cache key of the bytes that ship.
  // `?v=<hash>` is what stops a CDN/HTTP cache (or a shell without the service
  // worker) from pairing an OLD bundle with a NEW app. A manifest whose hash
  // no longer matches the shipped bytes does the opposite: the app keeps
  // asking for the old `?v=`, the cache keeps answering with the old bundle,
  // and the new app runs the old DSP. That is not a cache-efficiency nit —
  // it ships stale audio.
  //
  // It happened for real: commit 93e28e12 (the TSAR ORBIT surface) rebuilt
  // public/tsar-worklet.js and left public/worklets-manifest.json untouched,
  // so main shipped a stale key for one bundle and nothing noticed. The
  // committed bundles are all tracked, so this needs no build to decide.
  it("records the hash of the bytes that actually ship, for every bundle", () => {
    const publicDir = resolve(process.cwd(), "public");
    const shipped = parseWorkletManifest(
      JSON.parse(readFileSync(resolve(publicDir, "worklets-manifest.json"), "utf-8")),
    );
    expect(shipped).not.toBeNull();

    const bundles = readdirSync(publicDir)
      .filter((name) => name.endsWith("-worklet.js"))
      .sort();
    expect(bundles.length).toBeGreaterThan(0);

    for (const name of bundles) {
      const actual = createHash("sha256")
        .update(readFileSync(join(publicDir, name)))
        .digest("hex");
      expect(
        shipped!.assets[name],
        `${name} ships with a stale ?v= key — the cache would serve the old bundle to the new app`,
      ).toBe(actual);
    }
  });

  it("lists every shipped bundle — an unlisted one falls back to an unversioned URL", () => {
    const publicDir = resolve(process.cwd(), "public");
    const shipped = parseWorkletManifest(
      JSON.parse(readFileSync(resolve(publicDir, "worklets-manifest.json"), "utf-8")),
    );
    expect(shipped).not.toBeNull();

    const bundles = readdirSync(publicDir)
      .filter((name) => name.endsWith("-worklet.js"))
      .sort();
    expect(Object.keys(shipped!.assets).sort()).toEqual(bundles);
  });
});
