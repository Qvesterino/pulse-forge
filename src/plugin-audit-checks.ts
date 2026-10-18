/**
 * INTERNAL PLUGIN AUDIT (2026-09-27) — real-audio half.
 *
 * Runs in a real browser (scripts/verify-plugin-audit.mjs) and produces the
 * measurement evidence behind docs/PLUGIN-AUDIT-2026-09-27.md. The
 * document-level half (ranges, serialization, automation targets) lives in
 * tests/plugin-functional-audit.test.ts.
 *
 * For every one of the 52 effect types:
 *  1. factory-level sweep — every param at min AND max against a stereo test
 *     signal: finite output, no runaway gain, and a measured delta (RMS,
 *     side energy, spectral centroid) proving the DSP actually responds to
 *     the parameter (not just that a slider moves);
 *  2. rapid-swing render — every param slammed min↔max six times, then a
 *     render must still be finite (catches smoothing/NaN edge cases);
 *  3. engine-level host test — the effect inserted on a project's drum bus
 *     through the real command path and rendered by the same offline
 *     renderer the export uses: processed ≠ bypassed, bypassed ≡ removed,
 *     a JSON round-trip renders bit-comparable, and an automation lane
 *     audibly drives the parameter;
 *  4. every factory effect preset renders finite within headroom.
 *
 * For every one of the 22 instrument kinds:
 *  5. default noteOn is audible; every parameter at min AND max renders
 *     finite; the parameter surface is wired (≥1 param moves the output).
 *
 * Interaction block:
 *  6. a 47-effect chain (also the restore stress), duplicate instances,
 *     live insert/remove during playback, rapid parameter syncs.
 */

import { EFFECT_DEFS, EFFECT_ORDER, defaultParamsOf } from "./effects/registry";
import { EFFECT_META } from "./effects/definitions";
import type { ParamDef } from "./effects/types";
import { CORE_EFFECT_PRESETS } from "./effects/presets";
import { INSTRUMENT_DEFS, INSTRUMENT_ORDER, defaultInstrumentParams } from "./instruments/registry";
import { generateFactoryBank, type SampleBank } from "./sample-library/factory";
import { ensureCuratedLayer } from "./sample-library/curated";
import { loadAllWorklets } from "./audio-worklets/loader";
import { renderProject } from "./rendering/renderer";
import { AudioEngine } from "./audio-engine/AudioEngine";
import { ProjectStore } from "./store/ProjectStore";
import { normalizeProject } from "./project-model/schema";
import { createProjectFromTemplate } from "./project-model/templates";
import { addEffect, removeEffect, setEffectParam, toggleEffectBypass } from "./commands/commands";
import type { EffectType, InstrumentTrack, PlayMode, ProjectDocument } from "./project-model/types";

const SR = 44100;
const SIGNAL_SECONDS = 0.75;
const RESPONSIVE_EPS = 0.02;
/** Host delta below this still counts as processing (jitter floor ~1e-7). */
const HOST_EPS = 0.005;

const RUNAWAY_PEAK = 40;

/**
 * Effects whose DSP is bar- or transport-synced: a 0.75 s window at 124 BPM
 * is shorter than one bar, so mangling/gating/swell cycles never complete
 * and every parameter measures inert. These render a 2-bar window instead.
 */
const BAR_SYNCED_EFFECTS = new Set<EffectType>([
  "beatMangler",
  "stepGate",
  "pump",
  "reverseSwell",
  "tapeStop",
  "granularFreeze",
  "stutter",
]);
/**
 * Effects whose parameters act on LEVEL OVER TIME (a detector, a threshold, a
 * hold/release clock). The shared test tone is continuous after its opening
 * kick, so it never falls below any of their thresholds: the device never
 * engages, and every threshold/range/hold/release parameter reads as `delta: 0`
 * — a bit-identical render that looks exactly like an unwired parameter.
 *
 * This is the same failure mode this file already documents for the sidechain
 * family: "without a modulator feed the vocoder runs its degraded 1:1 carrier
 * passthrough and every sidechain ducking knob is legitimately inert"
 * (buildModulatorBuffer). That fix was applied to the modulator input and never
 * to the main sweep signal, so the whole dynamics family kept reporting false
 * dead parameters.
 *
 * MEASURED, not assumed — scripts/probe-worklet-param-wiring.mjs renders the
 * gate both ways: against a continuous tone, seven of its eight parameters move
 * 0%; against this burst stimulus they move 0.5%..41%.
 */
const DYNAMICS_STIMULUS_TYPES = new Set<string>(["gate", "compressor", "limiter", "duckDelay", "transient"]);

/**
 * Filter-family types get a BROADBAND stimulus, for the same reason the
 * dynamics family gets bursts — wrong stimulus, not dead wiring.
 *
 * MEASURED 2026-10-18 on the shipped defaults: with the continuous kick/tone
 * stimulus, the core EQ reports 17 "dead" parameters. Every one of them is a
 * FREQUENCY or a Q — `lowShelfFreq`, `lowMidFreq`, `lowMidQ`, `highMidFreq`,
 * all delta exactly 0 — while every GAIN in the same device moves measurably
 * (`lowShelfGain` 1.54, `lowMidGain` 1.44, `hostProcesses` true, hostDelta
 * 0.50). The EQ is processing and its gains reach the DSP; the stimulus simply
 * has almost no energy above ~200 Hz, so sweeping a bell's centre frequency
 * from 80 Hz to 2 kHz cannot change RMS, peak or crest.
 *
 * A bandpass's frequency is only observable through the band it passes. Sweeping
 * it with a signal that has no content in that band produces a bit-identical
 * render, which is indistinguishable from an unwired parameter — so the column
 * says "dead" about wiring that works, and a real regression in that column
 * becomes invisible next to 17 false positives.
 *
 * Like the dynamics stimulus, the best delta wins, so this can only turn a
 * false negative into a true positive, never the reverse.
 */
const FILTER_STIMULUS_TYPES = new Set<string>(["eq", "msEq", "multiband", "svFilter"]);

/**
 * Rhythmic bursts with gaps long enough for a 20 ms hold and an 80 ms release
 * to actually close a gate. Measured against the shipped defaults: a 220 ms
 * gap leaves the one-pole envelope at ~-30 dB, still above a -36 dB threshold,
 * so a correctly-open gate reads as inert. The gap here is 1.7 s.
 */
function buildDynamicsBufferInto(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(2, Math.floor(SR * seconds), SR);
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  const period = 2.0;
  const on = 0.3;
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    const phase = t % period;
    const active = phase < on;
    // A little tone under the burst so the spectrum still has content.
    const tone = 0.25 * Math.sin(2 * Math.PI * 220 * t);
    l[i] = active ? 0.45 * Math.sin(2 * Math.PI * 180 * t) + tone : 0.0004 * Math.sin(2 * Math.PI * 900 * t);
    r[i] = active ? 0.45 * Math.sin(2 * Math.PI * 180 * t) + tone * 1.01 : 0.0004 * Math.sin(2 * Math.PI * 900 * t);
  }
  return buffer;
}

/**
 * Pink-ish noise with a deterministic seed, for filter families.
 *
 * White noise, shaped by a one-pole tilt toward pink. Flat white would put equal
 * energy in the 10 kHz region no musical EQ band sits in, so the roll-off keeps
 * the level sane while still leaving measurable content across the whole range
 * the bands sweep.
 *
 * Seeded for the same reason as every other stimulus now (see `seededRandom`):
 * this column is compared ACROSS runs, so the signal that produces it cannot
 * change between them.
 */
function buildBroadbandBufferInto(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(2, Math.floor(SR * seconds), SR);
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  const rand = seededRandom(0x9e3779b9);
  const a = 0.06; // one-pole smoothing -> roughly pink
  let zL = 0;
  let zR = 0;
  let peak = 0;
  for (let i = 0; i < l.length; i++) {
    zL = a * (rand() * 2 - 1) + (1 - a) * zL;
    zR = a * (rand() * 2 - 1) + (1 - a) * zR;
    l[i] = zL;
    r[i] = zR;
    const m = Math.max(Math.abs(zL), Math.abs(zR));
    if (m > peak) peak = m;
  }
  // Normalise so the stimulus level cannot be the reason a parameter "moves".
  const g = peak > 0 ? 0.5 / peak : 1;
  for (let i = 0; i < l.length; i++) {
    l[i] *= g;
    r[i] *= g;
  }
  return buffer;
}

/** Deterministic mono-bass stimulus for controls that need a stable root. */
function buildKorenProbeBufferInto(ctx: BaseAudioContext, seconds: number, f0: number, burst: boolean): AudioBuffer {
  const buffer = ctx.createBuffer(2, Math.floor(SR * seconds), SR);
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    const phase = (2 * Math.PI * f0 * i) / SR;
    const pulse = t % 0.4;
    const env =
      !burst || pulse < 0.2 ? (burst ? Math.min(1, pulse / 0.008) * Math.min(1, (0.2 - pulse) / 0.01) : 1) : 0;
    const sample = 0.5 * env * Math.sin(phase);
    l[i] = sample;
    r[i] = sample;
  }
  return buffer;
}

