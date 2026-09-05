/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena v2 — State Model and Type Definitions
//
// OzvenaStateV1 is the canonical serialized state. It captures the
// full surface area of the plugin: three reverb engines, a Blend Pad
// that triangulates them, Pre-Delay, Smoother, Pre EQ + Auto Cut,
// Reverb EQ + Unmask, Masking Meter, Mod Pad, Reverb Assistant,
// and global I/O.
//
// Naming and structure mirror Neoverb's user-facing sections but
// every field name and every value range is a VocalForge original.
// ═══════════════════════════════════════════════════════════

/** Engine identifiers — fixed, stable, serializable. */
export type EngineId = "e1" | "e2" | "e3";

/** All engine IDs in default processing order (Reflections → Plate → Hall). */
export const ENGINE_IDS: readonly EngineId[] = ["e1", "e2", "e3"] as const;

/** Human-readable engine names (used by the UI / preset metadata). */
export const ENGINE_NAMES: Record<EngineId, string> = {
  e1: "Reflections",
  e2: "Plate / Chamber",
  e3: "Hall",
};

/** E2 algorithm (Plate / Chamber / Room). */
export type Engine2Algo = "room" | "mediumChamber" | "plate";

export const ENGINE2_ALGOS: readonly Engine2Algo[] = ["room", "mediumChamber", "plate"] as const;

/** E3 algorithm (Large Chamber / Hall). */
export type Engine3Algo = "largeChamber" | "hall";

export const ENGINE3_ALGOS: readonly Engine3Algo[] = ["largeChamber", "hall"] as const;

/** Reverb Assistant tone choice (Neoverb Clean / Dark / Bright / Airy). */
export type AssistantTone = "clean" | "dark" | "bright" | "airy";

export const ASSISTANT_TONES: readonly AssistantTone[] = ["clean", "dark", "bright", "airy"] as const;

/** Auto Cut / Unmask analysis status state machine. */
export type AssistantStatus = "idle" | "waiting" | "listening" | "done" | "accepted" | "dismissed";

export const ASSISTANT_STATUSES: readonly AssistantStatus[] = [
  "idle",
  "waiting",
  "listening",
  "done",
  "accepted",
  "dismissed",
] as const;

/** Pre-Delay tempo-sync note values (128th → 8 measures, including dotted/triplet). */
export type SyncNoteValue =
  | "1/128" | "1/128T" | "1/128."
  | "1/64"  | "1/64T"  | "1/64."
  | "1/32"  | "1/32T"  | "1/32."
  | "1/16"  | "1/16T"  | "1/16."
  | "1/8"   | "1/8T"   | "1/8."
  | "1/4"   | "1/4T"   | "1/4."
  | "1/2"   | "1/2T"   | "1/2."
  | "1/1"
  | "2/1"   | "3/1"   | "4/1"   | "6/1"   | "8/1";

export const SYNC_NOTE_VALUES: readonly SyncNoteValue[] = [
  "1/128", "1/128T", "1/128.",
  "1/64",  "1/64T",  "1/64.",
  "1/32",  "1/32T",  "1/32.",
  "1/16",  "1/16T",  "1/16.",
  "1/8",   "1/8T",   "1/8.",
  "1/4",   "1/4T",   "1/4.",
  "1/2",   "1/2T",   "1/2.",
  "1/1",
  "2/1",   "3/1",   "4/1",   "6/1",   "8/1",
] as const;

/** Pre EQ / Reverb EQ band shapes. */
export type EqBandShape = "lowShelf" | "bell" | "highShelf" | "lowCut" | "highCut";

export const EQ_SHAPES: readonly EqBandShape[] = [
  "lowShelf",
  "bell",
  "highShelf",
  "lowCut",
  "highCut",
] as const;

/** Processing quality tier (CPU ↔ quality trade-off). */
export type QualityMode = "eco" | "standard" | "high" | "render";

export const QUALITY_MODES: readonly QualityMode[] = ["eco", "standard", "high", "render"] as const;

/** Reverb Assistant wizard step. */
export const ASSISTANT_STEPS = 4 as const;

/** EQ band count per section (Pre EQ / Reverb EQ). */
export const EQ_BANDS_PER_SECTION = 3 as const;

// ── Blend Pad ──────────────────────────────────────────────

/**
 * Blend Pad XY coordinates.
 * - `x ∈ [0, 1]`: 0 = full Reflections, 1 = full Hall
 * - `y ∈ [0, 1]`: 0 = E1 dominant, 1 = E3 dominant
 *
 * The E2 (Plate / Room) weight is computed as the barycentric
 * complement. See `blendPadToEngineWeights()`.
 */
