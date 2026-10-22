import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { createDrumTrackModel, normalizeProject } from "../src/project-model/schema";
import type { ProjectDocument, EffectInstance } from "../src/project-model/types";

/**
 * METERING STATE MUST SURVIVE A CHAIN REBUILD FOR EFFECTS THAT STILL EXIST.
 *
 * `setFxMetersEnabled` is a PANEL-LIFETIME gate: an open Ultina panel turns it
 * on when it mounts and off when it unmounts (AudioEngine.ts:2890). The
 * engine's own comment on the setter promises the other half of that contract —
 * "the desired state is remembered and re-applied when chain rebuilds recreate
 * the runtime" — and the rebuild does re-read the flag at line 1240.
 *
 * But the rebuild also DELETED the flag first, for every id it had seen:
 *
 *     for (const fxId of state.params.keys()) this.fxMetersEnabled.delete(fxId);
 *
 * `state.params` holds the PREVIOUS chain, so that line fires on any rebuild —
 * insert, remove, reorder, bypass — not only for effects that actually went
 * away. The comment above it explains why it exists ("must not survive as
 * unreachable entries that grow across every add/remove/reorder"), which is a
 * real concern, but it conflates "this instance was replaced" with "this effect
 * is gone".
 *
 * Observable consequence, no audio required: with a panel open, reorder two
 * effects and the panel's metering silently switches off, and since the panel
 * only registers on mount/unmount it never turns back on. Analysis-heavy
 * effects (Ultina) then run with no analysis while the panel still displays
 * meters as active.
 *
 * The engine also disposes the RUNTIME, so the flag is the only surviving
 * record of what the panel asked for. Deleting it is the whole bug.
 */

function param(initial = 0) {
  let value = initial;
  const events: Array<{ kind: string; value: number; time?: number }> = [];
  return {
    events,
    get value() {
      return value;
    },
    set value(v: number) {
      value = v;
    },
    setTargetAtTime(v: number, time?: number) {
      value = v;
      events.push({ kind: "target", value: v, time });
    },
    setValueAtTime(v: number, time?: number) {
      value = v;
      events.push({ kind: "set", value: v, time });
    },
    linearRampToValueAtTime(v: number, time?: number) {
      value = v;
      events.push({ kind: "ramp", value: v, time });
    },
    cancelScheduledValues(time?: number) {
      events.push({ kind: "cancel", value, time });
    },
    cancelAndHoldAtTime(time?: number) {
      events.push({ kind: "hold", value, time });
    },
  };
}

function nodeWith(params: Record<string, ReturnType<typeof param>> = {}) {
  const node: Record<string, unknown> = {
    connections: new Set<unknown>(),
    gain: params.gain ?? param(1),
    pan: params.pan ?? param(0),
    ...params,
    connect(destination?: unknown) {
      if (destination !== undefined) (node.connections as Set<unknown>).add(destination);
      return node;
    },
    disconnect(destination?: unknown) {
      const set = node.connections as Set<unknown>;
      if (destination === undefined) set.clear();
      else set.delete(destination);
    },
  };
  return node;
}

/** One node shape carrying every AudioParam the engine and master chain write.
    Spread into every factory, so a missing param cannot masquerade as a
    product defect in a failure message. */
function mockNode() {
  const base = nodeWith();
  return {
    ...base,
    frequency: param(440),
    Q: param(1),
    threshold: param(0),
    ratio: param(1),
    attack: param(0),
    release: param(0),
    knee: param(0),
    delayTime: param(0),
  };
}

class MockLiveAudioContext {}

