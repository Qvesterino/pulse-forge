import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { pwaOptions } from "./src/pwa";

export default defineConfig({
  plugins: [react(), VitePWA(pwaOptions)],
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
