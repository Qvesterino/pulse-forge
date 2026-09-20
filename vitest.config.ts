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
    // Pool config (rejected 2026-09-18):
    //   - `isolate: false` collapsed 78-file setup time from 406 s to ~13 s
    //     in early testing, but it produced 7 contamination failures in
    //     WavetablePanel / SampleBrowser / Mixer. Each test file expects a
    //     fresh jsdom DOM and module-level service mocks; the 4× wall-clock
    //     speedup is not worth the false negatives.
    //   - `pool: 'forks'` + `maxForks: 6` (without `isolate: false`) added
    //     IPC overhead but no real speedup — extrapolation for all 78
    //     files was ~530 s (slower than the default `pool: 'threads'`).
    // Both reverted. The 400 s+ environment setup is structural — the cost
    // is per-file jsdom init plus the project-size module graph — and would
    // require splitting the test surface (e.g. unit-only vs UI tests,
    // separated into different packages) to make a meaningful dent. That
    // is out of scope for this campaign.
    // E2E specs under tests/e2e/ are run by the Playwright runner
    // (`npm run test:e2e`), not vitest — vitest's default `testMatch`
    // would otherwise pick them up and fail with a vitest-shaped error.
    // The Playwright config (`playwright.config.ts`) owns that directory.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      // `.kilo/worktrees/**` holds stale *git worktrees* (ignored by git via
      // `.git/info/exclude` but not by vitest). Without this, a full run
      // collects ~189 duplicate spec files from the old checkout, roughly
      // doubles wall clock, and flakes on hook timeouts under co-tenant load.
      "**/.kilo/**",
      "tests/e2e/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      // Don't try to cover vendored DSP cores — those have golden-vector
      // suites under `tests/<name>-vectors/` and `tests/*-golden.test.ts`
      // and are exercised via integration, not unit coverage.
      exclude: [
        "node_modules/",
        "dist/",
        "coverage/",
        "tests/",
        "**/*.d.ts",
        // Vendored plugin cores (upstream-mirrored, golden-vector tested)
        "src/effects/fxeq-core/**",
        "src/effects/ultina-core/**",
        "src/effects/ozvena-core/**",
        "src/effects/morph-dynamics-core/**",
        // Plain-JS worklet processors (typed via .d.ts shims only)
        "src/audio-worklets/*.js",
        "src/audio-workers/*.ts",
        // Test fixtures and the project harness itself
        "src/test-fixtures/**",
      ],
    },
  },
});
