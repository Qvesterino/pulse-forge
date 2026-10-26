import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import { createDrumTrackModel, normalizeProject } from "../src/project-model/schema";
import { EFFECT_DEFS } from "../src/effects/registry";
import type { ProjectDocument, EffectInstance } from "../src/project-model/types";
import type { EffectRuntime } from "../src/effects/types";

/**
 * A BYPASS TOGGLE IS A PARAMETER WRITE, NOT A CHAIN REBUILD (ADR 0068).
 *
 * The performance-cliff audit (finding C-5) found that toggling one effect's
 * bypass tore down that track's ENTIRE effect chain: `fxSignature` filtered
 * bypassed effects OUT of the signature, so the signature changed, so
 * `rebuildFxChain` ran, so every runtime on the track was disposed and
 * re-created. Every effect on the track lost its state — a delay tail, a
 * reverb decay — and the audio graph was churned under playback.
 *
 * The fix keeps every effect in the chain AND in the signature, and makes the
 * bypass a wet/dry crossfade. The audit's own acceptance gate for this
 * priority was: "a new spec asserts that the effect's node identity is
 * unchanged across a bypass toggle".
 *
 * This file IS that spec. It counts:
 *   - the runtime INSTANCES (identity, not count — a rebuild replaces them),
 *   - the NODES the context creates,
 *   - the times an effect FACTORY runs,
 *   - the compensation delay the PDC writes.
 *
 * Counts, not milliseconds: they do not care how busy the machine is, and
 * they do not need an audio device.
 */

// ---------------------------------------------------------------------------
// A counting, LIVE mock context (the census harness + the live prototype).
// ---------------------------------------------------------------------------

