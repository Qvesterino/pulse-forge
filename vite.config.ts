import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";
import { pwaOptions } from "./src/pwa";

const virtualPwaRegisterStub = fileURLToPath(
  new URL("./tests/_stubs/virtual-pwa-register.ts", import.meta.url),
);

export default defineConfig({
  plugins: [react(), VitePWA(pwaOptions)],
  resolve: {
    alias: [
      // `virtual:pwa-register` is a plugin-only module that has no on-disk
      // implementation. The vitest graph does not include the PWA plugin,
      // so tests that import `src/sw-update.ts` would fail without an
      // alias pointing at this no-op stub. Production builds resolve the
      // alias transparently (the stub is only consulted when the plugin
      // chain does not provide the virtual module).
      { find: /^virtual:pwa-register$/, replacement: virtualPwaRegisterStub },
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