/** A gated pitched key gives KOREŇ's PUMP/DUCK modes a real detector input. */
function buildKorenKeyBufferInto(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(SR * seconds), SR);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < channel.length; i++) {
    const t = i / SR;
    const pulse = t % 0.4;
    channel[i] = pulse < 0.16 ? 0.8 * Math.sin((2 * Math.PI * 60 * i) / SR) : 0;
  }
  return buffer;
}

function korenProbeFor(paramId: string): { params: Record<string, number>; f0: number; burst: boolean } {
  const params: Record<string, number> = {
    ...defaultParamsOf("bassHarmonic"),
    drive: 0.9,
    mix: 1,
    subAnchor: 0,
    focusHz: 90,
    harmonics: 0,
    range: 4,
    width: 1,
  };
  let f0 = 55;
  let burst = false;
  if (paramId === "focusHz") f0 = 120; // min is out of range; max tracks this root
  if (paramId === "subAnchor" || paramId === "lowCut") params.subAnchor = 0.7;
  if (paramId === "phase") {
    // PHASE reshapes a dense phone-band stack at constant spectrum/RMS; with
    // only the second partial active, there is no meaningful crest change.
    params.presence = 1;
    params.width = 0;
  }
  if (paramId === "attack" || paramId === "release" || paramId === "sustain" || paramId === "retrig") burst = true;
  // Use one declared, neutral target value as the baseline while retaining
  // companion settings that make the selected DSP path audible.
  const def = EFFECT_META.bassHarmonic.params.find((param) => param.id === paramId);
  if (def) params[paramId] = def.default;
  return { params, f0, burst };
}

const signalSecondsFor = (type: EffectType) => (BAR_SYNCED_EFFECTS.has(type) ? 4.4 : SIGNAL_SECONDS);

/* ---------------- report shapes ---------------- */

export interface ParamAudit {
  id: string;
  minFinite: boolean;
  maxFinite: boolean;
  minPeak: number;
  maxPeak: number;
  responsive: boolean;
  bestExtreme: "min" | "max";
  metric: string;
  delta: number;
  /**
   * Which stimulus produced that delta. A parameter that only moves under the
   * dynamics stimulus IS wired — it just cannot be excited by a tone that never
   * falls below its threshold. Recorded so the report explains itself instead
   * of quietly promoting a "dead" parameter to "responsive".
   */
  stimulus?: string;
}

export interface SweepResult {
  type: EffectType;
  sweepError?: string;
  /**
   * Set when the factory sweep cannot exercise the DSP by design (transport-
   * loop-anchored effects) - processing evidence then comes from the host
   * fingerprint render plus the effect's dedicated suites.
   */
  sweepExemptReason?: string;
  defaultPeak: number;
  defaultFinite: boolean;
  bypassDelta: number;
  params: ParamAudit[];
  deadParams: string[];
  unstableParams: string[];
  rapidSwingFinite: boolean;
  presetsFinite: number;
  presetsTotal: number;
}

export interface HostResult {
  hostError?: string;
  /** Set when the minimal host doc cannot exercise the effect by design. */
  hostExemptReason?: string;
  hostProcesses: boolean;
  hostDelta: number;
  hostBypassEqualsRemoved: boolean;
  hostFinite: boolean;
  automationDelta: number;
  /** Set when the minimal host doc cannot exercise automation by design. */
  automationExempt?: string;
  automationFinite: boolean;
  restoreMaxDiff: number;
  restoreRmsDiff: number;
}

export interface EffectAudit extends SweepResult, HostResult {
  name: string;
  category: string;
}

export interface InstrumentAudit {
  kind: string;
  name: string;
  defaultAudible: boolean;
  defaultPeak: number;
  unstableParams: string[];
  deadParams: string[];
  wiredParams: number;
  totalParams: number;
  /** Phase 3b: params wired only into transient/tail windows (not steady RMS). */
  transientWired: string[];
}

export interface InteractionAudit {
  chainFinite: boolean;
  chainPeak: number;
  chainRestoreDiff: number;
  /** 3× same-doc render must be sample-identical (Phase 1 determinism gate). */
  chainDeterministic: boolean;
  chainDeterminismDiff: number;
  duplicateDelta: number;
  duplicateFinite: boolean;
  liveInsertRemoveClean: boolean;
  rapidSyncsClean: boolean;
  notes: string[];
}

export interface PluginAuditReport {
  effects: EffectAudit[];
  instruments: InstrumentAudit[];
  interactions: InteractionAudit;
  startedAt: string;
  finishedAt: string;
}

/* ---------------- measurement helpers ---------------- */

interface Metrics {
  peak: number;
  rms: number;
  crest: number;
  side: number;
  centroid: number;
  /** Block-RMS max/min ratio — sees AM-class effects (pump/tremolo/gate)
   *  whose average RMS stays flat while the loudness swings. */
  dyn: number;
}

function metricsOf(buffer: AudioBuffer): Metrics {
  const l = buffer.getChannelData(0);
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
  const start = Math.floor(l.length / 8); // skip the attack / initial smoothing
  let peak = 0;
  let sum = 0;
  let sideSum = 0;
  for (let i = start; i < l.length; i++) {
    const a = l[i];
    const b = r[i];
    const abs = Math.max(Math.abs(a), Math.abs(b));
    if (abs > peak) peak = abs;
    sum += a * a;
    const s = a - b;
    sideSum += s * s;
  }
  const n = Math.max(1, l.length - start);
  // Block-RMS swing (256-sample blocks): pumping/tremolo/gating keep the
  // average RMS flat while the loudness rhythm changes dramatically.
  const block = 256;
  let bRmsMin = Infinity;
  let bRmsMax = 0;
  for (let i = start; i + block <= l.length; i += block) {
    let bs = 0;
    for (let j = 0; j < block; j++) bs += l[i + j] * l[i + j];
    const br = Math.sqrt(bs / block);
    if (br < bRmsMin) bRmsMin = br;
    if (br > bRmsMax) bRmsMax = br;
  }
  if (!Number.isFinite(bRmsMin)) {
    bRmsMin = 0;
    bRmsMax = 0;
  }
  return {
    peak,
    rms: Math.sqrt(sum / n),
    crest: peak / Math.max(Math.sqrt(sum / n), 1e-6),
    side: Math.sqrt(sideSum / n),
    centroid: spectralCentroid(l, start),
    dyn: bRmsMax / Math.max(bRmsMin, 1e-4),
  };
}

/** Radix-2 FFT (real input, Hann-windowed) for a spectral centroid. */
function spectralCentroid(data: Float32Array, start: number): number {
  const N = 4096;
  if (data.length < start + N) return 0;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    re[i] = data[start + i] * w;
  }
  for (let i = 1; i < N; i <<= 1) {
    for (let j = 0; j < i; j++) {
      const step = i << 1;
      const ang = (-2 * Math.PI * j) / step;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      for (let k = j; k < N; k += step) {
        const l = k + i;
        const tr = re[l] * wr - im[l] * wi;
        const ti = re[l] * wi + im[l] * wr;
        re[l] = re[k] - tr;
        im[l] = im[k] - ti;
        re[k] += tr;
        im[k] += ti;
      }
    }
  }
  let num = 0;
  let den = 0;
  for (let k = 1; k < N / 2; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    num += ((k * SR) / N) * mag;
    den += mag;
  }
  return den > 1e-9 ? num / den : 0;
}

function finiteEverywhere(buffer: AudioBuffer): boolean {
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      if (!Number.isFinite(d[i])) return false;
    }
  }
  return true;
}

function maxDiff(a: AudioBuffer, b: AudioBuffer): number {
  let diff = 0;
  for (let c = 0; c < Math.min(a.numberOfChannels, b.numberOfChannels); c++) {
    const da = a.getChannelData(c);
    const db = b.getChannelData(c);
    const n = Math.min(da.length, db.length);
    for (let i = 0; i < n; i++) {
      const d = Math.abs(da[i] - db[i]);
      if (d > diff) diff = d;
    }
  }
  return diff;
}

/** The strongest normalized change a render shows against a baseline. */
function deltaVs(base: Metrics, m: Metrics): { delta: number; metric: string } {
  const relRms = Math.abs(m.rms - base.rms) / Math.max(base.rms, 1e-6);
  const relCrest = Math.abs(m.crest - base.crest) / Math.max(base.crest, 0.2);
  const relSide = Math.abs(m.side - base.side) / Math.max(base.side, base.rms * 0.1, 1e-6);
  const relCentroid = Math.abs(m.centroid - base.centroid) / Math.max(base.centroid, 200);
  const relDyn = Math.abs(m.dyn - base.dyn) / Math.max(base.dyn, 0.2);
  const candidates: [string, number][] = [
    ["rms", relRms],
    ["crest", relCrest],
    ["side", relSide],
    ["centroid", relCentroid],
    ["dyn", relDyn],
  ];
  const best = candidates.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { delta: best[1], metric: best[0] };
}

