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

  it("live and offline AudioClips use the same pitch-capable engine trigger", () => {
    const renderer = readSrc(RENDERER_PATH);
    const scheduler = readSrc(SCHEDULER_PATH);
    const services = readSrc(SERVICES_PATH);
    const triggerEngine = readFileSync(resolve(process.cwd(), "src/audio-engine/triggerEngine.ts"), "utf8");

    expect(scheduler, "the live song scheduler must dispatch arrangement AudioClips").toMatch(
      /this\.deps\.triggerAudioClip\s*\(/,
    );
    expect(services, "the service bridge must route live clips to AudioEngine.triggerAudioClip").toMatch(
      /triggerAudioClip:\s*\(clip,\s*when,\s*durationSec,\s*resumeOffsetSec\)\s*=>\s*engine\.triggerAudioClip\s*\(/,
    );
    expect(renderer, "the offline renderer must dispatch clips through engine.triggerAudioClip").toMatch(
      /engine\.triggerAudioClip\s*\(clip,\s*when,\s*durationSec\)/,
    );
    expect(triggerEngine, "the shared clip trigger must apply independent pitch offsets").toMatch(
      /const pitchSemitones\s*=.*clip\.pitchSemitones[\s\S]*?computePitchShiftedBuffer/,
    );
  });

  it("offline scheduleModulatorsOffline is the same code path as live applyModulators", () => {
    // Defect A07.D2 (offline render audit): the live scheduler calls
    // `engine.applyModulators` once per 25 ms window; the offline
    // renderer must not re-implement that logic (different RNG state,
    // different smoothing, or different param ramps would silently
    // diverge live from export). The structural fix is to make the
    // offline path call the same function.
    // Wave 4d: the modulator layer lives in AutomationBridge (verbatim move);
    // the engine keeps a one-line delegate.
    const engine = readFileSync(resolve(process.cwd(), "src/audio-engine/automationBridge.ts"), "utf8");
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
    // The default tail resolves through resolveRenderTailSeconds (explicit
    // override honored; fallback 2 scaled up to the deepest DRIFT reverb's
    // T60, bounded [2,12] — exports capture the real decay, not a fixed 2 s).
    expect(renderer).toMatch(/options\.tailSeconds\s*\?\?\s*resolveRenderTailSeconds\(doc\)/);
    // The tail must be added to the duration, not subtracted.
    expect(renderer).toMatch(/const duration\s*=\s*\([\s\S]*?\)\s*\+\s*tail/);
  });

  it("offline render disposes its throwaway engine on every path (no per-export graph accumulation)", () => {
    // The engine-level BEHAVIOUR is covered by audio-engine-lifecycle-stress
    // (dispose releases the graph and never closes a caller-owned context).
    // This structural pin exists because the renderer's wiring is the part a
    // refactor can silently drop: without dispose(), every export/stem/bounce
    // leaves a full offline graph (worklet nodes + runtimes) for GC instead of
    // releasing it deterministically.
    const renderer = readSrc(RENDERER_PATH);
    const detachIdx = renderer.indexOf("engine.detachBank()");
    expect(detachIdx, "the renderer lost its cleanup finally block").toBeGreaterThan(-1);
    const cleanup = renderer.slice(detachIdx, detachIdx + 500);
    expect(cleanup, "the throwaway render engine must dispose its graph").toMatch(/engine\.dispose\(\)/);
  });
});
