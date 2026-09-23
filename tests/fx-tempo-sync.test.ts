import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EFFECT_DEFS } from "../src/effects/registry";
import {
  LFO_SYNC_DIVISIONS,
  createLfoSyncController,
  lfoSyncIndex,
  syncedLfoHz,
} from "../src/effects/tempo-sync";
import type { EffectType } from "../src/project-model/types";

/**
 * C2 tempo-sync for the Hz-rate LFO effects (chorus, flanger, phaser,
 * tremolo, freqShifter LFO): a musical `sync` param locks the rate to the
 * transport (host-side division→Hz conversion, engine syncBpm hook), OFF
 * keeps the user's knob. Pump is division-native already; delay had its own
 * sync — both out of scope here.
 */

describe("syncedLfoHz", () => {
  it("converts bpm × division into Hz (triplets are 3×/2× per two divisions)", () => {
    expect(syncedLfoHz(120, 1, 0.6)).toBe(2); // 1/4 → one cycle per beat
    expect(syncedLfoHz(120, 2, 0.6)).toBe(4); // 1/8
    expect(syncedLfoHz(120, 3, 0.6)).toBe(6); // 1/8T
    expect(syncedLfoHz(120, 4, 0.6)).toBe(8); // 1/16
    expect(syncedLfoHz(120, 5, 0.6)).toBe(12); // 1/16T
    expect(syncedLfoHz(137, 2, 0.6)).toBeCloseTo((137 / 60) * 2, 10);
  });

  it("OFF (0) keeps the user's free-running Hz", () => {
    expect(syncedLfoHz(120, 0, 0.6)).toBe(0.6);
  });

  it("garbage tempo falls back to the free-running rate", () => {
    expect(syncedLfoHz(0, 2, 0.6)).toBe(0.6);
    expect(syncedLfoHz(Number.NaN, 4, 0.6)).toBe(0.6);
  });
});

describe("lfoSyncIndex", () => {
  it("sanitizes untrusted sync values", () => {
    expect(lfoSyncIndex(undefined)).toBe(0);
    expect(lfoSyncIndex("2" as unknown as number)).toBe(0);
    expect(lfoSyncIndex(Number.NaN)).toBe(0);
    expect(lfoSyncIndex(2.6)).toBe(3);
    expect(lfoSyncIndex(99)).toBe(LFO_SYNC_DIVISIONS.length - 1);
  });
});

describe("createLfoSyncController", () => {
  it("writes the initial (possibly synced) rate immediately", () => {
    const writes: [string, number, number | null][] = [];
    const ctrl = createLfoSyncController({
      rateParamId: "rate",
      defaultRate: 0.6,
      initialRate: 0.6,
      initialSync: 2,
      initialBpm: 120,
      write: (id, v, when) => writes.push([id, v, when]),
    });
    ctrl.parameter("rate", 0.6, null);
    expect(writes).toEqual([["rate", 4, null]]); // 1/8 at 120 bpm
  });

  it("rate changes pass through when OFF, are locked when synced", () => {
    const writes: [string, number, number | null][] = [];
    const ctrl = createLfoSyncController({
      rateParamId: "rate",
      defaultRate: 0.6,
      initialRate: 1.2,
      initialSync: 0,
      write: (id, v, when) => writes.push([id, v, when]),
    });
    ctrl.parameter("rate", 3, 5); // OFF: the knob rules
    expect(writes.at(-1)).toEqual(["rate", 3, 5]);
    ctrl.parameter("sync", 4, 5); // 1/16 at default 120? no bpm yet → fallback
    expect(writes.at(-1)![1]).toBe(3); // no bpm → keeps free Hz
    ctrl.syncBpm(120, 6); // now the grid takes over
    expect(writes.at(-1)).toEqual(["rate", 8, 6]);
    ctrl.parameter("rate", 99, 7); // ignored while synced — grid rules
    expect(writes.at(-1)).toEqual(["rate", 8, 7]);
    ctrl.parameter("sync", 0, 8); // back to free
    expect(writes.at(-1)).toEqual(["rate", 99, 8]); // user's last knob value restored
  });

  it("non-rate/sync params are not handled (caller falls through)", () => {
    const ctrl = createLfoSyncController({
      rateParamId: "rate",
      defaultRate: 0.6,
      write: () => undefined,
    });
    expect(ctrl.parameter("depth", 0.5, 0)).toBe(false);
    expect(ctrl.parameter("mix", 1, 0)).toBe(false);
  });
});