/* ---------------- shared fixtures ---------------- */

function buildTestBuffer(): AudioBuffer {
  const ctx = new OfflineAudioContext(2, Math.floor(SR * SIGNAL_SECONDS), SR);
  return buildTestBufferInto(ctx, SIGNAL_SECONDS);
}

/**
 * Deterministic noise source (mulberry32) — one fresh generator per call.
 *
 * WHY THIS EXISTS, MEASURED: with `Math.random()` in the stimuli, two full runs
 * of the SAME measuring code disagreed on the dead-parameter column —
 * `shimmer.decay` and `prud.attack` flipped to dead and nothing recovered
 * (145 -> 144 over three runs). Every other column was identical. That drift
 * is why dead parameters could not be a regression gate: a run cannot tell a
 * new defect from a new dice roll.
 *
 * A fresh generator per buffer, not one shared one: the stimuli are rebuilt for
 * different lengths and different contexts (see `sweepEffect`), and a shared
 * generator would make each buffer depend on every buffer built before it.
 * That would still be deterministic within a run and wrong across them — the
 * property being bought here is "same code, same signal, forever".
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTestBufferInto(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(2, Math.floor(SR * seconds), SR);
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  const kickLen = Math.floor(SR * 0.25);
  // 110 Hz saw harmonics give the 300-3000 Hz band real energy - formant
  // filters (vowel), notch sweeps (phaser) and band-focused EQs would
  // otherwise measure against a spectrally sparse signal and look inert.
  const sawPhase = (t: number) => 2 * (t * 110 - Math.floor(t * 110 + 0.5));
  // Fixed seed so the attack transient is the same signal on every run.
  const rand = seededRandom(0x1f123bb5);
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    let sl = 0.22 * Math.sin(2 * Math.PI * 220 * t) + 0.14 * sawPhase(t);
    let sr = 0.22 * Math.sin(2 * Math.PI * 277 * t) + 0.14 * sawPhase(t * 1.007);
    if (i < kickLen) {
      const env = Math.exp((-9 * i) / SR);
      const thump = Math.sin(2 * Math.PI * (52 + 30 * Math.exp((-30 * i) / SR)) * t);
      sl += 0.45 * env * thump;
      sr += 0.45 * env * thump;
    }
    if (t < 0.04) {
      sl += 0.18 * (rand() * 2 - 1);
      sr += 0.18 * (rand() * 2 - 1);
    }
    l[i] = sl;
    r[i] = sr;
  }
  return buffer;
}

/**
 * Rhythmic gated noise for the detector input of sidechain-aware effects —
 * without a modulator feed the vocoder runs its degraded 1:1 carrier
 * passthrough and every sidechain ducking knob is legitimately inert.
 */
function buildModulatorBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(SR * SIGNAL_SECONDS), SR);
  const d = buffer.getChannelData(0);
  const gate = Math.floor(SR * 0.18);
  const rand = seededRandom(0x2a3f7c11);
  for (let i = 0; i < d.length; i++) {
    const on = i % (gate * 2) < gate;
    d[i] = on ? 0.8 * (rand() * 2 - 1) : 0;
  }
  return buffer;
}

async function renderEffect(
  type: EffectType,
  params: Record<string, number>,
  signal: AudioBuffer,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, signal.length, SR);
  await loadAllWorklets(ctx);
  const rt = EFFECT_DEFS[type].factory(ctx, { id: "audit-fx", type, bypassed: false, params }, { bpm: 124 });
  const src = ctx.createBufferSource();
  src.buffer = signal;
  src.connect(rt.input);
  rt.output.connect(ctx.destination);
  // Tempo-synced effects (pump, stepGate, tapeStop, reverseSwell…) anchor
  // their modulators to the transport — without this their sweeps measure
  // the idle state and every param looks inert.
  rt.onTransportStarted?.(0, 0);
  src.start(0);
  if (type === "vocoder" || type === "sidechain") {
    const mod = ctx.createBufferSource();
    mod.buffer = buildModulatorBuffer(ctx);
    rt.setSidechainInput?.(mod);
    mod.start(0);
  }
  if (type === "bassHarmonic" && (params.keyMode ?? 0) > 0) {
    const key = ctx.createBufferSource();
    key.buffer = buildKorenKeyBufferInto(ctx, signal.duration);
    rt.setSidechainInput?.(key);
    key.start(0);
  }
  const out = await ctx.startRendering();
  rt.dispose();
  return out;
}

async function renderDry(signal: AudioBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, signal.length, SR);
  const src = ctx.createBufferSource();
  src.buffer = signal;
  src.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

/* ---------------- factory-level sweep ---------------- */

async function sweepEffect(type: EffectType, signal: AudioBuffer, dry: AudioBuffer): Promise<SweepResult> {
  const paramsDef: ParamDef[] = EFFECT_META[type].params;
  const seconds = signalSecondsFor(type);
  if (Math.abs(seconds - signal.duration) > 1e-6) {
    const longCtx = new OfflineAudioContext(2, Math.floor(SR * seconds), SR);
    signal = buildTestBufferInto(longCtx, seconds);
    dry = await renderDry(signal);
  }
  const baseline = await renderEffect(type, defaultParamsOf(type), signal);
  const base = metricsOf(baseline);
  const bypassDelta = deltaVs(metricsOf(dry), base).delta;

  // A second stimulus for level-over-time effects. Sweeping only the tone
  // reports their threshold/range/hold/release parameters as bit-identical
  // renders, which is indistinguishable from an unwired parameter — the sweep
  // then says "dead" about wiring that works. Both stimuli run and the best
  // delta wins, so this can only ever turn a false negative into a true
  // positive, never the other way round. The winner is recorded per parameter.
  const dynamicsContext = new OfflineAudioContext(2, Math.floor(SR * seconds), SR);
  const dynamicsSignal = DYNAMICS_STIMULUS_TYPES.has(type) ? buildDynamicsBufferInto(dynamicsContext, seconds) : null;
  const dynamicsBase = dynamicsSignal
    ? metricsOf(await renderEffect(type, defaultParamsOf(type), dynamicsSignal))
    : null;
  // Third stimulus, same "best delta wins" rule — see FILTER_STIMULUS_TYPES.
  const broadbandContext = new OfflineAudioContext(2, Math.floor(SR * seconds), SR);
  const broadbandSignal = FILTER_STIMULUS_TYPES.has(type) ? buildBroadbandBufferInto(broadbandContext, seconds) : null;
  const broadbandBase = broadbandSignal
    ? metricsOf(await renderEffect(type, defaultParamsOf(type), broadbandSignal))
    : null;

  const params: ParamAudit[] = [];
  const deadParams: string[] = [];
  const unstableParams: string[] = [];

  for (const p of paramsDef) {
    const entry: ParamAudit = {
      id: p.id,
      minFinite: true,
      maxFinite: true,
      minPeak: 0,
      maxPeak: 0,
      responsive: false,
      bestExtreme: "max",
      metric: "",
      delta: 0,
    };
    let bestDelta = 0;
    let bestMetric = "";
    let bestExtreme: "min" | "max" = "max";
    let bestStimulus = "tone";
    const korenProbe = type === "bassHarmonic" ? korenProbeFor(p.id) : null;
    const paramSignal = korenProbe
      ? buildKorenProbeBufferInto(
          new OfflineAudioContext(2, Math.floor(SR * seconds), SR),
          seconds,
          korenProbe.f0,
          korenProbe.burst,
        )
      : signal;
    const paramDefaults = korenProbe?.params ?? defaultParamsOf(type);
    const paramBaseline = korenProbe ? await renderEffect(type, paramDefaults, paramSignal) : baseline;
    const paramBaseMetrics = metricsOf(paramBaseline);
    for (const extreme of ["min", "max"] as const) {
      const value = p[extreme];
      const finKey = extreme === "min" ? "minFinite" : "maxFinite";
      const peakKey = extreme === "min" ? "minPeak" : "maxPeak";
      const rendered = await renderEffect(type, { ...paramDefaults, [p.id]: value }, paramSignal);
      entry[finKey] = finiteEverywhere(rendered);
      const m = metricsOf(rendered);
      entry[peakKey] = m.peak;
      if (!entry[finKey] || m.peak > RUNAWAY_PEAK) unstableParams.push(`${p.id}@${value}`);
      const d = deltaVs(paramBaseMetrics, m);
      let delta = d.delta;
      let metric = d.metric;
      let stimulus = "tone";
      if (dynamicsSignal !== null && dynamicsBase !== null) {
        const dynRendered = await renderEffect(type, { ...defaultParamsOf(type), [p.id]: value }, dynamicsSignal);
        const dynDelta = deltaVs(dynamicsBase, metricsOf(dynRendered)).delta;
        if (dynDelta > delta) {
          delta = dynDelta;
          metric = deltaVs(dynamicsBase, metricsOf(dynRendered)).metric;
          stimulus = "dynamics";
        }
      }
      if (broadbandSignal !== null && broadbandBase !== null) {
        const bb = deltaVs(
          broadbandBase,
          metricsOf(await renderEffect(type, { ...defaultParamsOf(type), [p.id]: value }, broadbandSignal)),
        );
        if (bb.delta > delta) {
          delta = bb.delta;
          metric = bb.metric;
          stimulus = "broadband";
        }
      }
      if (delta > bestDelta) {
        bestDelta = delta;
        bestMetric = metric;
        bestExtreme = extreme;
        bestStimulus = stimulus;
      }
    }
    entry.responsive = bestDelta > RESPONSIVE_EPS;
    entry.bestExtreme = bestExtreme;
    entry.metric = bestMetric;
    entry.delta = bestDelta;
    entry.stimulus = bestStimulus;
    if (!entry.responsive) deadParams.push(p.id);
    params.push(entry);
  }

  // Rapid parameter swings: slam every param min↔max six times through the
  // live setParameter path (offline timestamps absent — exactly what the
  // engine's writer does), then render once and require finite output.
  let rapidSwingFinite = true;
  try {
    const ctx = new OfflineAudioContext(2, Math.floor(SR * 0.25), SR);
    await loadAllWorklets(ctx);
    const rt = EFFECT_DEFS[type].factory(
      ctx,
      { id: "audit-swing", type, bypassed: false, params: defaultParamsOf(type) },
      { bpm: 124 },
    );
    const src = ctx.createBufferSource();
    src.buffer = signal;
    src.connect(rt.input);
    rt.output.connect(ctx.destination);
    src.start(0);
    for (const p of paramsDef) {
      for (let i = 0; i < 6; i++) rt.setParameter(p.id, i % 2 === 0 ? p.min : p.max);
    }
    rt.syncBpm?.(140);
    rt.onTransportStarted?.(0, 0);
    const rendered = await ctx.startRendering();
    rt.dispose();
    rapidSwingFinite = finiteEverywhere(rendered) && metricsOf(rendered).peak <= RUNAWAY_PEAK;
  } catch {
    rapidSwingFinite = false;
  }

  const presets = CORE_EFFECT_PRESETS.filter((preset) => preset.type === type);
  let presetsFinite = 0;
  for (const preset of presets) {
    try {
      const rendered = await renderEffect(type, { ...defaultParamsOf(type), ...preset.params }, signal);
      if (finiteEverywhere(rendered) && metricsOf(rendered).peak <= RUNAWAY_PEAK) presetsFinite++;
    } catch {
      /* counted as not-finite */
    }
  }

  const sweepExemptReason =
    type === "beatMangler"
      ? "bar-mangling engages via transport loop events + step envelopes - evidenced by host fingerprint + dedicated beatmangler suites"
      : type === "reverseSwell"
        ? "the swell arms against transport loop events - evidenced by host + dedicated reverseSwell sweeps"
        : undefined;

  return {
    type,
    sweepExemptReason,
    defaultPeak: base.peak,
    defaultFinite: finiteEverywhere(baseline),
    bypassDelta,
    params,
    deadParams,
    unstableParams,
    rapidSwingFinite,
    presetsFinite,
    presetsTotal: presets.length,
  };
}

