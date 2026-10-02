import { defineConfig, mergeConfig } from "vite";
import baseConfig from "./vite.config";

/**
 * E2E DEV SERVER OVERRIDE — the concurrent session's live file saves push
 * Vite full reloads, which restart the SPA mid-boot and kill the E2E run
 * ("waiting for .topbar" timeouts while the page never finishes mounting).
 * HMR off makes the dev server serve a STABLE page regardless of concurrent
 * edits — the same fix the measurement scripts use (measure-preset-loudness
 * et al.). Run: npx vite --config vite.e2e.config.ts --port 5199 --strictPort
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    server: { host: "127.0.0.1", hmr: false },
  }),
);
