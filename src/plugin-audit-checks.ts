/**
 * INTERNAL PLUGIN AUDIT (2026-09-27) — real-audio half.
 *
 * Runs in a real browser (scripts/verify-plugin-audit.mjs) and produces the
 * measurement evidence behind docs/PLUGIN-AUDIT-2026-09-27.md. The
 * document-level half (ranges, serialization, automation targets) lives in
 * tests/plugin-functional-audit.test.ts.
 *
 * For every one of the 47 effect types:
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
 * For every one of the 21 instrument kinds:
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
const RUNAWAY_PEAK = 8;

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
}

export interface SweepResult {
  type: EffectType;
  sweepError?: string;
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
  hostProcesses: boolean;
  hostDelta: number;
  hostBypassEqualsRemoved: boolean;
  hostFinite: boolean;
  automationDelta: number;
  automationFinite: boolean;
  restoreMaxDiff: number;
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
}

export interface InteractionAudit {
  chainFinite: boolean;
  chainPeak: number;
  chainRestoreDiff: number;
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
  side: number;
  centroid: number;
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
  return {
    peak,
    rms: Math.sqrt(sum / n),
    side: Math.sqrt(sideSum / n),
    centroid: spectralCentroid(l, start),
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
  const relSide = Math.abs(m.side - base.side) / Math.max(base.side, base.rms * 0.1, 1e-6);
  const relCentroid = Math.abs(m.centroid - base.centroid) / Math.max(base.centroid, 200);
  const candidates: [string, number][] = [
    ["rms", relRms],
    ["side", relSide],
    ["centroid", relCentroid],
  ];
  const best = candidates.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { delta: best[1], metric: best[0] };
}

/* ---------------- shared fixtures ---------------- */