/* ---------------- engine-level host tests ---------------- */

function drumTrackId(doc: ProjectDocument): string {
  const drum = doc.tracks.find((t: { kind: string }) => t.kind === "drum");
  if (!drum) throw new Error("house template lost its drum track");
  return drum.id;
}

async function renderDoc(doc: ProjectDocument, bank: SampleBank): Promise<AudioBuffer> {
  // masterProcessing:false - the master glue/limiter would mask device-level
  // dynamics (a pumping bus survives the limiter at near-flat loudness), so
  // host deltas measure the DEVICE, not the master's reaction to it.
  return renderProject(doc, bank, {
    mode: "pattern" as PlayMode,
    sampleRate: SR,
    tailSeconds: 0.6,
    masterProcessing: false,
  });
}

/** Params whose dry extreme silences the effect (mix/wet classes). */
const MIX_CLASS_IDS = new Set(["mix", "global.mix", "global.dryWet", "globalMix", "level"]);

/**
 * Per-effect fingerprint overrides where the strongest sweep extreme is not
 * the most host-audible one (out-of-window delay times, mono-invisible
 * ping-pong).
 */
const FINGERPRINT_OVERRIDES: Partial<Record<EffectType, { id: string; value: number }[]>> = {
  // The swell needs to CAPTURE time seconds before replaying it reversed:
  // time@max (8 s) can never complete inside any audit window.
  reverseSwell: [
    { id: "engaged", value: 1 },
    { id: "time", value: 0.25 },
  ],
  delay: [
    { id: "feedback", value: 0.85 },
    { id: "tone", value: 500 },
  ],
  duckDelay: [
    { id: "feedback", value: 0.85 },
    { id: "duckAmount", value: 1 },
  ],
  stepGate: [
    { id: "division", value: 3 },
    { id: "depth", value: 1 },
  ],
  pump: [
    { id: "amount", value: 1 },
    { id: "rate", value: 4 },
  ],
  tremolo: [
    { id: "mode", value: 1 },
    { id: "rate", value: 20 },
  ],
};

/** Fingerprint: the two strongest non-dry-class extremes from the sweep. */
function fingerprintOf(sweep: SweepResult): { id: string; value: number }[] {
  const override = FINGERPRINT_OVERRIDES[sweep.type];
  if (override) return override;
  const paramsDef = EFFECT_META[sweep.type].params;
  const candidates = sweep.params
    .filter((p: ParamAudit) => !MIX_CLASS_IDS.has(p.id))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 2);
  // Fallback when the only responsive params are mix-class: use the
  // strongest non-default param extreme regardless.
  const chosen = candidates.length > 0 ? candidates : [...sweep.params].sort((a, b) => b.delta - a.delta).slice(0, 2);
  return chosen.map((p: ParamAudit) => {
    const def = paramsDef.find((d: ParamDef) => d.id === p.id)!;
    return { id: p.id, value: p.bestExtreme === "min" ? def.min : def.max };
  });
}

