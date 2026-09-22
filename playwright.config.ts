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
const e2ePort = Number(process.env.PULSE_FORGE_E2E_PORT ?? "5199");
if (!Number.isInteger(e2ePort) || e2ePort < 1024 || e2ePort > 65535) {
  throw new Error("PULSE_FORGE_E2E_PORT must be an integer between 1024 and 65535");
}

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
    baseURL: `http://127.0.0.1:${e2ePort}`,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // `predev` already builds the worklet bundles; the npm script just wraps
    // `vite` and forwards the port flags. strictPort mirrors the smoke flow.
    command: `npm run dev -- --host 127.0.0.1 --port ${e2ePort} --strictPort`,
    url: `http://127.0.0.1:${e2ePort}`,
    timeout: 120_000,
    reuseExistingServer: !isCI,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Safari-engine coverage on Windows: the same scenarios through the
      // WebKit engine. Playwright's Windows WebKit build ships WITHOUT the
      // media stack (no AudioContext at all), so the engine-backed scenarios
      // 01–08 cannot run there — spec 09 exercises the no-Web-Audio
      // degradation path natively instead. Real Safari-on-macOS audio
      // behavior still needs a manual pass (owner gate).
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testIgnore: /0[1-8]-/,
    },
  ],
});
