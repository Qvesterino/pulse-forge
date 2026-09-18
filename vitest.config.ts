import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
