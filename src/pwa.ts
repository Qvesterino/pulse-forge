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
  registerType: "autoUpdate",
  includeAssets: ["apple-touch-icon.png"],
  manifest: {
    name: "Pulse Forge — Browser DAW",
    short_name: "Pulse Forge",
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
    // Precache all built assets (JS/CSS/HTML) + icons from public/.
    globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
    // Factory samples are generated at runtime — nothing extra to cache.
    navigateFallback: "index.html",
    navigateFallbackDenylist: [/^\/api\//],
  },
};
