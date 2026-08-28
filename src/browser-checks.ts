import { EFFECT_DEFS, EFFECT_ORDER, defaultParamsOf } from "./effects/registry";
import { INSTRUMENT_DEFS, INSTRUMENT_ORDER, defaultInstrumentParams } from "./instruments/registry";
import { generateFactoryBank } from "./sample-library/factory";
import { renderProject } from "./rendering/renderer";
import { buildStemProject, STEM_GROUPS } from "./rendering/stems";
import { encodeWav } from "./rendering/wav";
import { createDefaultProject, normalizeProject, validateProjectShape } from "./project-model/schema";
import { TEMPLATES, createProjectFromTemplate } from "./project-model/templates";
import { FACTORY_PRESETS } from "./presets/factory";
import { FACTORY_ASSETS } from "./sample-library/manifest";
import { applyInstrumentPreset } from "./commands/commands";
import { PPQ } from "./project-model/types";
import { loadWorkletModules, isWorkletReady } from "./audio-worklets/loader";
import { createBitcrusherNode } from "./audio-worklets/bitcrusher-node";
import { AudioEngine } from "./audio-engine/AudioEngine";
import { detectTransients } from "./audio-engine/transients";
import { createKwMeterNode } from "./audio-worklets/kwmeter-node";
import { createDrumTrackModel, createGroupTrackModel } from "./project-model/schema";
import { encodeMp3 } from "./export/mp3";
import { pickVideoMimeType, recordVideo } from "./export/video";
import type { DrumTrack, EffectType, InstrumentTrack, ProjectDocument } from "./project-model/types";
import { generatePattern } from "./ai/generator";
import { canonicalizePattern, contentHash } from "./ai/evaluation";
import { inspectPatternInvariants } from "./ai/invariants";

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

const SR = 44100;

function peakOf(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  return peak;
}

/** How often the value changes when sampled every `step` frames. */
function countChanges(data: Float32Array, step: number): number {
  let changes = 0;
  for (let i = step; i < data.length; i += step) {
    if (Math.abs(data[i] - data[i - step]) > 1e-6) changes++;
  }
  return changes;
}

async function renderThrough(type: EffectType, paramsOverride: Record<string, number> = {}): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.floor(SR / 2), SR);
  const def = EFFECT_DEFS[type];
  const params = { ...defaultParamsOf(type), ...paramsOverride };
  const rt = def.factory(ctx, { id: "check-fx", type, bypassed: false, params }, { bpm: 124 });
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 220;
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  osc.connect(gain).connect(rt.input);
  rt.output.connect(ctx.destination);
  osc.start(0);
  const buffer = await ctx.startRendering();
  rt.dispose();
  return buffer.getChannelData(0);
}