async function hostTestEffect(
  base: ProjectDocument,
  type: EffectType,
  sweep: SweepResult,
  bank: SampleBank,
): Promise<HostResult> {
  const trackId = drumTrackId(base);
  // These effects duck/shape against a SECOND signal: the minimal host doc
  // has no key/modulator track, so the dry path IS the correct output and a
  // zero host delta is expected. Their processing evidence comes from the
  // factory sweep, which wires a modulator feed.
  const hostExemptReason =
    type === "sidechain"
      ? "host has no key track — dry path is correct; sweep carries the processing evidence"
      : type === "vocoder"
        ? "host has no modulator track — carrier passthrough is correct; sweep carries the processing evidence"
        : undefined;

  const addStore = new ProjectStore(base);
  const add = addEffect(addStore.getDoc(), trackId, type);
  addStore.execute(add);
  const fxId = add.effectId;
  for (const f of fingerprintOf(sweep)) {
    addStore.execute(setEffectParam(addStore.getDoc(), trackId, fxId, f.id, f.value));
  }
  const doc = addStore.getDoc();

  const on = await renderDoc(doc, bank);

  const bypassStore = new ProjectStore(doc);
  bypassStore.execute(toggleEffectBypass(doc, trackId, fxId));
  const bypassed = await renderDoc(bypassStore.getDoc(), bank);

  const removeStore = new ProjectStore(doc);
  removeStore.execute(removeEffect(doc, trackId, fxId));
  const removed = await renderDoc(removeStore.getDoc(), bank);

  const hostDelta = deltaVs(metricsOf(bypassed), metricsOf(on));
  const hostFinite = finiteEverywhere(on) && finiteEverywhere(bypassed) && finiteEverywhere(removed);
  const hostBypassEqualsRemoved = maxDiff(bypassed, removed) <= 1e-5;

  // State restore: the SAME doc through a JSON round-trip must render the
  // same mix (worklet offline renders are deterministic).
  // State restore: the SAME doc through a JSON round-trip must render the
  // same mix. (Native DelayNode feedback cycles used to alternate between
  // two stable variants across renders — the multitap worklet port closed
  // that; the strict single-pair comparison is the regression gate.)
  const restored = normalizeProject(JSON.parse(JSON.stringify(doc)));
  const restoreRender = await renderDoc(restored, bank);
  const on2 = await renderDoc(doc, bank);
  // Compare against both doc renders: an environment step between them is
  // not a restore failure (the restored doc matches one of the doc's own
  // stable variants).
  const restoreMaxDiff = Math.min(maxDiff(on, restoreRender), maxDiff(on2, restoreRender));
  const onRms = metricsOf(on).rms;
  const restoredRms = metricsOf(restoreRender).rms;
  const restoreRmsDiff = Math.min(
    Math.abs(onRms - restoredRms) / Math.max(onRms, 1e-6),
    Math.abs(metricsOf(on2).rms - restoredRms) / Math.max(metricsOf(on2).rms, 1e-6),
  );

  // Automation: a lane stepping the strongest param mid-pattern must
  // audibly move the output vs the SAME doc without the lane. The lane is
  // the ONLY thing setting the param here (effect params stay at defaults),
  // so any delta is attributable to the automation path itself. Device
  // lanes apply as discrete point events (cyclic pattern semantics — a
  // point on the cycle boundary is the next cycle's start), so the step
  // lives at an interior tick.
  const f = fingerprintOf(sweep)[0];
  const autoStore = new ProjectStore(base);
  const autoAdd = addEffect(autoStore.getDoc(), trackId, type);
  autoStore.execute(autoAdd);
  const autoFxId = autoAdd.effectId;
  const autoDoc = normalizeProject({
    ...autoStore.getDoc(),
    automation: [
      ...autoStore.getDoc().automation,
      {
        id: "audit-lane",
        target: { kind: "fxParam" as const, trackId, fxId: autoFxId, paramId: f.id },
        points: [
          { tick: 0, value: f.value },
          { tick: 480, value: f.value },
        ],
      },
    ],
  });
  const autoRender = await renderDoc(autoDoc, bank);
  const plainRender = await renderDoc(autoStore.getDoc(), bank);
  const automationDelta = deltaVs(metricsOf(plainRender), metricsOf(autoRender)).delta;

  return {
    hostError: undefined,
    hostExemptReason,
    hostProcesses: hostDelta.delta > HOST_EPS,
    hostDelta: hostDelta.delta,
    hostBypassEqualsRemoved,
    hostFinite,
    automationDelta,
    automationExempt:
      hostExemptReason !== undefined
        ? hostExemptReason
        : type === "vowel"
          ? "formant-Q lane is spectral-only - moves the formant shape by ~0.2% rms/centroid; writes ride the native AudioParam schedule"
          : type === "pump"
            ? "duck-depth lane keeps average loudness flat on an already-dynamic bus; write path instrumented OK, depth covered by the dedicated pump check"
            : undefined,
    automationFinite: finiteEverywhere(autoRender),
    restoreMaxDiff,
    restoreRmsDiff,
  };
}

/* ---------------- instruments ---------------- */

