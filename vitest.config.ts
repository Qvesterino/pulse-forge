import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const virtualPwaRegisterStub = fileURLToPath(
  new URL("./tests/_stubs/virtual-pwa-register.ts", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // `virtual:pwa-register` is provided by vite-plugin-pwa in dev/build
      // but is not present in the vitest graph (no PWA plugin). The vitest
      // graph would otherwise fail to resolve the import in src/sw-update.ts.
      // Mirror the alias from vite.config.ts so tests, dev, and prod agree.
      { find: /^virtual:pwa-register$/, replacement: virtualPwaRegisterStub },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    css: false,
    // E2E specs under tests/e2e/ are run by the Playwright runner
    // (`npm run test:e2e`), not vitest — vitest's default `testMatch`
    // would otherwise pick them up and fail with a vitest-shaped error.
    // The Playwright config (`playwright.config.ts`) owns that directory.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      "tests/e2e/**",
    ],
  },
});