function param(initial = 0) {
  let value = initial;
  return {
    get value() {
      return value;
    },
    set value(v: number) {
      value = v;
    },
    setTargetAtTime(v: number) {
      value = v;
    },
    setValueAtTime(v: number) {
      value = v;
    },
    linearRampToValueAtTime(v: number) {
      value = v;
    },
    cancelScheduledValues() {},
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

function countingLiveCtx() {
  const counts: Record<string, number> = {};
  const bump = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  const ctx = {
    count: () => Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    currentTime: 0,
    sampleRate: 48000,
    state: "running",
    createGain: () => (bump("gain"), mockNode()),
    createStereoPanner: () => (bump("panner"), mockNode()),
    createAnalyser: () => (
      bump("analyser"),
      {
        ...mockNode(),
        fftSize: 0,
        channelCount: 2,
        channelCountMode: "explicit",
        getFloatTimeDomainData() {},
        getByteFrequencyData() {},
      }
    ),
    createDelay: () => (bump("delay"), mockNode()),
    createDynamicsCompressor: () => (bump("compressor"), { ...mockNode(), reduction: 0 }),
    createBiquadFilter: () => (bump("biquad"), { ...mockNode(), type: "lowpass" }),
    createChannelSplitter: () => (bump("splitter"), mockNode()),
    createChannelMerger: () => (bump("merger"), mockNode()),
    createWaveShaper: () => (
      bump("waveshaper"),
      { oversample: "none" as OverSampleType, curve: null, connect() {}, disconnect() {} }
    ),
    createConstantSource: () => (bump("constant"), { ...mockNode(), offset: param(0), start() {}, stop() {} }),
    createOscillator: () => (bump("oscillator"), { ...mockNode(), type: "sine", start() {}, stop() {} }),
    createBufferSource: () => (
      bump("bufferSource"),
      { ...mockNode(), buffer: null, playbackRate: param(1), start() {}, stop() {} }
    ),
    createBuffer: (channels: number, len: number, rate: number) => ({
      length: len,
      sampleRate: rate,
      numberOfChannels: channels,
      getChannelData: () => new Float32Array(len),
    }),
    decodeAudioData: async () => ({
      duration: 1,
      sampleRate: 48000,
      length: 48000,
      numberOfChannels: 2,
      getChannelData: () => new Float32Array(48000),
    }),
    // The core worklets must NOT land: a landed worklet makes the engine take
    // the AudioWorkletNode path, and that global does not exist outside a
    // browser. A never-resolving addModule keeps every effect on its native
    // fallback — which is also what a user with no worklet support gets.
    audioWorklet: { addModule: () => new Promise(() => {}) },
    destination: mockNode(),
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  Object.setPrototypeOf(ctx, MockLiveAudioContext.prototype);
  return ctx;
}

// ---------------------------------------------------------------------------
// The document.
// ---------------------------------------------------------------------------

// ONE track id for the whole spec: `createDrumTrackModel` mints a random id
// per call, so a fresh doc per step would give the engine a DIFFERENT track —
// it would legitimately dispose the previous strip, and that is correct
// product behaviour measuring a broken harness, not a defect.
const TRACK_A = createDrumTrackModel("A").id;
const TRACK_B = createDrumTrackModel("B").id;

function docWith(tracks: { id: string; effects: EffectInstance[] }[]) {
  const base = normalizeProject({
    schemaVersion: 32,
    id: "bypass-parameter",
    name: "Bypass parameter",
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
  const list = tracks.map((t) => ({ ...createDrumTrackModel(t.id), id: t.id, effects: t.effects }));
  return { ...base, tracks: list } as unknown as ProjectDocument;
}

const fx = (id: string, type: string, bypassed = false): EffectInstance =>
  ({ id, type, bypassed, params: {} }) as unknown as EffectInstance;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface FxChainView {
  runtimes: Map<string, unknown>;
  bypass: Map<string, { dryGain: { gain: { value: number } }; trimGain: { gain: { value: number } } }>;
  pdcDelay: { delayTime: { value: number } } | null;
}

function chainOf(engine: AudioEngine, trackId: string): FxChainView {
  const internals = engine as unknown as { trackNodes: Map<string, { fx: FxChainView }> };
  return internals.trackNodes.get(trackId)!.fx;
}

function syncPdc(engine: AudioEngine): void {
  (engine as unknown as { syncPdc: () => void }).syncPdc();
}

async function engineWith(doc: ProjectDocument) {
  const ctx = countingLiveCtx();
  const engine = new AudioEngine();
  vi.stubGlobal("AudioContext", MockLiveAudioContext);
  engine.useContext(ctx as unknown as BaseAudioContext);
  engine.setProject(doc);
  await flush();
  return { engine, ctx };
}

// ---------------------------------------------------------------------------
// The gates.
// ---------------------------------------------------------------------------

describe("a bypass toggle is a parameter write (ADR 0068)", () => {
  it("keeps the runtime identity, the node count and the factory count across a toggle", async () => {
    const { engine, ctx } = await engineWith(
      docWith([{ id: TRACK_A, effects: [fx("fx-eq", "eq"), fx("fx-comp", "compressor")] }]),
    );
    const chain = chainOf(engine, TRACK_A);

    const runtimesBefore = [...chain.runtimes.values()];
    const nodesBefore = ctx.count();
    const factory = vi.spyOn(EFFECT_DEFS.eq, "factory");

    engine.setProject(docWith([{ id: TRACK_A, effects: [fx("fx-eq", "eq"), fx("fx-comp", "compressor", true)] }]));
    await flush();

    // The factory must not run again: a rebuild would re-instantiate.
    expect(factory, "the eq factory ran again — the chain was rebuilt").not.toHaveBeenCalled();
    factory.mockRestore();

    const runtimesAfter = [...chain.runtimes.values()];
    expect(runtimesAfter.length, "an effect left the chain").toBe(runtimesBefore.length);
    for (const [i, runtime] of runtimesBefore.entries()) {
      expect(runtimesAfter[i], "the runtime was REPLACED — the chain was rebuilt").toBe(runtime);
    }
    expect(ctx.count(), "the graph grew — nodes were created").toBe(nodesBefore);
  });

  it("moves the wet/dry gains and nothing else", async () => {
    const { engine } = await engineWith(docWith([{ id: TRACK_A, effects: [fx("fx-eq", "eq")] }]));
    const chain = chainOf(engine, TRACK_A);
    const wiring = chain.bypass.get("fx-eq")!;

    // Live: the wet path is open, the dry path closed.
    expect(wiring.dryGain.gain.value, "the dry path must be closed while the effect is live").toBe(0);
    expect(wiring.trimGain.gain.value, "the wet path must be open while the effect is live").toBe(1);

    engine.setProject(docWith([{ id: TRACK_A, effects: [fx("fx-eq", "eq", true)] }]));
    await flush();

    expect(wiring.dryGain.gain.value, "the dry path must open when the effect is bypassed").toBe(1);
    expect(wiring.trimGain.gain.value, "the wet path must mute when the effect is bypassed").toBe(0);

    engine.setProject(docWith([{ id: TRACK_A, effects: [fx("fx-eq", "eq")] }]));
    await flush();

    expect(wiring.dryGain.gain.value, "the dry path must close again").toBe(0);
    expect(wiring.trimGain.gain.value, "the wet path must open again").toBe(1);
  });

  it("counts a bypassed effect as no latency — with a positive control", async () => {
    // The mock has no worklet, so the latency report is injected: the engine
    // reads `getLatencySec()` from whatever runtime sits in the chain.
    const injectLatency = (engine: AudioEngine, trackId: string, fxId: string, seconds: number) => {
      chainOf(engine, trackId).runtimes.set(fxId, { getLatencySec: () => seconds } as unknown as EffectRuntime);
    };

    // --- POSITIVE CONTROL: the effect is LIVE, so its latency IS counted ---
    const live = await engineWith(
      docWith([
        { id: TRACK_A, effects: [fx("fx-lat", "eq")] },
        { id: TRACK_B, effects: [] },
      ]),
    );
    injectLatency(live.engine, TRACK_A, "fx-lat", 0.05);
    syncPdc(live.engine);
    const liveCompensation = chainOf(live.engine, TRACK_B).pdcDelay?.delayTime.value ?? 0;
    expect(liveCompensation, "the control must show the latency being counted").toBeCloseTo(0.05, 6);

    // --- The gate: the SAME effect, bypassed, contributes NO latency ---
    const muted = await engineWith(
      docWith([
        { id: TRACK_A, effects: [fx("fx-lat", "eq", true)] },
        { id: TRACK_B, effects: [] },
      ]),
    );
    injectLatency(muted.engine, TRACK_A, "fx-lat", 0.05);
    syncPdc(muted.engine);
    const mutedCompensation = chainOf(muted.engine, TRACK_B).pdcDelay?.delayTime.value ?? 0;
    expect(mutedCompensation, "a bypassed effect's latency was counted — the project is misaligned").toBe(0);
  });
});