export interface BlendPadState {
  x: number;
  y: number;
  engine2Algo: Engine2Algo;
  /** E1 (Reflections) → late engines injection amount (0..1). >0 feeds the
   *  early-reflection tail into the E2/E3 FDN inputs so the space gels. */
  injectER: number;
}

export function defaultBlendPad(): BlendPadState {
  return { x: 0.5, y: 0.5, engine2Algo: "room", injectER: 0 };
}

/** Triangle weights over E1/E2/E3 derived from a Blend Pad XY position. */
export interface EngineWeights {
  e1: number;
  e2: number;
  e3: number;
}

/**
 * Map a Blend Pad XY position to barycentric weights over the three
 * engine vertices of an equilateral triangle:
 *
 *           E3
 *          ▲
 *         /│\
 *        / │ \
 *       /  │  \
 *      /   │   \
 *     ◄────┼────►
 *    E1    E2
 *
 * The triangle has its three vertices placed at:
 *   E1 = (0,    0)
 *   E2 = (1,    0)
 *   E3 = (0.5,  √3/2 ≈ 0.866)
 *
 * `x ∈ [0, 1]` moves the point horizontally (E1 ↔ E2).
 * `y ∈ [0, 1]` moves it vertically toward E3.
 *
 * Standard barycentric coordinate derivation. The raw values may go
 * slightly negative when the point is outside the triangle; those are
 * clamped to 0 and the result is renormalised.
 */
export function blendPadToEngineWeights(x: number, y: number): EngineWeights {
  const cx = clamp01(x);
  const cy = clamp01(y);

  // Standard barycentric for an equilateral triangle:
  //   e2Raw = x - y / √3
  //   e3Raw = 2y / √3
  //   e1Raw = 1 - e2Raw - e3Raw
  const invSqrt3 = 1 / Math.sqrt(3);
  const e2Raw = cx - cy * invSqrt3;
  const e3Raw = (2 * cy) * invSqrt3;
  const e1Raw = 1 - e2Raw - e3Raw;

  const e1 = Math.max(0, e1Raw);
  const e2 = Math.max(0, e2Raw);
  const e3 = Math.max(0, e3Raw);

  const sum = e1 + e2 + e3;
  if (sum < 1e-6) return { e1: 0, e2: 0, e3: 0 };
  return { e1: e1 / sum, e2: e2 / sum, e3: e3 / sum };
}

/** Inverse — find the dominant vertex and project it back to XY. */
export function engineWeightsToBlendPad(w: EngineWeights): BlendPadState {
  // Pick the dominant engine and project it to its vertex XY.
  if (w.e3 >= w.e1 && w.e3 >= w.e2) {
    return { x: 0.5, y: Math.sqrt(3) / 2, engine2Algo: "room", injectER: 0 };
  }
  if (w.e1 >= w.e2) {
    return { x: 0, y: 0, engine2Algo: "room", injectER: 0 };
  }
  return { x: 1, y: 0, engine2Algo: "room", injectER: 0 };
}

// ── Engine 1 — Reflections ─────────────────────────────────

export interface ReflectionsEngineState {
  enabled: boolean;
  /** Macro control (0..1). Adjusts `time` + `size` together. */
  space: number;
  /** Initial echo time in milliseconds (36.73..250). */
  time: number;
  /** Room density coefficient (0..1). */
  size: number;
  /** Reflection density (0..100). */
  diffusion: number;
  /** Tap angle / character (0..100). */
  angle: number;
  /** Lowpass cutoff in Hz (30..20000). */
  lowpassHz: number;
  /** Per-lane mix (0..100). */
  mix: number;
}

export function defaultReflectionsEngine(): ReflectionsEngineState {
  return {
    enabled: true,
    space: 0.5,
    time: 80,
    size: 0.5,
    diffusion: 70,
    angle: 50,
    lowpassHz: 8000,
    mix: 100,
  };
}

// ── Engine 2 — Plate / Room / Medium Chamber ───────────────

