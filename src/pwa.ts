import type { VitePWAOptions } from "vite-plugin-pwa";

/**
 * Shared PWA configuration — consumed by vite.config.ts and validated by tests
 * (tests/pwa.test.ts) so manifest regressions are caught without a build.
 *
 * Strategy: precache the entire app shell (autoUpdate) so PulseForge boots
 * fully offline. Project/sample data already lives in IndexedDB, which is
 * inherently offline-first.
 */
export const pwaOptions: Partial<VitePWAOptions> = {
  // "prompt" (release roadmap Fáza 3): a new service worker WAITS until the
  // user accepts the reload banner. With "autoUpdate" the new precache
  // activates + cleans outdated revisions while a long-running tab is still
  // on the old build — its next lazy-chunk import (ExportPanel, FxEqPanel…)
  // can then 404 mid-session. A DAW with work in progress must never have
  // its cache pulled out from under it; the update banner in src/sw-update.ts
  // hands the reload decision to the user.
  registerType: "prompt",
  includeAssets: ["apple-touch-icon.png"],
  manifest: {
    name: "KYX — Browser DAW",
    short_name: "KYX",
    description:
      "Step sequencer, synths, effects and arrangement — a full DAW that runs entirely in your browser. Works offline, saves automatically.",
    lang: "en",
    dir: "ltr",
    orientation: "any",
    scope: "/",
    start_url: "/",
    display: "standalone",
    background_color: "#14161c",
    theme_color: "#14161c",
    categories: ["music", "productivity", "entertainment"],
    icons: [
      { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
      { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
      {
        src: "maskable-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  },
  workbox: {
    // Precache all built assets (JS/CSS/HTML) + icons + curated factory
    // samples from public/samples/ (local-first: the curated kit must be
    // available offline, not only on the first online visit). Internal
    // golden-review listening renders are not product assets, and the optional
    // intent ranker stays lazy: its 13.9 MB WASM runtime must never inflate
    // the app-shell install/update payload.
    globPatterns: ["**/*.{js,css,html,svg,png,woff2,wav}"],
    globIgnores: ["models/ort/**", "models/intent-ranker-v1.onnx", "golden-review/**"],
    // Workbox silently EXCLUDES precache entries above its 2 MiB default —
    // raise the cap so curated one-shots (kicks/snares are typically well
    // under this) never get silently dropped from the offline kit.
    maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
    navigateFallback: "index.html",
    navigateFallbackDenylist: [/^\/api\//],
  },
};
