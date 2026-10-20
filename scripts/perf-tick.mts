/**
 * perf-tick — measures the SCHEDULER TICK path.
 *
 * WHY THIS TOOL EXISTS
 * The worst hot-path defect found in the 2026-10-20 performance audit was NOT
 * on the command path — it was on the tick path. `effectTargetParamDefs`
 * rebuilt an effect's whole parameter catalog on every call, and the
 * automation write path resolves a target seven times per lane per tick, so an
 * automated fxeq rebuilt an identical 315-def catalog 280 times a second:
 * measured 0.65 ms per rebuild, ~159 ms of CPU per second per lane, ~16 % of
 * a core, continuously, during playback.
 *
 * `scripts/bench-hotpath.ts` measures the COMMAND path and had no way to see
 * this: the cost lives between the scheduler tick and the audio parameter
 * write. This tool closes that gap.
 *
 * WHAT IT MEASURES
 * The real chain: Scheduler.tick() → deps.applyAutomation() →
 * AudioEngine.applyAutomation() → AutomationBridge.applyAutomation() →
 * targetParamDef() → DeviceLookup.writeDeviceTargetAt(). The scheduler, the
 * engine, the bridge and the document are the production ones; only the
 * AUDIO CONTEXT is a mock (there is no audio device in Node), because the
 * cost under study is main-thread JavaScript — the audio thread is not where
 * a jank-inducing stall comes from.
 *
 * WHAT IT DOES NOT MEASURE
 * The audio thread, the DSP itself, the worklet's `process()`, and anything
 * that needs a real AudioContext. It measures the main-thread cost of
 * planning and writing one tick.
 *
 * The tick cadence is the real one: the worklet ticker fires every
 * TICKER_INTERVAL_BLOCKS (8 blocks ≈ 21.3 ms @48 kHz), so the report
 * projects the measured tick cost to 40 ticks per second — the number that
 * decides whether a path is affordable.
 *
 * USAGE
 *   npx vite-node scripts/perf-tick.mts
 *   npx vite-node scripts/perf-tick.mts --lanes 1,4,16 --points 8
 *   npx vite-node scripts/perf-tick.mts --budget 4      # % of one core; exit 1 if exceeded
 */

import { createDefaultProject } from "../src/project-model/schema";
import { getDrumTrack } from "../src/project-model/types";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import type { AutomationLane, EffectInstance, ProjectDocument } from "../src/project-model/types";

// ─── arguments ─────────────────────────────────────────────────────────────

function argNumber(name: string, fallback: number): number {
  const hit = argValue(name);
  if (hit === undefined) return fallback;
  const value = Number(hit);
  return Number.isFinite(value) ? value : fallback;
}

function argList(name: string, fallback: number[]): number[] {
  const hit = argValue(name);
  if (hit === undefined) return fallback;
  // Split on commas AND whitespace: PowerShell hands an array argument over as
  // a space-joined string ("1 16"), so a comma-only split would silently
  // yield one unparseable token and fall back to the default.
  const parsed = hit
    .split(/[\s,]+/)
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length ? parsed : fallback;
}

/** Accepts both `--name=value` and `--name value`. */
function argValue(name: string): string | undefined {
  const argv = process.argv;
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith("--")) return argv[index + 1];
  return undefined;
}

// ─── mock audio context ────────────────────────────────────────────────────
// Only the nodes the engine actually creates. The count of node creations is
// irrelevant here — the tool measures the TICK's work, not the graph.

function param(initial = 0) {
  return {
    value: initial,
    setValueAtTime(v: number) {
      this.value = v;
    },
    setTargetAtTime(v: number) {
      this.value = v;
    },
    linearRampToValueAtTime(v: number) {
      this.value = v;
    },
    cancelScheduledValues() {},
  };
}