describe("registry wiring", () => {
  const SYNCED: EffectType[] = ["chorus", "flanger", "phaser", "tremolo", "freqShifter"];

  it("every Hz-rate LFO effect has a 6-option sync param, defaulting OFF", () => {
    for (const type of SYNCED) {
      const sync = EFFECT_DEFS[type].params.find((p) => p.id === "sync");
      expect(sync, `${type}.sync param`).toBeDefined();
      expect(sync!.options?.map((o) => o.label)).toEqual(["OFF", "1/4", "1/8", "1/8T", "1/16", "1/16T"]);
      expect(sync!.default).toBe(0);
    }
  });

  it("pump keeps its own division-native rate (no duplicate sync param)", () => {
    expect(EFFECT_DEFS.pump.params.some((p) => p.id === "sync")).toBe(false);
    expect(EFFECT_DEFS.pump.params.some((p) => p.id === "rate")).toBe(true);
  });

  it("factories hand the wrappers the live tempo (env.bpm)", () => {
    // Source-level wiring check — the wrappers cannot take a fake context
    // in unit tests, so the factory call shape is the contract here.
    const registry = readFileSync("src/effects/registry.ts", "utf8");
    for (const call of [
      "createChorusNode(ctx, instance, env.bpm)",
      "createFlangerNode(ctx, instance, env.bpm)",
      "createTremoloNode(ctx, instance, env.bpm)",
      "createFreqShiftNode(ctx, instance, env.bpm)",
    ]) {
      expect(registry.includes(call), call).toBe(true);
    }
    for (const wrapper of ["chorus-node", "flanger-node", "tremolo-node", "freqshifter-node"]) {
      const src = readFileSync(`src/audio-worklets/${wrapper}.ts`, "utf8");
      expect(src.includes("createLfoSyncController"), `${wrapper} uses the sync controller`).toBe(true);
      expect(/syncBpm\(/.test(src), `${wrapper} exposes syncBpm`).toBe(true);
    }
  });
});

describe('offline scene-BPM seam (timestamped syncBpm)', () => {
  // The offline renderer pushes per-window BPM at the window's START TIME;
  // AudioParam-backed runtimes must SCHEDULE there, not at ctx.currentTime
  // (0 in an OfflineAudioContext — the last window used to win globally).

  it('the renderer anchors each window push at its tempo-map time; the engine fans when out', () => {
    const renderer = readFileSync('src/rendering/renderer.ts', 'utf8');
    expect(renderer).toContain('engine.setEffectiveBpm(window.bpm ?? null, timeAt(window.from))');
    const engine = readFileSync('src/audio-engine/AudioEngine.ts', 'utf8');
    expect(engine).toContain('setEffectiveBpm(bpm: number | null, when?: number)');
    expect(engine).toContain('rt.syncBpm?.(bpm, when)');
    expect(engine).toContain('inst.runtime.syncBpm?.(bpm, when)');
    // The change-guard must not swallow scheduled 120→140→120 pushes.
    expect(engine).toContain('if (when === undefined && this.syncedBpm === bpm) return;');
  });

  it('every AudioParam-backed runtime honors when (falls back to ctx.currentTime live)', () => {
    const ducking = readFileSync('src/audio-worklets/ducking-delay-node.ts', 'utf8');
    expect(ducking).toContain('safeApplyAudioParam(node, "time", nextMs, when ?? ctx.currentTime)');
    const registry = readFileSync('src/effects/registry.ts', 'utf8');
    // Pump-key oscillator, native-chorus LFO pair, LFO-sync wrapper, multitap.
    expect(registry).toContain('smooth(osc.frequency, freqOf(), when ?? ctx.currentTime, 0.05)');
    expect(registry).toContain('lfoSync.syncBpm(nextBpm, when ?? ctx.currentTime)');
    // Native-chorus fallback: the syncBpm(bpm, when) body schedules at `at`.
    expect(registry).toContain('syncBpm(bpm, when) {');
    expect(registry).toContain('const at = when ?? ctx.currentTime;');
    expect(registry).toContain('tapNodes[t].delay.delayTime.setTargetAtTime(multitapDelaySec(divisions[t], bpm), at, 0.05)');
    // Contract carries the optional timestamp.
    const types = readFileSync('src/effects/types.ts', 'utf8');
    expect(types).toContain('syncBpm?(bpm: number, when?: number): void');
  });

  it('message-port runtimes are documented last-write-wins (vendor constraint)', () => {
    // beatmangler / stepgate / stutter / fxeq / ozvena / granular forward BPM
    // over the port — processors cannot schedule, so offline renders keep
    // last-write-wins for them BY DESIGN (the engine comment pins it).
    const engine = readFileSync('src/audio-engine/AudioEngine.ts', 'utf8');
    expect(engine).toContain('last-write-wins across offline windows');
  });
});