export interface PlateChamberEngineState {
  enabled: boolean;
  space: number;
  /** Decay time in ms (1400..14000). */
  time: number;
  size: number;
  diffusion: number;
  /** Initial onset time in ms (0..250). */
  attack: number;
  /** Crossover frequency for low/high split (20..4000). */
  crossoverHz: number;
  /** Low/high balance (0..1). 0=low dominant, 1=high dominant. */
  balance: number;
  /** Damping amount (1..11). */
  dampingAmount: number;
  /** Damping frequency (30..20000). */
  dampingFreqHz: number;
  mix: number;
  /** Algorithm selection (room / mediumChamber / plate). */
  algo: Engine2Algo;
  /** Bass decay multiplier (0.25..4). >1 = bass rings longer than the
   *  mid T60 — the signature "space holds the low end" behaviour. */
  bassDecay: number;
  /** Feedback cross-feed width (0..1). 1 = fully independent L/R loops
   *  (widest), 0 = mono feedback (collapsed image). */
  stereoWidth: number;
  /** Octave-up pitch shifter in the feedback path (0..1). */
  shimmer: number;
  /** In-loop drive (0..1). Padé-tanh saturation of the feedback path —
   *  adds harmonic density and slightly shortens hot decay. 0 = pure
   *  linear (bit-neutral to legacy presets). */
  drive: number;
}

export function defaultPlateChamberEngine(): PlateChamberEngineState {
  return {
    enabled: true,
    space: 0.5,
    time: 2000,
    size: 0.5,
    diffusion: 70,
    attack: 30,
    crossoverHz: 1000,
    balance: 0.5,
    dampingAmount: 5,
    dampingFreqHz: 5000,
    mix: 100,
    algo: "room",
    bassDecay: 1.0,
    stereoWidth: 1.0,
    shimmer: 0,
    drive: 0,
  };
}

// ── Engine 3 — Hall / Large Chamber ────────────────────────

export interface HallEngineState {
  enabled: boolean;
  space: number;
  /** Decay time in ms (4170..24000). */
  time: number;
  size: number;
  diffusion: number;
  attack: number;
  crossoverHz: number;
  balance: number;
  dampingAmount: number;
  dampingFreqHz: number;
  mix: number;
  /** Algorithm selection (largeChamber / hall). */
  algo: Engine3Algo;
  /** Bass decay multiplier — see PlateChamberEngineState. */
  bassDecay: number;
  /** Feedback cross-feed width — see PlateChamberEngineState. */
  stereoWidth: number;
  /** Octave-up pitch shifter in the feedback path (0..1). */
  shimmer: number;
  /** In-loop drive (0..1). Padé-tanh saturation of the feedback path —
   *  adds harmonic density and slightly shortens hot decay. 0 = pure
   *  linear (bit-neutral to legacy presets). */
  drive: number;
}

export function defaultHallEngine(): HallEngineState {
  return {
    enabled: true,
    space: 0.5,
    time: 6000,
    size: 0.5,
    diffusion: 70,
    attack: 50,
    crossoverHz: 800,
    balance: 0.5,
    dampingAmount: 5,
    dampingFreqHz: 5000,
    mix: 100,
    algo: "hall",
    bassDecay: 1.0,
    stereoWidth: 1.0,
    shimmer: 0,
    drive: 0,
  };
}

// ── Engines aggregate (so presets can address them by ID) ──

export interface EnginesState {
  e1: ReflectionsEngineState;
  e2: PlateChamberEngineState;
  e3: HallEngineState;
}

export function defaultEngine1State(): ReflectionsEngineState { return defaultReflectionsEngine(); }
export function defaultEngine2State(): PlateChamberEngineState { return defaultPlateChamberEngine(); }
export function defaultEngine3State(): HallEngineState { return defaultHallEngine(); }

// ── Pre-Delay ──────────────────────────────────────────────

export interface PreDelayState {
  enabled: boolean;
  /** Pre-delay in ms (0..500). Used when `syncEnabled` is false. */
  ms: number;
  syncEnabled: boolean;
  syncNote: SyncNoteValue;
}

export function defaultPreDelay(): PreDelayState {
  return { enabled: true, ms: 20, syncEnabled: false, syncNote: "1/4" };
}

// ── Smoother (transient shaper) ────────────────────────────

export interface SmootherState {
  enabled: boolean;
  /** Transient reduction amount (0..100). */
  amount: number;
}

export function defaultSmoother(): SmootherState {
  return { enabled: true, amount: 30 };
}

// ── Pre EQ (3-band) + Auto Cut ─────────────────────────────

export interface EqBandState {
  enabled: boolean;
  /** Band frequency in Hz. */
  freqHz: number;
  /** Gain in dB (-24..+24). */
  gainDb: number;
  /** Resonance / Q (0.1..24). */
  q: number;
  /** Filter shape. */
  shape: EqBandShape;
}

/** Per-section EQ has exactly 3 bands (low, mid, high). */
export const EQ_BAND_COUNT = EQ_BANDS_PER_SECTION;

