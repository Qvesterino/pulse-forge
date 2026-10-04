import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
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
  server: { host: "127.0.0.1" },
  plugins: [react(), ...(desktopBuild ? [] : [VitePWA(pwaOptions)])],
  resolve: {
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
      {
        find: /^@qvester\/qmr-hud$/,
        replacement: resolve(qvesterPkgSrc("qmr-hud"), "index.ts"),
      },
      {
        find: /^@qvester\/qmr-hud\/(.*)$/,
        replacement: `${qvesterPkgSrc("qmr-hud")}/$1`,
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
          return containsAudiotoolCode ? "assets/audiotool-nexus-[hash].js" : "assets/[name]-[hash].js";
        },
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react-dom") || /[\/]react[\/]/.test(id) || id.includes("scheduler")) {
              return "vendor-react";
            }
          }
        },
      },
    },
  },
});