export async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (name: string, ok: boolean, message = "") => results.push({ name, ok, message: message || (ok ? "ok" : "failed") });

  const bank = await generateFactoryBank();
  check("factory bank generates a buffer for every manifest asset", bank.size === FACTORY_ASSETS.length, `size=${bank.size}/${FACTORY_ASSETS.length}`);
  const silentAssets = bank.entries().filter(([, buf]) => peakOf(buf.getChannelData(0)) < 0.001);
  check("factory buffers are audible", silentAssets.length === 0, silentAssets.map(([id]) => id).join(","));

  for (const type of EFFECT_ORDER) {
    const def = EFFECT_DEFS[type];
    try {
      const ctx = new OfflineAudioContext(1, 128, SR);
      const rt = def.factory(ctx, { id: "t", type, bypassed: false, params: defaultParamsOf(type) }, { bpm: 124 });
      for (const p of def.params) {
        rt.setParameter(p.id, p.min);
        rt.setParameter(p.id, p.max);
        rt.setParameter(p.id, p.default);
      }
      rt.syncBpm?.(140);
      rt.onTransportStarted?.(0, 0);
      rt.dispose();
      check(`${def.name}: constructs + param sweep`, true);
    } catch (error) {
      check(`${def.name}: constructs + param sweep`, false, String(error));
    }

    try {
      const data = await renderThrough(type);
      const peak = peakOf(data);
      check(`${def.name}: renders signal`, peak > 0.001 && peak <= 4, `peak=${peak.toFixed(3)}`);
    } catch (error) {
      check(`${def.name}: renders signal`, false, String(error));
    }
  }

  const clipped = await renderThrough("clipper", { drive: 1, ceiling: -6, softness: 0, output: 0 });
  const ceiling = Math.pow(10, -6 / 20);
  const maxAbs = peakOf(clipped);
  check("clipper honors ceiling", maxAbs <= ceiling + 0.01, `max=${maxAbs.toFixed(3)} ceiling=${ceiling.toFixed(3)}`);

  const pumped = await renderThrough("pump", { amount: 1, rate: 2, release: 0.4 });
  const block = 256;
  const blocks: number[] = [];
  for (let i = 0; i + block <= pumped.length; i += block) {
    let sum = 0;
    for (let j = 0; j < block; j++) sum += pumped[i + j] * pumped[i + j];
    blocks.push(Math.sqrt(sum / block));
  }
  const maxRms = Math.max(...blocks);
  const minRms = Math.min(...blocks);
  check(
    "pump modulates gain over the beat",
    maxRms / Math.max(minRms, 1e-9) > 1.5,
    `maxRms=${maxRms.toFixed(3)} minRms=${minRms.toFixed(3)} ratio=${(maxRms / Math.max(minRms, 1e-9)).toFixed(2)}`,
  );

  for (const kind of INSTRUMENT_ORDER) {
    const def = INSTRUMENT_DEFS[kind];
    try {
      const ctx = new OfflineAudioContext(1, SR, SR);
      const track: InstrumentTrack = {
        id: `check-${kind}`,
        kind: "instrument",
        instrument: kind,
        name: def.name,
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: "factory.tonal.pluck",
        params: defaultInstrumentParams(kind),
        effects: [],
        sends: {},
      };
      const rt = def.factory(ctx, track, { bpm: 124, getSample: (id) => bank.get(id) });
      rt.output.connect(ctx.destination);
      rt.noteOn(45, 0.9, 0.05, 0.4);
      const buffer = await ctx.startRendering();
      const peak = peakOf(buffer.getChannelData(0));
      check(`${def.name}: noteOn renders signal`, peak > 0.01 && peak <= 4, `peak=${peak.toFixed(3)}`);
      rt.dispose();
    } catch (error) {
      check(`${def.name}: noteOn renders signal`, false, String(error));
    }
  }

  // Texture Synth: polyphony + voice stealing
  try {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    const track: InstrumentTrack = {
      id: "check-texture-poly",
      kind: "instrument",
      instrument: "texture",
      name: "Texture",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: defaultInstrumentParams("texture"),
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS.texture.factory(ctx, track, { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    // 5 voices, more than the 4-voice limit
    rt.noteOn(48, 0.8, 0.0, 1.5);
    rt.noteOn(55, 0.8, 0.05, 1.5);
    rt.noteOn(60, 0.8, 0.1, 1.5);
    rt.noteOn(64, 0.8, 0.15, 1.5);
    rt.noteOn(67, 0.8, 0.2, 1.5);
    const buffer = await ctx.startRendering();
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
    }
    check("Texture Synth: polyphony + voice stealing renders signal", peak > 0.01 && peak <= 4, `peak=${peak.toFixed(3)}`);
    rt.dispose();
  } catch (error) {
    check("Texture Synth: polyphony + voice stealing renders signal", false, String(error));
  }

  // Wavetable Synth: morphing from the sine frame to the saw frame brightens
  // the spectrum — a saw carries far more high-frequency energy, measured
  // here as the first-difference energy ratio of the render.
  try {
    const renderWt = async (morph: number) => {
      const ctx = new OfflineAudioContext(1, SR, SR);
      const track: InstrumentTrack = {
        id: "check-wt-morph",
        kind: "instrument",
        instrument: "wavetable",
        name: "Wavetable",
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: null,
        params: { ...defaultInstrumentParams("wavetable"), morph, detune: 0, sub: 0 },
        effects: [],
        sends: {},
      };
      const rt = INSTRUMENT_DEFS.wavetable.factory(ctx, track, { bpm: 124, getSample: () => undefined });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 0.4);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return { peak: peakOf(buffer.getChannelData(0)), data: buffer.getChannelData(0) };
    };
    const hfRatio = (data: Float32Array) => {
      let sum = 0;
      let diff = 0;
      for (let i = 1; i < data.length; i++) {
        sum += data[i] * data[i];
        const d = data[i] - data[i - 1];
        diff += d * d;
      }
      return Math.sqrt(diff / Math.max(sum, 1e-12));
    };
    const dark = await renderWt(0);
    const bright = await renderWt(1);
    check(
      "Wavetable Synth: morph moves the timbre (sine -> saw HF energy)",
      dark.peak > 0.01 && bright.peak > 0.01 && hfRatio(bright.data) > hfRatio(dark.data) * 2,
      `darkHF=${hfRatio(dark.data).toFixed(3)} brightHF=${hfRatio(bright.data).toFixed(3)}`,
    );
  } catch (error) {
    check("Wavetable Synth: morph moves the timbre (sine -> saw HF energy)", false, String(error));
  }

  // Granular Synth: deterministic grain clouds + noteOff cuts the tail.
  try {
    const renderGran = async (cut: boolean) => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const track: InstrumentTrack = {
        id: "check-gran",
        kind: "instrument",
        instrument: "granular",
        name: "Granular",
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: "factory.tonal.keys",
        params: { ...defaultInstrumentParams("granular"), release: 0.01, rate: 30 },
        effects: [],
        sends: {},
      };
      const rt = INSTRUMENT_DEFS.granular.factory(ctx, track, { bpm: 124, getSample: (id) => bank.get(id) });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 1.0);
      if (cut) rt.noteOff?.(60, 0.4);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return Array.from(buffer.getChannelData(0));
    };
    const full = await renderGran(false);
    const fullAgain = await renderGran(false);
    const cut = await renderGran(true);
    // Bit-identical renders can differ at ULP level in Chrome — treat
    // max-sample-diff below 1e-4 as deterministic (random grain placement
    // would diverge by orders of magnitude).
    let maxDiff = 0;
    const sameLength = full.length === fullAgain.length;
    if (sameLength) {
      for (let i = 0; i < full.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(full[i] - fullAgain[i]));
      }
    }
    const peakAfter = (data: number[]) => {
      let peak = 0;
      for (let i = Math.floor(SR * 0.7); i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      return peak;
    };
    check(
      "Granular Synth: deterministic render + noteOff cuts the tail",
      sameLength && maxDiff < 1e-4 && peakAfter(full) > 0.001 && peakAfter(cut) < 0.005,
      `maxDiff=${maxDiff.toExponential(2)} fullTail=${peakAfter(full).toFixed(4)} cutTail=${peakAfter(cut).toFixed(4)}`,
    );
  } catch (error) {
    check("Granular Synth: deterministic render + noteOff cuts the tail", false, String(error));
  }

  // Distortion: harmonics produced
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const params = { ...defaultParamsOf("distortion"), drive: 0.9, tone: 12000, mix: 1, output: 0 };
    const rt = EFFECT_DEFS.distortion.factory(ctx, { id: "t", type: "distortion", bypassed: false, params }, { bpm: 124 });
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    rt.dispose();
    // A 220 Hz sine has ~44 zero-crossings/sec. A heavily-distorted signal
    // has visibly more crossings in a 100 ms window.
    let crossings = 0;
    let last = 0;
    const limit = Math.floor(SR * 0.1);
    for (let i = 0; i < limit; i++) {
      const v = data[i];
      if ((last <= 0 && v > 0) || (last >= 0 && v < 0)) crossings++;
      last = v;
    }
    check("distortion: cubic clip adds harmonics (more zero-crossings than input)", crossings > 50, `crossings=${crossings}`);
  } catch (error) {
    check("distortion: cubic clip adds harmonics", false, String(error));
  }

  // Bitcrusher: Web Audio's WaveShaperNode linearly interpolates between
  // curve samples, which means a step-function quantisation curve gets
  // smoothed into a ramp. Exact bit-accurate quantisation would need an
  // AudioWorklet (out of scope for now). We verify here that the runtime
  // constructs, the curve is applied, and the output stays in a sane range.
  // The vitest suite (`tests/effects.test.ts`) covers the quantisation
  // contract more directly with a held-sample value check.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const params = { ...defaultParamsOf("bitcrusher"), bits: 4, downsample: 1, mix: 1, output: 0 };
    const rt = EFFECT_DEFS.bitcrusher.factory(ctx, { id: "t", type: "bitcrusher", bypassed: false, params }, { bpm: 124 });
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 110;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    rt.dispose();
    const peak = peakOf(data);
    check("bitcrusher: 4-bit quantisation renders signal with sane peak", peak > 0.001 && peak <= 4, `peak=${peak.toFixed(3)}`);
  } catch (error) {
    check("bitcrusher: 4-bit quantisation renders signal with sane peak", false, String(error));
  }

  // Chorus: late-window signal energy (delay is audible past input offset)
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const params = { ...defaultParamsOf("chorus"), rate: 0.5, depth: 1, mix: 1, output: 0 };
    const rt = EFFECT_DEFS.chorus.factory(ctx, { id: "t", type: "chorus", bypassed: false, params }, { bpm: 124 });
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 440;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    rt.dispose();
    let max = 0;
    for (let i = Math.floor(SR * 0.02); i < data.length; i++) {
      if (Math.abs(data[i]) > max) max = Math.abs(data[i]);
    }
    check("chorus: produces audible signal past 20 ms (delay-line smear)", max > 0.001, `late-peak=${max.toFixed(3)}`);
  } catch (error) {
    check("chorus: produces audible signal past 20 ms (delay-line smear)", false, String(error));
  }

  // Phaser: stages can be re-chained at runtime
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const rt = EFFECT_DEFS.phaser.factory(ctx, { id: "t", type: "phaser", bypassed: false, params: defaultParamsOf("phaser") }, { bpm: 124 });
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 110;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    rt.setParameter("stages", 0); // 2
    rt.setParameter("stages", 3); // 8
    rt.setParameter("stages", 1); // 4
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    rt.dispose();
    const peak = peakOf(data);
    check("phaser: re-chains stages at runtime and renders signal", peak > 0.001 && peak <= 4, `peak=${peak.toFixed(3)}`);
  } catch (error) {
    check("phaser: re-chains stages at runtime and renders signal", false, String(error));
  }

  // Sidechain: setSidechainInput is safe to call with both null and a live node;
  // the actual ducking happens via a JS-driven AnalyserNode envelope follower
  // (not audio-rate), so it does not show up in OfflineAudioContext. We only
  // verify the wiring and lifecycle here — the live ducking path is exercised
  // by the realtime engine + the new `effects.test.ts` unit test.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const rt = EFFECT_DEFS.sidechain.factory(ctx, { id: "t", type: "sidechain", bypassed: false, params: defaultParamsOf("sidechain") }, { bpm: 124 });
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.5;
    osc.connect(oscGain);
    // Attaching a sidechain node and removing it must be safe.
    rt.setSidechainInput?.(oscGain);
    rt.setSidechainInput?.(null);
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    rt.dispose();
    const peak = peakOf(data);
    check("sidechain: setSidechainInput attaches/detaches safely and renders signal", peak > 0.001 && peak <= 4, `peak=${peak.toFixed(3)}`);
  } catch (error) {
    check("sidechain: setSidechainInput attaches/detaches safely and renders signal", false, String(error));
  }

  // AudioWorklet processors load per context and the bitcrusher actually
  // sample-and-holds (downsample) — impossible with the WaveShaper fallback.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    await loadWorkletModules(ctx);
    if (!isWorkletReady("bitcrusher", ctx) || !isWorkletReady("sidechain", ctx)) {
      check("audio-worklet: processors load and bitcrusher downsamples", false, "modules not ready after loadWorkletModules");
    } else {
      const rt = createBitcrusherNode(ctx, { params: { bits: 8, downsample: 4, mix: 1, output: 0 } });
      const buf = ctx.createBuffer(1, 512, SR);
      const d = buf.getChannelData(0);
      for (let i = 0; i < 512; i++) d[i] = Math.sin((i / 64) * Math.PI * 2);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(rt.input);
      rt.output.connect(ctx.destination);
      src.start(0);
      const out = await ctx.startRendering();
      rt.dispose();
      const o = out.getChannelData(0);
      let holds = true;
      for (let i = 1; i < 4; i++) if (Math.abs(o[i] - o[0]) > 1e-6) holds = false;
      const changes = countChanges(o, 4);
      check(
        "audio-worklet: processors load and bitcrusher downsamples",
        holds && changes > 8,
        `plateau=${holds} changes=${changes} (fallback would give ~0)`,
      );
    }
  } catch (error) {
    check("audio-worklet: processors load and bitcrusher downsamples", false, String(error));
  }

  // P0.0: worklet-dependent effects must degrade LOUDLY — flagged as degraded
  // with a human-readable reason instead of silently pretending to process.
  for (const type of ["gate", "transient", "limiter", "compressor"] as EffectType[]) {
    try {
      const ctx = new OfflineAudioContext(1, Math.floor(SR / 2), SR);
      const def = EFFECT_DEFS[type];
      const rt = def.factory(ctx, { id: `fb-${type}`, type, bypassed: false, params: defaultParamsOf(type) }, { bpm: 124 });
      const ok = rt.degraded === true && typeof rt.degradedReason === "string" && rt.degradedReason.length > 0;
      check(`${def.name}: fallback reports degraded state`, ok, `degraded=${String(rt.degraded)} reason=${String(rt.degradedReason ?? "-")}`);
      rt.dispose();
    } catch (error) {
      check(`${EFFECT_DEFS[type].name}: fallback reports degraded state`, false, String(error));
    }
  }

  // Gate with an impossible threshold would silence everything IF the worklet
  // ran — the worklet-unavailable fallback must pass the signal 1:1 instead.
  try {
    const bypassed = await renderThrough("gate", { threshold: 0, range: -80, mix: 1 });
    const peak = peakOf(bypassed);
    check("gate: fallback passes signal 1:1 (never silent)", Math.abs(peak - 0.5) < 0.02, `peak=${peak.toFixed(3)} expected≈0.500`);
  } catch (error) {
    check("gate: fallback passes signal 1:1 (never silent)", false, String(error));
  }

  // Contrast: once modules are loaded the same closed-gate config must actually
  // gate — proves the chains upgraded from fallback onto real processors.
  try {
    const ctx = new OfflineAudioContext(1, Math.floor(SR / 2), SR);
    await loadWorkletModules(ctx);
    if (!isWorkletReady("gate", ctx)) {
      check("gate: worklet path gates when modules are loaded", false, "modules not ready after loadWorkletModules");
    } else {
      const params = { ...defaultParamsOf("gate"), threshold: 0, range: -80, mix: 1 };
      const rt = EFFECT_DEFS.gate.factory(ctx, { id: "gk", type: "gate", bypassed: false, params }, { bpm: 124 });
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 220;
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      osc.connect(gain).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const buffer = await ctx.startRendering();
      rt.dispose();
      const peak = peakOf(buffer.getChannelData(0));
      check("gate: worklet path gates when modules are loaded", peak < 0.005, `peak=${peak.toFixed(4)} (fallback would be ≈0.5)`);
    }
  } catch (error) {
    check("gate: worklet path gates when modules are loaded", false, String(error));
  }

  // P0.1 acceptance: the look-ahead limiter pins peaks at CEILING, reports GR,
  // holds steady gain on sustained material (no pumping) and delays by exactly
  // LOOKAHEAD — while without look-ahead those peaks would overshoot.
  try {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    await loadWorkletModules(ctx);
    if (!isWorkletReady("limiter", ctx)) {
      check("limiter: look-ahead worklet limits, meters and anticipates", false, "worklet modules not ready");
    } else {
      const limiterParams = { ...defaultParamsOf("limiter"), ceiling: -6, threshold: -18, release: 0.05, lookaheadMs: 5, mix: 1 };
      const rt = EFFECT_DEFS.limiter.factory(ctx, { id: "lim", type: "limiter", bypassed: false, params: limiterParams }, { bpm: 124 });
      const buf = ctx.createBuffer(1, SR * 2, SR);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = 0.9 * Math.sin((i / SR) * 200 * Math.PI * 2); // ~-0.9 dBFS sine
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(rt.input);
      rt.output.connect(ctx.destination);
      src.start(0);
      const limited = await ctx.startRendering();
      rt.dispose();
      await new Promise((resolve) => setTimeout(resolve, 120)); // port messages flush after render
      const data = limited.getChannelData(0);
      const peak = peakOf(data);
      const ceilingLin = Math.pow(10, -6 / 20);
      const gr = rt.getGainReductionDb?.() ?? 0;
      // Pumping proxy: steady-state window RMS spread must stay flat.
      let minWin = Infinity;
      let maxWin = 0;
      for (let start = SR; start + 2048 <= data.length; start += 2048) {
        let sum = 0;
        for (let j = 0; j < 2048; j++) sum += data[start + j] * data[start + j];
        const rms = Math.sqrt(sum / 2048);
        minWin = Math.min(minWin, rms);
        maxWin = Math.max(maxWin, rms);
      }
      const spread = maxWin / Math.max(minWin, 1e-9);
      let onset = -1;
      for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) > 0.005) { onset = i; break; }
      }
      const expectedDelay = Math.round((limiterParams.lookaheadMs / 1000) * SR);
      const onsetOk = onset >= Math.round(expectedDelay * 0.9) && onset <= expectedDelay + 512;
      check(
        "limiter: look-ahead worklet limits, meters and anticipates",
        peak <= ceilingLin + 0.02 && gr >= 3 && spread < 1.15 && onsetOk,
        `peak=${peak.toFixed(3)}/${ceilingLin.toFixed(3)} gr=${gr.toFixed(1)}dB spread=${spread.toFixed(3)} onset=${onset}/${expectedDelay}`,
      );
    }
  } catch (error) {
    check("limiter: look-ahead worklet limits, meters and anticipates", false, String(error));
  }

  // PDC: the track holding the look-ahead limiter must stay sample-aligned
  // with a dry sibling — syncPdc() delays every other chain by the same
  // latency. Hard panning isolates each track into its own master channel.
  try {
    const doc = createProjectFromTemplate("empty");
    const limitedTrack = createDrumTrackModel("Drums B");
    doc.tracks = [doc.tracks[0], limitedTrack];
    const dryTrack = doc.tracks[0];
    if (dryTrack.kind !== "drum") throw new Error("template drift: expected a drum track");
    dryTrack.pan = -1;
    limitedTrack.pan = 1;
    limitedTrack.effects = [{ id: "pdc-lim", type: "limiter", bypassed: false, params: defaultParamsOf("limiter") }];
    const ctx = new OfflineAudioContext(2, Math.floor(SR * 0.6), SR);
    await loadWorkletModules(ctx);
    const engine = new AudioEngine();
    engine.attachBank(bank);
    engine.useContext(ctx);
    engine.setProject(doc);
    engine.trigger(dryTrack.id, dryTrack.pads[0], 0.03, 1);
    engine.trigger(limitedTrack.id, limitedTrack.pads[0], 0.03, 1);
    const rendered = await ctx.startRendering();
    const findOnset = (channel: Float32Array): number => {
      for (let i = 0; i < channel.length; i++) {
        if (Math.abs(channel[i]) > 0.02) return i;
      }
      return -1;
    };
    const onsetL = findOnset(rendered.getChannelData(0));
    const onsetR = findOnset(rendered.getChannelData(1));
    const skewSec = onsetL >= 0 && onsetR >= 0 ? Math.abs(onsetL - onsetR) / SR : Number.POSITIVE_INFINITY;
    check(
      "pdc: limiter track stays aligned with dry track (<2 ms)",
      skewSec <= 0.002,
      `skew=${Number.isFinite(skewSec) ? `${(skewSec * 1000).toFixed(2)}ms` : "no onset"} (≈5ms means PDC inactive)`,
    );
  } catch (error) {
    check("pdc: limiter track stays aligned with dry track (<2 ms)", false, String(error));
  }

  // Groups: a track moved between groups must feed ONLY the new group.
  // Regression: the old rerouting left the edge to the previous group's
  // input connected, so the track played through both groups at once.
  try {
    const doc = createProjectFromTemplate("house");
    const groupA = { ...createGroupTrackModel("A"), pan: -1 };
    const groupB = { ...createGroupTrackModel("B"), pan: 1 };
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    const withGroups = {
      ...doc,
      tracks: [
        ...doc.tracks.map((t) => (t.id === drum.id ? { ...t, groupId: groupA.id } : t)),
        groupA,
        groupB,
      ],
    };
    const moved = {
      ...withGroups,
      tracks: withGroups.tracks.map((t) => (t.id === drum.id ? { ...t, groupId: groupB.id } : t)),
    };
    const ctx = new OfflineAudioContext(2, SR, SR);
    const engine = new AudioEngine();
    engine.attachBank(bank);
    engine.useContext(ctx);
    engine.setProject(withGroups);
    engine.setProject(moved); // same engine → exercises the syncProject re-route
    engine.trigger(drum.id, drum.pads[0], 0.02, 1);
    const out = await ctx.startRendering();
    const l = peakOf(out.getChannelData(0));
    const r = peakOf(out.getChannelData(1));
    check("groups: moved track feeds only the new group", r > 0.05 && l < r * 0.15, `L=${l.toFixed(3)} R=${r.toFixed(3)} (leak would make L≈R)`);
  } catch (error) {
    check("groups: moved track feeds only the new group", false, String(error));
  }

  // Master meter must read TRUE stereo (splitter + per-channel analysers).
  // Regression: a single AnalyserNode downmixes to mono even with
  // channelCount=2/explicit, so L/R read the same mono signal.
  try {
    const ctx = new AudioContext();
    try {
      if (ctx.state === "suspended") await ctx.resume();
    } catch { /* autoplay may block resume — handled below */ }
    if (ctx.state !== "running") {
      check("master meter: reads true stereo (hard-left stays out of R)", true, "skipped — autoplay blocked in this environment");
    } else {
      // Headless audio devices take a moment to start rendering — wait until
      // the audio clock actually advances, otherwise the scheduled note has
      // not sounded yet when the meter is read and the check sees silence.
      const t0 = ctx.currentTime;
      for (let i = 0; i < 40 && ctx.currentTime < t0 + 0.05; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (ctx.currentTime < t0 + 0.05) {
        check("master meter: reads true stereo (hard-left stays out of R)", true, "skipped — audio clock not advancing");
      } else {
        const engine = new AudioEngine();
        engine.useContext(ctx);
        const doc = createProjectFromTemplate("house");
        const inst = doc.tracks.find((t) => t.kind === "instrument")!;
        const panned = {
          ...doc,
          tracks: doc.tracks.map((t) => (t.id === inst.id ? { ...t, pan: -1 } : t)),
        };
        engine.setProject(panned);
        engine.noteOn(inst.id, 48, 0.9, ctx.currentTime + 0.02, 0.4);
        await new Promise((r) => setTimeout(r, 220));
        const lv = engine.getMasterLevels();
        check(
          "master meter: reads true stereo (hard-left stays out of R)",
          lv.left.peak > 0.02 && lv.right.peak < lv.left.peak * 0.25,
          `L=${lv.left.peakDb.toFixed(1)}dB R=${lv.right.peakDb.toFixed(1)}dB corr=${lv.correlation.toFixed(2)}`,
        );
      }
    }
    await ctx.close();
  } catch (error) {
    check("master meter: reads true stereo (hard-left stays out of R)", false, String(error));
  }

  // 808: rapid retrigger must keep rendering after the voice-cleanup fix
  // (per-voice post + click chain teardown, shared shaper without rewiring).
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const track: InstrumentTrack = {
      id: "check-808-retrigger",
      kind: "instrument",
      instrument: "808",
      name: "808",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: { ...defaultInstrumentParams("808"), decay: 0.4 },
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS["808"].factory(ctx, track, { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(33, 1, 0.05, 0);
    rt.noteOn(33, 1, 0.25, 0);
    rt.noteOn(33, 1, 0.45, 0);
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    const first = peakOf(data.subarray(Math.floor(0.05 * SR), Math.floor(0.2 * SR)));
    const third = peakOf(data.subarray(Math.floor(0.45 * SR), Math.floor(0.7 * SR)));
    check("808: rapid retrigger renders every note (voice cleanup wiring)", first > 0.3 && third > 0.3, `first=${first.toFixed(3)} third=${third.toFixed(3)}`);
  } catch (error) {
    check("808: rapid retrigger renders every note (voice cleanup wiring)", false, String(error));
  }

  // Wavetable: a user sample assigned but not yet in the bank (async restore
  // after a reload) plays the factory fallback WITHOUT caching it forever —
  // the next note after the sample arrives must use the real sample.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    let sample: AudioBuffer | null = null;
    const track: InstrumentTrack = {
      id: "check-wt-reload",
      kind: "instrument",
      instrument: "wavetable",
      name: "WT",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "user-late-arriving",
      // detune 0 + open filter keeps the voice spectrum faithful to the
      // table — the default ±7 ct unison beating smears edge energy and
      // makes any two tables measure alike.
      params: { ...defaultInstrumentParams("wavetable"), detune: 0, cutoff: 16000, morph: 0 },
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS["wavetable"].factory(ctx, track, { bpm: 124, getSample: () => sample ?? undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(48, 1, 0.05, 0.15); // fallback (sample not restored yet)
    const buf = ctx.createBuffer(1, Math.floor(SR * 0.1), SR);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = i % 64 < 32 ? 0.7 : -0.7; // 690 Hz square (inside extractWavetable's period range) → bright
    sample = buf; // the async restore lands between the two notes
    rt.noteOn(48, 1, 0.45, 0.15); // must now use the extracted user table
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    const hfRatio = (w: Float32Array) => {
      let sum = 0;
      let diff = 0;
      for (let i = 1; i < w.length; i++) {
        sum += w[i] * w[i];
        const dd = w[i] - w[i - 1];
        diff += dd * dd;
      }
      return Math.sqrt(diff / Math.max(sum, 1e-12));
    };
    const fallbackHf = hfRatio(data.subarray(Math.floor(0.06 * SR), Math.floor(0.3 * SR)));
    const sampleHf = hfRatio(data.subarray(Math.floor(0.46 * SR), Math.floor(0.7 * SR)));
    check(
      "wavetable: late-arriving user sample replaces the cached factory fallback",
      sampleHf > fallbackHf * 1.5,
      `fallbackHF=${fallbackHf.toFixed(3)} sampleHF=${sampleHf.toFixed(3)}`,
    );
  } catch (error) {
    check("wavetable: late-arriving user sample replaces the cached factory fallback", false, String(error));
  }

  // MP3 export round-trip: encode the rendered pattern, then decode it back
  // through the browser's own decoder — a successful decode proves the MP3
  // stream is valid, not just non-empty bytes.
  try {
    const doc = createProjectFromTemplate("house");
    const buffer = await renderProject(doc, bank, { mode: "pattern", sampleRate: 44100 });
    const mp3 = await encodeMp3(buffer, { kbps: 192 });
    const wavBytes = encodeWav(buffer, 16).byteLength;
    const decodeCtx = new OfflineAudioContext(1, 1, 44100);
    const decoded = await decodeCtx.decodeAudioData(await mp3.arrayBuffer());
    check(
      "export: MP3 encodes small and decodes back to the same duration",
      mp3.size < wavBytes / 4 && Math.abs(decoded.duration - buffer.duration) < 0.15,
      `mp3=${(mp3.size / 1024).toFixed(0)}kB vs wav=${(wavBytes / 1024).toFixed(0)}kB dur=${decoded.duration.toFixed(2)}s/${buffer.duration.toFixed(2)}s`,
    );
  } catch (error) {
    check("export: MP3 encodes small and decodes back to the same duration", false, String(error));
  }

  // Generated-pattern quality gate: the browser must validate the same local
  // output that the UI preview/command path uses, then render that exact
  // pattern through the offline engine and encode a playable WAV.
  try {
    const project = createProjectFromTemplate("house");
    const options = {
      genre: "house" as const,
      style: "deep",
      seed: "browser-quality-gate",
      stepCount: 64,
      ghostWeight: 0.3,
      microWeight: 0.2,
      velocityVariation: 0.3,
      temperature: 1,
      replaceMode: "new" as const,
    };
    const generated = generatePattern(project, options);
    const generatedAgain = generatePattern(project, options);
    const report = inspectPatternInvariants(project, generated);
    const hash = contentHash(canonicalizePattern(project, generated));
    const hashAgain = contentHash(canonicalizePattern(project, generatedAgain));
    check(
      "quality: browser-generated pattern passes invariants and content hash is deterministic",
      report.ok && hash === hashAgain && generated.generation?.outputContentHash === hash,
      report.issues.map((item) => `${item.code}@${item.path}`).join(", ") || `${hash}/${hashAgain}`,
    );

    const generatedProject = {
      ...project,
      patterns: [...project.patterns, generated],
      activePatternId: generated.id,
    };
    const buffer = await renderProject(generatedProject, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const wav = encodeWav(buffer, 16);
    check(
      "quality: generated pattern renders offline audio and a valid WAV",
      peakOf(buffer.getChannelData(0)) > 0.01 && wav.byteLength > 44,
      `peak=${peakOf(buffer.getChannelData(0)).toFixed(3)} wav=${wav.byteLength}`,
    );
  } catch (error) {
    check("quality: browser-generated pattern passes invariants and content hash is deterministic", false, String(error));
    check("quality: generated pattern renders offline audio and a valid WAV", false, String(error));
  }

  // Video export: MediaRecorder over the branded canvas + offline-rendered
  // audio muxed via MediaStreamAudioDestinationNode.
  try {
    const mime = pickVideoMimeType();
    if (!mime) {
      check("export: video records canvas + audio via MediaRecorder", true, "skipped — MediaRecorder unavailable");
    } else {
      const ctx = new OfflineAudioContext(1, 44100 * 2, 44100);
      const osc = ctx.createOscillator();
      osc.frequency.value = 220;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      osc.connect(g).connect(ctx.destination);
      osc.start(0);
      const buffer = await ctx.startRendering();
      const result = await recordVideo(buffer, {
        title: "Browser Check",
        bpm: 120,
        seconds: 2,
        width: 270,
        height: 480,
        fps: 24,
      });
      check(
        "export: video records canvas + audio via MediaRecorder",
        result.blob.size > 15_000 && result.blob.type.startsWith("video/"),
        `${result.ext} ${(result.blob.size / 1024).toFixed(0)}kB type=${result.blob.type || mime.split(";")[0]}`,
      );
    }
  } catch (error) {
    check("export: video records canvas + audio via MediaRecorder", false, String(error));
  }

  // Chop beats: engine slicing plays ONLY the pad's [start, end) region of
  // the source (native offset+duration), and transient detection finds hits.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    // Source: burst A [0.05, 0.15), silence, burst B [0.5, 0.65).
    const srcBuffer = ctx.createBuffer(1, SR, SR);
    const d = srcBuffer.getChannelData(0);
    for (let i = Math.floor(0.05 * SR); i < Math.floor(0.15 * SR); i++) d[i] = 0.7 * Math.sin((2 * Math.PI * 220 * i) / SR);
    for (let i = Math.floor(0.5 * SR); i < Math.floor(0.65 * SR); i++) d[i] = 0.7 * Math.sin((2 * Math.PI * 440 * i) / SR);
    bank.add("check-slice-src", srcBuffer);

    const doc = createProjectFromTemplate("house");
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    const engine = new AudioEngine();
    engine.attachBank(bank);
    engine.useContext(ctx);
    // Slice pointing ONLY at burst B; triggered at t=0.1.
    engine.setProject(doc);
    engine.trigger(drum.id, { ...drum.pads[0], assetId: "check-slice-src", sliceStart: 0.5, sliceEnd: 0.65 }, 0.1, 1);
    const out = await ctx.startRendering();
    const data = out.getChannelData(0);
    const rms = (a: number, b: number) => {
      let sum = 0;
      for (let i = Math.floor(a * SR); i < Math.floor(b * SR); i++) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, Math.floor(b * SR) - Math.floor(a * SR)));
    };
    const before = rms(0, 0.09); // before trigger — must be silent
    const during = rms(0.11, 0.25); // burst B playing through the slice
    const after = rms(0.3, 0.5); // after slice end — must be silent again

    // Transient detection over the same source must find both bursts.
    const onsets = detectTransients(d, SR);
    const foundA = onsets.some((t: number) => Math.abs(t - 0.05) < 0.05);
    const foundB = onsets.some((t: number) => Math.abs(t - 0.5) < 0.05);

    check(
      "chop beats: pads play only their slice region + transients detected",
      before < 0.005 && during > 0.05 && after < 0.005 && foundA && foundB && onsets.length === 2,
      `before=${before.toFixed(4)} during=${during.toFixed(3)} after=${after.toFixed(4)} onsets=[${onsets.map((t) => t.toFixed(2)).join(",")}]`,
    );
  } catch (error) {
    check("chop beats: pads play only their slice region + transients detected", false, String(error));
  }

  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const track: InstrumentTrack = {
      id: "check-808-decay",
      kind: "instrument",
      instrument: "808",
      name: "808",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: { ...defaultInstrumentParams("808"), decay: 0.5 },
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS["808"].factory(ctx, track, { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(33, 1, 0.02, 0.3);
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    const rms = (from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, to - from));
    };
    const early = rms(Math.floor(SR * 0.05), Math.floor(SR * 0.15));
    const late = rms(Math.floor(SR * 0.6), Math.floor(SR * 0.95));
    check("808 amplitude decays over time", early > late * 3, `early=${early.toFixed(3)} late=${late.toFixed(3)}`);
  } catch (error) {
    check("808 amplitude decays over time", false, String(error));
  }

  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const track: InstrumentTrack = {
      id: "check-sampler-pitch",
      kind: "instrument",
      instrument: "sampler",
      name: "Sampler",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "factory.tonal.pluck",
      params: defaultInstrumentParams("sampler"),
      effects: [],
      sends: {},
    };
    const rt = INSTRUMENT_DEFS.sampler.factory(ctx, track, { bpm: 124, getSample: (id) => bank.get(id) });
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.02, 0.3);
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    let peakPos = 0;
    let peakVal = 0;
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) > peakVal) {
        peakVal = Math.abs(data[i]);
        peakPos = i;
      }
    }
    check("sampler plays transposed sample from C4 root", peakVal > 0.05 && peakPos > 0, `peak=${peakVal.toFixed(3)} at ${peakPos}`);
  } catch (error) {
    check("sampler plays transposed sample from C4 root", false, String(error));
  }

  try {
    const ctx = new OfflineAudioContext(1, SR * 2, SR);
    const source = ctx.createOscillator();
    source.type = "sine";
    source.frequency.value = 220;
    const modGain = ctx.createGain();
    modGain.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 2;
    const depth = ctx.createGain();
    depth.gain.value = 0.8;
    lfo.connect(depth).connect(modGain.gain);
    source.connect(modGain).connect(ctx.destination);
    source.start(0);
    lfo.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    const rmsBlocks: number[] = [];
    for (let i = 0; i + 2048 <= data.length; i += 2048) {
      let sum = 0;
      for (let j = 0; j < 2048; j++) sum += data[i + j] * data[i + j];
      rmsBlocks.push(Math.sqrt(sum / 2048));
    }
    const maxRms = Math.max(...rmsBlocks);
    const minRms = Math.min(...rmsBlocks);
    check(
      "LFO modulates gain at audio rate",
      maxRms / Math.max(minRms, 1e-9) > 2,
      `max=${maxRms.toFixed(3)} min=${minRms.toFixed(3)} ratio=${(maxRms / Math.max(minRms, 1e-9)).toFixed(2)}`,
    );
  } catch (error) {
    check("LFO modulates gain at audio rate", false, String(error));
  }

  try {
    const ctx = new OfflineAudioContext(1, SR * 2, SR);
    const source = ctx.createOscillator();
    source.type = "sine";
    source.frequency.value = 220;
    const autoGain = ctx.createGain();
    autoGain.gain.setValueAtTime(1, 0);
    for (let t = 0; t <= 1.0; t += 0.025) {
      autoGain.gain.setTargetAtTime(Math.max(0, 1 - t), t, 0.008);
    }
    source.connect(autoGain).connect(ctx.destination);
    source.start(0);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    const rms = (from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, to - from));
    };
    const early = rms(Math.floor(SR * 0.05), Math.floor(SR * 0.2));
    const late = rms(Math.floor(SR * 1.5), Math.floor(SR * 1.95));
    check(
      "automation ramps track level over time",
      early / Math.max(late, 1e-9) > 8,
      `early=${early.toFixed(3)} late=${late.toFixed(3)} ratio=${(early / Math.max(late, 1e-9)).toFixed(1)}`,
    );
  } catch (error) {
    check("automation ramps track level over time", false, String(error));
  }

  try {
    const project = createDefaultProject();
    const patternBuffer = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.5 });
    const patternPeak = peakOf(patternBuffer.getChannelData(0));
    const expectedPatternSec = (16 * (PPQ / 4)) * (60 / (project.bpm * PPQ)) + 0.5;
    check(
      "offline render: pattern mode produces audio of correct length",
      patternPeak > 0.05 && Math.abs(patternBuffer.duration - expectedPatternSec) < 0.05,
      `peak=${patternPeak.toFixed(3)} dur=${patternBuffer.duration.toFixed(2)}s expected=${expectedPatternSec.toFixed(2)}s`,
    );
  } catch (error) {
    check("offline render: pattern mode produces audio of correct length", false, String(error));
  }

  try {
    const project = createDefaultProject();
    const songBuffer = await renderProject(project, bank, { mode: "song", sampleRate: SR, tailSeconds: 0.5 });
    const patternBuffer = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.5 });
    check(
      "offline render: song mode (4-bar arrangement) is longer than one pattern pass",
      songBuffer.duration > patternBuffer.duration && peakOf(songBuffer.getChannelData(0)) > 0.05,
      `song=${songBuffer.duration.toFixed(2)}s pattern=${patternBuffer.duration.toFixed(2)}s`,
    );
  } catch (error) {
    check("offline render: song mode (4-bar arrangement) is longer than one pattern pass", false, String(error));
  }

  try {
    const project = createDefaultProject();
    const drumStem = await renderProject(buildStemProject(project, STEM_GROUPS[0].filter), bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const bassStem = await renderProject(buildStemProject(project, STEM_GROUPS[1].filter), bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const drumPeak = peakOf(drumStem.getChannelData(0));
    const bassPeak = peakOf(bassStem.getChannelData(0));
    check(
      "offline render: drum and bass stems are independently audible",
      drumPeak > 0.05 && bassPeak > 0.01,
      `drum=${drumPeak.toFixed(3)} bass=${bassPeak.toFixed(3)}`,
    );
  } catch (error) {
    check("offline render: drum and bass stems are independently audible", false, String(error));
  }

  try {
    const project = createDefaultProject();
    const buffer = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const wav16 = encodeWav(buffer, 16);
    const header = new DataView(wav16);
    const riff = String.fromCharCode(header.getUint8(0), header.getUint8(1), header.getUint8(2), header.getUint8(3));
    const wave = String.fromCharCode(header.getUint8(8), header.getUint8(9), header.getUint8(10), header.getUint8(11));
    check(
      "offline render encodes to a valid WAV file",
      riff === "RIFF" && wave === "WAVE" && wav16.byteLength >= 44 + buffer.length * 2 * 2,
      `bytes=${wav16.byteLength}`,
    );
  } catch (error) {
    check("offline render encodes to a valid WAV file", false, String(error));
  }

  check("templates: six factory templates are registered", TEMPLATES.length === 6, TEMPLATES.map((t) => t.id).join(","));

  for (const template of TEMPLATES) {
    try {
      const project = createProjectFromTemplate(template.id);
      const valid = validateProjectShape(project) && normalizeProject(project) === project;
      const buffer = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
      const peak = peakOf(buffer.getChannelData(0));
      // The Empty template is deliberately silent — it only has to be valid.
      const audible = template.id === "empty" ? peak <= 4 : peak > 0.01 && peak <= 4;
      check(
        `template ${template.id}: valid project and renders audio`,
        valid && audible,
        `valid=${valid} peak=${peak.toFixed(3)}`,
      );
    } catch (error) {
      check(`template ${template.id}: valid project and renders audio`, false, String(error));
    }
  }

  try {
    const sceneScore = createProjectFromTemplate("scene-score");
    const songBuffer = await renderProject(sceneScore, bank, { mode: "song", sampleRate: SR, tailSeconds: 0.2 });
    const patternBuffer = await renderProject(sceneScore, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    check(
      "scene-score template: song arrangement renders longer than one pattern",
      songBuffer.duration > patternBuffer.duration * 2 && peakOf(songBuffer.getChannelData(0)) > 0.01,
      `song=${songBuffer.duration.toFixed(2)}s pattern=${patternBuffer.duration.toFixed(2)}s`,
    );
  } catch (error) {
    check("scene-score template: song arrangement renders longer than one pattern", false, String(error));
  }

  try {
    const straight = createProjectFromTemplate("house");
    const grooved: typeof straight = {
      ...straight,
      groove: { swing: 0.6, humanizeTiming: 0.5, humanizeVelocity: 0.4 },
      patterns: straight.patterns.map((p) => ({
        ...p,
        stepMeta: {
          ...p.stepMeta,
          [Object.keys(p.rows)[0]]: { 14: { ratchet: 4 }, 10: { probability: 0.6 } },
        },
      })),
    };
    const straightBuf = await renderProject(straight, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const groovedBuf = await renderProject(grooved, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const a = straightBuf.getChannelData(0);
    const b = groovedBuf.getChannelData(0);
    let diff = 0;
    const limit = Math.min(a.length, b.length);
    for (let i = 0; i < limit; i += 37) diff += Math.abs(a[i] - b[i]);
    check(
      "groove: swing/humanize/ratchet change the exported audio",
      peakOf(b) > 0.05 && diff > 1,
      `peak=${peakOf(b).toFixed(3)} sample-diff=${diff.toFixed(1)}`,
    );
  } catch (error) {
    check("groove: swing/humanize/ratchet change the exported audio", false, String(error));
  }

  check("presets: factory bank covers all seven instruments", new Set(FACTORY_PRESETS.map((p) => p.instrument)).size === 7, `count=${FACTORY_PRESETS.length}`);

  try {
    const project = createProjectFromTemplate("house");
    const bassTrack = project.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "808");
    const preset = FACTORY_PRESETS.find((p) => p.instrument === "808");
    if (!bassTrack || !preset) throw new Error("808 track or preset missing");
    const applied = applyInstrumentPreset(project, bassTrack.id, preset).execute(project);
    const appliedTrack = applied.tracks.find((t) => t.id === bassTrack.id) as InstrumentTrack;
    const presetApplied = appliedTrack.presetId === preset.id && appliedTrack.params.decay === preset.params.decay;
    const buffer = await renderProject(applied, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    const peak = peakOf(buffer.getChannelData(0));
    check("presets: apply command sticks and project still renders", presetApplied && peak > 0.01, `applied=${presetApplied} peak=${peak.toFixed(3)}`);
  } catch (error) {
    check("presets: apply command sticks and project still renders", false, String(error));
  }

  try {
    const project = createDefaultProject();
    for (const track of project.tracks) track.gain = 1.5;
    const drumTrack = project.tracks.find((t) => t.kind === "drum");
    if (drumTrack && drumTrack.kind === "drum") {
      for (const pad of drumTrack.pads) pad.gain = 2;
    }

    project.master.limiterEnabled = false;
    project.master.clipperEnabled = false;
    const unlimited = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });

    project.master.limiterEnabled = true;
    project.master.clipperEnabled = false;
    const limited = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });

    project.master.limiterEnabled = true;
    project.master.clipperEnabled = true;
    const clipped = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });

    const unlimitedPeak = peakOf(unlimited.getChannelData(0));
    const limitedPeak = peakOf(limited.getChannelData(0));
    const clippedPeak = peakOf(clipped.getChannelData(0));
    check(
      "master chain tames a hot mix (limiter reduces, clipper softens)",
      unlimitedPeak > 1.5 && limitedPeak < unlimitedPeak * 0.6 && clippedPeak < 1.2,
      `unlimited=${unlimitedPeak.toFixed(3)} limited=${limitedPeak.toFixed(3)} clipped=${clippedPeak.toFixed(3)}`,
    );
  } catch (error) {
    check("master chain tames a hot mix (limiter reduces, clipper softens)", false, String(error));
  }

  // Master stage with AudioWorklets: renderProject preloads processors, so the
  // export path runs through the look-ahead limiter — peaks must sit exactly
  // AT ceiling (brickwall anticipation) rather than being loosely pulled down.
  try {
    const project = createDefaultProject();
    for (const track of project.tracks) track.gain = 1.5;
    const drumTrack = project.tracks.find((t) => t.kind === "drum");
    if (drumTrack && drumTrack.kind === "drum") {
      for (const pad of drumTrack.pads) pad.gain = 2;
    }
    project.master.ceilingDb = -3;
    project.master.limiterEnabled = true;
    project.master.clipperEnabled = false;
    const mastered = await renderProject(project, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.2 });
    let masteredPeak = 0;
    for (let ch = 0; ch < mastered.numberOfChannels; ch++) {
      masteredPeak = Math.max(masteredPeak, peakOf(mastered.getChannelData(ch)));
    }
    const ceilingLin = Math.pow(10, -3 / 20);
    check(
      "master limiter: look-ahead brickwall pins export at ceiling",
      masteredPeak <= ceilingLin + 0.02 && masteredPeak >= ceilingLin * 0.6,
      `peak=${masteredPeak.toFixed(3)} ceiling=${ceilingLin.toFixed(3)}`,
    );
  } catch (error) {
    check("master limiter: look-ahead brickwall pins export at ceiling", false, String(error));
  }

  // ---------------- Track modulators (random S&H / step / envFollower) ----------------
  // Harness note: these checks ride the REAL export pipeline (renderProject),
  // which preloads worklets and drives the same scheduling math as live.

  const rmsWindow = (data: Float32Array, fromSample: number, toSample: number): number => {
    let sum = 0;
    for (let i = Math.max(0, Math.floor(fromSample)); i < Math.min(data.length, Math.floor(toSample)); i++) {
      sum += data[i] * data[i];
    }
    return Math.sqrt(sum / Math.max(1, toSample - fromSample));
  };

  const makeModDoc = (attach: (doc: ProjectDocument) => void): ProjectDocument => {
    const doc = createProjectFromTemplate("house");
    attach(doc);
    for (const track of doc.tracks) {
      if (track.kind === "drum") track.pan = -1; // isolate analysis channels
      if (track.kind === "instrument" && track.instrument === "808") track.pan = 1;
      else if (track.kind === "instrument") track.mute = true;
    }
    doc.master.limiterEnabled = false;
    doc.master.clipperEnabled = false;
    return doc;
  };

  // Step modulator composes a rhythmic volume gate on the DRUM bus. Windows
  // derive from the template BPM because the offline buffer spans ONE bar.
  try {
    const renderGated = async (withGate: boolean): Promise<{ data: Float32Array; bpm: number }> => {
      const doc = makeModDoc((d) => {
        const drums = d.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
        if (withGate) {
          d.lfos = [{
            id: "chk-step", trackId: drums.id, kind: "step", param: "gain",
            division: 2, glideSec: 0.02, amount: 0.9, steps: [1, -1],
          }];
        }
      });
      const buf = await renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 });
      return { data: buf.getChannelData(0), bpm: doc.bpm };
    };
    const gatedRender = await renderGated(true);
    const controlRender = await renderGated(false);
    const beatsOf = (data: Float32Array, bpm: number): number[] => {
      const beatSec = 60 / bpm;
      return [0, 1, 2, 3].map((i) => rmsWindow(data, i * beatSec * SR, (i + 0.45) * beatSec * SR));
    };
    const gateBeats = beatsOf(gatedRender.data, gatedRender.bpm);
    const ctrlBeats = beatsOf(controlRender.data, controlRender.bpm);
    const gateHigh = (gateBeats[0] + gateBeats[2]) / 2;
    const gateLow = (gateBeats[1] + gateBeats[3]) / 2;
    const ctrlHigh = (ctrlBeats[0] + ctrlBeats[2]) / 2;
    const ctrlLow = (ctrlBeats[1] + ctrlBeats[3]) / 2;
    check(
      "step modulator: gain alternates on the division grid (offline)",
      // House groove itself has stronger backbeats — judge the gate RELATIVE
      // to the unmuted baseline ratio, plus absolute attenuation of gated lows.
      ctrlHigh > 0.005 && gateHigh > 0.005
        && (gateHigh / Math.max(gateLow, 1e-6)) > 2 * (ctrlHigh / Math.max(ctrlLow, 1e-6))
        && gateLow < ctrlLow * 1.4,
      "gate=" + [gateHigh.toFixed(4), gateLow.toFixed(4)].join("/") + " ctrl=" + [ctrlHigh.toFixed(4), ctrlLow.toFixed(4)].join("/"),
    );

    // Determinism law: two renders of the same document are sample-identical.
    try {
      const gatedDoc = makeModDoc((d) => {
        const drums = d.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
        d.lfos = [{
          id: "chk-step", trackId: drums.id, kind: "step", param: "gain",
          division: 2, glideSec: 0.02, amount: 0.9, steps: [1, -1],
        }];
      });
      const ra = await renderProject(gatedDoc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 });
      const rb = await renderProject(gatedDoc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 });
      let diff = 0;
      let energy = 0;
      for (let ch = 0; ch < 2; ch++) {
        const da = ra.getChannelData(ch);
        const dbv = rb.getChannelData(ch);
        for (let i = 0; i < da.length; i++) {
          diff += Math.abs(da[i] - dbv[i]);
          energy += Math.abs(da[i]);
        }
      }
      const relative = diff / Math.max(energy, 1e-9);
      check(
        "modulators: offline renders are deterministic (live == offline law)",
        diff < 5e-5 || relative < 1e-4,
        "SUM|a-b|=" + diff.toExponential(2) + " rel=" + relative.toExponential(2),
      );
    } catch (error) {
      check("modulators: offline renders are deterministic (live == offline law)", false, String(error));
    }
  } catch (error) {
    check("step modulator: gain alternates on the division grid (offline)", false, String(error));
  }

  // Random S&H: deterministic AND visibly active (blocks diverge).
  try {
    const doc = makeModDoc((d) => {
      const drums = d.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
      d.lfos = [{
        id: "chk-rnd", trackId: drums.id, kind: "random", param: "gain",
        snh: "hold", rateMode: "sync", rateHz: 8, division: 3, amount: 0.85, seed: "browser-check-seed",
      }];
    });
    const runRandom = (): Promise<Float32Array> =>
      renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 }).then((b) => b.getChannelData(0));
    const first = await runRandom();
    const second = await runRandom();
    let pairDiff = 0;
    let energy = 0;
    for (let i = 0; i < first.length; i++) {
      pairDiff += Math.abs(first[i] - second[i]);
      energy += Math.abs(first[i]);
    }
    const blockLen = Math.floor(SR / 16);
    const blocks: number[] = [];
    for (let start = 0; start + blockLen <= first.length; start += blockLen) {
      const r = rmsWindow(first, start, start + blockLen);
      if (r > 1e-3) blocks.push(r);
    }
    const meanBlock = blocks.reduce((a, b) => a + b, 0) / Math.max(1, blocks.length);
    const spread = Math.sqrt(blocks.reduce((acc, v) => acc + (v - meanBlock) ** 2, 0) / Math.max(1, blocks.length)) / Math.max(meanBlock, 1e-9);
    const relativeDelta = pairDiff / Math.max(energy, 1e-9);
    check(
      "random S&H: seeded stream is active and repeat-render stable",
      (pairDiff < 5e-5 || relativeDelta < 1e-4) && spread > 0.25 && blocks.length >= 12,
      "rel=" + relativeDelta.toExponential(2) + " spread=" + spread.toFixed(2) + " blocks=" + blocks.length,
    );
  } catch (error) {
    check("random S&H: seeded stream is active and repeat-render stable", false, String(error));
  }

  // Envelope follower: kicks (left source) duck the sustained 808 carrier on
  // the right — cross-track wiring measured per quarter-note cycle.
  try {
    let beatSecRef = 0.5;
    const renderCoupled = async (withFollower: boolean): Promise<{ data: Float32Array }> => {
      const doc = makeModDoc((d) => {
        beatSecRef = 60 / d.bpm;
        const drums = d.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
        const bass = d.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "808");
        if (withFollower && bass) {
          d.lfos = [{
            id: "chk-env", trackId: bass.id, kind: "envFollower", param: "gain",
            sourceTrackId: drums.id, attackMs: 4, releaseMs: 260, sensitivity: 2.5, amount: 0.95,
          }];
        }
      });
      return { data: (await renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 })).getChannelData(1) };
    };
    const ducked = await renderCoupled(true);
    const plain = await renderCoupled(false);
    const beatSec = beatSecRef;
    const cycleDuck = (data: Float32Array): number => {
      const ratios: number[] = [];
      for (let k = 1; k <= 3; k++) {
        const hit = k * beatSec; // house kick lands on each beat
        const after = rmsWindow(data, (hit + 0.05) * SR, (hit + beatSec * 0.75) * SR);
        const before = rmsWindow(data, (hit - beatSec * 0.6) * SR, (hit - beatSec * 0.08) * SR);
        ratios.push(after / Math.max(before, 1e-6));
      }
      return ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
    };
    const duckedRatio = cycleDuck(ducked.data);
    const plainRatio = cycleDuck(plain.data);
    check(
      "envelope follower: source transients shape host gain (cross-track)",
      Number.isFinite(duckedRatio) && Number.isFinite(plainRatio) && duckedRatio < plainRatio * 0.93,
      "ducked=" + duckedRatio.toFixed(3) + " plain=" + plainRatio.toFixed(3),
    );
  } catch (error) {
    check("envelope follower: source transients shape host gain (cross-track)", false, String(error));
  }

  // ---------------- Bus compressor (P0.2) ----------------

  // Hot input: per-sample worklet compresses hard and reports GR.
  try {
    const ctx = new OfflineAudioContext(2, SR, SR);
    await loadWorkletModules(ctx);
    if (!isWorkletReady("compressor", ctx)) {
      check("compressor: worklet compresses hot input and reports GR", false, "worklet modules not ready");
    } else {
      const params = { threshold: -30, ratio: 6, attack: 0.005, release: 0.1, knee: 6, makeup: 0, mix: 1, detector: 0, scHpf: 20 };
      const rt = EFFECT_DEFS.compressor.factory(ctx, { id: "chk-comp", type: "compressor", bypassed: false, params }, { bpm: 124 });
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 220;
      const gain = ctx.createGain();
      gain.gain.value = 0.7; // ≈ −6.1 dBFS RMS — far above THRESH −30
      osc.connect(gain).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      rt.dispose();
      await new Promise((resolve) => setTimeout(resolve, 120)); // GR messages flush
      let rmsOut = 0;
      for (let i = 0; i < out.length; i++) rmsOut += out[i] * out[i];
      rmsOut = Math.sqrt(rmsOut / out.length);
      const baseline = 0.7 / Math.SQRT2;
      const gr = rt.getGainReductionDb?.() ?? 0;
      check(
        "compressor: worklet compresses hot input and reports GR",
        rmsOut < baseline * 0.4 && gr >= 8,
        `rms=${rmsOut.toFixed(4)} baseline=${baseline.toFixed(4)} gr=${gr.toFixed(1)}dB`,
      );
    }
  } catch (error) {
    check("compressor: worklet compresses hot input and reports GR", false, String(error));
  }

  // Sidechain HPF: a sub-only detector drives compression when the HPF is off
  // and is rejected once the HPF sits above the sub band — the reason this is
  // a worklet and not the native node.
  try {
    const ctx = new OfflineAudioContext(2, SR, SR);
    await loadWorkletModules(ctx);
    if (!isWorkletReady("compressor", ctx)) {
      check("compressor: sidechain HPF gates bass-only detector", false, "worklet modules not ready");
    } else {
    const renderWith = async (scHpf: number, withSidechain: boolean): Promise<{ rms: number; gr: number }> => {
      // Each variant needs a FRESH context — startRendering closes it.
      const ctx = new OfflineAudioContext(2, SR, SR);
      await loadWorkletModules(ctx);
      const params = { threshold: -30, ratio: 8, attack: 0.003, release: 0.05, knee: 3, makeup: 0, mix: 1, detector: 0, scHpf };
      const rt = EFFECT_DEFS.compressor.factory(ctx, { id: `chk-sc${scHpf}`, type: "compressor", bypassed: false, params }, { bpm: 124 });
        const carrier = ctx.createOscillator();
        carrier.type = "sine";
        carrier.frequency.value = 220;
        const carrierGain = ctx.createGain();
        carrierGain.gain.value = 0.4;
        carrier.connect(carrierGain).connect(rt.input);
        if (withSidechain) {
          const sub = ctx.createOscillator();
          sub.type = "sine";
          sub.frequency.value = 45; // sub bass — must vanish through the HPF
          const subGain = ctx.createGain();
          subGain.gain.value = 0.9;
          sub.connect(subGain);
          rt.setSidechainInput?.(subGain);
          sub.start(0);
        }
        carrier.start(0);
        rt.output.connect(ctx.destination);
        const buf = await ctx.startRendering();
        rt.dispose();
        const data = buf.getChannelData(0);
        let rms = 0;
        for (let i = Math.floor(data.length * 0.25); i < data.length; i++) rms += data[i] * data[i];
        rms = Math.sqrt(rms / (data.length - Math.floor(data.length * 0.25)));
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { rms, gr: rt.getGainReductionDb?.() ?? 0 };
      };
      const baseline = await renderWith(20, false);
      const bassOn = await renderWith(20, true);
      const filtered = await renderWith(300, true);
      check(
        "compressor: sidechain HPF gates bass-only detector",
        bassOn.rms < baseline.rms * 0.5 && bassOn.gr >= 6
          && filtered.rms > baseline.rms * 0.85 && filtered.gr <= 0.7,
        `baseline=${baseline.rms.toFixed(4)} bassOn=${bassOn.rms.toFixed(4)}(gr ${bassOn.gr.toFixed(1)}) hpf300=${filtered.rms.toFixed(4)}(gr ${filtered.gr.toFixed(1)})`,
      );
    }
  } catch (error) {
    check("compressor: sidechain HPF gates bass-only detector", false, String(error));
  }

  // Parallel path: MIX = 0 must pass the signal untouched.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    await loadWorkletModules(ctx);
    const params = { threshold: -40, ratio: 20, attack: 0.001, release: 0.05, knee: 0, makeup: 0, mix: 0, detector: 1, scHpf: 20 };
    const rt = EFFECT_DEFS.compressor.factory(ctx, { id: "chk-mix0", type: "compressor", bypassed: false, params }, { bpm: 124 });
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220;
    const gain = ctx.createGain();
    gain.gain.value = 0.8;
    osc.connect(gain).connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const data = (await ctx.startRendering()).getChannelData(0);
    rt.dispose();
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    check("compressor: mix = 0 passes unity (parallel blend)", Math.abs(peak - 0.8) < 0.02, `peak=${peak.toFixed(4)} expected≈0.8`);
  } catch (error) {
    check("compressor: mix = 0 passes unity (parallel blend)", false, String(error));
  }

  // K-weighted loudness meter (BS.1770): a 1 kHz sine at −23 dBFS must read
  // ≈ −23 LUFS integrated — the official conformance target, live path.
  try {
    const ctx = new OfflineAudioContext(2, SR * 2.5, SR);
    await loadWorkletModules(ctx);
    if (!isWorkletReady("kwmeter", ctx)) {
      check("kwmeter: BS.1770 conformance (1 kHz @ −23 dBFS → −23 LUFS)", false, "worklet modules not ready");
    } else {
      const meter = createKwMeterNode(ctx);
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 1000;
      const amplitude = Math.pow(10, -23 / 20);
      const gain = ctx.createGain();
      gain.gain.value = amplitude;
      osc.connect(gain).connect(meter.input);
      osc.start(0);
      await ctx.startRendering();
      meter.dispose();
      await new Promise((resolve) => setTimeout(resolve, 150)); // loudness messages flush
      const loudness = meter.getLoudness();
      check(
        "kwmeter: BS.1770 conformance (1 kHz @ −23 dBFS → −23 LUFS)",
        loudness.i > -24 && loudness.i < -22,
        `integrated=${loudness.i.toFixed(2)} LUFS (momentary=${loudness.m.toFixed(2)})`,
      );
    }
  } catch (error) {
    check("kwmeter: BS.1770 conformance (1 kHz @ −23 dBFS → −23 LUFS)", false, String(error));
  }

  // ---------------- Step Gate (P0.4) ----------------

  // Step gate alternates volume on a grid derived from BPM — identical grid
  // math to the step modulator, but running inside an EffectRuntime instead
  // of an automation lane.  Render through the same pipeline (renderProject)
  // with a house pattern and a stepGate on the drums; compare gated vs
  // control (no effect) block RMS on alternating 1/8-note windows.
  // Division=3 (1/8) → each step = half-beat, so within a full beat there
  // are exactly two steps (one gated, one open), giving clean contrast.
  try {
    const renderStepGate = async (withGate: boolean): Promise<Float32Array> => {
      const doc = createProjectFromTemplate("house");
      const drums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
      drums.pan = -1;
      for (const track of doc.tracks) {
        if (track.kind === "instrument") track.mute = true;
      }
      doc.master.limiterEnabled = false;
      doc.master.clipperEnabled = false;
      if (withGate) {
        drums.effects = [{
          id: "sg-chk", type: "stepGate", bypassed: false,
          params: { division: 3, depth: 1, smooth: 0.02, mix: 1 },
          steps: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
        }];
      }
      const buf = await renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 });
      return buf.getChannelData(0);
    };
    const gateData = await renderStepGate(true);
    const ctrlData = await renderStepGate(false);
    const beatSec = 60 / 124; // house bpm
    const stepSec = beatSec * 0.5; // 1/8 note
    const gateWins = [...Array(8)].map((_, w) => rmsWindow(gateData, w * stepSec * SR, (w + 0.9) * stepSec * SR));
    const ctrlWins = [...Array(8)].map((_, w) => rmsWindow(ctrlData, w * stepSec * SR, (w + 0.9) * stepSec * SR));
    // Pattern [1,0,1,0,...]: even steps = open, odd steps = closed
    const gateHigh = (gateWins[0] + gateWins[2] + gateWins[4] + gateWins[6]) / 4;
    const gateLow = (gateWins[1] + gateWins[3] + gateWins[5] + gateWins[7]) / 4;
    const ctrlHigh = (ctrlWins[0] + ctrlWins[2] + ctrlWins[4] + ctrlWins[6]) / 4;
    check(
      "step gate: pattern halves signal on off-beats (offline)",
      ctrlHigh > 0.005
        && gateHigh > gateLow * 2
        && gateHigh > ctrlHigh * 0.6,
      `even=${gateHigh.toFixed(4)} odd=${gateLow.toFixed(4)} ctrl=${ctrlHigh.toFixed(4)}`,
    );
  } catch (error) {
    check("step gate: pattern halves signal on off-beats (offline)", false, String(error));
  }

  // Step gate mix=0 passthrough:
  try {
    const renderGate = async (mix: number, stepVal: number): Promise<{ peak: number }> => {
      const doc = createProjectFromTemplate("house");
      const drums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
      drums.pan = -1;
      for (const track of doc.tracks) { if (track.kind === "instrument") track.mute = true; }
      doc.master.limiterEnabled = false;
      doc.master.clipperEnabled = false;
      drums.effects = [{ id: "sg-p", type: "stepGate", bypassed: false, params: { division: 4, depth: 1, smooth: 0.02, mix }, steps: Array(16).fill(stepVal) }];
      const buf = await renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 });
      const data = buf.getChannelData(0);
      let pk = 0;
      for (let i = 0; i < data.length; i++) pk = Math.max(pk, Math.abs(data[i]));
      return { peak: pk };
    };
    const allOpen = await renderGate(1, 1);
    const mix0 = await renderGate(0, 0);
    check("step gate: mix=0 passes signal through (no gating)", Math.abs(mix0.peak - allOpen.peak) < 0.05, `mix0=${mix0.peak.toFixed(4)} allOpen=${allOpen.peak.toFixed(4)}`);
  } catch (error) {
    check("step gate: mix=0 passes signal through (no gating)", false, String(error));
  }

  // Multiband sidechain: with splitFreq the low band is ducked but high
  // frequencies pass through unaffected — the reason this is a worklet.
  try {
    const renderCarrier = async (carrierFreq: number, splitFreq: number): Promise<{ rms: number }> => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      await loadWorkletModules(ctx);
      const params = { threshold: -30, ratio: 8, attack: 0.002, release: 0.1, amount: 1, splitFreq };
      const sidechainRt = EFFECT_DEFS.sidechain.factory(ctx, { id: "mb-sc", type: "sidechain", bypassed: false, params }, { bpm: 124 });
      // Main: carrier tone
      const carrier = ctx.createOscillator();
      carrier.type = "sine";
      carrier.frequency.value = carrierFreq;
      const mainGain = ctx.createGain();
      mainGain.gain.value = 0.7;
      carrier.connect(mainGain).connect(sidechainRt.input);
      sidechainRt.output.connect(ctx.destination);
      // Sidechain: loud sub kick to trigger ducking
      const kick = ctx.createOscillator();
      kick.type = "sine";
      kick.frequency.value = 50;
      const kickGain = ctx.createGain();
      kickGain.gain.value = 1.2;
      kick.connect(kickGain);
      sidechainRt.setSidechainInput?.(kickGain);
      kick.start(0);
      carrier.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      sidechainRt.dispose();
      // Measure RMS from 200ms onward (steady state after initial kick tails)
      let rms = 0;
      const start = Math.floor(SR * 0.4);
      for (let i = start; i < out.length; i++) rms += out[i] * out[i];
      rms = Math.sqrt(rms / Math.max(1, out.length - start));
      return { rms };
    };
    // Baseline: full-band (splitFreq=0) ducks the 1 kHz carrier hard
    const fullBand = await renderCarrier(1000, 0);
    // Multiband: only low band ducked — 1 kHz carrier should survive
    const multiBand = await renderCarrier(1000, 150);
    check(
      "sidechain: multiband split frees high frequencies from ducking",
      multiBand.rms > fullBand.rms * 0.8 && fullBand.rms < 0.7 * Math.sqrt(0.7),
      `fullBandRms=${fullBand.rms.toFixed(4)} multiBandRms=${multiBand.rms.toFixed(4)}`,
    );
  } catch (error) {
    check("sidechain: multiband split frees high frequencies from ducking", false, String(error));
  }

  // ---------------- SV Filter (P1.1) ----------------
  // LP mode passes low, blocks high: render two-tone (200 Hz + 8 kHz) through
  // LP at 1000 Hz cutoff; assert the 8 kHz component is attenuated.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    await loadWorkletModules(ctx);
    if (!isWorkletReady("svFilter", ctx)) {
      check("svFilter: LP attenuates high frequencies", false, "worklet modules not ready");
    } else {
      const params = { cutoff: 1000, resonance: 0, mode: 0, drive: 0, mix: 1 };
      const rt = EFFECT_DEFS.svFilter.factory(ctx, { id: "svf-lp", type: "svFilter", bypassed: false, params }, { bpm: 124 });
      // Two-tone: 200 Hz + 8 kHz
      const osc1 = ctx.createOscillator();
      osc1.type = "sine"; osc1.frequency.value = 200;
      const osc2 = ctx.createOscillator();
      osc2.type = "sine"; osc2.frequency.value = 8000;
      const g1 = ctx.createGain(); g1.gain.value = 0.4;
      const g2 = ctx.createGain(); g2.gain.value = 0.4;
      osc1.connect(g1).connect(rt.input);
      osc2.connect(g2).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc1.start(0); osc2.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      rt.dispose();
      // Measure energy above 4 kHz by zero-crossing density (proxy for high freq content)
      let crossings = 0;
      for (let i = 1; i < out.length; i++) {
        if (out[i - 1] >= 0 !== out[i] >= 0) crossings++;
      }
      const crossingDensity = crossings / out.length;
      // With only 200 Hz the crossing rate would be ~400/s; with 8 kHz it would be ~16000/s
      // LP at 1 kHz should keep it close to the 200 Hz rate
      const densityPerSample = crossingDensity; // per sample
      check(
        "svFilter: LP attenuates high frequencies (zero-crossing proxy)",
        densityPerSample < 0.035,
        `crossingDensity=${densityPerSample.toFixed(4)} (bare two-tone would be ~0.36)`,
      );
    }
  } catch (error) {
    check("svFilter: LP attenuates high frequencies", false, String(error));
  }

  // SV Filter HP mode passes high, blocks low
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    await loadWorkletModules(ctx);
    if (!isWorkletReady("svFilter", ctx)) {
      check("svFilter: HP blocks low frequencies", false, "worklet modules not ready");
    } else {
      const params = { cutoff: 1000, resonance: 0, mode: 1, drive: 0, mix: 1 };
      const rt = EFFECT_DEFS.svFilter.factory(ctx, { id: "svf-hp", type: "svFilter", bypassed: false, params }, { bpm: 124 });
      const osc = ctx.createOscillator();
      osc.type = "sine"; osc.frequency.value = 100; // 100 Hz — below cutoff
      osc.connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      rt.dispose();
      let rms = 0;
      for (let i = Math.floor(out.length * 0.5); i < out.length; i++) rms += out[i] * out[i];
      rms = Math.sqrt(rms / (out.length * 0.5));
      // 100 Hz through 1 kHz HP should be heavily attenuated
      check("svFilter: HP blocks low frequencies", rms < 0.05, `rms=${rms.toFixed(4)} (100 Hz through 1 kHz HP)`);
    }
  } catch (error) {
    check("svFilter: HP blocks low frequencies", false, String(error));
  }

  // ---------------- Flanger (P1.2) ----------------
  // Flanger creates time-varying comb filtering: RMS varies when compared to
  // a passthrough render. Assert the wet signal is different from dry and
  // has audible energy (not silence).
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    await loadWorkletModules(ctx);
    if (!isWorkletReady("flanger", ctx)) {
      check("flanger: wet signal differs from dry (comb filtering active)", false, "worklet modules not ready");
    } else {
      const params = { rate: 1, depth: 3, base: 5, feedback: 0.5, spread: 0, mix: 0.7 };
      const rt = EFFECT_DEFS.flanger.factory(ctx, { id: "chk-flg", type: "flanger", bypassed: false, params }, { bpm: 124 });
      const osc = ctx.createOscillator();
      osc.type = "sawtooth"; // rich spectrum for flanging
      osc.frequency.value = 220;
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      osc.connect(gain).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const flanged = (await ctx.startRendering()).getChannelData(0);
      rt.dispose();
      // Render dry reference
      const ctx2 = new OfflineAudioContext(1, SR, SR);
      const osc2 = ctx2.createOscillator();
      osc2.type = "sawtooth"; osc2.frequency.value = 220;
      const gain2 = ctx2.createGain(); gain2.gain.value = 0.5;
      osc2.connect(gain2).connect(ctx2.destination);
      osc2.start(0);
      const dry = (await ctx2.startRendering()).getChannelData(0);
      // Measure difference between flanged and dry in the last half
      let diff = 0;
      let energy = 0;
      for (let i = Math.floor(flanged.length / 2); i < flanged.length; i++) {
        diff += Math.abs(flanged[i] - dry[i]);
        energy += Math.abs(flanged[i]);
      }
      const relDiff = diff / Math.max(energy, 1e-9);
      check(
        "flanger: wet signal differs from dry (comb filtering active)",
        relDiff > 0.1 && energy / (flanged.length / 2) > 0.001,
        `relDiff=${relDiff.toFixed(3)} rmsFlanged=${(energy / (flanged.length / 2)).toFixed(4)}`,
      );
    }
  } catch (error) {
    check("flanger: wet signal differs from dry (comb filtering active)", false, String(error));
  }

  // ---------------- Tremolo (P1.3) ----------------
  // Classic AM: gain oscillates between (1-depth) and 1 at the LFO rate.
  // Assert: peak stays at input level (gain never exceeds 1), and RMS
  // alternates between high/low halves of the LFO cycle.
  try {
    const ctx = new OfflineAudioContext(1, SR, SR);
    await loadWorkletModules(ctx);
    if (!isWorkletReady("tremolo", ctx)) {
      check("tremolo: AM modulates gain rhythmically", false, "worklet modules not ready");
    } else {
      const params = { rate: 4, depth: 0.9, shape: 1, mode: 0, mix: 1 }; // 4 Hz, square, hard
      const rt = EFFECT_DEFS.tremolo.factory(ctx, { id: "chk-trem", type: "tremolo", bypassed: false, params }, { bpm: 124 });
      const osc = ctx.createOscillator();
      osc.type = "sine"; osc.frequency.value = 2000;
      const gain = ctx.createGain(); gain.gain.value = 0.5;
      osc.connect(gain).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const data = (await ctx.startRendering()).getChannelData(0);
      rt.dispose();
      // LFO period = 1/4 = 0.25s. Measure RMS in high/low halves of each cycle.
      const period = SR / 4;
      const half = period / 2;
      let peakAll = 0;
      let hiRms = 0; let loRms = 0;
      const cycles = 4;
      for (let c = 0; c < cycles; c++) {
        let hiSum = 0; let loSum = 0;
        for (let i = 0; i < half; i++) {
          const hv = data[Math.floor(c * period + i)];
          const lv = data[Math.floor(c * period + half + i)];
          hiSum += hv * hv; loSum += lv * lv;
          peakAll = Math.max(peakAll, Math.abs(hv), Math.abs(lv));
        }
        hiRms += Math.sqrt(hiSum / half);
        loRms += Math.sqrt(loSum / half);
      }
      hiRms /= cycles;
      loRms /= cycles;
      check(
        "tremolo: AM modulates gain rhythmically",
        hiRms > loRms * 3 && peakAll <= 0.55 && hiRms > 0.05,
        `hi=${hiRms.toFixed(4)} lo=${loRms.toFixed(4)} ratio=${(hiRms / Math.max(loRms, 1e-6)).toFixed(1)} peak=${peakAll.toFixed(3)}`,
      );
    }
  } catch (error) {
    check("tremolo: AM modulates gain rhythmically", false, String(error));
  }

  // ---------------- Autowah (P1.4) ----------------
  // Envelope follower drives filter cutoff: loud input opens the filter,
  // quiet input closes it. Assert: loud tone passes more energy than quiet tone.
  try {
    const ctx = new OfflineAudioContext(1, SR * 2, SR);
    await loadWorkletModules(ctx);
    if (!isWorkletReady("autowah", ctx)) {
      check("autowah: envelope drives filter cutoff", false, "worklet modules not ready");
    } else {
      // LP mode: quiet → cutoff closes below carrier → attenuated
    // loud → cutoff opens above carrier → passes
    const params = { minFreq: 200, maxFreq: 4000, resonance: 0.5, attack: 0.01, release: 0.15, sensitivity: 2, mode: 1, mix: 1 };
      const rt = EFFECT_DEFS.autowah.factory(ctx, { id: "chk-aw", type: "autowah", bypassed: false, params }, { bpm: 124 });
      // First half: quiet tone (0.05) → cutoff ≈ 400 Hz → 2 kHz attenuated
      // Second half: loud tone (0.8) → cutoff ≈ 3800 Hz → 2 kHz passes
      const osc = ctx.createOscillator();
      osc.type = "sine"; osc.frequency.value = 2000;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.05, 0);
      gain.gain.setValueAtTime(0.05, 0.9);
      gain.gain.setValueAtTime(0.8, 0.901);
      osc.connect(gain).connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      rt.dispose();
      const quietRms = rmsWindow(out, SR * 0.3, SR * 0.8);
      const loudRms = rmsWindow(out, SR * 1.3, SR * 1.8);
      check(
        "autowah: envelope drives filter cutoff",
        quietRms < loudRms * 0.7 && loudRms > 0.005,
        `quiet=${quietRms.toFixed(4)} loud=${loudRms.toFixed(4)} ratio=${(loudRms / Math.max(quietRms, 1e-6)).toFixed(1)}`,
      );
    }
  } catch (error) {
    check("autowah: envelope drives filter cutoff", false, String(error));
  }

  // ---------------- Stutter (P1.7) ----------------
  // Stutter reads from one loop behind — when the gate pattern is fully open,
  // the output is a delayed copy of the input (one loop late). When gate has
  // gaps, alternating 1/8-note windows show on/off contrast.
  try {
    const renderStutter = async (steps: number[] | undefined, mix: number): Promise<Float32Array> => {
      const doc = createProjectFromTemplate("house");
      const drums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
      drums.pan = -1;
      for (const track of doc.tracks) { if (track.kind === "instrument") track.mute = true; }
      doc.master.limiterEnabled = false;
      doc.master.clipperEnabled = false;
      drums.effects = [{
        id: "stut-chk", type: "stutter", bypassed: false,
        params: { division: 4, mix, feedback: 0 },
        ...(steps ? { steps } : {}),
      }];
      const buf = await renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0 });
      return buf.getChannelData(0);
    };
    // Gated: [1,0,1,0...] → alternating 1/8-note windows
    const gated = await renderStutter([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0], 1);
    const beatSec = 60 / 124;
    const stepSec = beatSec * 0.5; // 1/8 note
    const wins = [...Array(8)].map((_, w) => rmsWindow(gated, w * stepSec * SR, (w + 0.9) * stepSec * SR));
    const high = (wins[0] + wins[2] + wins[4] + wins[6]) / 4;
    const low = (wins[1] + wins[3] + wins[5] + wins[7]) / 4;
    check(
      "stutter: gate pattern alternates delayed loop audibility",
      high > low * 1.5 && high > 0.001,
      `high=${high.toFixed(4)} low=${low.toFixed(4)} ratio=${(high / Math.max(low, 1e-6)).toFixed(1)}`,
    );
  } catch (error) {
    check("stutter: gate pattern alternates delayed loop audibility", false, String(error));
  }

  return results;
}

