import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { pwaOptions } from "./src/pwa";

const virtualPwaRegisterStub = fileURLToPath(new URL("./tests/_stubs/virtual-pwa-register.ts", import.meta.url));

// QMR HUD ecosystem packages live in the SIBLING checkout (monorepo
// file:-dep style). The default expects pulse-forge and QVESTER_LANDING_PAGE
// side by side on disk; clean checkouts (the Qvester CI vendored build)
// override the root via QVESTER_SIBLING_ROOT — without it the aliases point
// at a directory that does not exist and vite build dies on ENOENT before
// producing anything.
const qvesterSiblingRoot = process.env.QVESTER_SIBLING_ROOT
  ? resolve(process.env.QVESTER_SIBLING_ROOT)
  : fileURLToPath(new URL("../QVESTER_LANDING_PAGE", import.meta.url));
const qvesterPkgSrc = (pkg: string) => resolve(qvesterSiblingRoot, "packages", pkg, "src");

// The QMR HUD chip trigger is the ONLY sibling dependency left in the build,
// and it is OPTIONAL. A clean checkout (GitHub Actions, a reviewer's clone)
// has no sibling — and an unresolvable import is FATAL there: vite build dies
// on ENOENT before producing anything, and the studio then crashes on boot
// (measured 2026-10-28: five red CI jobs from one such import).
//
// So the alias falls back to an in-repo stub when the sibling is absent: the
// chip is an affordance, and the app already renders "no chip" when its load
// fails (QmrErrorBoundary). The fallback does NOT change what the gates
// measure — the chip lives in its own optional bundle bucket, and the
// command bus is KYX's own module (src/interop/qmrCommandBus.ts).
const qmrHudStubSrc = fileURLToPath(new URL("./src/integrations/qmr-hud-stub", import.meta.url));
const qmrHudRealSrc = qvesterPkgSrc("qmr-hud");
const qmrHudSrc = existsSync(resolve(qmrHudRealSrc, "qmr-mini-chip-mount.tsx")) ? qmrHudRealSrc : qmrHudStubSrc;

// Desktop packaging (ADR 0010): the Electron shell serves the static dist/
// over its own app:// scheme — the service-worker precache would be dead
// weight there, so the PWA layer is only built for the browser target.
// Without the plugin, the alias above transparently resolves the
// `virtual:pwa-register` import to the no-op stub.
const desktopBuild = process.env.KYX_DESKTOP === "1";

// Ecosystem mount (Qvester Studio): STUDIO_APP_BASE=/kyx/ builds the
// app for a subpath deployment — asset URLs, the PWA scope/start_url (see
// src/pwa.ts) and SPA route parsing all derive from it. Unset (default) →
// "/" — the standalone root deployment, byte-for-byte today's output.
export const studioAppBase = process.env.STUDIO_APP_BASE ?? "/";