export function defaultPreEqBand(): EqBandState {
  return { enabled: false, freqHz: 1000, gainDb: 0, q: 1.0, shape: "bell" };
}

export interface PreEqAutoCutState {
  /** When true, the AutoCut analyzer can run. */
  enabled: boolean;
  /** Cut amount scale (0..100). Higher = more aggressive. */
  amount: number;
  /** Status state machine. */
  status: AssistantStatus;
  /** Suggested band gains in dB (length 3, low/mid/high). Set by analyzer. */
  suggestedBandGainsDb: [number, number, number];
}

export function defaultPreEqAutoCut(): PreEqAutoCutState {
  return {
    enabled: false,
    amount: 50,
    status: "idle",
    suggestedBandGainsDb: [0, 0, 0],
  };
}

export interface PreEqState {
  enabled: boolean;
  autoCut: PreEqAutoCutState;
  band1: EqBandState;
  band2: EqBandState;
  band3: EqBandState;
}

export function defaultPreEq(): PreEqState {
  return {
    enabled: false,
    autoCut: defaultPreEqAutoCut(),
    band1: { enabled: false, freqHz: 100, gainDb: 0, q: 0.7, shape: "lowShelf" },
    band2: { enabled: false, freqHz: 1000, gainDb: 0, q: 1.0, shape: "bell" },
    band3: { enabled: false, freqHz: 8000, gainDb: 0, q: 0.7, shape: "highShelf" },
  };
}

// ── Reverb EQ (3-band) + Unmask ────────────────────────────

export interface ReverbEqUnmaskState {
  enabled: boolean;
  amount: number;
  source: "dryVsWet";
  status: AssistantStatus;
  suggestedBandGainsDb: [number, number, number];
}

export function defaultReverbEqUnmask(): ReverbEqUnmaskState {
  return {
    enabled: false,
    amount: 50,
    source: "dryVsWet",
    status: "idle",
    suggestedBandGainsDb: [0, 0, 0],
  };
}

export function defaultReverbEqBand(): EqBandState { return defaultPreEqBand(); }

export interface ReverbEqState {
  enabled: boolean;
  unmask: ReverbEqUnmaskState;
  band1: EqBandState;
  band2: EqBandState;
  band3: EqBandState;
}

export function defaultReverbEq(): ReverbEqState {
  return {
    enabled: false,
    unmask: defaultReverbEqUnmask(),
    band1: { enabled: false, freqHz: 200, gainDb: 0, q: 0.7, shape: "lowShelf" },
    band2: { enabled: false, freqHz: 2500, gainDb: 0, q: 1.0, shape: "bell" },
    band3: { enabled: false, freqHz: 10000, gainDb: 0, q: 0.7, shape: "highShelf" },
  };
}

// ── Masking Meter ──────────────────────────────────────────

export interface MaskingState {
  enabled: boolean;
  source: "dryVsWet";
}

export function defaultMasking(): MaskingState {
  return { enabled: false, source: "dryVsWet" };
}

// ── Mod Pad ────────────────────────────────────────────────

export interface ModState {
  enabled: boolean;
  /** Mod mode: 0=RandomFat (randomised LFO), 1=Pitch (Doppler-ish delay). */
  mode: "randomFat" | "pitch";
  /** X-axis: modulation depth (0..1.25, Neoverb allows up to 125%). */
  depthX: number;
  /** Y-axis: modulation rate (0..1, normalized to 0.05..8 Hz). */
  rateY: number;
}

export function defaultMod(): ModState {
  return { enabled: false, mode: "randomFat", depthX: 0.25, rateY: 0.24 };
}

// ── Reverb Assistant ───────────────────────────────────────

export interface AssistantState {
  /** 0 = hidden, 1..4 = wizard steps. */
  step: number;
  /** 0..1 macro: 0=Room, 1=epic/dramatic. */
  style: number;
  /** 0..1 macro: fine-tune of size. */
  size: number;
  /** 0..1 macro: dry/wet suggestion. */
  dryWet: number;
  tone: AssistantTone;
  status: AssistantStatus;
  /** True after the user accepts an analysis result. */
  accepted: boolean;
}

export function defaultAssistant(): AssistantState {
  return {
    step: 0,
    style: 0.5,
    size: 0.5,
    dryWet: 0.5,
    tone: "clean",
    status: "idle",
    accepted: false,
  };
}

// ── Global I/O ─────────────────────────────────────────────

