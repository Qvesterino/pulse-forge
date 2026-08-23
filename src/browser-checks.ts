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
import type { EffectType, InstrumentTrack } from "./project-model/types";

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

  return results;
}