function mockNode() {
  const connections = new Set<unknown>();
  const node: Record<string, unknown> = {
    connections,
    gain: param(1),
    pan: param(0),
    connect(destination?: unknown) {
      if (destination !== undefined) connections.add(destination);
      return node;
    },
    disconnect(destination?: unknown) {
      if (destination === undefined) connections.clear();
      else connections.delete(destination);
    },
  };
  return {
    ...node,
    frequency: param(440),
    Q: param(1),
    threshold: param(0),
    ratio: param(1),
    attack: param(0),
    release: param(0),
    knee: param(0),
    delayTime: param(0),
    fftSize: 0,
    channelCount: 2,
    channelCountMode: "explicit",
    getFloatTimeDomainData() {},
    getByteFrequencyData() {},
  };
}

function mockContext() {
  return {
    currentTime: 0,
    sampleRate: 48000,
    state: "running" as AudioContextState,
    createGain: () => mockNode(),
    createStereoPanner: () => mockNode(),
    createAnalyser: () => mockNode(),
    createDelay: () => mockNode(),
    createDynamicsCompressor: () => ({ ...mockNode(), reduction: 0 }),
    createBiquadFilter: () => ({ ...mockNode(), type: "lowpass" }),
    createChannelSplitter: () => mockNode(),
    createChannelMerger: () => mockNode(),
    createWaveShaper: () => ({
      oversample: "none" as OverSampleType,
      curve: null,
      connect() {},
      disconnect() {},
    }),
    createConstantSource: () => ({ ...mockNode(), offset: param(0), start() {}, stop() {} }),
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
  };
}

// ─── project fixture ───────────────────────────────────────────────────────

interface Fixture {
  lanes: number;
  points: number;
  effectType: string;
  bandCount: number;
}

function buildDoc({ lanes, points, effectType, bandCount }: Fixture): ProjectDocument {
  const doc = createDefaultProject();
  const base = doc.tracks[0];
  const drumTrack = getDrumTrack(doc);

  // One flagship effect per track; every lane automates a DIFFERENT effect so
  // no two lanes share a target — the shape of a real mix.
  const tracks = Array.from({ length: Math.max(1, lanes) }, (_, i) => {
    const effect: EffectInstance = {
      id: `fx-${i}`,
      type: effectType,
      bypassed: false,
      params: effectType === "fxeq" ? { bandCount } : {},
    } as EffectInstance;
    return { ...base, id: `track-${i}`, name: `Track ${i}`, effects: [effect] } as typeof base;
  });

  const automation: AutomationLane[] = Array.from({ length: lanes }, (_, i) => ({
    id: `lane-${i}`,
    target: { kind: "fxParam", trackId: `track-${i}`, fxId: `fx-${i}`, paramId: "mix" },
    points: Array.from({ length: points }, (_, p) => ({
      tick: p * 120,
      value: p % 2 === 0 ? 0.25 : 0.75,
    })),
  }));

  // Keep the drum track so the scheduler has an active pattern to plan from.
  const withTracks = doc.tracks.filter((t) => t.id === base.id || t.id === drumTrack.id);
  void withTracks;

  return {
    ...doc,
    tracks: [...doc.tracks, ...tracks],
    automation,
  } as ProjectDocument;
}

// ─── measurement ───────────────────────────────────────────────────────────

const TICKS_PER_SECOND = 40; // 8-block worklet ticker ≈ 21.3 ms @48 kHz
const TICK_STEP_SEC = 1 / TICKS_PER_SECOND;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

interface Measurement {
  medianMs: number;
  p95Ms: number;
  projectedCpuPercent: number;
  /** How many times the tick entered the automation path. */
  automationCallsPerTick: number;
}

