import { defineConfig, devices } from "playwright/test";

/**
 * Playwright E2E runner for Pulse Forge.
 *
 * Mirrors the existing smoke flow in scripts/verify-browser.mjs but breaks it
 * into isolated scenarios so a single failure does not block every assertion.
 * Keeps port 5199 / strictPort so the existing dev loop stays uncontended and
 * `npm run dev` can be reused (`reuseExistingServer`).
 *
 * The existing `scripts/verify-browser.mjs` keeps its own local copy of
 * `clickPanelAction` on purpose — pulling the helper out of scripts/ would
 * break the standalone smoke entry point. The Playwright specs read the same
 * helper from `tests/e2e/_helpers.ts`.
 */
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: true,
  workers: 2,
  retries: isCI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // `predev` already builds the worklet bundles; the npm script just wraps
    // `vite` and forwards the port flags. strictPort mirrors the smoke flow.
    command: "npm run dev -- --port 5199 --strictPort",
    url: "http://127.0.0.1:5199",
    timeout: 120_000,
    reuseExistingServer: !isCI,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