function buildTestBuffer(): AudioBuffer {
  const ctx = new OfflineAudioContext(2, Math.floor(SR * SIGNAL_SECONDS), SR);
  const buffer = ctx.createBuffer(2, Math.floor(SR * SIGNAL_SECONDS), SR);
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  const kickLen = Math.floor(SR * 0.25);
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    let sl = 0.32 * Math.sin(2 * Math.PI * 220 * t);
    let sr = 0.32 * Math.sin(2 * Math.PI * 277 * t);
    if (i < kickLen) {
      const env = Math.exp((-9 * i) / SR);
      const thump = Math.sin(2 * Math.PI * (52 + 30 * Math.exp((-30 * i) / SR)) * t);
      sl += 0.45 * env * thump;
      sr += 0.45 * env * thump;
    }
    if (t < 0.04) {
      sl += 0.18 * (Math.random() * 2 - 1);
      sr += 0.18 * (Math.random() * 2 - 1);
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
  for (let i = 0; i < d.length; i++) {
    const on = i % (gate * 2) < gate;
    d[i] = on ? 0.8 * (Math.random() * 2 - 1) : 0;
  }
  return buffer;
}

async function renderEffect(type: EffectType, params: Record<string, number>, signal: AudioBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, signal.length, SR);
  await loadAllWorklets(ctx);
  const rt = EFFECT_DEFS[type].factory(ctx, { id: "audit-fx", type, bypassed: false, params }, { bpm: 124 });
  const src = ctx.createBufferSource();
  src.buffer = signal;
  src.connect(rt.input);
  rt.output.connect(ctx.destination);
  src.start(0);
  if (type === "vocoder" || type === "sidechain") {
    const mod = ctx.createBufferSource();
    mod.buffer = buildModulatorBuffer(ctx);
    rt.setSidechainInput?.(mod);
    mod.start(0);
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
  const baseline = await renderEffect(type, defaultParamsOf(type), signal);
  const base = metricsOf(baseline);
  const bypassDelta = deltaVs(metricsOf(dry), base).delta;

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
    for (const extreme of ["min", "max"] as const) {
      const value = p[extreme];
      const finKey = extreme === "min" ? "minFinite" : "maxFinite";
      const peakKey = extreme === "min" ? "minPeak" : "maxPeak";
      const rendered = await renderEffect(type, { ...defaultParamsOf(type), [p.id]: value }, signal);
      entry[finKey] = finiteEverywhere(rendered);
      const m = metricsOf(rendered);
      entry[peakKey] = m.peak;
      if (!entry[finKey] || m.peak > RUNAWAY_PEAK) unstableParams.push(`${p.id}@${value}`);
      const d = deltaVs(base, m);
      if (d.delta > bestDelta) {
        bestDelta = d.delta;
        bestMetric = d.metric;
        bestExtreme = extreme;
      }
    }
    entry.responsive = bestDelta > RESPONSIVE_EPS;
    entry.bestExtreme = bestExtreme;
    entry.metric = bestMetric;
    entry.delta = bestDelta;
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

  return {
    type,
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
  return renderProject(doc, bank, { mode: "pattern" as PlayMode, sampleRate: SR, tailSeconds: 0.6 });
}

/** Fingerprint: the two strongest extremes from the factory sweep. */
function fingerprintOf(sweep: SweepResult): { id: string; value: number }[] {
  const paramsDef = EFFECT_META[sweep.type].params;
  return [...sweep.params]
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 2)
    .map((p: ParamAudit) => {
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
  const restored = normalizeProject(JSON.parse(JSON.stringify(doc)));
  const restoreRender = await renderDoc(restored, bank);
  const restoreMaxDiff = maxDiff(on, restoreRender);

  // Automation: a lane ramping the strongest param default → fingerprint
  // must audibly move the output and stay finite (engine clamps to def range).
  const f = fingerprintOf(sweep)[0];
  const def = EFFECT_META[type].params.find((p: ParamDef) => p.id === f.id)!;
  const autoStore = new ProjectStore(doc);
  const autoDoc = normalizeProject({
    ...autoStore.getDoc(),
    automation: [
      ...autoStore.getDoc().automation,
      {
        id: "audit-lane",
        target: { kind: "fxParam" as const, trackId, fxId, paramId: f.id },
        points: [
          { tick: 0, value: def.default },
          { tick: 1920, value: f.value },
        ],
      },
    ],
  });
  const autoRender = await renderDoc(autoDoc, bank);
  const automationDelta = deltaVs(metricsOf(bypassed), metricsOf(autoRender)).delta;

  return {
    hostProcesses: hostDelta.delta > RESPONSIVE_EPS,
    hostDelta: hostDelta.delta,
    hostBypassEqualsRemoved,
    hostFinite,
    automationDelta,
    automationFinite: finiteEverywhere(autoRender),
    restoreMaxDiff,
  };
}

/* ---------------- instruments ---------------- */

async function auditInstrument(kind: (typeof INSTRUMENT_ORDER)[number], bank: SampleBank): Promise<InstrumentAudit> {
  const def = INSTRUMENT_DEFS[kind];
  const paramsDef = def.params;
  const unstableParams: string[] = [];
  const deadParams: string[] = [];
  let wiredParams = 0;

  const render = async (params: Record<string, number>): Promise<AudioBuffer> => {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
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
      sampleId: "factory.tonal.pluck",
      params,
      effects: [],
      sends: {},
    };
    const rt = def.factory(ctx, track, { bpm: 124, getSample: (id) => bank.get(id) });
    rt.output.connect(ctx.destination);
    rt.noteOn(45, 0.9, 0.03, 0.5);
    const buffer = await ctx.startRendering();
    rt.dispose();
    return buffer;
  };

  const defaults = defaultInstrumentParams(kind);
  const baseBuffer = await render(defaults);
  const base = metricsOf(baseBuffer);
  const defaultAudible = base.peak > 0.01 && finiteEverywhere(baseBuffer);

  for (const p of paramsDef) {
    const deltas: number[] = [];
    for (const value of [p.min, p.max]) {
      let rendered: AudioBuffer;
      try {
        rendered = await render({ ...defaults, [p.id]: value });
      } catch (error) {
        unstableParams.push(`${p.id}@${value} (threw: ${String(error).slice(0, 120)})`);
        continue;
      }
      if (!finiteEverywhere(rendered) || metricsOf(rendered).peak > RUNAWAY_PEAK) {
        unstableParams.push(`${p.id}@${value}`);
        continue;
      }
      deltas.push(deltaVs(base, metricsOf(rendered)).delta);
    }
    if (deltas.length && Math.max(...deltas) > RESPONSIVE_EPS) wiredParams++;
    else deadParams.push(p.id);
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
    if (result.duplicateDelta <= RESPONSIVE_EPS) notes.push("second delay instance changed nothing (instance ignored?)");
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
      syncStore.execute(
        setEffectParam(syncStore.getDoc(), trackId, fxAdd.effectId, "feedback", i % 2 === 0 ? 0 : 0.9),
      );
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

export async function runPluginAudit(
  onProgress?: (msg: string) => void,
  only?: EffectType[],
): Promise<PluginAuditReport> {
  const progress = (msg: string) => onProgress?.(msg);
  const startedAt = new Date().toISOString();
  const bank = await generateFactoryBank();
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
  progress(`base render peak=${basePeak.toFixed(3)}`);

  const effects: EffectAudit[] = [];
  const types = (only && only.length > 0 ? only : EFFECT_ORDER).filter((t) => EFFECT_ORDER.includes(t));
  for (const type of types) {
    progress(`sweep ${type}`);
    let sweep: SweepResult;
    try {
      sweep = await sweepEffect(type, signal, dry);
    } catch (error) {
      sweep = {
        type,
        sweepError: String(error),
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
    progress(`host ${type}`);
    let host: HostResult;
    try {
      host = await hostTestEffect(baseDoc, type, sweep, bank);
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
      };
    }
    const def = EFFECT_DEFS[type];
    effects.push({ ...sweep, ...host, name: def.name, category: def.category });
  }

  progress("instruments");
  const instruments: InstrumentAudit[] = [];
  for (const kind of INSTRUMENT_ORDER) {
    progress(`instrument ${kind}`);
    instruments.push(await auditInstrument(kind, bank));
  }

  progress("interactions");
  const interactions = await auditInteractions(baseDoc, bank);

  return {
    effects,
    instruments,
    interactions,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