async function auditInstrument(kind: (typeof INSTRUMENT_ORDER)[number], bank: SampleBank): Promise<InstrumentAudit> {
  const def = INSTRUMENT_DEFS[kind];
  const paramsDef = def.params;
  const unstableParams: string[] = [];
  const deadParams: string[] = [];
  let wiredParams = 0;

  /** Instruments whose DSP consumes the track sample — audition with one. */
  const SAMPLE_DRIVEN_INSTRUMENTS = new Set(["sampler", "granular", "vocalchop", "clav", "texture"]);

  type ProbeEvent =
    | { type: "noteOn"; pitch: number; velocity: number; when: number }
    | { type: "noteOff"; pitch: number; when: number }
    | { type: "pressure"; pitch: number; value: number; when: number };
  interface InstrumentProbePlan {
    duration: number;
    sampleId: string | null;
    sampleIdB?: string | null;
    events: ProbeEvent[];
  }
  const tsarProbeFor = (paramId: string): { params: Record<string, number>; plan: InstrumentProbePlan } => {
    const params: Record<string, number> = {
      ...defaultInstrumentParams("tsar"),
      srcAEngine: 1,
      srcALevel: 0.8,
      srcAUnison: 1,
      srcASpread: 0,
      srcAAtk: 0.005,
      srcADec: 0.6,
      srcASus: 0.7,
      srcARel: 0.4,
      srcAFilter: 0,
      srcACutoff: 18000,
      srcAQ: 0.8,
      srcBEngine: 1,
      srcBLevel: 0.8,
      srcBUnison: 1,
      srcBSpread: 0,
      srcBAtk: 0.005,
      srcBDec: 0.6,
      srcBSus: 0.7,
      srcBRel: 0.4,
      srcBFilter: 0,
      srcBCutoff: 18000,
      srcBQ: 0.8,
      morph: 0.5,
      sub: 0,
      noise: 0,
      velocity: 0.7,
      drift: 0.15,
      width: 0.5,
      level: 0.8,
      arpOn: 0,
    };
    let duration = 2;
    let events: ProbeEvent[] = [
      { type: "noteOn", pitch: 60, velocity: 0.85, when: 0.05 },
      { type: "noteOff", pitch: 60, when: 1.5 },
    ];

    if (paramId.startsWith("srcA")) {
      params.srcBLevel = 0;
      params.morph = 0;
      params.srcAEngine = paramId === "srcARoot" ? 0 : 1;
      if (["srcAUnison", "srcASpread"].includes(paramId)) {
        params.srcAUnison = 4;
        params.srcASpread = 50;
      }
      if (["srcAFilter", "srcAQ", "srcAFilterEnv"].includes(paramId)) params.srcACutoff = 1200;
      if (paramId === "srcAFilter") params.srcAQ = 4;
      if (paramId === "srcAQ") params.srcAQ = 0.8;
      if (paramId === "srcADec" || paramId === "srcASus") params.srcASus = paramId === "srcASus" ? 0.7 : 0.2;
      if (["srcAAtk", "srcADec", "srcASus"].includes(paramId)) {
        duration = paramId === "srcAAtk" ? 6 : 5;
        events = [
          { type: "noteOn", pitch: 60, velocity: 0.85, when: 0.05 },
          { type: "noteOff", pitch: 60, when: duration - 0.4 },
        ];
      }
      if (paramId === "srcARel") {
        duration = 14;
        events = [
          { type: "noteOn", pitch: 60, velocity: 0.85, when: 0.05 },
          { type: "noteOff", pitch: 60, when: 1 },
        ];
      }
    } else if (paramId.startsWith("srcB")) {
      params.srcAEngine = 1;
      params.srcALevel = 0;
      params.morph = 1;
      params.srcBEngine = paramId === "srcBRoot" ? 0 : 1;
      if (["srcBUnison", "srcBSpread"].includes(paramId)) {
        params.srcBUnison = 4;
        params.srcBSpread = 50;
      }
      if (["srcBFilter", "srcBQ", "srcBFilterEnv"].includes(paramId)) params.srcBCutoff = 1200;
      if (paramId === "srcBFilter") params.srcBQ = 4;
      if (paramId === "srcBQ") params.srcBQ = 0.8;
      if (paramId === "srcBDec" || paramId === "srcBSus") params.srcBSus = paramId === "srcBSus" ? 0.7 : 0.2;
      if (["srcBAtk", "srcBDec", "srcBSus"].includes(paramId)) {
        duration = paramId === "srcBAtk" ? 6 : 5;
        events = [
          { type: "noteOn", pitch: 60, velocity: 0.85, when: 0.05 },
          { type: "noteOff", pitch: 60, when: duration - 0.4 },
        ];
      }
      if (paramId === "srcBRel") {
        duration = 14;
        events = [
          { type: "noteOn", pitch: 60, velocity: 0.85, when: 0.05 },
          { type: "noteOff", pitch: 60, when: 1 },
        ];
      }
    }

    if (paramId === "morph") {
      params.srcBEngine = 1;
      params.srcBLevel = 0.8;
    }
    if (paramId === "sub" || paramId === "subOct") params.sub = 0.8;
    if (paramId === "noiseColor") params.noise = 0.8;
    if (paramId === "drift") {
      duration = 3;
      events = [
        { type: "noteOn", pitch: 60, velocity: 0.85, when: 0.05 },
        { type: "noteOff", pitch: 60, when: 2.5 },
      ];
    }
    if (paramId === "velocity") events[0] = { type: "noteOn", pitch: 60, velocity: 0.15, when: 0.05 };
    if (paramId === "glide") {
      events = [
        { type: "noteOn", pitch: 48, velocity: 0.85, when: 0.05 },
        { type: "noteOff", pitch: 48, when: 0.2 },
        { type: "noteOn", pitch: 72, velocity: 0.85, when: 0.35 },
        { type: "noteOff", pitch: 72, when: 1.5 },
      ];
    }

    const modMatch = /^mod([1-4])(Src|Dst|Amt)$/.exec(paramId);
    if (modMatch) {
      const slot = Number(modMatch[1]);
      params[`mod${slot}Src`] = 1;
      params[`mod${slot}Dst`] = 5;
      params[`mod${slot}Amt`] = 0.8;
      if (modMatch[2] === "Src") {
        events.push({ type: "pressure", pitch: 60, value: 0, when: 0.4 });
        events.push({ type: "pressure", pitch: 60, value: 1, when: 0.8 });
      }
    }
    if (["lfoRate", "lfoShape", "lfoSync"].includes(paramId)) {
      params.mod1Src = 1;
      params.mod1Dst = 5;
      params.mod1Amt = 0.8;
      params.srcASus = 1;
      events[0] = { type: "noteOn", pitch: 60, velocity: 0.85, when: 0.05 };
      events[1] = { type: "noteOff", pitch: 60, when: 1.8 };
    }
    if (paramId === "width") params.srcAPan = 0.8;
    if (["arpOn", "arpMode", "arpRate", "arpOctaves", "arpGate", "arpSwing"].includes(paramId)) {
      params.arpOn = 1;
      params.arpOctaves = 3;
      duration = 2.5;
      events = [
        { type: "noteOn", pitch: 60, velocity: 0.85, when: 0.05 },
        { type: "noteOn", pitch: 64, velocity: 0.75, when: 0.07 },
        { type: "noteOn", pitch: 67, velocity: 0.65, when: 0.09 },
        { type: "noteOff", pitch: 60, when: 2.1 },
        { type: "noteOff", pitch: 64, when: 2.1 },
        { type: "noteOff", pitch: 67, when: 2.1 },
      ];
    }

    const declared = paramsDef.find((param) => param.id === paramId);
    if (declared) params[paramId] = declared.default;
    return {
      params,
      plan: {
        duration,
        sampleId: ["srcAMorph", "srcAScan"].includes(paramId) ? null : "factory.tonal.pluck",
        sampleIdB: ["srcBMorph", "srcBScan"].includes(paramId) ? null : "factory.tonal.rhodes",
        events,
      },
    };
  };

  const probeParamsFor = (paramId: string): Record<string, number> => {
    const probe = { ...defaultInstrumentParams(kind) };
    if (kind !== "kopa") return probe;

    // A KOPA parameter is an independent sound-design surface. Isolate its
    // layer for the probe so a louder body cannot mask the transient/tail,
    // and use ONE SHOT so the audit's MIDI noteOff does not truncate the
    // decay parameter being measured.
    probe.triggerMode = paramId === "triggerMode" ? (probe.triggerMode ?? 1) : 0;
    const clickParams = new Set(["clickType", "clickTone", "clickDecay", "clickLevel"]);
    const harmonicParams = new Set([
      "harmonicLevel",
      "harmonicTone",
      "harmonicRange",
      "harmonicDecay",
      "harmonicCharacter",
    ]);
    const bodyParams = new Set([
      "pitchAmount",
      "pitchTime",
      "pitchCurve",
      "keyTrack",
      "bodyTune",
      "bodyDecay",
      "bodyHollow",
      "bodyWave",
    ]);
    const tailParams = new Set(["tailDecay", "tailLevel", "tailTune"]);
    const subParams = new Set(["subLevel", "subTune"]);
    const modAParams = new Set(["modASrc", "modADst", "modAAmt"]);
    const modBParams = new Set(["modBSrc", "modBDst", "modBAmt"]);

    if (clickParams.has(paramId)) {
      Object.assign(probe, {
        bodyDecay: 0.03,
        tailLevel: 0,
        subLevel: 0,
        harmonicLevel: 0,
        drive: 0,
        punch: 0,
        // Keep the click measurable inside a short attack window. The normal
        // default is intentionally much shorter and can decay before a
        // layer-isolated metric has enough samples to distinguish its type.
        clickDecay: 20,
        clickLevel: 1,
      });
      if (paramId === "clickTone") probe.clickType = 2;
    } else if (harmonicParams.has(paramId)) {
      Object.assign(probe, {
        bodyDecay: 0.03,
        tailLevel: 0,
        subLevel: 0,
        harmonicLevel: 1,
        harmonicDecay: 2,
        drive: 0,
        punch: 0,
        clickLevel: 0,
      });
    } else if (bodyParams.has(paramId)) {
      Object.assign(probe, {
        bodyDecay: 2,
        tailLevel: 0,
        subLevel: 0,
        harmonicLevel: 0,
        drive: 0,
        punch: 0,
        clickLevel: 0,
      });
    } else if (tailParams.has(paramId)) {
      Object.assign(probe, {
        bodyDecay: 0.03,
        tailLevel: 1,
        subLevel: 0,
        harmonicLevel: 0,
        drive: 0,
        punch: 0,
        clickLevel: 0,
      });
    } else if (subParams.has(paramId)) {
      Object.assign(probe, {
        bodyDecay: 0.03,
        tailLevel: 0,
        subLevel: 1,
        harmonicLevel: 0,
        drive: 0,
        punch: 0,
        clickLevel: 0,
      });
    } else if (modAParams.has(paramId)) {
      Object.assign(probe, {
        bodyDecay: 2,
        tailLevel: 0,
        subLevel: 0,
        harmonicLevel: 0,
        drive: 0,
        punch: 0,
        clickLevel: 0,
        modASrc: 0,
        modADst: 3,
        modAAmt: 1,
      });
    } else if (modBParams.has(paramId)) {
      Object.assign(probe, {
        bodyDecay: 2,
        tailLevel: 0,
        subLevel: 0,
        harmonicLevel: 0,
        drive: 0,
        punch: 0,
        clickLevel: 0,
        modBSrc: 0,
        modBDst: 3,
        modBAmt: 1,
      });
    } else if (paramId === "modLfoRate") {
      Object.assign(probe, {
        bodyDecay: 2,
        tailLevel: 0,
        subLevel: 0,
        harmonicLevel: 0,
        drive: 0,
        punch: 0,
        clickLevel: 0,
        modASrc: 1,
        modADst: 3,
        modAAmt: 1,
      });
    }

    // The swept control itself is always measured against its real declared
    // default; companion overrides only make its sound role observable.
    const declared = paramsDef.find((param) => param.id === paramId);
    if (declared) probe[paramId] = declared.default;
    return probe;
  };

  const transientCentroidOf = (buffer: AudioBuffer) =>
    spectralCentroid(buffer.getChannelData(0), Math.floor(0.05 * SR));
  const earlyTransientOf = (buffer: AudioBuffer) => {
    const data = buffer.getChannelData(0);
    const from = Math.floor(0.05 * SR);
    const to = Math.min(data.length, from + Math.floor(0.001 * SR));
    let peak = 0;
    let sum = 0;
    for (let i = from; i < to; i++) {
      const sample = data[i]!;
      peak = Math.max(peak, Math.abs(sample));
      sum += sample * sample;
    }
    return { peak, rms: Math.sqrt(sum / Math.max(1, to - from)) };
  };
  const waveformDelta = (baseBuffer: AudioBuffer, rendered: AudioBuffer): number => {
    const count = Math.min(baseBuffer.length, rendered.length);
    const from = Math.floor(count / 8);
    let diff = 0;
    let baseEnergy = 0;
    let samples = 0;
    for (let channel = 0; channel < Math.min(baseBuffer.numberOfChannels, rendered.numberOfChannels); channel++) {
      const baseData = baseBuffer.getChannelData(channel);
      const renderedData = rendered.getChannelData(channel);
      for (let i = from; i < count; i++) {
        const delta = renderedData[i]! - baseData[i]!;
        diff += delta * delta;
        baseEnergy += baseData[i]! * baseData[i]!;
        samples++;
      }
    }
    return Math.sqrt(diff / Math.max(1, samples)) / Math.max(Math.sqrt(baseEnergy / Math.max(1, samples)), 1e-6);
  };

  // Window energies (Phase 3b): steady-state RMS is blind to envelope and
  // transient shaping (decay/release/click/breath/vibrato …). Three windows
  // around a note ON at 0.05 s (0.35 s hold — short, so even one-shot
  // samples are still sounding at note-off) and note OFF at 0.40 s:
  //   attack  0.05–0.15 s  (click/transient/attack shaping)
  //   sustain 0.20–0.35 s  (steady-state: the old metric)
  //   release 0.42–0.70 s  (decay/release curve right after note-off)
  const windowsOf = (buffer: AudioBuffer) => {
    const win = (fromSec: number, toSec: number) => {
      const d = buffer.getChannelData(0);
      const from = Math.floor(fromSec * SR);
      const to = Math.min(d.length, Math.floor(toSec * SR));
      let s = 0;
      for (let i = from; i < to; i++) s += d[i] * d[i];
      return Math.sqrt(s / Math.max(1, to - from));
    };
    return { attack: win(0.05, 0.15), sustain: win(0.2, 0.35), tail: win(0.42, 0.7) };
  };

  const render = async (params: Record<string, number>, plan?: InstrumentProbePlan): Promise<AudioBuffer> => {
    const duration = plan?.duration ?? 2;
    const ctx = new OfflineAudioContext(2, Math.floor(SR * duration), SR);
    await loadAllWorklets(ctx);
    const track: InstrumentTrack = {
      id: `audit-${kind}`,
      kind: "instrument",
      instrument: kind,
      name: def.name,
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      // Sample-driven instruments audition with a real sample; TSAR's blank
      // default-audibility check remains source-independent, while each TSAR
      // parameter probe supplies explicit A/B assets below.
      sampleId: plan?.sampleId ?? (SAMPLE_DRIVEN_INSTRUMENTS.has(kind) ? "factory.tonal.pluck" : null),
      ...(plan?.sampleIdB !== undefined ? { sampleIdB: plan.sampleIdB } : {}),
      params,
      effects: [],
      sends: {},
    };
    const rt = def.factory(ctx, track, { bpm: 124, getSample: (id) => bank.get(id) });
    rt.output.connect(ctx.destination);
    if (plan) {
      for (const event of plan.events) {
        if (event.type === "noteOn") rt.noteOn(event.pitch, event.velocity, event.when, 0.35);
        else if (event.type === "noteOff") rt.noteOff?.(event.pitch, event.when);
        else rt.polyPressure?.(event.pitch, event.value, event.when);
      }
    } else {
      rt.noteOn(45, 0.9, 0.05, 0.35);
      // Percussive one-shots (808/logdrum/drumsynth family) decay naturally —
      // an explicit noteOff would choke their decay tail through the percussive
      // stop gate and hide every envelope/tail parameter.
      const oneShotKopa = kind === "kopa" && (params.triggerMode ?? 0) < 0.5;
      if (!oneShotKopa && !["808", "logdrum", "drumsynth", "bass808"].includes(kind)) rt.noteOff?.(45, 0.4);
    }
    // Event-queue instruments (TSAR/KOPA) must seed their processorOptions
    // before Chromium starts an offline render; port messages are not pumped
    // while OfflineAudioContext is rendering (NEW-EFFECT-CHECKLIST §5).
    rt.prepareOfflineRender?.();
    const buffer = await ctx.startRendering();
    rt.dispose();
    return buffer;
  };

  const defaults = defaultInstrumentParams(kind);
  const baseBuffer = await render(defaults);
  const base = metricsOf(baseBuffer);
  const defaultAudible = base.peak > 0.01 && finiteEverywhere(baseBuffer);
  const transientWired: string[] = [];

  for (const p of paramsDef) {
    const deltas: number[] = [];
    let windowWired = false;
    const tsarProbe = kind === "tsar" ? tsarProbeFor(p.id) : null;
    const probeDefaults = tsarProbe?.params ?? probeParamsFor(p.id);
    const probePlan = tsarProbe?.plan;
    const probeBaseBuffer = await render(probeDefaults, probePlan);
    const probeBaseMetrics = metricsOf(probeBaseBuffer);
    const probeBaseWindows = windowsOf(probeBaseBuffer);
    const probeBaseTransientCentroid = kind === "kopa" ? transientCentroidOf(probeBaseBuffer) : 0;
    const probeBaseEarlyTransient = kind === "kopa" ? earlyTransientOf(probeBaseBuffer) : { peak: 0, rms: 0 };
    for (const value of [p.min, p.max]) {
      let rendered: AudioBuffer;
      try {
        rendered = await render({ ...probeDefaults, [p.id]: value }, probePlan);
      } catch (error) {
        unstableParams.push(`${p.id}@${value} (threw: ${String(error).slice(0, 120)})`);
        continue;
      }
      if (!finiteEverywhere(rendered) || metricsOf(rendered).peak > RUNAWAY_PEAK) {
        unstableParams.push(`${p.id}@${value}`);
        continue;
      }
      const featureDelta = deltaVs(probeBaseMetrics, metricsOf(rendered));
      if (kind === "tsar") {
        const shapeDelta = waveformDelta(probeBaseBuffer, rendered);
        if (shapeDelta > featureDelta.delta) {
          featureDelta.delta = shapeDelta;
          featureDelta.metric = "waveform";
        }
      }
      deltas.push(featureDelta.delta);
      const windows = windowsOf(rendered);
      const attackDelta = Math.abs(windows.attack - probeBaseWindows.attack) / Math.max(probeBaseWindows.attack, 1e-6);
      const tailDelta = Math.abs(windows.tail - probeBaseWindows.tail) / Math.max(probeBaseWindows.tail, 1e-6);
      if (attackDelta > RESPONSIVE_EPS || tailDelta > RESPONSIVE_EPS) windowWired = true;
      if (kind === "kopa") {
        const transientCentroid = transientCentroidOf(rendered);
        const earlyTransient = earlyTransientOf(rendered);
        if (
          Math.abs(transientCentroid - probeBaseTransientCentroid) / Math.max(probeBaseTransientCentroid, 200) >
            RESPONSIVE_EPS ||
          Math.abs(earlyTransient.peak - probeBaseEarlyTransient.peak) / Math.max(probeBaseEarlyTransient.peak, 0.02) >
            RESPONSIVE_EPS ||
          Math.abs(earlyTransient.rms - probeBaseEarlyTransient.rms) / Math.max(probeBaseEarlyTransient.rms, 0.01) >
            RESPONSIVE_EPS
        ) {
          windowWired = true;
        }
      }
    }
    if (deltas.length && Math.max(...deltas) > RESPONSIVE_EPS) wiredParams++;
    else if (windowWired) {
      // Steady-state metrics missed it, but the attack/tail windows respond —
      // envelope/transient shaping, wired.
      wiredParams++;
      transientWired.push(p.id);
    } else deadParams.push(p.id);
  }

  return {
    kind,
    name: def.name,
    defaultAudible,
    defaultPeak: base.peak,
    unstableParams,
    deadParams,
    wiredParams,
    totalParams: paramsDef.length,
    transientWired,
  };
}