function measureTick(fixture: Fixture, ticks: number): Measurement {
  const doc = buildDoc(fixture);
  const ctx = mockContext();
  const engine = new AudioEngine();
  engine.useContext(ctx as unknown as BaseAudioContext);
  engine.setProject(doc);

  let audioTime = 10;
  const transport = new Transport({ now: () => audioTime }, 124);
  transport.play(0);

  // The tool must be able to PROVE it is looking at the automation path. If
  // the fixture ever stops exercising it (a renamed dep, a gated lane, a
  // scheduler change), the numbers would quietly describe the pattern
  // scheduling instead — and the tool would look healthy while watching the
  // wrong thing. Counting the entries makes that impossible to miss.
  let automationCalls = 0;
  const scheduler = new Scheduler({
    getProject: () => doc,
    getTransport: () => transport,
    getAudioTime: () => audioTime,
    getMode: () => "pattern",
    trigger: () => {},
    noteOn: () => {},
    metronomeClick: () => {},
    applyAutomation: (fromTick, toTick, relOf, offset, timeAt, suppressed) => {
      automationCalls++;
      engine.applyAutomation(fromTick, toTick, relOf, offset, timeAt, suppressed);
    },
    applyPatternLaunch: () => {},
  });

  const tick = () => (scheduler as unknown as { tick: () => void }).tick();

  // Warm-up: the first tick pays one-off costs (catalog construction, graph
  // materialisation, JIT warm-up). Those are NOT the steady-state cost the
  // tool reports — and pretending otherwise is exactly the kind of flattering
  // measurement this tool exists to replace.
  for (let i = 0; i < 5; i++) {
    audioTime += TICK_STEP_SEC;
    tick();
  }

  const samples: number[] = [];
  automationCalls = 0;
  for (let i = 0; i < ticks; i++) {
    audioTime += TICK_STEP_SEC;
    const t0 = performance.now();
    tick();
    samples.push(performance.now() - t0);
  }

  const automationCallsPerTick = automationCalls / ticks;
  if (fixture.lanes > 0 && automationCallsPerTick === 0) {
    throw new Error(
      "perf-tick: the fixture did NOT exercise the automation path (0 applyAutomation calls per tick). " +
        "The numbers would describe pattern scheduling only — fix the fixture before trusting them.",
    );
  }

  scheduler.stop();
  engine.dispose();

  const medianMs = median(samples);
  return {
    medianMs,
    p95Ms: percentile(samples, 95),
    projectedCpuPercent: (medianMs * TICKS_PER_SECOND) / 10,
    automationCallsPerTick,
  };
}

// ─── report ────────────────────────────────────────────────────────────────

const LANE_COUNTS = argList("lanes", [1, 4, 16, 32]);
const POINTS = argNumber("points", 4);
const EFFECT_TYPE = (argValue("type") ?? "fxeq").trim();
const BAND_COUNT = argNumber("bands", 6);
const TICKS = argNumber("ticks", 120);
const BUDGET = argNumber("budget", 0);

console.log(`perf-tick — scheduler tick path`);
console.log(
  `effect=${EFFECT_TYPE}  points/lane=${POINTS}  ticks/s=${TICKS_PER_SECOND}  ticks measured=${TICKS}  lanes=${LANE_COUNTS.join(",")}`,
);
console.log("");
console.log("lanes | median ms/tick | p95 ms/tick | projected CPU @40 ticks/s | automation calls/tick");
console.log("------|----------------|-------------|----------------------|----------------------");

let worstCpu = 0;
for (const lanes of LANE_COUNTS) {
  process.stderr.write(`  measuring ${lanes} lane(s)...\n`);
  const result = measureTick({ lanes, points: POINTS, effectType: EFFECT_TYPE, bandCount: BAND_COUNT }, TICKS);
  worstCpu = Math.max(worstCpu, result.projectedCpuPercent);
  console.log(
    `${String(lanes).padStart(5)} | ${result.medianMs.toFixed(4).padStart(14)} | ${result.p95Ms
      .toFixed(4)
      .padStart(
        11,
      )} | ${result.projectedCpuPercent.toFixed(2).padStart(8)} % of one core | ${result.automationCallsPerTick.toFixed(1).padStart(14)}`,
  );
}

console.log("");
if (BUDGET > 0) {
  const verdict = worstCpu <= BUDGET ? "WITHIN" : "OVER";
  console.log(`budget ${BUDGET} % of one core -> ${verdict} (worst ${worstCpu.toFixed(2)} %)`);
  if (worstCpu > BUDGET) {
    console.error("perf-tick: the tick path exceeds its budget.");
    process.exit(1);
  }
} else {
  console.log(`worst case: ${worstCpu.toFixed(2)} % of one core (pass --budget <pct> to gate on it)`);
}

// The engine and the transport keep handles that would hold the process open
// long after the measurement is done — a measurement tool must not look like
// a hung one.
process.exit(0);