function mockCtx() {
  const constantSources: Array<{
    onended: (() => void) | null;
    connections: Set<unknown>;
    fireEnded: () => void;
  }> = [];
  const ctx = {
    constantSources,
    currentTime: 0,
    sampleRate: 48000,
    state: "running",
    createGain: () => mockNode(),
    createStereoPanner: () => mockNode(),
    createAnalyser: () => ({
      ...mockNode(),
      fftSize: 2048,
      channelCount: 2,
      channelCountMode: "explicit",
      getFloatTimeDomainData() {},
      getByteTimeDomainData() {},
      getByteFrequencyData() {},
      getFloatFrequencyData() {},
    }),
    createDelay: () => mockNode(),
    createDynamicsCompressor: () => ({ ...mockNode(), reduction: 0 }),
    createBiquadFilter: () => ({ ...mockNode(), type: "lowpass" }),
    createChannelSplitter: () => mockNode(),
    createChannelMerger: () => mockNode(),
    createWaveShaper: () => ({ ...mockNode(), oversample: "none" as OverSampleType, curve: null }),
    createConstantSource: () => {
      const base = mockNode();
      const source = {
        ...base,
        connections: (base as unknown as { connections: Set<unknown> }).connections,
        offset: param(0),
        onended: null as (() => void) | null,
        start() {},
        stop() {},
        fireEnded() {
          source.onended?.();
        },
      };
      constantSources.push(source);
      return source;
    },
    createOscillator: () => ({ ...mockNode(), type: "sine", start() {}, stop() {} }),
    createBufferSource: () => ({ ...mockNode(), buffer: null, playbackRate: param(1), start() {}, stop() {} }),
    createBuffer: (channels: number, len: number, rate: number) => ({
      length: len,
      sampleRate: rate,
      numberOfChannels: channels,
      getChannelData: () => new Float32Array(len),
    }),
    decodeAudioData: async () => ({
      duration: 1,
      sampleRate: 48000,
      numberOfChannels: 2,
      length: 48000,
      getChannelData: () => new Float32Array(48000),
    }),
    audioWorklet: { addModule: async () => {} },
    destination: mockNode(),
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  Object.setPrototypeOf(ctx, MockLiveAudioContext.prototype);
  return ctx;
}

// ONE track instance for the whole spec. `createDrumTrackModel` mints a random
// id per call, so building a fresh doc per step would give the engine a
// DIFFERENT track each time — it would then legitimately dispose the previous
// strip, and `disposeTrackNodes` clears every meter flag on the way out. That
// is correct product behaviour measuring a broken harness, not a defect.
const TRACK_ID = createDrumTrackModel("Drums").id;

function docWith(effects: EffectInstance[]) {
  const base = normalizeProject({
    schemaVersion: 32,
    id: "meter-state",
    name: "Meter state",
    bpm: 124,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [],
    patterns: [],
    activePatternId: "",
    scenes: [],
    arrangement: { clips: [] },
    markers: [],
    sceneAutomation: [],
    automation: [],
    lfos: [],
    macros: [],
    returns: [],
    master: { masterGain: 1, ceilingDb: -1, limiterEnabled: false, clipperEnabled: false },
    createdAt: "",
    updatedAt: "",
  } as unknown as ProjectDocument);
  const track = { ...createDrumTrackModel("Drums"), id: TRACK_ID, effects };
  return { ...base, tracks: [track] } as unknown as ProjectDocument;
}

const fx = (id: string, type: string, bypassed = false): EffectInstance =>
  ({ id, type, bypassed, params: {} }) as unknown as EffectInstance;

const flags = (engine: AudioEngine) => (engine as unknown as { fxMetersEnabled: Map<string, boolean> }).fxMetersEnabled;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function engineWith(effects: EffectInstance[]) {
  const engine = new AudioEngine();
  engine.useContext(mockCtx() as unknown as BaseAudioContext);
  engine.setProject(docWith(effects));
  await flush();
  return engine;
}

describe("effect metering state across chain rebuilds", () => {
  it("keeps a still-present effect's metering request when an effect is added", async () => {
    const engine = await engineWith([fx("fx-eq", "eq")]);
    engine.setFxMetersEnabled(TRACK_ID, "fx-eq", true);
    expect(flags(engine).get("fx-eq")).toBe(true);

    // Insert a second effect: the chain signature changes, so the whole chain
    // is rebuilt and every runtime is disposed and recreated.
    engine.setProject(docWith([fx("fx-eq", "eq"), fx("fx-comp", "compressor")]));
    await flush();

    expect(flags(engine).get("fx-eq"), "metering for a still-present effect was dropped by the rebuild").toBe(true);
  });

  it("keeps a still-present effect's metering request when the chain is reordered", async () => {
    const engine = await engineWith([fx("fx-eq", "eq"), fx("fx-comp", "compressor")]);
    engine.setFxMetersEnabled(TRACK_ID, "fx-eq", true);

    engine.setProject(docWith([fx("fx-comp", "compressor"), fx("fx-eq", "eq")]));
    await flush();

    expect(flags(engine).get("fx-eq"), "metering did not survive a reorder").toBe(true);
  });

  it("keeps metering across a bypass toggle of a DIFFERENT effect", async () => {
    const engine = await engineWith([fx("fx-eq", "eq"), fx("fx-comp", "compressor")]);
    engine.setFxMetersEnabled(TRACK_ID, "fx-eq", true);

    engine.setProject(docWith([fx("fx-eq", "eq"), fx("fx-comp", "compressor", true)]));
    await flush();

    expect(flags(engine).get("fx-eq"), "bypassing a sibling effect cleared this effect's metering").toBe(true);
  });

  // The leak the original line was written to prevent must stay prevented.
  it("still forgets metering for an effect that was actually REMOVED", async () => {
    const engine = await engineWith([fx("fx-eq", "eq"), fx("fx-comp", "compressor")]);
    engine.setFxMetersEnabled(TRACK_ID, "fx-eq", true);
    engine.setFxMetersEnabled(TRACK_ID, "fx-comp", true);

    engine.setProject(docWith([fx("fx-eq", "eq")]));
    await flush();

    expect(flags(engine).has("fx-comp"), "a removed effect's meter flag leaked").toBe(false);
    expect(flags(engine).get("fx-eq")).toBe(true);
  });

  it("keeps metering for a bypassed-but-present effect so unbypass restores it", async () => {
    const engine = await engineWith([fx("fx-eq", "eq")]);
    engine.setFxMetersEnabled(TRACK_ID, "fx-eq", true);

    engine.setProject(docWith([fx("fx-eq", "eq", true)]));
    await flush();
    expect(flags(engine).get("fx-eq"), "bypassing an effect dropped its panel's metering request").toBe(true);

    engine.setProject(docWith([fx("fx-eq", "eq")]));
    await flush();
    expect(flags(engine).get("fx-eq"), "un-bypass did not restore metering").toBe(true);
  });
});

/**
 * CHURN ACCOUNTING — "repeated insertion/removal + cleanup after deletion".
 *
 * This is the least-covered item in the hosting layer's whole checklist. The
 * existing gates cannot see it: `fx-node-dispose.test.ts` calls
 * `runtime.dispose()` directly on two flagship wrappers rather than going
 * through the engine, and `audio-engine-lifecycle-stress.test.ts` counts only
 * nodes that carry a `connections` field — `FxChainState` has none, so fx
 * runtimes are invisible to it by construction. Nothing churned a chain and
 * checked that the engine's own bookkeeping came back to baseline.
 *
 * These do. Each assertion is on a map the engine owns, not on a side effect,
 * so a leak shows up as a count that only ever grows.
 */
describe("effect chain churn returns to baseline", () => {
  const fxState = (engine: AudioEngine) => {
    const nodes = (
      engine as unknown as {
        trackNodes: Map<string, { fx: { runtimes: Map<string, unknown>; params: Map<string, unknown> } }>;
      }
    ).trackNodes.get(TRACK_ID);
    return nodes?.fx;
  };

  it("runtime and param maps return to their baseline after repeated insert/remove", async () => {
    const engine = await engineWith([]);
    expect(fxState(engine)?.runtimes.size, "no baseline").toBe(0);

    for (let cycle = 0; cycle < 6; cycle += 1) {
      engine.setProject(docWith([fx(`fx-eq-${cycle}`, "eq"), fx(`fx-comp-${cycle}`, "compressor")]));
      await flush();
      expect(fxState(engine)?.runtimes.size, `cycle ${cycle}: runtimes missing`).toBe(2);
      expect(fxState(engine)?.params.size, `cycle ${cycle}: params missing`).toBe(2);

      engine.setProject(docWith([]));
      await flush();
      expect(fxState(engine)?.runtimes.size, `cycle ${cycle}: runtimes leaked back to empty chain`).toBe(0);
      expect(fxState(engine)?.params.size, `cycle ${cycle}: params leaked back to empty chain`).toBe(0);
    }
  });

  it("meter flags return to their baseline after repeated insert/remove", async () => {
    const engine = await engineWith([]);

    for (let cycle = 0; cycle < 6; cycle += 1) {
      engine.setProject(docWith([fx(`fx-eq-${cycle}`, "eq")]));
      await flush();
      engine.setFxMetersEnabled(TRACK_ID, `fx-eq-${cycle}`, true);
      expect(flags(engine).size, `cycle ${cycle}: the live effect's flag is missing`).toBe(1);

      engine.setProject(docWith([]));
      await flush();
      expect(flags(engine).size, `cycle ${cycle}: meter flag leaked after removal`).toBe(0);
    }
  });

  it("bypass toggling back and forth never grows the runtime map", async () => {
    const engine = await engineWith([fx("fx-eq", "eq"), fx("fx-comp", "compressor")]);
    expect(fxState(engine)?.runtimes.size).toBe(2);

    for (let cycle = 0; cycle < 8; cycle += 1) {
      const bypassed = cycle % 2 === 0;
      engine.setProject(docWith([fx("fx-eq", "eq"), fx("fx-comp", "compressor", bypassed)]));
      await flush();
      expect(fxState(engine)?.runtimes.size, `cycle ${cycle}: a bypassed effect holds a runtime`).toBe(
        bypassed ? 1 : 2,
      );
      expect(fxState(engine)?.params.size, `cycle ${cycle}: param cache does not track the runtime`).toBe(
        bypassed ? 1 : 2,
      );
    }
  });
});

describe("live FX chain rebuild transition", () => {
  it("crossfades to the replacement and retires the old runtime on the audio clock", async () => {
    const engine = new AudioEngine();
    const ctx = mockCtx();
    engine.useContext(ctx as unknown as BaseAudioContext);
    await flush();
    vi.stubGlobal("AudioContext", MockLiveAudioContext);
    try {
      await engine.setProject(docWith([fx("fx-sat", "saturation")]));
      const internals = engine as unknown as {
        trackNodes: Map<
          string,
          {
            fx: {
              runtimes: Map<string, unknown>;
              outputGain: { gain: { events: Array<{ kind: string; value: number }> }; connections: Set<unknown> };
              retiring?: Set<{
                outputGain: { connections: Set<unknown> };
                input: { connections: Set<unknown> };
                chainInput: { connections: Set<unknown> };
                disposed: boolean;
                clock: { fireEnded: () => void };
              }>;
            };
          }
        >;
      };
      const state = internals.trackNodes.get(TRACK_ID)!.fx;
      const oldOutput = state.outputGain;
      await engine.setProject(docWith([fx("fx-sat", "saturation"), fx("fx-phaser", "phaser")]));
      await flush();

      expect(state.outputGain).not.toBe(oldOutput);
      expect(oldOutput.gain.events.some((event) => event.kind === "ramp" && event.value === 0)).toBe(true);
      expect(state.outputGain.gain.events.some((event) => event.kind === "ramp" && event.value === 1)).toBe(true);
      expect(state.retiring?.size).toBe(1);
      expect(ctx.constantSources).toHaveLength(1);

      const retired = [...state.retiring!][0]!;
      expect(retired.disposed).toBe(false);
      expect(retired.input.connections.has(retired.chainInput)).toBe(true);
      retired.clock.fireEnded();
      expect(retired.disposed).toBe(true);
      expect(retired.input.connections.has(retired.chainInput)).toBe(false);
      expect(retired.outputGain.connections.size).toBe(0);
      expect(state.retiring?.size).toBe(0);
    } finally {
      engine.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("releases a pending old branch if the engine is disposed before its crossfade ends", async () => {
    const engine = new AudioEngine();
    const ctx = mockCtx();
    engine.useContext(ctx as unknown as BaseAudioContext);
    await flush();
    vi.stubGlobal("AudioContext", MockLiveAudioContext);
    try {
      await engine.setProject(docWith([fx("fx-sat", "saturation")]));
      const internals = engine as unknown as {
        trackNodes: Map<
          string,
          {
            fx: {
              retiring?: Set<{
                outputGain: { connections: Set<unknown> };
                disposed: boolean;
                clock: { onended: (() => void) | null };
              }>;
            };
          }
        >;
      };
      await engine.setProject(docWith([fx("fx-sat", "saturation"), fx("fx-phaser", "phaser")]));
      await flush();
      const retired = [...internals.trackNodes.get(TRACK_ID)!.fx.retiring!][0]!;

      engine.dispose();

      expect(retired.disposed).toBe(true);
      expect(retired.clock.onended).toBeNull();
      expect(retired.outputGain.connections.size).toBe(0);
    } finally {
      engine.dispose();
      vi.unstubAllGlobals();
    }
  });
});