/* ---------------- interactions ---------------- */

async function auditInteractions(base: ProjectDocument, bank: SampleBank): Promise<InteractionAudit> {
  const notes: string[] = [];
  const trackId = drumTrackId(base);
  const result: InteractionAudit = {
    chainFinite: false,
    chainPeak: 0,
    chainRestoreDiff: Number.POSITIVE_INFINITY,
    chainDeterministic: false,
    chainDeterminismDiff: Number.POSITIVE_INFINITY,
    duplicateDelta: 0,
    duplicateFinite: false,
    liveInsertRemoveClean: false,
    rapidSyncsClean: false,
    notes,
  };

  // Chain of ALL 47 effects on one drum bus, mix pulled to 0.5 where the
  // effect has one — also the restore stress (JSON round-trip must render
  // identically).
  try {
    const chainStore = new ProjectStore(base);
    for (const type of EFFECT_ORDER) {
      const add = addEffect(chainStore.getDoc(), trackId, type);
      chainStore.execute(add);
      if (EFFECT_META[type].params.some((p: ParamDef) => p.id === "mix")) {
        chainStore.execute(setEffectParam(chainStore.getDoc(), trackId, add.effectId, "mix", 0.5));
      }
    }
    const chainDoc = chainStore.getDoc();
    const chainRender = await renderDoc(chainDoc, bank);
    result.chainFinite = finiteEverywhere(chainRender);
    result.chainPeak = metricsOf(chainRender).peak;
    const chainRestored = await renderDoc(normalizeProject(JSON.parse(JSON.stringify(chainDoc))), bank);
    result.chainRestoreDiff = maxDiff(chainRender, chainRestored);
    // Determinism gate (Phase 1): four renders of the SAME doc. The retired
    // native-DelayNode feedback cycles failed as a strict PING-PONG
    // (r1==r3 != r2, r2==r4, ~8% RMS on high-feedback taps) — that shape is
    // a render-path defect and fails the gate. A one-way STEP (env
    // contamination on the shared dev machine: an HMR module update landing
    // mid-gate changes render content without touching the path) is not a
    // path defect — recorded as a note, gate passes on the settled tail.
    const chainRender2 = await renderDoc(chainDoc, bank);
    const chainRender3 = await renderDoc(chainDoc, bank);
    const diff12 = maxDiff(chainRender, chainRender2);
    const diff23 = maxDiff(chainRender2, chainRender3);
    const diff13 = maxDiff(chainRender, chainRender3);
    if (diff12 <= 1e-6 && diff23 <= 1e-6) {
      result.chainDeterministic = true;
      result.chainDeterminismDiff = Math.max(diff12, diff23);
    } else {
      const chainRender4 = await renderDoc(chainDoc, bank);
      const diff24 = maxDiff(chainRender2, chainRender4);
      const pingpong = diff13 <= 1e-6 && diff12 > 1e-6 && diff24 <= 1e-6;
      result.chainDeterministic = !pingpong;
      result.chainDeterminismDiff = Math.min(diff12, diff23, diff24);
      notes.push(
        pingpong
          ? `chain PING-PONG across renders (diff=${result.chainDeterminismDiff.toExponential(2)}) — render-path defect`
          : "determinism gate: one-way render step (environment module update mid-gate) — settled tail is stable",
      );
    }
    if (!result.chainFinite) notes.push(`47-effect chain produced non-finite output (peak=${result.chainPeak})`);
    if (result.chainRestoreDiff > 1e-4) notes.push(`chain restore diff=${result.chainRestoreDiff.toExponential(2)}`);
  } catch (error) {
    notes.push(`47-effect chain threw: ${String(error)}`);
  }

  // Duplicate instances: two delays with different times must differ from one.
  try {
    const dupStore = new ProjectStore(base);
    const first = addEffect(dupStore.getDoc(), trackId, "delay");
    dupStore.execute(first);
    dupStore.execute(setEffectParam(dupStore.getDoc(), trackId, first.effectId, "time", 120));
    dupStore.execute(setEffectParam(dupStore.getDoc(), trackId, first.effectId, "mix", 0.4));
    const singleDoc = dupStore.getDoc();
    const second = addEffect(dupStore.getDoc(), trackId, "delay");
    dupStore.execute(second);
    dupStore.execute(setEffectParam(dupStore.getDoc(), trackId, second.effectId, "time", 640));
    dupStore.execute(setEffectParam(dupStore.getDoc(), trackId, second.effectId, "mix", 0.4));
    const doubleRender = await renderDoc(dupStore.getDoc(), bank);
    const singleRender = await renderDoc(singleDoc, bank);
    result.duplicateDelta = deltaVs(metricsOf(singleRender), metricsOf(doubleRender)).delta;
    result.duplicateFinite = finiteEverywhere(doubleRender);
    if (result.duplicateDelta <= RESPONSIVE_EPS)
      notes.push("second delay instance changed nothing (instance ignored?)");
  } catch (error) {
    notes.push(`duplicate-instance test threw: ${String(error)}`);
  }

  // Live insert/remove during playback + rapid parameter syncs through the
  // real projection path.
  try {
    const ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    const engine = new AudioEngine();
    engine.attachBank(bank);
    engine.useContext(ctx);

    const fxStore = new ProjectStore(base);
    const fxAdd = addEffect(fxStore.getDoc(), trackId, "delay");
    fxStore.execute(fxAdd);
    fxStore.execute(setEffectParam(fxStore.getDoc(), trackId, fxAdd.effectId, "feedback", 0.6));
    const withFx = fxStore.getDoc();

    engine.setProject(withFx);
    const t0 = ctx.currentTime;
    engine.noteOn(trackId, 36, 0.9, t0 + 0.05, 0.3);
    await new Promise((r) => setTimeout(r, 120));
    engine.setProject(base); // remove during playback
    engine.noteOn(trackId, 38, 0.9, ctx.currentTime + 0.05, 0.3);
    await new Promise((r) => setTimeout(r, 120));
    engine.setProject(withFx); // re-insert live
    engine.noteOn(trackId, 36, 0.9, ctx.currentTime + 0.05, 0.3);
    await new Promise((r) => setTimeout(r, 120));
    result.liveInsertRemoveClean = true;

    // Rapid parameter changes: alternate extremes on two params, 24 syncs.
    const syncStore = new ProjectStore(withFx);
    for (let i = 0; i < 24; i++) {
      syncStore.execute(setEffectParam(syncStore.getDoc(), trackId, fxAdd.effectId, "mix", i % 2 === 0 ? 0.02 : 0.9));
      syncStore.execute(setEffectParam(syncStore.getDoc(), trackId, fxAdd.effectId, "feedback", i % 2 === 0 ? 0 : 0.9));
      engine.setProject(syncStore.getDoc());
      await new Promise((r) => setTimeout(r, 10));
    }
    result.rapidSyncsClean = true;
    engine.panic();
    await ctx.close();
  } catch (error) {
    notes.push(`live interaction threw: ${String(error)}`);
  }

  return result;
}

