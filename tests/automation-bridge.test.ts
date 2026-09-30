import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DeviceLookup } from "../src/audio-engine/deviceLookup";
import type { DeviceLookupDeps } from "../src/audio-engine/deviceLookup";

/**
 * Wave 4d (AudioEngine decomposition) — DeviceLookup + AutomationBridge pins.
 *
 * Step 1 extracted the five shared device-target resolvers so graph sync and
 * the automation bridge consume ONE resolution source; step 2 moved the
 * whole modulation/automation write layer (LFO runtime buses, macro/
 * intensity composer, schedulable modulators, scene lanes, automation
 * writers, stop takeover, MIDI CC). The load-bearing invariants: the
 * facade law (neither module imports AudioEngine), the single-writer
 * composition law, and the exact public surface kept as engine delegates.
 */

const ENGINE = resolve(process.cwd(), "src/audio-engine/AudioEngine.ts");
const BRIDGE = resolve(process.cwd(), "src/audio-engine/automationBridge.ts");
const LOOKUP = resolve(process.cwd(), "src/audio-engine/deviceLookup.ts");

function makeLookupDeps(overrides: Partial<DeviceLookupDeps> = {}): DeviceLookupDeps {
  return {
    doc: () => null,
    trackNodes: () => undefined,
    groupNodes: () => undefined,
    returnNodes: () => undefined,
    instrumentStates: () => new Map(),
    ...overrides,
  };
}

describe("DeviceLookup (Wave 4d step 1)", () => {
  it("facade law: never imports AudioEngine", () => {
    const src = readFileSync(LOOKUP, "utf8");
    expect(/from\s+"\.\/AudioEngine"/.test(src)).toBe(false);
    expect(/from\s+"[^"]*audio-engine\/AudioEngine"/.test(src)).toBe(false);
  });

  it("resolves an FX runtime across track/group/return ownership", () => {
    const rt = { setParameter: () => {} };
    const trackMap = new Map([
      ["t1", { fx: { runtimes: new Map([["fx1", rt]]) }, modAutoGain: { gain: {} }, modAutoPan: { pan: {} } }],
    ]);
    const lookup = new DeviceLookup(
      makeLookupDeps({
        trackNodes: (id) => trackMap.get(id) as never,
      }),
    );
    expect(lookup.effectRuntimeForTarget({ kind: "fxParam", trackId: "t1", fxId: "fx1", paramId: "p" })).toBe(rt);
    expect(lookup.effectRuntimeForTarget({ kind: "fxParam", trackId: "tX", fxId: "fx1", paramId: "p" })).toBeNull();
    // Non-fxParam targets never resolve an FX runtime.
    expect(lookup.effectRuntimeForTarget({ kind: "instParam", trackId: "t1", paramId: "p" })).toBeNull();
  });

  it("writeDeviceTargetAt refuses a runtime-less target and unknown params (doc-bound validation)", () => {
    const lookup = new DeviceLookup(makeLookupDeps({ doc: () => null }));
    // No doc → runtime fallback path: no runtime → false.
    expect(lookup.writeDeviceTargetAt({ kind: "fxParam", trackId: "t1", fxId: "fx", paramId: "p" }, 1)).toBe(false);
    // No paramId at all → immediate false.
    expect(lookup.writeDeviceTargetAt({ kind: "instParam", trackId: "t1", paramId: undefined } as never, 1)).toBe(
      false,
    );
  });
});

describe("AutomationBridge (Wave 4d step 2)", () => {
  it("facade law: never imports AudioEngine", () => {
    const src = readFileSync(BRIDGE, "utf8");
    expect(/from\s+"\.\/AudioEngine"/.test(src)).toBe(false);
    expect(/from\s+"[^"]*audio-engine\/AudioEngine"/.test(src)).toBe(false);
  });

  it("owns the moved writer layer verbatim (method inventory)", () => {
    const src = readFileSync(BRIDGE, "utf8");
    for (const marker of [
      "syncLfos(doc: ProjectDocument): void {",
      "syncMacros(doc: ProjectDocument): void {",
      "setSceneIntensity(value: number): void {",
      "scheduleSceneIntensity(points:",
      "applySceneAutomationLane(",
      "applyModulators(fromTick:",
      "scheduleModulatorsOffline(windows:",
      "applyEnvFollowersToParams(): void {",
      "applyAutomation(",
      "scheduleTrackAutomation(",
      "scheduleDeviceAutomation(",
      "automationReset(): void {",
      "applyMidiCc(target: AutomationTarget, value: number): void {",
      "disposeLfos(): void {",
      "degradedLfos():",
    ]) {
      expect(src.includes(marker), `missing: ${marker}`).toBe(true);
    }
  });

  it("engine keeps the exact public surface as delegates (no stale writer state)", () => {
    const src = readFileSync(ENGINE, "utf8");
    for (const marker of [
      "this.automation.syncLfos(doc);",
      "this.automation.syncMacros(doc);",
      "this.automation.automationReset();",
      "this.automation.applyMidiCc(target, value);",
      "this.automation.disposeLfos();",
      "this.automation.degradedLfos()",
      "activeLfos: this.automation.lfoCount,",
    ]) {
      expect(src.includes(marker), `missing: ${marker}`).toBe(true);
    }
    for (const gone of [
      "private lfos = new Map",
      "private macroCache = new Map",
      "private currentSceneIntensity",
      "private writeDeviceTargetAt(",
      "private resolveModTargetParam(",
    ]) {
      expect(src.includes(gone), `stale engine member: ${gone}`).toBe(false);
    }
  });

  it("one resolution source: the engine routes device writes through the shared lookup", () => {
    const src = readFileSync(ENGINE, "utf8");
    expect(src).toMatch(/private deviceLookup = new DeviceLookup\(/);
    expect(src).toMatch(/private automation = new AutomationBridge\(/);
    // The bridge consumes the SAME lookup instance (single resolution source).
    expect(src).toMatch(/this\.deviceLookup,\s*\n\s*\);\s*\n/);
  });

  it("expandSceneLaneWindow re-exported from AudioEngine (offline-mirror test contract)", () => {
    const src = readFileSync(ENGINE, "utf8");
    expect(src).toMatch(/export \{ expandSceneLaneWindow \} from "\.\/automationBridge"/);
    const bridge = readFileSync(BRIDGE, "utf8");
    expect(bridge).toMatch(/export function expandSceneLaneWindow\(/);
  });

  it("degradedLfos surfaces follower degradation entries only", () => {
    // Structural check over the bridge source: degraded reporting reads the
    // follower states; osc runtimes never carry a degradedReason.
    const src = readFileSync(BRIDGE, "utf8");
    expect(src).toMatch(/if \(!isOscRuntime\(state\) && state\.degradedReason\)/);
  });
});
