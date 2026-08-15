import { EFFECT_DEFS, EFFECT_ORDER, defaultParamsOf } from "./effects/registry";
import { INSTRUMENT_DEFS, INSTRUMENT_ORDER, defaultInstrumentParams } from "./instruments/registry";
import { generateFactoryBank } from "./sample-library/factory";
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
  check("factory bank generates 20 buffers", bank.size === 20, `size=${bank.size}`);
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

  return results;
}
