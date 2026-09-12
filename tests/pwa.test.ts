import { describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pwaOptions } from "../src/pwa";

interface TestManifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
}

const manifest = pwaOptions.manifest as unknown as TestManifest;
const publicDir = join(process.cwd(), "public");

describe("PWA manifest config", () => {
  it("has required identity fields", () => {
    expect(manifest.name).toMatch(/KYX/);
    expect(manifest.short_name).toBe("KYX");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("has non-empty description", () => {
    expect(manifest.description!.length).toBeGreaterThan(40);
  });

  it("theme colors are valid hex and match the app shell", () => {
    const hex = /^#[0-9a-f]{6}$/i;
    expect(manifest.theme_color).toMatch(hex);
    expect(manifest.background_color).toMatch(hex);
    expect(manifest.theme_color).toBe("#14161c");
  });

  it("declares a 192, a 512 and a maskable icon", () => {
    const icons = manifest.icons;
    expect(icons.some((i) => i.sizes === "192x192")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512")).toBe(true);
    const maskable = icons.find((i) => i.purpose === "maskable");
    expect(maskable).toBeDefined();
    expect(maskable!.sizes).toBe("512x512");
  });

  it("every referenced icon file exists on disk and is non-trivial", () => {
    for (const icon of manifest.icons) {
      const path = join(publicDir, icon.src);
      expect(existsSync(path), `${icon.src} should exist in public/`).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(500);
    }
    expect(existsSync(join(publicDir, "apple-touch-icon.png"))).toBe(true);
  });

  it("icon dimensions in filenames match declared sizes", () => {
    for (const icon of manifest.icons) {
      expect(icon.src).toContain(icon.sizes);
    }
  });
});

describe("PWA caching strategy", () => {
  it("precache pattern covers the app shell", () => {
    const glob = (pwaOptions.workbox!.globPatterns as string[]).join(" ");
    expect(glob).toContain("js");
    expect(glob).toContain("css");
    expect(glob).toContain("html");
  });

  it("precache includes curated factory samples with a raised per-file cap", () => {
    // Local-first (VISION §24): the curated kit must survive offline — WAVs
    // are precached, and the 2 MiB workbox default would SILENTLY drop any
    // larger curated one-shot from the offline kit.
    const glob = (pwaOptions.workbox!.globPatterns as string[]).join(" ");
    expect(glob).toContain("wav");
    expect(pwaOptions.workbox!.maximumFileSizeToCacheInBytes).toBeGreaterThan(2 * 1024 * 1024);
  });

  it("keeps the optional ranker runtime out of the app-shell precache", () => {
    const ignores = (pwaOptions.workbox!.globIgnores as string[]).join(" ");
    expect(ignores).toContain("models/ort/**");
    expect(ignores).toContain("models/intent-ranker-v1.onnx");
    expect(ignores).toContain("golden-review/**");
  });

  it("navigations fall back to index.html for SPA routing", () => {
    expect(pwaOptions.workbox!.navigateFallback).toBe("index.html");
  });

  it("uses PROMPT mode so a running session never loses its precache", () => {
    // Release roadmap Fáza 3: with "autoUpdate" the new precache activates
    // and cleans outdated revisions while a long-running tab is still on the
    // old build — its next lazy-chunk import (ExportPanel, FxEqPanel…) can
    // 404 mid-session. "prompt" parks the new worker behind an update
    // banner (src/sw-update.ts); the old cache stays intact until the user
    // chooses RELOAD.
    expect(pwaOptions.registerType).toBe("prompt");
  });
});
