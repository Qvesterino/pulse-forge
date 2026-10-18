import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * BROWSER LIFECYCLE AUDIT GATE (2026-10-18)
 *
 * The behavioural lifecycle surface is covered elsewhere:
 *   - context suspend/resume, contextlost/restored, worklet refresh:
 *     tests/audio-engine-lifecycle.test.ts + audio-engine-lifecycle-stress.test.ts
 *   - scheduler ticker + stall watchdog: tests/scheduler-driver.test.ts,
 *     tests/scheduler-stall.test.ts
 *   - autosave / pagehide / beforeunload / crash journal / recovery:
 *     tests/save-lifecycle.test.ts, autosave-debouncer, crash-journal,
 *     recovery-buffer
 *   - device disconnect messaging: tests/audio-status-chips.test.ts
 *   - hung reference workers: tests/reference-client-lifecycle.test.ts
 *
 * What no single suite states is the CROSS-CUTTING guarantee that makes those
 * behaviours survive tab-hide, sleep and a long idle. These structural pins
 * encode it (same source-structural style as tests/offline-parity.test.ts):
 *
 *   1. the transport runs on the AUDIO clock — a wall clock would advance
 *      during system sleep while the device is frozen, so the playhead would
 *      jump on wake;
 *   2. nothing in the audio scheduling path is driven by animation frames
 *      (rAF stops in hidden tabs; audio must not);
 *   3. hiding the tab flushes the save and pauses generative audio; the
 *      visible edge best-effort resumes the context;
 *   4. every worker REQUEST has a bounded wait, so a worker that dies without
 *      an `error` event cannot leave a promise pending forever.
 */

const ROOT = resolve(__dirname, "..");

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("browser lifecycle invariants", () => {
  it("the transport runs on the AUDIO clock, not wall-clock time", () => {
    const services = read("src/services.ts");
    expect(services, "the studio transport must be anchored to engine.currentTime (audio clock)").toMatch(
      /new Transport\(\{\s*now:\s*\(\)\s*=>\s*engine\.currentTime\s*\}/,
    );
    expect(services, "a wall-clock transport would advance during system sleep while the device is frozen").not.toMatch(
      /new Transport\(\s*systemClock/,
    );
  });

  it("audio scheduling never depends on animation frames", () => {
    for (const file of [
      "src/scheduler/Scheduler.ts",
      "src/scheduler/schedulerDriver.ts",
      "src/audio-engine/AudioEngine.ts",
      "src/transport/Transport.ts",
    ]) {
      expect(read(file), `${file} must not be driven by requestAnimationFrame`).not.toMatch(/requestAnimationFrame/);
    }
  });

  it("hiding the tab flushes the save and pauses generative audio; showing resumes the context", () => {
    const services = read("src/services.ts");
    const start = services.indexOf("const onVisibility");
    expect(start, "the services visibility handler disappeared").toBeGreaterThan(-1);
    const body = services.slice(start, start + 1200);
    expect(body, "hidden must flush the save (work must survive a background kill)").toMatch(
      /visibilityState\s*===\s*"hidden"[\s\S]{0,400}?flushSave\(\)/,
    );
    expect(body, "hidden must pause generative audio").toMatch(/pauseGenerativeForContext\(\)/);
    expect(body, "the visible edge must best-effort resume the AudioContext").toMatch(/ensureContext\(\)/);
  });

  it("the save lifecycle installs pagehide AND beforeunload safety nets", () => {
    const saveLifecycle = read("src/persistence/save-lifecycle.ts");
    expect(saveLifecycle).toMatch(/addEventListener\("pagehide"/);
    expect(saveLifecycle).toMatch(/addEventListener\("beforeunload"/);
    expect(saveLifecycle).toMatch(/removeEventListener\("pagehide"/);
    expect(saveLifecycle).toMatch(/removeEventListener\("beforeunload"/);
  });

  it("every worker request has a bounded wait (a dead worker cannot hang the UI)", () => {
    const workerFiles = sourceFiles("src").filter((file) => read(file).includes("new Worker("));
    expect(workerFiles.length, "the worker inventory shrank unexpectedly — update this audit").toBeGreaterThan(10);
    for (const file of workerFiles) {
      const text = read(file);
      const bounded =
        text.includes("setTimeout(") ||
        text.includes("AbortSignal.timeout") ||
        text.includes("Promise.race(") ||
        text.includes("withTimeout");
      expect(
        bounded,
        `${file} spawns a worker with no bounded wait — a worker that dies without an error event leaves its promise pending forever`,
      ).toBe(true);
    }
  });
});
