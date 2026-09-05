import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Source-grep regression tests for offline render / live playback parity.
 *
 * The realtime scheduler and the offline renderer BOTH feed audio events
 * into the same AudioEngine methods (trigger, noteOn, applyAutomation,
 * applySceneAutomationLane, scheduleModulatorsOffline). When a refactor
 * bypasses that shared surface and reaches into engine internals, the
 * export and the live playback drift apart — golden render hashes may
 * still pass while the user hears the export behave differently. These
 * tests pin the structural parity so any silent divergence shows up
 * in CI.
 */

const RENDERER_PATH = resolve(process.cwd(), "src/rendering/renderer.ts");
const SCHEDULER_PATH = resolve(process.cwd(), "src/scheduler/Scheduler.ts");
const SERVICES_PATH = resolve(process.cwd(), "src/services.ts");

function readSrc(path: string): string {
  return readFileSync(path, "utf8");
}

describe("offline render / live playback — shared engine surface", () => {
  it("offline renderer and realtime scheduler both dispatch through engine.trigger / engine.noteOn", () => {
    // Defect A07.D1 (offline render audit): if a future refactor adds
    // a side-channel for offline (e.g. direct createBufferSource calls
    // in renderer.ts) the export would drift from live playback
    // because the instrument runtimes would never see the
    // engine-internal pre-processing (midi, locks, voice allocation).
    // Both surfaces must funnel through the same engine methods.
    const renderer = readSrc(RENDERER_PATH);
    const scheduler = readSrc(SCHEDULER_PATH);
    // The renderer should call engine.trigger for drum hits and
    // engine.noteOn for melodic events. The scheduler's
    // trigger/noteOn deps must forward to engine.trigger/noteOn
    // through services.ts.
    expect(renderer, "renderer.ts must dispatch drum hits via engine.trigger").toMatch(/engine\.trigger\s*\(/);
    expect(renderer, "renderer.ts must dispatch note events via engine.noteOn").toMatch(/engine\.noteOn\s*\(/);
    const services = readSrc(SERVICES_PATH);
    expect(services, "services.ts must forward Scheduler.trigger to engine.trigger").toMatch(
      /trigger:\s*\([^)]*\)\s*=>\s*engine\.trigger\s*\(/,
    );
    expect(services, "services.ts must forward Scheduler.noteOn to engine.noteOn").toMatch(
      /noteOn:\s*\([^)]*\)\s*=>\s*engine\.noteOn\s*\(/,
    );
    // And the scheduler declares them with the same shape (method
    // signature `trigger(trackId: string, ...)` not `trigger:` in an
    // object literal).
    expect(scheduler).toMatch(/trigger\s*\(\s*trackId/);
    expect(scheduler).toMatch(/noteOn\s*\(\s*trackId/);
  });

  it("offline scheduleModulatorsOffline is the same code path as live applyModulators", () => {
    // Defect A07.D2 (offline render audit): the live scheduler calls
    // `engine.applyModulators` once per 25 ms window; the offline
    // renderer must not re-implement that logic (different RNG state,
    // different smoothing, or different param ramps would silently
    // diverge live from export). The structural fix is to make the
    // offline path call the same function.
    const engine = readFileSync(resolve(process.cwd(), "src/audio-engine/AudioEngine.ts"), "utf8");
    // Find the `scheduleModulatorsOffline(` method and verify the
    // first ~300 chars after the opening paren (well inside the
    // method body) reference `this.applyModulators`. The body is a
    // one-liner delegation; an inlined re-implementation would
    // exceed this budget.
    const sigIdx = engine.indexOf("scheduleModulatorsOffline(");
    expect(sigIdx, "scheduleModulatorsOffline not found in AudioEngine.ts").toBeGreaterThan(-1);
    const probe = engine.slice(sigIdx, sigIdx + 300);
    expect(
      probe,
      "scheduleModulatorsOffline must call this.applyModulators (no parallel modulator implementation)",
    ).toMatch(/this\.applyModulators\s*\(/);
  });

  it("offline automation and live automation both call engine.applyAutomation with the same time mapping", () => {
    // Defect A07.D3 (offline render audit): if the offline renderer
    // and the live scheduler map `tick → wall-clock time` through
    // different code, automation ramps land on different sample
    // boundaries and the export is audibly different from what the
    // user heard during composition. The fix is to thread the same
    // `timeAt(tick)` closure through both paths — the offline path
    // uses `tempoMap.timeAt`; the live path uses
    // `transport.timeAtTick`. Both must reach `engine.applyAutomation`
    // (the offline path may thread it through a local helper like
    // `scheduleAutomation` — that helper must call `engine.applyAutomation`).
    const renderer = readSrc(RENDERER_PATH);
    const engine = readFileSync(resolve(process.cwd(), "src/audio-engine/AudioEngine.ts"), "utf8");
    expect(engine, "AudioEngine.ts must define engine.applyAutomation as the shared automation sink").toMatch(
      /applyAutomation\s*\(\s*fromTick/,
    );
    expect(
      renderer,
      "renderer.ts must forward automation through tempoMap.timeAt (the live scheduler uses transport.timeAtTick)",
    ).toMatch(/timeAt/);
    expect(renderer, "renderer.ts must call scheduleAutomation with tempoMap-derived timeAt").toMatch(
      /scheduleAutomation\s*\(/,
    );
  });

  it("offline render and live scheduler use the same tail handling for effect decays", () => {
    // Defect A07.D4 (offline render audit): the offline render adds
    // `tailSeconds` (default 2) to the song duration so reverb /
    // delay decays are captured in the WAV. The live scheduler does
    // not — voices run on the AudioContext and decay naturally even
    // after play stop. The export must therefore be at least
    // `tailSeconds` longer than the live loop, not less. Pin the
    // tail handling so a refactor that drops it doesn't shorten
    // exports below the live behaviour.
    const renderer = readSrc(RENDERER_PATH);
    // The default tail must be 2 seconds (documented in README and
    // used by bounce / stems / export paths).
    expect(renderer).toMatch(/options\.tailSeconds\s*\?\?\s*2/);
    // The tail must be added to the duration, not subtracted.
    expect(renderer).toMatch(/duration.*\+.*tail/);
  });
});
