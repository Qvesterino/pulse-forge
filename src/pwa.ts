import type { VitePWAOptions } from "vite-plugin-pwa";

/**
 * Shared PWA configuration — consumed by vite.config.ts and validated by tests
 * (tests/pwa.test.ts) so manifest regressions are caught without a build.
 *
 * Strategy: precache the entire app shell (autoUpdate) so PulseForge boots
 * fully offline. Project/sample data already lives in IndexedDB, which is
 * inherently offline-first.
 */

// Ecosystem mount: the same STUDIO_APP_BASE env vite.config.ts feeds to
// `base` also drives the manifest scope/start_url — both must stay inside
// the mount subpath or the browser rejects the service-worker scope.
const mountBase = `${(process.env.STUDIO_APP_BASE ?? "/").replace(/\/?$/, "/")}`;

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
    // Stable identity for install + TWA. It follows the mount so two mounts
    // of the same origin do not fight over one installed app identity.
    id: mountBase,
    name: "KYX — Browser DAW",
    short_name: "KYX",
    description:
      "Step sequencer, synths, effects and arrangement — a full DAW that runs entirely in your browser. Works offline, saves automatically.",
    lang: "en",
    dir: "ltr",
    orientation: "any",
    scope: mountBase,
    start_url: mountBase,
    display: "standalone",
    // Standalone is the product shell; minimal-ui is the honest fallback for
    // a browser that cannot hide its chrome. Both keep the same start URL.
    display_override: ["standalone", "minimal-ui"],
    // Signal Glass app shell (mirrors --bg in src/styles/01-base.css / THEME_PRESETS[0]).
    background_color: "#0b0c10",
    theme_color: "#0b0c10",
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
    // Precache the app shell only: JS/CSS/HTML/icons. Sample WAVs are NOT
    // part of install/update anymore — the curated piano pack alone is 236 MB
    // and the one-shots another 36 MB. On mobile that is a multi-hundred-MB
    // download before the first note, and every deploy would churn it.
    // Samples now use the runtime `kyx-samples` cache on first use, and the
    // explicit "offline pack" action (Diagnostics → Device) can prefill the
    // same cache for a chosen pack. The app remains offline-capable for the
    // shell; audio content becomes offline after use or after that action.
    globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
    globIgnores: [
      "models/ort/**",
      "models/intent-ranker-v1.onnx",
      "golden-review/**",
      // All sample packs are on-demand, never install payload.
      "**/samples/**",
      // The optional SDK and its KYX adapter are downloaded only after the
      // user chooses Audiotool export; do not include either in PWA install/update.
      "**/audiotool-nexus-*.js",
      // Stem separation's WebGPU-capable ONNX runtime is imported only after
      // the user selects an available model; cache it after that first use.
      "**/ort.bundle.min-*.js",
      // FLAC workers and WASM codecs are opt-in; cache their
      // chunks after first use instead of downloading them during PWA install.
      "**/flac-codec-*.js",
      // The ONNX runtime blobs are model dependencies, loaded behind circuit
      // breakers — never part of the install payload.
      "assets/ort-*.wasm",
      // An optional vendored copy must not be downloaded during PWA install.
      "audiotool-nexus/**",
      // Local-only VSCO conversions are development assets, not shipped
      // content. They are excluded even from the runtime pack manifest by the
      // generator, so a developer's converted loops cannot inflate a release.
      "**/samples/vsco/**",
    ],
    // Workbox silently EXCLUDES precache entries above its 2 MiB default —
    // raise the cap so curated one-shots (kicks/snares are typically well
    // under this) never get silently dropped from the offline kit.
    //
    // Keep the app-shell cap bounded: optional third-party runtimes must not
    // turn a small PWA install into a multi-dozen-megabyte download. Note this
    // is a limit, not a guarantee — anything above it is dropped from the
    // precache manifest, so keeping local-only assets out is what actually
    // makes `npm run build` succeed on a machine that has them.
    maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
    runtimeCaching: [
      {
        // Sample content is cache-first after the first use. The explicit
        // offline pack writes into this same cache, so the SW can serve it
        // without a second policy. 600 entries covers curated one-shots +
        // the 120-file piano pack; quota pressure can purge the cache rather
        // than failing a project save.
        urlPattern: /\/samples\/.+\.(?:wav|ogg|mp3|flac)$/i,
        handler: "CacheFirst",
        options: {
          cacheName: "kyx-samples",
          cacheableResponse: { statuses: [0, 200] },
          expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 365, purgeOnQuotaError: true },
        },
      },
      {
        // Optional AI models load behind circuit breakers; cache only after
        // a model is actually used (never during install).
        urlPattern: /\/models\/.+\.(?:onnx|json|bin)$/i,
        handler: "CacheFirst",
        options: {
          cacheName: "kyx-models",
          cacheableResponse: { statuses: [0, 200] },
          expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 365, purgeOnQuotaError: true },
        },
      },
      {
        urlPattern: /\/assets\/ort\.bundle\.min-[^/]+\.js$/,
        handler: "CacheFirst",
        options: {
          cacheName: "kyx-stem-runtime",
          cacheableResponse: { statuses: [0, 200] },
          expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 365 },
        },
      },
      {
        urlPattern: /\/assets\/flac-codec-[^/]+\.js$/,
        handler: "CacheFirst",
        options: {
          cacheName: "kyx-flac-codec",
          cacheableResponse: { statuses: [0, 200] },
          expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
        },
      },
      {
        urlPattern:
          /^https:\/\/cdn\.audiotool\.com\/website-assets\/document-service\/[0-9a-f]+\/(?:wasm_exec\.js|document_validator\.wasm\.gz)$/,
        handler: "CacheFirst",
        options: {
          cacheName: "audiotool-nexus-validator",
          cacheableResponse: { statuses: [0, 200] },
          expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 365 },
        },
      },
    ],
    navigateFallback: "index.html",
    // Qvester owns this nested marketing route. The KYX worker shares the
    // /kyx/ scope, but must let the host shell serve /kyx/landing.
    navigateFallbackDenylist: [/^\/api\//, /^\/kyx\/landing(?:\/|$)/],
  },
};