export interface GlobalState {
  /** Input gain in dB (-24..+24). */
  inputGainDb: number;
  /** Output gain in dB (-24..+24). */
  outputGainDb: number;
  /** Dry/Wet mix (0..100). 100% = full wet (bus-mode default). */
  dryWet: number;
  /** Final output level in dB (-24..+6). */
  levelDb: number;
  /** When true, the dry input is removed from the output (FX-only). */
  fxOnly: boolean;
  /** Bypass — true means the plugin passes audio unchanged. */
  bypass: boolean;
  /** Processing quality mode. */
  quality: QualityMode;
  /** Infinite tail hold: FDN feedback → 1, loop input cut. */
  freeze: boolean;
  /** Gated reverb: wet bus closes when the input stops. */
  gate: boolean;
}

/** Auto-duck controller state (wet-bus gain reduction when peer
 *  plugins signal masking energy in the same band). */
export interface DuckState {
  /** Enable auto-duck. Default: false (opt-in). */
  enabled: boolean;
  /** Masking threshold in dB. Default: -20. */
  thresholdDb: number;
  /** Sensitivity (0..1). Higher = more aggressive ducking. Default: 0.5. */
  sensitivity: number;
  /** Attack time in ms. Default: 50. */
  attackMs: number;
  /** Release time in ms. Default: 200. */
  releaseMs: number;
}

export function defaultDuck(): DuckState {
  return {
    enabled: false,
    thresholdDb: -20,
    sensitivity: 0.5,
    attackMs: 50,
    releaseMs: 200,
  };
}

/** Convolution mode: algorithmic (default), hybrid, or convolution-only. */
export type ConvolutionMode = "algorithmic" | "hybrid" | "convolution";

export interface ConvolutionState {
  /** Convolution mode. */
  mode: ConvolutionMode;
  /** Active IR identifier (null = no IR loaded). */
  irId: string | null;
  /** Wet mix 0..100 (%). */
  wet: number;
  /** Pre-EQ gains in dB: [low, mid, high]. */
  preEq: [number, number, number];
  /** Post-EQ gains in dB: [low, mid, high]. */
  postEq: [number, number, number];
}

export function defaultGlobal(): GlobalState {
  return {
    inputGainDb: 0,
    outputGainDb: 0,
    dryWet: 100,
    levelDb: 0,
    fxOnly: false,
    bypass: false,
    quality: "standard",
    freeze: false,
    gate: false,
  };
}

export function defaultConvolution(): ConvolutionState {
  return {
    mode: "algorithmic",
    irId: null,
    wet: 100,
    preEq: [0, 0, 0],
    postEq: [0, 0, 0],
  };
}

// ── Top-level OzvenaStateV1 ────────────────────────────────

/** Current schema version. Bump on incompatible changes. */
export const SCHEMA_VERSION = 1 as const;

/**
 * Complete serialized state for the Ozvena plugin.
 *
 * The state is fully JSON-serializable. Optional `__meta` carries
 * preset identity when the state is stored inside a preset envelope.
 */
export interface OzvenaStateV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  global: GlobalState;
  blendPad: BlendPadState;
  engines: EnginesState;
  preDelay: PreDelayState;
  smoother: SmootherState;
  preEq: PreEqState;
  reverbEq: ReverbEqState;
  masking: MaskingState;
  mod: ModState;
  assistant: AssistantState;
  /** Auto-duck controller (wet-bus gain reduction triggered by peer
   *  level notifications). Opt-in: defaults.enabled = false. */
  duck: DuckState;
  /** Convolution reverb configuration (Phase 8a). */
  convolution: ConvolutionState;
  /** Optional preset/identity metadata (only populated when wrapped in a preset). */
  __meta?: {
    name?: string;
    author?: string;
    category?: string;
    notes?: string;
  };
}

export function defaultOzvenaStateV1(): OzvenaStateV1 {
  return {
    schemaVersion: SCHEMA_VERSION,
    global: defaultGlobal(),
    blendPad: defaultBlendPad(),
    engines: {
      e1: defaultEngine1State(),
      e2: defaultEngine2State(),
      e3: defaultEngine3State(),
    },
    preDelay: defaultPreDelay(),
    smoother: defaultSmoother(),
    preEq: defaultPreEq(),
    reverbEq: defaultReverbEq(),
    masking: defaultMasking(),
    mod: defaultMod(),
    assistant: defaultAssistant(),
    duck: defaultDuck(),
    convolution: defaultConvolution(),
  };
}

// ── Internal helpers ───────────────────────────────────────

// NaN-safe — a corrupted Blend Pad coordinate must fall back to 0.
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
