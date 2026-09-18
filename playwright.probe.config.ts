import { defineConfig, devices } from "playwright/test";

// Throwaway: run the e2e smoke against an isolated dev server (port 5198)
// so a concurrently-running editor + HMR on 5199 cannot reload test pages.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5198", headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