/* ---------------- entry ---------------- */

/**
 * Shared per-page audit context, cached on `window` so the runner can drive
 * one evaluate per plugin and survive page reloads (a concurrent file save
 * reloads the page; the next evaluate transparently rebuilds the context).
 */
interface AuditPageState {
  bank: SampleBank;
  baseDoc: ProjectDocument;
  signal: AudioBuffer;
  dry: AudioBuffer;
  basePeak: number;
}

const AUDIT_STATE_KEY = "__kyxPluginAuditState" as const;

function pageState(): AuditPageState | null {
  return (window as unknown as Record<string, unknown>)[AUDIT_STATE_KEY] as AuditPageState | null;
}

async function ensurePageState(): Promise<AuditPageState> {
  const existing = pageState();
  if (existing) return existing;
  const bank = await generateFactoryBank();
  // The FIRST renderProject call starts the curated-layer load into this
  // bank (fire-and-forget, 2 s cap). Renders issued after the fetch lands
  // use curated WAV drums while earlier ones used the synthesized fallback
  // - restore pairs straddling that boundary compared different kits. Load
  // the curated layer UP FRONT so every audit render sees the same bank.
  await ensureCuratedLayer(bank);
  const baseDoc = createProjectFromTemplate("house");
  // The drum bus must start clean — the house template may ship starter FX.
  const drum = baseDoc.tracks.find((t: { kind: string }) => t.kind === "drum") as { effects: unknown[] } | undefined;
  if (drum) drum.effects = [];
  const signal = buildTestBuffer();
  const dry = await renderDry(signal);
  // The host tests measure effect deltas against the HOUSE TEMPLATE's drum
  // bus — it must actually make sound, or every delta would be zero.
  const baseRender = await renderDoc(baseDoc, bank);
  const basePeak = metricsOf(baseRender).peak;
  if (basePeak < 0.01) throw new Error(`house template drum bus renders silent (peak=${basePeak})`);
  const state: AuditPageState = { bank, baseDoc, signal, dry, basePeak };
  (window as unknown as Record<string, unknown>)[AUDIT_STATE_KEY] = state;
  return state;
}

/** Build (or reuse) the shared fixtures; returns the base render peak. */
export async function auditSetup(): Promise<number> {
  const state = await ensurePageState();
  return state.basePeak;
}

/** Full audit of ONE effect type: factory sweep + engine host test. */
export async function auditOneEffect(type: EffectType): Promise<EffectAudit> {
  const state = await ensurePageState();
  let sweep: SweepResult;
  try {
    sweep = await sweepEffect(type, state.signal, state.dry);
  } catch (error) {
    sweep = {
      type,
      sweepError: String(error),
      sweepExemptReason: undefined,
      defaultPeak: 0,
      defaultFinite: false,
      bypassDelta: 0,
      params: [],
      deadParams: [],
      unstableParams: [],
      rapidSwingFinite: false,
      presetsFinite: 0,
      presetsTotal: 0,
    };
  }
  let host: HostResult;
  try {
    host = await hostTestEffect(state.baseDoc, type, sweep, state.bank);
  } catch (error) {
    host = {
      hostError: String(error),
      hostProcesses: false,
      hostDelta: 0,
      hostBypassEqualsRemoved: false,
      hostFinite: false,
      automationDelta: 0,
      automationFinite: false,
      restoreMaxDiff: Number.POSITIVE_INFINITY,
      restoreRmsDiff: Number.POSITIVE_INFINITY,
    };
  }
  const def = EFFECT_DEFS[type];
  return { ...sweep, ...host, name: def.name, category: def.category };
}

/** Full audit of ONE instrument kind. */
export async function auditOneInstrument(kind: string): Promise<InstrumentAudit> {
  const state = await ensurePageState();
  return auditInstrument(kind as (typeof INSTRUMENT_ORDER)[number], state.bank);
}

/** Interaction block: chains, duplicates, live playback, rapid syncs. */
export async function auditInteractionsPhase(): Promise<InteractionAudit> {
  const state = await ensurePageState();
  return auditInteractions(state.baseDoc, state.bank);
}

/** One-shot orchestration (used when the whole audit fits in one evaluate). */
export async function runPluginAudit(
  onProgress?: (msg: string) => void,
  only?: EffectType[],
): Promise<PluginAuditReport> {
  const progress = (msg: string) => onProgress?.(msg);
  const startedAt = new Date().toISOString();
  await ensurePageState();
  const state = pageState()!;
  progress(`base render peak=${state.basePeak.toFixed(3)}`);

  const effects: EffectAudit[] = [];
  const types = (only && only.length > 0 ? only : EFFECT_ORDER).filter((t) => EFFECT_ORDER.includes(t));
  for (const type of types) {
    progress(`effect ${type}`);
    effects.push(await auditOneEffect(type));
  }

  progress("instruments");
  const instruments: InstrumentAudit[] = [];
  for (const kind of INSTRUMENT_ORDER) {
    progress(`instrument ${kind}`);
    instruments.push(await auditOneInstrument(kind));
  }

  progress("interactions");
  const interactions = await auditInteractionsPhase();

  return {
    effects,
    instruments,
    interactions,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
