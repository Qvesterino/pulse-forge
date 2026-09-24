import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Audit 14 re-run (Browser Lifecycle) — regression pins.
 *
 * The 2026-09-22 fixes (persist() boot, SW-reload mic guard) are re-pinned
 * here, plus the lifecycle surfaces that changed since:
 *  - HUM recording rides the same suspend/interruption recovery as timeline
 *    recording (PcmMicRecorder context-statechange → keep-for-recovery).
 *  - The browser-checks lifecycle stress (3× init→process→teardown) exists
 *    and closes each context (no dangling contexts between cycles).
 */

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("audit 14 re-run — browser lifecycle pins", () => {
  it("boot persists durable storage (iOS ~7-day eviction guard)", () => {
    const src = read("src/services.ts");
    expect(src).toContain("navigator.storage?.persist?.()");
  });

  it("service-worker update reload is blocked while a mic take is live", () => {
    const swUpdate = read("src/sw-update.ts");
    expect(swUpdate).toContain("isMicRecordingActive()");
    const recorder = read("src/audio-engine/PcmMicRecorder.ts");
    expect(recorder).toContain("export function isMicRecordingActive(): boolean");
  });

  it("a suspended/interrupted context during a HUM take keeps committed audio for recovery", () => {
    // The recorder treats context statechange during recording as an
    // interruption: stop + preserve staged PCM. Tab hidden / OS sleep /
    // device disconnect all funnel through this path.
    const recorder = read("src/audio-engine/PcmMicRecorder.ts");
    expect(recorder).toContain('onContextStateChange');
    expect(recorder).toContain("ctx.state !== \"running\"");
    // The harness proves the behavior at runtime:
    const tests = read("tests/pcm-mic-recorder.test.ts");
    expect(tests).toContain("stops and preserves the take when the AudioContext is suspended");
  });

  it("the browser-checks lifecycle stress closes every context it opens", () => {
    const checks = read("src/browser-checks.ts");
    expect(checks).toContain("init→process→teardown→reinit");
    expect(checks).toContain("await ctx.close();");
  });
});