export default defineConfig({
  base: studioAppBase,
  // The dep-optimizer cache must NOT live in node_modules. A checkout whose
  // node_modules is a JUNCTION into another checkout shares that cache, so
  // two Vite servers overwrite each other's optimized deps — the page then
  // loads two copies of React ("Invalid hook call") and the app never
  // mounts. One cache per CHECKOUT ROOT instead of per node_modules.
  cacheDir: ".vite-cache",
  optimizeDeps: {
    // Pin the scan to the app entry. The default crawl (every *.html under the
    // root) reaches into package "exports" maps — lib0 ships a `test.js`
    // entry — and the cold-cache build then dies on
    // "Could not resolve ./array.test.js".
    entries: ["index.html"],
    // Deps the optimizer would otherwise meet LATE.
    //
    // The scanner crawls the entry graph; a WORKER module is not in it (Vite
    // bundles workers separately), so a bare import inside a worker is
    // discovered only when the worker is created — i.e. when the studio boots
    // the AI runtime. A runtime discovery re-runs the optimizer, which changes
    // the ?v= hash of EVERY optimized dep and triggers a FULL PAGE RELOAD
    // (measured 2026-10-22: the page loaded react.js?v=5e019cbd AND
    // react.js?v=e2debdb6 — two React instances, "Invalid hook call" — and the
    // reload destroyed the DOM the app-boot gate was waiting for, which it
    // reported as "UI did not mount").
    //
    // Pre-declared so the FIRST optimizer pass already knows them - no
    // runtime discovery, no re-optimize, no reload.
    include: ["@huggingface/transformers", "onnxruntime-web/wasm"],
    // zod comes from the SIBLING's interop-types barrel, so it resolves to
    // the sibling's zod 3.25.76 - the same copy the production build uses.
    // It must NOT be pre-bundled: `include` resolves from the ROOT, where the
    // app happens to carry zod 4.5.4 as a transitive dep, and dev would then
    // run a different zod than prod. Excluding keeps the resolution exactly
    // as it is and only skips the optimizer.
    exclude: ["zod"],
  },
  server: {
    host: "127.0.0.1",
    // Keep an opt-in long audio soak isolated from HMR caused by edits in the
    // shared working tree. Normal development retains hot reload.
    ...(process.env.KYX_RECORDING_SOAK_SECONDS ? { hmr: false } : {}),
  },
  plugins: [react(), ...(desktopBuild ? [] : [VitePWA(pwaOptions)])],
  resolve: {
    // ONE React for the whole graph.
    //
    // Measured (tests/react-single-copy.test.ts): the QMR HUD ships as TS
    // SOURCE from the SIBLING checkout, so its bare `import ... from "react"`
    // resolves through node resolution from THAT tree and lands on
    // D:\QVESTER_LANDING_PAGE\node_modules\react (19.3.0) instead of this
    // app's own 18.3.1. The production build merges both into one
    // vendor-react chunk, so the app ships a single React - the dev server
    // must not be allowed to resolve a second one.
    //
    // @vitejs/plugin-react already contributes this list; stating it here
    // keeps the invariant visible in THIS repo and survives a plugin swap.
    dedupe: ["react", "react-dom"],
    alias: [
      // `virtual:pwa-register` is a plugin-only module that has no on-disk
      // implementation. The vitest graph does not include the PWA plugin,
      // so tests that import `src/sw-update.ts` would fail without an
      // alias pointing at this no-op stub. Production builds resolve the
      // alias transparently (the stub is only consulted when the plugin
      // chain does not provide the virtual module).
      { find: /^virtual:pwa-register$/, replacement: virtualPwaRegisterStub },
      // QMR HUD (Qvester ecosystem): the packages ship TS SOURCE (monorepo
      // file:-dep style) — alias them in-place so KYX mounts the REAL chip
      // without publishing or copying. Keep in sync with vitest.config.ts.
      // The chip falls back to the in-repo stub when the sibling checkout is
      // absent (see qmrHudSrc above) — a build without the chip, not a build
      // that cannot start.
      {
        find: /^@qvester\/qmr-hud$/,
        replacement: resolve(qmrHudSrc, "index.ts"),
      },
      {
        find: /^@qvester\/qmr-hud\/(.*)$/,
        replacement: `${qmrHudSrc}/$1`,
      },
      {
        find: /^@qvester\/qmr-interop(.*)$/,
        replacement: `${qvesterPkgSrc("qmr-interop")}/$1`,
      },
      {
        find: /^@qvester\/intent-engine(.*)$/,
        replacement: `${qvesterPkgSrc("intent-engine")}/$1`,
      },
      {
        find: /^@qvester\/interop-types(.*)$/,
        replacement: `${qvesterPkgSrc("interop-types")}/$1`,
      },
    ],
  },
  // Browser ranker workers use module imports (onnxruntime-web + shared
  // feature code). IIFE output cannot be code-split, so keep Vite's worker
  // contract aligned with the native ESM Worker created by ranker-client.
  worker: {
    format: "es",
  },
  build: {
    rollupOptions: {
      output: {
        // Vendor split (release roadmap 2.1): the framework lives in its own
        // chunk so app-code edits don't invalidate the (PWA-precached) vendor
        // bytes, and the entry-budget check keeps measuring the shell the
        // team actually controls. The vendor chunk still loads at boot —
        // the initial payload is unchanged; only cache granularity improves.
        chunkFileNames(chunkInfo) {
          const containsAudiotoolCode = chunkInfo.moduleIds.some(
            (id) =>
              id.includes("@audiotool/nexus/") ||
              id.includes("/src/integrations/audiotool-nexus/") ||
              id.endsWith("/src/ui/AudiotoolNexusExport.tsx"),
          );
          const containsFlacCodec = chunkInfo.moduleIds.some(
            (id) =>
              id.includes("/node_modules/mediabunny/") ||
              id.includes("/node_modules/@mediabunny/flac-encoder/") ||
              id.includes("/node_modules/@wasm-audio-decoders/") ||
              id.includes("/node_modules/codec-parser/") ||
              id.includes("/node_modules/@eshaz/web-worker/") ||
              id.includes("/node_modules/simple-yenc/"),
          );
          if (containsAudiotoolCode) return "assets/audiotool-nexus-[hash].js";
          return containsFlacCodec ? "assets/flac-codec-[hash].js" : "assets/[name]-[hash].js";
        },
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (
              id.includes("/node_modules/@wasm-audio-decoders/") ||
              id.includes("/node_modules/codec-parser/") ||
              id.includes("/node_modules/@eshaz/web-worker/") ||
              id.includes("/node_modules/simple-yenc/")
            ) {
              return "flac-codec";
            }
            if (id.includes("react-dom") || /[\/]react[\/]/.test(id) || id.includes("scheduler")) {
              return "vendor-react";
            }
          }
        },
      },
    },
  },
});
