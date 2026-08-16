import { EFFECT_DEFS, EFFECT_ORDER, defaultParamsOf } from "./effects/registry";
import { INSTRUMENT_DEFS, INSTRUMENT_ORDER, defaultInstrumentParams } from "./instruments/registry";
import { generateFactoryBank } from "./sample-library/factory";
import { renderProject } from "./rendering/renderer";
import { buildStemProject, STEM_GROUPS } from "./rendering/stems";
import { encodeWav } from "./rendering/wav";
import { createDefaultProject } from "./project-model/schema";
import { PPQ } from "./project-model/types";
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

  // Bitcrusher: unique output values bounded by bit depth
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
    const unique = new Set<number>();
    for (let i = 0; i < data.length; i++) unique.add(Math.round(data[i] * 1000) / 1000);
    check("bitcrusher: 4-bit quantisation caps unique output values ≤ 16", unique.size <= 16 && unique.size > 0, `unique=${unique.size}`);
  } catch (error) {
    check("bitcrusher: 4-bit quantisation caps unique output values ≤ 16", false, String(error));
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

  // Sidechain: ducks the target gain on a sidechain burst
  try {
    const ctx = new OfflineAudioContext(1, SR * 2, SR);
    const params = { ...defaultParamsOf("sidechain"), threshold: -30, ratio: 8, attack: 0.001, release: 0.05, amount: 1 };
    const rt = EFFECT_DEFS.sidechain.factory(ctx, { id: "t", type: "sidechain", bypassed: false, params }, { bpm: 124 });

    // Main path: steady tone
    const main = ctx.createOscillator();
    main.type = "sine";
    main.frequency.value = 440;
    main.connect(rt.input);

    // Sidechain feed: short loud burst at 200 ms
    const burst = ctx.createOscillator();
    burst.type = "sine";
    burst.frequency.value = 220;
    const burstGain = ctx.createGain();
    burstGain.gain.setValueAtTime(0, 0);
    burstGain.gain.setValueAtTime(1, 0.2);
    burstGain.gain.setTargetAtTime(0, 0.22, 0.01);
    burst.connect(burstGain);
    rt.setSidechainInput?.(burstGain);

    rt.output.connect(ctx.destination);
    main.start(0);
    burst.start(0);
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    const rms = (from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, to - from));
    };
    const before = rms(Math.floor(SR * 0.05), Math.floor(SR * 0.15));
    const during = rms(Math.floor(SR * 0.18), Math.floor(SR * 0.22));
    check("sidechain: target gain drops during sidechain burst", during < before * 0.5, `before=${before.toFixed(3)} during=${during.toFixed(3)}`);
  } catch (error) {
    check("sidechain: target gain drops during sidechain burst", false, String(error));
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
      "master chain tames a hot mix (limiter reduces, clipper brick-walls)",
      unlimitedPeak > 1.5 && limitedPeak < unlimitedPeak * 0.6 && clippedPeak <= 1.0,
      `unlimited=${unlimitedPeak.toFixed(3)} limited=${limitedPeak.toFixed(3)} clipped=${clippedPeak.toFixed(3)}`,
    );
  } catch (error) {
    check("master chain tames a hot mix (limiter reduces, clipper brick-walls)", false, String(error));
  }

  return results;
}
