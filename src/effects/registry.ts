import type { EffectDefinition, EffectRuntime } from "./types";
import type { EffectInstance, EffectType } from "../project-model/types";
import { hashString, mulberry32 } from "../shared/rng";
import { isWorkletReady } from "../audio-worklets/loader";
import { createLfoSyncController } from "./tempo-sync";
import { createBitcrusherNode } from "../audio-worklets/bitcrusher-node";
import { createFxEqNode } from "./fxeqNode";
import { createUltinaNode } from "./ultinaNode";
import { createOzvenaNode } from "./ozvenaNode";
import { createMorphDynamicsNode } from "./morphDynamicsNode";
import { createSidechainNode } from "../audio-worklets/sidechain-node";
import { createLimiterNode } from "../audio-worklets/limiter-node";
import { createCompressorNode } from "../audio-worklets/compressor-node";
import { createStepGateNode } from "../audio-worklets/stepgate-node";
import { createSvFilterNode } from "../audio-worklets/svfilter-node";
import { createFlangerNode } from "../audio-worklets/flanger-node";
import { createTremoloNode } from "../audio-worklets/tremolo-node";
import { createAutowahNode } from "../audio-worklets/autowah-node";
import { createStutterNode } from "../audio-worklets/stutter-node";
import { createTapeNode } from "../audio-worklets/tape-node";
import { createCombNode } from "../audio-worklets/comb-node";
import { createChorusNode } from "../audio-worklets/chorus-node";
import { createEqNode } from "../audio-worklets/eq-node";
import { createStockDelayNode } from "../audio-worklets/stock-delay-node";
import { createVowelNode } from "../audio-worklets/vowel-node";
import { createDuckingDelayNode } from "../audio-worklets/ducking-delay-node";
import { createEnvFollowerNode } from "../audio-worklets/envfollower-node";
import { createKaskadaNode } from "../audio-worklets/kaskada-node";
import { createRingModNode } from "../audio-worklets/ringmod-node";
import { createTapeStopNode } from "../audio-worklets/tapestop-node";
import { createFreqShiftNode } from "../audio-worklets/freqshifter-node";
import { createPitchShiftNode } from "../audio-worklets/pitchshift-node";
import { createVinylNode } from "../audio-worklets/vinyl-node";
import { createBeatManglerNode } from "../audio-worklets/beatmangler-node";
import { createVocoderNode } from "../audio-worklets/vocoder-node";
import { createReverseSwellNode } from "../audio-worklets/reverseswell-node";
import { createGranularFreezeNode } from "../audio-worklets/granularfreeze-node";
import { createReverbNode } from "../audio-worklets/reverb-node";
import { characterCurve, type CharacterMode } from "./characterCurve";
import {
  eqParams,
  msEqParams,
  haasWidenerParams,
  multibandParams,
  compressorParams,
  saturationParams,
  tapeSatParams,
  clipperParams,
  reverbParams,
  delayParams,
  pumpParams,
  distortionParams,
  bitcrusherParams,
  chorusParams,
  phaserParams,
  sidechainParams,
  transientParams,
  gateParams,
  shimmerParams,
  fxeqParams,
  ultinaParams,
  ozvenaParams,
  morphdynamicsParams,
  drumBussParams,
  bassBussParams,
  utilityParams,
  limiterParams,
  stepGateParams,
  svFilterParams,
  flangerParams,
  tremoloParams,
  autowahParams,
  stutterParams,
  combParams,
  vowelParams,
  duckDelayParams,
  ringModParams,
  tapeStopParams,
  freqShifterParams,
  multiTapDelayParams,
  pitchShiftParams,
  vinylParams,
  beatManglerParams,
  vocoderParams,
  reverseSwellParams,
  granularFreezeParams,
  kaskadaParams,
  FXEQ_PARAM_DEFAULTS,
  ULTINA_PARAM_DEFAULTS,
  MORPH_PARAM_DEFAULTS,
  PUMP_DIVISIONS,
  PHASER_STAGE_COUNTS,
  CORE_EFFECT_ORDER,
  FLAGSHIP_EFFECT_ORDER,
  EFFECT_ORDER,
} from "./definitions";
export {
  EFFECT_ORDER,
  CORE_EFFECT_ORDER,
  FLAGSHIP_EFFECT_ORDER,
  defaultParamsOf,
  clampEffectParam,
  normalizePluginParams,
  formatDb,
  formatHz,
  formatMs,
  formatPct,
  formatSec,
  VOWEL_OPTIONS,
  FXEQ_PARAM_DEFAULTS,
  ULTINA_PARAM_DEFAULTS,
  MORPH_PARAM_DEFAULTS,
  collectStateLeafPaths,
  flattenNumericState,
  OZVENA_PARAM_SECTIONS,
  OZVENA_DEFAULT_STATE,
  OZVENA_PARAM_PATHS,
  OZVENA_DEFAULT_DEEP_PARAMS,
  OZVENA_QUALITY_OPTIONS,
  AUTOWAH_MODES,
  BEATMANGLER_MODES,
  GATE_DIVISIONS,
  MULTITAP_DIVISIONS,
  STUTTER_DIVISIONS,
  SVF_MODES,
  TREMOLO_MODES,
  PHASER_STAGE_COUNTS,
  STOCK_DELAY_DIVISIONS,
  PUMP_DIVISIONS,
  BEATMANGLE_REPEAT_DIVISIONS,
  BEATMANGLE_OFFSETS,
  BEATMANGLE_GATE_DIVISIONS,
  REVERSE_SWELL_MAX_SEC,
  GRANULAR_FREEZE_MAX_WINDOW_SEC,
} from "./definitions";

const dbToLin = (db: number) => Math.pow(10, db / 20);
const smooth = (param: AudioParam, value: number, when: number, tc = 0.02) => param.setTargetAtTime(value, when, tc);

interface MixBus {
  input: GainNode;
  output: GainNode;
  wet: GainNode;
  setMix(m: number, when: number): void;
}

function mixBus(ctx: BaseAudioContext): MixBus {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  // Wet starts SILENT. Factories replay instance params through setMix on
  // construction, which smooths (setTargetAtTime); starting wet at 1 meant a
  // full-wet effect briefly summed dry+wet (~+6 dB decaying over ~60 ms) on
  // every insertion and every rack rebuild. From dry-only, the init smoothing
  // is a short crossfade into the saved mix instead.
  dry.gain.value = 1;
  wet.gain.value = 0;
  input.connect(dry).connect(output);
  input.connect(wet);
  const setMix = (m: number, when: number) => {
    smooth(wet.gain, m, when);
    smooth(dry.gain, 1 - m, when);
  };
  return { input, output, wet, setMix };
}

/**
 * Force a 2-channel (stereo, speakers) signal stage. ChannelSplitterNode runs
 * with explicit channelCount + discrete interpretation, so feeding it a MONO
 * input leaves output channel 1 silent — every splitter-based effect (utility,
 * haasWidener, msEq, bassBuss) lost its right channel for mono sources. An
 * explicit-stereo gain node upmixes mono to both channels (speakers rules)
 * before the split, and passes stereo through untouched.
 */
function stereoUpmix(ctx: BaseAudioContext): GainNode {
  const up = ctx.createGain();
  up.channelCount = 2;
  up.channelCountMode = "explicit";
  up.channelInterpretation = "speakers";
  return up;
}

/** Effects whose real DSP lives in an AudioWorklet processor. */
export const WORKLET_EFFECTS: Partial<Record<EffectType, "critical" | "degraded">> = {
  gate: "critical",
  transient: "critical",
  limiter: "critical",
  stepGate: "critical",
  svFilter: "critical",
  flanger: "critical",
  tremolo: "critical",
  autowah: "critical",
  stutter: "critical",
  tapeSat: "critical",
  comb: "critical",
  vowel: "critical",
  duckDelay: "critical",
  reverb: "degraded",
  compressor: "degraded",
  bitcrusher: "degraded",
  sidechain: "degraded",
  chorus: "degraded",
  delay: "degraded",
  eq: "degraded",
  // Flagship suites degrade to an honest 1:1 bypass (never silence) when
  // their worklet module has not landed in this context yet — the engine
  // hot-swaps the real DSP once the module arrives. Kaskáda rides the
  // always-loaded core bundle, the others lazy-load on demand.
  fxeq: "degraded",
  ultina: "degraded",
  ozvena: "degraded",
  kaskada: "degraded",
  morphdynamics: "degraded",
  // FX expansion (docs/FX-EXPANSION-ROADMAP.md): real DSP lives in the
  // always-loaded core worklet bundle; the fallback is an honest bypass.
  ringMod: "critical",
  tapeStop: "critical",
  freqShifter: "critical",
  pitchShift: "critical",
  vinyl: "critical",
  beatMangler: "critical",
  // The vocoder degrades to a 1:1 carrier passthrough when the worklet is
  // missing OR when no modulator track is routed (see createVocoderNode).
  vocoder: "degraded",
  reverseSwell: "critical",
  granularFreeze: "critical",
};

export type EffectProcessorStatus = "ok" | "bypassed" | "fallback";

/**
 * Whether `type` runs its real AudioWorklet DSP in this context. "bypassed"
 * means the effect cannot process at all right now (signal passes 1:1 — the
 * UI warns loudly); "fallback" means a reduced native approximation runs.
 */
export function effectProcessorStatus(
  type: EffectType,
  ctx: BaseAudioContext | null | undefined,
): EffectProcessorStatus {
  const severity = WORKLET_EFFECTS[type];
  if (!severity) return "ok";
  return isWorkletReady(
    type as
      | "bitcrusher"
      | "sidechain"
      | "transient"
      | "gate"
      | "limiter"
      | "compressor"
      | "stepGate"
      | "svFilter"
      | "flanger"
      | "tremolo"
      | "autowah"
      | "stutter"
      | "tapeSat"
      | "comb"
      | "vowel"
      | "duckDelay"
      | "chorus"
      | "delay"
      | "eq"
      | "fxeq"
      | "ultina"
      | "ozvena"
      | "morphdynamics"
      | "kaskada",
    ctx,
  )
    ? "ok"
    : severity === "critical"
      ? "bypassed"
      : "fallback";
}

/** Transparent 1:1 passthrough for contexts where the worklet is unavailable. */
function bypassRuntime(ctx: BaseAudioContext, reason: string): EffectRuntime {
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(output);
  return {
    input,
    output,
    degraded: true,
    degradedReason: reason,
    setParameter: () => undefined,
    dispose: () => {
      input.disconnect();
      output.disconnect();
    },
  };
}

/* ---------------- EQ ---------------- */
// Decramped 6-band worklet (parallel shelves, Q-corrected bells); the legacy
// native biquad chain survives as the degraded fallback.

const eq: EffectDefinition = {
  type: "eq",
  name: "EQ",
  category: "tone",
  params: eqParams,
  factory(ctx, instance) {
    if (isWorkletReady("eq", ctx)) return createEqNode(ctx, instance);
    return eqNativeFallback(ctx, instance);
  },
};

function eqNativeFallback(ctx: BaseAudioContext, instance: EffectInstance): EffectRuntime {
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  const lowMid = ctx.createBiquadFilter();
  lowMid.type = "peaking";
  const highMid = ctx.createBiquadFilter();
  highMid.type = "peaking";
  const high = ctx.createBiquadFilter();
  high.type = "highshelf";
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  hp.connect(low).connect(lowMid).connect(highMid).connect(high).connect(lp);
  const apply = (id: string, v: number, when: number) => {
    switch (id) {
      case "hpFreq":
        smooth(hp.frequency, v, when);
        break;
      case "lpFreq":
        smooth(lp.frequency, v, when);
        break;
      case "lowShelfGain":
        smooth(low.gain, v, when);
        break;
      case "lowShelfFreq":
        smooth(low.frequency, v, when);
        break;
      case "lowMidGain":
        smooth(lowMid.gain, v, when);
        break;
      case "lowMidFreq":
        smooth(lowMid.frequency, v, when);
        break;
      case "lowMidQ":
        smooth(lowMid.Q, v, when);
        break;
      case "highMidGain":
        smooth(highMid.gain, v, when);
        break;
      case "highMidFreq":
        smooth(highMid.frequency, v, when);
        break;
      case "highMidQ":
        smooth(highMid.Q, v, when);
        break;
      case "highShelfGain":
        smooth(high.gain, v, when);
        break;
      case "highShelfFreq":
        smooth(high.frequency, v, when);
        break;
      case "lowGain":
        if (instance.params.lowShelfGain === undefined) smooth(low.gain, v, when);
        break;
      case "lowFreq":
        if (instance.params.lowShelfFreq === undefined) smooth(low.frequency, v, when);
        break;
      case "midGain":
        if (instance.params.lowMidGain === undefined) smooth(lowMid.gain, v, when);
        break;
      case "midFreq":
        if (instance.params.lowMidFreq === undefined) smooth(lowMid.frequency, v, when);
        break;
      case "midQ":
        if (instance.params.lowMidQ === undefined) smooth(lowMid.Q, v, when);
        break;
      case "highGain":
        if (instance.params.highShelfGain === undefined) smooth(high.gain, v, when);
        break;
      case "highFreq":
        if (instance.params.highShelfFreq === undefined) smooth(high.frequency, v, when);
        break;
    }
  };
  for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
  return {
    input: hp,
    output: lp,
    degraded: true,
    degradedReason: "AudioWorklet unavailable — EQ on legacy biquad graph (shelves cramp near Nyquist)",
    setParameter: (id, v) => apply(id, v, ctx.currentTime),
    setParameterAt: (id, v, when) => apply(id, v, when),
    getAudioParam: (paramId: string) => {
      switch (paramId) {
        case "hpFreq":
          return hp.frequency;
        case "lpFreq":
          return lp.frequency;
        case "lowShelfFreq":
        case "lowFreq":
          return low.frequency;
        case "lowShelfGain":
        case "lowGain":
          return low.gain;
        case "lowMidFreq":
        case "midFreq":
          return lowMid.frequency;
        case "lowMidGain":
        case "midGain":
          return lowMid.gain;
        case "lowMidQ":
        case "midQ":
          return lowMid.Q;
        case "highMidFreq":
          return highMid.frequency;
        case "highMidGain":
          return highMid.gain;
        case "highMidQ":
          return highMid.Q;
        case "highShelfFreq":
        case "highFreq":
          return high.frequency;
        case "highShelfGain":
        case "highGain":
          return high.gain;
        default:
          return null;
      }
    },
    dispose: () => {
      hp.disconnect();
      low.disconnect();
      lowMid.disconnect();
      highMid.disconnect();
      high.disconnect();
      lp.disconnect();
    },
  };
}

/* ---------------- M/S EQ — mid/side encode, 2×2-band  ---------------- */

const msEq: EffectDefinition = {
  type: "msEq",
  name: "M/S EQ",
  category: "tone",
  params: msEqParams,
  factory(ctx, instance) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const splitterIn = ctx.createChannelSplitter(2);
    const mergerMS = ctx.createChannelMerger(2);
    const splitterMS = ctx.createChannelSplitter(2);
    const mergerOut = ctx.createChannelMerger(2);

    // Encode: Mid = 0.5*(L+R), Side = 0.5*(L-R)
    const gMidL = ctx.createGain();
    gMidL.gain.value = 0.5;
    const gMidR = ctx.createGain();
    gMidR.gain.value = 0.5;
    const gSideL = ctx.createGain();
    gSideL.gain.value = 0.5;
    const gSideR = ctx.createGain();
    gSideR.gain.value = -0.5;

    // Mid EQ
    const midLow = ctx.createBiquadFilter();
    midLow.type = "lowshelf";
    const midHigh = ctx.createBiquadFilter();
    midHigh.type = "highshelf";
    // Side EQ
    const sideLow = ctx.createBiquadFilter();
    sideLow.type = "lowshelf";
    const sideHigh = ctx.createBiquadFilter();
    sideHigh.type = "highshelf";

    // Decode gains
    const gLmid = ctx.createGain();
    gLmid.gain.value = 1;
    const gLside = ctx.createGain();
    gLside.gain.value = 1;
    const gRmid = ctx.createGain();
    gRmid.gain.value = 1;
    const gRside = ctx.createGain();
    gRside.gain.value = -1;

    // Upmix mono→stereo BEFORE the split: a mono source into a bare splitter
    // leaves channel 1 silent, so Side = 0.5·L and the right output collapsed.
    const upmixIn = stereoUpmix(ctx);
    input.connect(upmixIn).connect(splitterIn);
    splitterIn.connect(gMidL, 0);
    splitterIn.connect(gMidR, 1);
    splitterIn.connect(gSideL, 0);
    splitterIn.connect(gSideR, 1);
    gMidL.connect(mergerMS, 0, 0);
    gMidR.connect(mergerMS, 0, 0);
    gSideL.connect(mergerMS, 0, 1);
    gSideR.connect(mergerMS, 0, 1);

    mergerMS.connect(splitterMS);
    // M -> EQ
    splitterMS.connect(midLow, 0);
    midLow.connect(midHigh);
    splitterMS.connect(sideLow, 1);
    sideLow.connect(sideHigh);

    // Decode M/S -> L/R
    midHigh.connect(gLmid);
    midHigh.connect(gRmid);
    sideHigh.connect(gLside);
    sideHigh.connect(gRside);
    gLmid.connect(mergerOut, 0, 0);
    gLside.connect(mergerOut, 0, 0);
    gRmid.connect(mergerOut, 0, 1);
    gRside.connect(mergerOut, 0, 1);
    mergerOut.connect(output);

    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "midLowFreq":
          smooth(midLow.frequency, v, when);
          break;
        case "midLowGain":
          smooth(midLow.gain, v, when);
          break;
        case "midHighFreq":
          smooth(midHigh.frequency, v, when);
          break;
        case "midHighGain":
          smooth(midHigh.gain, v, when);
          break;
        case "sideLowFreq":
          smooth(sideLow.frequency, v, when);
          break;
        case "sideLowGain":
          smooth(sideLow.gain, v, when);
          break;
        case "sideHighFreq":
          smooth(sideHigh.frequency, v, when);
          break;
        case "sideHighGain":
          smooth(sideHigh.gain, v, when);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input,
      output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      getAudioParam: (paramId: string) => {
        switch (paramId) {
          case "midLowFreq":
            return midLow.frequency;
          case "midLowGain":
            return midLow.gain;
          case "midHighFreq":
            return midHigh.frequency;
          case "midHighGain":
            return midHigh.gain;
          case "sideLowFreq":
            return sideLow.frequency;
          case "sideLowGain":
            return sideLow.gain;
          case "sideHighFreq":
            return sideHigh.frequency;
          case "sideHighGain":
            return sideHigh.gain;
          default:
            return null;
        }
      },
      dispose: () => {
        input.disconnect();
        output.disconnect();
        upmixIn.disconnect();
        splitterIn.disconnect();
        mergerMS.disconnect();
        splitterMS.disconnect();
        mergerOut.disconnect();
        gMidL.disconnect();
        gMidR.disconnect();
        gSideL.disconnect();
        gSideR.disconnect();
        midLow.disconnect();
        midHigh.disconnect();
        sideLow.disconnect();
        sideHigh.disconnect();
        gLmid.disconnect();
        gLside.disconnect();
        gRmid.disconnect();
        gRside.disconnect();
      },
    };
  },
};

/* ---------------- Haas Widener ---------------- */

const haasWidener: EffectDefinition = {
  type: "haasWidener",
  name: "Haas Widener",
  category: "movement",
  params: haasWidenerParams,
  factory(ctx, instance) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = (instance.params.delayMs ?? 12) / 1000;
    const wet = ctx.createGain();
    wet.gain.value = instance.params.width ?? 0.7;
    const dry = ctx.createGain();
    dry.gain.value = 1 - (instance.params.width ?? 0.7);
    // CROSSFEED: a (optionally inverted) delayed copy of L is ADDED to the
    // right channel — true inter-channel decorrelation (real width), not
    // just the L comb filter the old version produced.
    const xf = ctx.createGain();
    const applyXf = (level: number, invert: boolean, when: number): void => {
      xf.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * (invert ? -1 : 1) * 0.8, when, 0.03);
    };
    applyXf(instance.params.crossfeed ?? 0.4, Math.round(instance.params.invert ?? 0) >= 0.5, ctx.currentTime);
    const fb = ctx.createGain();
    fb.gain.value = instance.params.feedback ?? 0;

    // L channel Haas: dry + delayed via width blend. Upmix mono first — a
    // bare splitter fed mono leaves channel 1 (the untouched right leg) dead.
    const upmixIn = stereoUpmix(ctx);
    input.connect(upmixIn).connect(splitter);
    splitter.connect(delay, 0);
    splitter.connect(dry, 0);
    delay.connect(wet);
    wet.connect(merger, 0, 0);
    dry.connect(merger, 0, 0);
    // R channel direct
    splitter.connect(merger, 1, 1);
    // Delayed-left copy into the RIGHT channel (crossfeed — the widening).
    delay.connect(xf).connect(merger, 0, 1);
    // Feedback: delayed L back into delay input (adds shimmer)
    wet.connect(fb).connect(delay);
    merger.connect(output);

    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "delayMs":
          smooth(delay.delayTime, v / 1000, when, 0.05);
          break;
        case "width":
          smooth(wet.gain, v, when);
          smooth(dry.gain, 1 - v, when);
          break;
        case "crossfeed":
          applyXf(v, Math.round(instance.params.invert ?? 0) >= 0.5, when);
          break;
        case "invert":
          applyXf(instance.params.crossfeed ?? 0.4, Math.round(v) >= 0.5, when);
          break;
        case "feedback":
          smooth(fb.gain, v, when);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input,
      output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      getAudioParam: (paramId: string) => {
        switch (paramId) {
          case "delayMs":
            return delay.delayTime;
          case "width":
            return wet.gain;
          case "feedback":
            return fb.gain;
          default:
            return null;
        }
      },
      dispose: () => {
        input.disconnect();
        output.disconnect();
        upmixIn.disconnect();
        splitter.disconnect();
        merger.disconnect();
        delay.disconnect();
        wet.disconnect();
        dry.disconnect();
        xf.disconnect();
        fb.disconnect();
      },
    };
  },
};

/* ---------------- Multiband Processor (3-band crossover gains) ---------------- */

const multiband: EffectDefinition = {
  type: "multiband",
  name: "Multiband",
  category: "tone",
  params: multibandParams,
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    // Complementary 3-band crossover (unity-sum): low = LP(lowFreq, wet)
    // midHigh = wet − low; mid = LP(highFreq, midHigh); high = midHigh − mid
    // Each branch feeds a gain stage (−12..+12 dB), then a PARALLEL
    // per-band compressor (COMP crossfades band → compressed band) and a
    // SOLO gate (any solo active mutes the other bands).
    const lowLP = ctx.createBiquadFilter();
    lowLP.type = "lowpass";
    const midLP = ctx.createBiquadFilter();
    midLP.type = "lowpass";
    const gLow = ctx.createGain();
    const gMid = ctx.createGain();
    const gHigh = ctx.createGain();
    const invLow = ctx.createGain();
    invLow.gain.value = -1;
    const invMid = ctx.createGain();
    invMid.gain.value = -1;
    const midHighSum = ctx.createGain();
    const highSum = ctx.createGain();

    // Per-band parallel compressor + solo gate. COMP crossfades the band
    // between dry and compressed; a solo active anywhere mutes the others.
    const makeBand = (): {
      input: GainNode;
      setComp: (amount: number, when: number) => void;
      setSolo: (soloed: boolean, when: number) => void;
      output: GainNode;
      dispose: () => void;
    } => {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -24;
      comp.ratio.value = 4;
      comp.attack.value = 0.005;
      comp.release.value = 0.2;
      comp.knee.value = 12;
      const compWet = ctx.createGain();
      const solo = ctx.createGain();
      const output = ctx.createGain();
      input.connect(dry).connect(output);
      input.connect(comp).connect(compWet).connect(output);
      output.connect(solo);
      const setComp = (amount: number, when: number): void => {
        const a = Math.max(0, Math.min(1, amount));
        compWet.gain.setTargetAtTime(a, when, 0.03);
        dry.gain.setTargetAtTime(1 - a, when, 0.03);
      };
      const setSolo = (soloed: boolean, when: number): void => {
        solo.gain.setTargetAtTime(soloed ? 1 : 0, when, 0.015);
      };
      const dispose = (): void => {
        input.disconnect();
        dry.disconnect();
        comp.disconnect();
        compWet.disconnect();
        output.disconnect();
        solo.disconnect();
      };
      return { input, setComp, setSolo, output, dispose };
    };
    const bandLow = makeBand();
    const bandMid = makeBand();
    const bandHigh = makeBand();
    const soloFlags = (): [boolean, boolean, boolean] => [
      Math.round(instance.params.soloLow ?? 0) >= 0.5,
      Math.round(instance.params.soloMid ?? 0) >= 0.5,
      Math.round(instance.params.soloHigh ?? 0) >= 0.5,
    ];
    const applySolos = (when: number): void => {
      const [lo, mid, hi] = soloFlags();
      const any = lo || mid || hi;
      bandLow.setSolo(!any || lo, when);
      bandMid.setSolo(!any || mid, when);
      bandHigh.setSolo(!any || hi, when);
    };

    mix.wet.connect(lowLP);
    lowLP.connect(gLow).connect(bandLow.input);
    bandLow.output.connect(mix.output);
    // wet − low → midHighSum
    mix.wet.connect(midHighSum);
    lowLP.connect(invLow).connect(midHighSum);
    midHighSum.connect(midLP);
    midLP.connect(gMid).connect(bandMid.input);
    bandMid.output.connect(mix.output);
    // midHighSum − mid → high branch
    midHighSum.connect(highSum);
    midLP.connect(invMid).connect(highSum);
    highSum.connect(gHigh).connect(bandHigh.input);
    bandHigh.output.connect(mix.output);

    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "lowFreq":
          smooth(lowLP.frequency, v, when);
          break;
        case "highFreq":
          smooth(midLP.frequency, v, when);
          break;
        case "lowGain":
          smooth(gLow.gain, dbToLin(v), when);
          break;
        case "midGain":
          smooth(gMid.gain, dbToLin(v), when);
          break;
        case "highGain":
          smooth(gHigh.gain, dbToLin(v), when);
          break;
        case "comp":
          bandLow.setComp(v, when);
          bandMid.setComp(v, when);
          bandHigh.setComp(v, when);
          break;
        case "soloLow":
        case "soloMid":
        case "soloHigh":
          applySolos(when);
          break;
        case "mix":
          mix.setMix(v, when);
          break;
      }
    };
    applySolos(ctx.currentTime);
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      getAudioParam: (paramId: string) => {
        switch (paramId) {
          case "lowFreq":
            return lowLP.frequency;
          case "highFreq":
            return midLP.frequency;
          case "lowGain":
            return gLow.gain;
          case "midGain":
            return gMid.gain;
          case "highGain":
            return gHigh.gain;
          case "mix":
            return mix.wet.gain;
          default:
            return null;
        }
      },
      dispose: () => {
        mix.input.disconnect();
        mix.output.disconnect();
        lowLP.disconnect();
        midLP.disconnect();
        gLow.disconnect();
        gMid.disconnect();
        gHigh.disconnect();
        invLow.disconnect();
        invMid.disconnect();
        midHighSum.disconnect();
        highSum.disconnect();
        bandLow.dispose();
        bandMid.dispose();
        bandHigh.dispose();
      },
    };
  },
};

/* ---------------- Compressor ---------------- */

const compressor: EffectDefinition = {
  type: "compressor",
  name: "Compressor",
  category: "dynamics",
  params: compressorParams,
  factory(ctx, instance) {
    if (isWorkletReady("compressor", ctx)) return createCompressorNode(ctx, instance);
    // Native fallback: DynamicsCompressorNode approximation — no sidechain,
    // no detector HPF, coarse GR. Degraded so the UI warns (never silent).
    const mix = mixBus(ctx);
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    mix.wet.connect(comp).connect(makeup).connect(mix.output);
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "threshold":
          smooth(comp.threshold, v, when);
          break;
        case "ratio":
          smooth(comp.ratio, v, when);
          break;
        case "attack":
          smooth(comp.attack, v, when);
          break;
        case "release":
          smooth(comp.release, v, when);
          break;
        case "knee":
          smooth(comp.knee, v, when);
          break;
        case "makeup":
          smooth(makeup.gain, dbToLin(v), when);
          break;
        case "mix":
          mix.setMix(v, when);
          break;
        case "detector":
        case "scHpf":
          break; // no native equivalent — parameter stays stored
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    const reduction = () => {
      const raw = (comp as unknown as { reduction?: number | { value: number } }).reduction;
      const value =
        typeof raw === "number" ? raw : typeof raw === "object" && raw && typeof raw.value === "number" ? raw.value : 0;
      return Math.max(0, Number.isFinite(value) ? -value : 0);
    };
    return {
      input: mix.input,
      output: mix.output,
      degraded: true,
      degradedReason: "Fallback — native approximation (sidechain & HPF inactive)",
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      setSidechainInput: () => undefined, // accepted, inactive on the fallback path
      getGainReductionDb: reduction,
      dispose: () => {
        mix.input.disconnect();
        mix.output.disconnect();
        comp.disconnect();
        makeup.disconnect();
      },
    };
  },
};

/* ---------------- Saturation (character engine) ---------------- */

const saturation: EffectDefinition = {
  type: "saturation",
  name: "Saturation",
  category: "character",
  params: saturationParams,
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    // Pre-HPF: band-limits what reaches the shaper so heavy bass doesn't
    // intermodulate the whole spectrum (decapitator-style FOCUS).
    const preHP = ctx.createBiquadFilter();
    preHP.type = "highpass";
    preHP.frequency.value = instance.params.preHpfHz ?? 20;
    preHP.Q.value = 0.7;
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "4x";
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    const out = ctx.createGain();
    mix.wet.connect(preHP).connect(shaper).connect(tone).connect(out).connect(mix.output);
    let mode = Math.round(instance.params.character ?? 0);
    let driveVal = instance.params.drive ?? 0.3;
    let biasVal = instance.params.bias ?? 0;
    const applyCurve = () => {
      shaper.curve = characterCurve(Math.max(0, Math.min(4, mode)) as CharacterMode, driveVal, biasVal);
    };
    applyCurve();
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "drive":
          driveVal = v;
          applyCurve();
          break;
        case "character":
          mode = Math.round(v);
          applyCurve();
          break;
        case "bias":
          biasVal = v;
          applyCurve();
          break;
        case "tone":
          smooth(tone.frequency, v, when);
          break;
        case "preHpfHz":
          smooth(preHP.frequency, v, when);
          break;
        case "mix":
          mix.setMix(v, when);
          break;
        case "output":
          smooth(out.gain, dbToLin(v), when);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => {
        mix.input.disconnect();
        mix.output.disconnect();
        preHP.disconnect();
        shaper.disconnect();
        tone.disconnect();
        out.disconnect();
      },
    };
  },
};

/* ---------------- Tape Saturation (hysteresis) ---------------- */

const tapeSat: EffectDefinition = {
  type: "tapeSat",
  name: "Tape Sat",
  category: "character",
  params: tapeSatParams,
  factory(ctx, instance) {
    if (isWorkletReady("tapeSat", ctx)) return createTapeNode(ctx, instance);
    return bypassRuntime(ctx, "AudioWorklet unavailable — tape saturation bypassed (1:1 signal)");
  },
};

/* ---------------- Clipper ---------------- */

const clipper: EffectDefinition = {
  type: "clipper",
  name: "Clipper",
  category: "character",
  params: clipperParams,
  factory(ctx, instance) {
    // Parallel topology via mixBus: MIX < 100 blends the CLEAN path back in
    // (the classic "parallel clipper" — transient snap without the crushed
    // body). The dry reference is pre-drive, so DRIVE does not change the
    // blended level.
    const mix = mixBus(ctx);
    mix.setMix(instance.params.mix ?? 1, ctx.currentTime);
    const pre = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "4x";
    const post = ctx.createGain();
    mix.wet.connect(pre).connect(shaper).connect(post).connect(mix.output);
    let ceiling = instance.params.ceiling ?? -1;
    let softness = instance.params.softness ?? 0.2;
    const curveOf = () => {
      const c = dbToLin(ceiling);
      const n = 2048;
      const curve = new Float32Array(new ArrayBuffer(n * 4));
      for (let i = 0; i < n; i++) {
        const u = (i / (n - 1)) * 2 - 1;
        let shaped: number;
        if (softness < 0.02) {
          shaped = Math.max(-1, Math.min(1, u));
        } else {
          const k = 1 + softness * 7;
          shaped = Math.tanh(u * k) / Math.tanh(k);
        }
        curve[i] = c * shaped;
      }
      return curve;
    };
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "drive":
          smooth(pre.gain, 1 + v * 8, when);
          break;
        case "ceiling":
          ceiling = v;
          shaper.curve = curveOf();
          break;
        case "softness":
          softness = v;
          shaper.curve = curveOf();
          break;
        case "mix":
          mix.setMix(v, when);
          break;
        case "output":
          smooth(post.gain, dbToLin(v), when);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => {
        mix.input.disconnect();
        mix.output.disconnect();
        pre.disconnect();
        shaper.disconnect();
        post.disconnect();
      },
    };
  },
};

/* ---------------- Reverb ---------------- */

function makeImpulseResponse(ctx: BaseAudioContext, decaySec: number, seed: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * decaySec));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const rand = mulberry32(seed);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (rand() * 2 - 1) * Math.pow(1 - i / length, 2.4);
    }
  }
  return buffer;
}

const reverb: EffectDefinition = {
  type: "reverb",
  name: "Reverb",
  category: "space",
  params: reverbParams,
  factory(ctx, instance) {
    if (isWorkletReady("reverb", ctx)) {
      const mix = mixBus(ctx);
      mix.setMix(instance.params.mix ?? 0.3, ctx.currentTime);
      const preDelay = ctx.createDelay(0.5);
      const node = createReverbNode(ctx, instance);
      mix.wet.connect(preDelay).connect(node.input);
      node.output.connect(mix.output);
      const apply = (id: string, v: number, when: number) => {
        switch (id) {
          case "decay":
            node.setParameter("decay", v);
            break;
          case "predelay":
            smooth(preDelay.delayTime, v / 1000, when, 0.05);
            break;
          case "tone":
            // Output brightness — separate from the in-loop damping.
            node.setParameter("tone", v);
            break;
          case "damping":
            // Feedback-loop darkening (how fast the TAIL loses HF).
            node.setParameter("damping", v);
            break;
          case "diffusion":
            node.setParameter("diffusion", v);
            break;
          case "mod":
            node.setParameter("mod", v);
            break;
          case "mix":
            mix.setMix(v, when);
            break;
        }
      };
      for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
      return {
        input: mix.input,
        output: mix.output,
        setParameter: (id, v) => apply(id, v, ctx.currentTime),
        setParameterAt: (id, v, when) => apply(id, v, when),
        getAudioParam: (paramId: string) => node.getAudioParam?.(paramId) ?? null,
        dispose: () => {
          mix.input.disconnect();
          mix.output.disconnect();
          preDelay.disconnect();
          node.dispose();
        },
      };
    }
    // Fallback: convolution IR (degraded — no FDN, CPU spikes on decay change)
    const mix = mixBus(ctx);
    mix.setMix(instance.params.mix ?? 0.3, ctx.currentTime);
    const preDelay = ctx.createDelay(0.5);
    const conv = ctx.createConvolver();
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    mix.wet.connect(preDelay).connect(conv).connect(tone).connect(mix.output);
    const seed = hashString(instance.id);
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL("../audio-workers/ir-generator.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<{ left: Float32Array; right: Float32Array; length: number }>) => {
        const { left, right, length } = e.data;
        const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
        buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
        buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
        conv.buffer = buffer;
      };
    } catch {
      // Worker not available — sync fallback
    }
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "decay":
          if (worker) worker.postMessage({ decay: v, sampleRate: ctx.sampleRate, seed });
          else conv.buffer = makeImpulseResponse(ctx, v, seed);
          break;
        case "predelay":
          smooth(preDelay.delayTime, v / 1000, when, 0.05);
          break;
        case "tone":
        case "damping":
          smooth(tone.frequency, v, when);
          break;
        case "diffusion":
          break;
        case "mix":
          mix.setMix(v, when);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      degraded: true,
      degradedReason: "Fallback convolution — FDN unavailable",
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      getAudioParam: (paramId: string) => {
        switch (paramId) {
          case "predelay":
            return preDelay.delayTime;
          case "tone":
          case "damping":
            return tone.frequency;
          default:
            return null;
        }
      },
      dispose: () => {
        worker?.terminate();
        mix.input.disconnect();
        mix.output.disconnect();
        preDelay.disconnect();
        conv.disconnect();
        tone.disconnect();
      },
    };
  },
};

/* ---------------- Delay ---------------- */
// Stereo tempo-aware worklet (damped loop, ping-pong, BPM sync); the legacy
// DelayNode graph survives as the degraded fallback.

function delayNativeFallback(ctx: BaseAudioContext, instance: EffectInstance): EffectRuntime {
  const mix = mixBus(ctx);
  const delayNode = ctx.createDelay(2);
  const feedback = ctx.createGain();
  const damp = ctx.createBiquadFilter();
  damp.type = "lowpass";
  mix.wet.connect(delayNode);
  delayNode.connect(damp).connect(feedback).connect(delayNode);
  delayNode.connect(mix.output);
  const apply = (id: string, v: number, when: number) => {
    switch (id) {
      case "time":
        smooth(delayNode.delayTime, v / 1000, when, 0.05);
        break;
      case "feedback":
        smooth(feedback.gain, v, when);
        break;
      case "tone":
        smooth(damp.frequency, v, when);
        break;
      case "mix":
        mix.setMix(v, when);
        break;
      case "sync":
      case "pingPong":
        break; // worklet-only — no native equivalent, parameters stay stored
    }
  };
  for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
  return {
    input: mix.input,
    output: mix.output,
    degraded: true,
    degradedReason: "AudioWorklet unavailable — Delay on legacy native graph (no sync/ping-pong)",
    setParameter: (id, v) => apply(id, v, ctx.currentTime),
    setParameterAt: (id, v, when) => apply(id, v, when),
    dispose: () => {
      mix.input.disconnect();
      mix.output.disconnect();
      delayNode.disconnect();
      damp.disconnect();
      feedback.disconnect();
    },
  };
}

const delay: EffectDefinition = {
  type: "delay",
  name: "Delay",
  category: "space",
  params: delayParams,
  factory(ctx, instance, env) {
    if (isWorkletReady("delay", ctx)) return createStockDelayNode(ctx, instance, env.bpm);
    return delayNativeFallback(ctx, instance);
  },
};

/* ---------------- Pump ---------------- */

export function duckCurve(release: number, n = 1024): Float32Array<ArrayBuffer> {
  const k = 3 + release * 15;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    curve[i] = Math.exp(-(i / (n - 1)) * k);
  }
  return curve;
}

const pump: EffectDefinition = {
  type: "pump",
  name: "Pump",
  category: "movement",
  params: pumpParams,
  factory(ctx, instance, env) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const target = ctx.createGain();
    target.gain.value = 1;
    input.connect(target).connect(output);

    const shaper = ctx.createWaveShaper();
    const amt = ctx.createGain();
    const inv = ctx.createGain();
    inv.gain.value = -1;
    shaper.connect(amt).connect(inv).connect(target.gain);

    // Key-driven path (real sidechain): the kick/buss signal feeds an
    // envelope follower whose audio-rate 0..~1 output ducks target.gain
    // through the shared amount/invert stages. The worklet follower gives
    // true asymmetric ballistics (2 ms attack, RELEASE-timed recovery);
    // without the core bundle a native rectifier + smoothing-LP chain
    // covers the same routing with symmetric ballistics (degraded flag).
    // Connected only while a key source is wired; otherwise the classic
    // beat-synced oscillator drives the same duck curve.
    const keyInput = ctx.createGain();
    const useKeyFollower = isWorkletReady("envFollower", ctx);
    // RELEASE maps to follower recovery 50..600 ms.
    const releaseMsOf = (r: number) => 50 + Math.max(0, Math.min(1, r)) * 550;
    let keyFollower: { dispose: () => void } | null = null;
    let keyReleaseParam: AudioParam | null = null;
    // Native fallback chain nodes (built only when the worklet is missing).
    let keyLp: BiquadFilterNode | null = null;
    let rectifier: WaveShaperNode | null = null;
    let smoothLp: BiquadFilterNode | null = null;
    let sens: GainNode | null = null;
    let clampShape: WaveShaperNode | null = null;
    const releaseLpFreq = (r: number) => 120 - Math.max(0, Math.min(1, r)) * 108; // 12..120 Hz recovery
    if (useKeyFollower) {
      const follower = createEnvFollowerNode(ctx, {
        params: { attackMs: 2, releaseMs: releaseMsOf(instance.params.release ?? 0.5), sensitivity: 2 },
      });
      keyFollower = follower;
      keyReleaseParam = follower.getAudioParam?.("release") ?? null;
      keyInput.connect(follower.input);
      follower.output.connect(amt);
    } else {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 200;
      const rect = ctx.createWaveShaper();
      rect.oversample = "none"; // control-rate envelope, not audio
      rect.curve = (() => {
        const n = 1024;
        const curve = new Float32Array(new ArrayBuffer(n * 4));
        for (let i = 0; i < n; i++) curve[i] = Math.abs((i / (n - 1)) * 2 - 1);
        return curve;
      })();
      const smooth = ctx.createBiquadFilter();
      smooth.type = "lowpass";
      const sensitivity = ctx.createGain();
      sensitivity.gain.value = 1.5;
      const clamp = ctx.createWaveShaper();
      clamp.oversample = "none";
      clamp.curve = (() => {
        const n = 1024;
        const curve = new Float32Array(new ArrayBuffer(n * 4));
        for (let i = 0; i < n; i++) curve[i] = Math.min(1, Math.max(0, (i / (n - 1)) * 2 - 1));
        return curve;
      })();
      keyLp = lp;
      rectifier = rect;
      smoothLp = smooth;
      sens = sensitivity;
      clampShape = clamp;
      keyInput.connect(lp).connect(rect).connect(smooth).connect(sensitivity).connect(clamp).connect(amt);
    }

    let keySource: AudioNode | null = null;

    let bpm = env.bpm;
    let release = instance.params.release ?? 0.5;
    let rateIndex = Math.max(0, Math.min(PUMP_DIVISIONS.length - 1, Math.round(instance.params.rate ?? 2)));
    let osc: OscillatorNode | null = null;

    if (smoothLp) smoothLp.frequency.value = releaseLpFreq(release);

    const freqOf = () => (bpm / 60) * PUMP_DIVISIONS[rateIndex].mult;
    const applyCurve = () => {
      shaper.curve = duckCurve(release);
    };
    const stopOsc = (when: number) => {
      if (!osc) return;
      try {
        osc.stop(when);
      } catch {
        /* not started */
      }
      const old = osc;
      osc = null;
      old.onended = () => {
        try {
          old.disconnect();
        } catch {
          /* already gone */
        }
      };
    };
    const startOsc = (when: number) => {
      // A wired key owns the ducking — the oscillator stays out of the way.
      if (keySource) return;
      if (osc) {
        // Disconnect only AFTER the scheduled stop — an immediate disconnect
        // collapsed the modulation into target.gain in one sample (audible
        // jump) and left the pump dead until the new oscillator started at
        // `when`. onended fires at the stop time; the replacement oscillator
        // starts at the same `when`, so the handover is sample-continuous.
        const old = osc;
        try {
          old.stop(when);
        } catch {
          /* not started */
        }
        old.onended = () => {
          try {
            old.disconnect();
          } catch {
            /* already gone */
          }
        };
      }
      osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freqOf();
      osc.connect(shaper);
      osc.start(when);
    };

    applyCurve();
    startOsc(0);

    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "amount":
          smooth(amt.gain, v, when);
          break;
        case "rate":
          rateIndex = Math.max(0, Math.min(PUMP_DIVISIONS.length - 1, Math.round(v)));
          if (osc) smooth(osc.frequency, freqOf(), when, 0.05);
          break;
        case "release":
          release = v;
          applyCurve();
          if (keyReleaseParam) keyReleaseParam.setTargetAtTime(releaseMsOf(v) / 1000, when, 0.05);
          else if (smoothLp) smooth(smoothLp.frequency, releaseLpFreq(v), when, 0.05);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);

    return {
      input,
      output,
      // The native key envelope is symmetric (no fast-attack stage) — flag
      // it while a key is wired so the UI stays honest. Oscillator mode and
      // the worklet follower never degrade.
      get degraded() {
        return keySource !== null && !useKeyFollower;
      },
      degradedReason: "Pump key on native envelope — attack follows release",
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      syncBpm(next) {
        bpm = next;
        if (osc) smooth(osc.frequency, freqOf(), ctx.currentTime, 0.05);
      },
      onTransportStarted(time, beatPhase) {
        if (keySource) return; // key owns the groove — no oscillator restart
        const beatSec = 60 / bpm;
        const nextBeat = time + (1 - beatPhase) * beatSec;
        startOsc(nextBeat);
      },
      /**
       * Real sidechain key (kick/buss track via the SOURCE picker). While a
       * key is wired the oscillator stops and the kick's own envelope ducks
       * the target; disconnecting falls back to the beat-synced oscillator.
       */
      setSidechainInput(source: AudioNode | null) {
        if (source === keySource) return;
        if (keySource) {
          try {
            keySource.disconnect(keyInput);
          } catch {
            /* already gone */
          }
          keySource = null;
        }
        if (source) {
          keySource = source;
          stopOsc(ctx.currentTime);
          source.connect(keyInput);
        } else {
          startOsc(ctx.currentTime);
        }
      },
      dispose: () => {
        if (osc) {
          try {
            osc.stop();
          } catch {
            /* not started */
          }
          osc.disconnect();
        }
        if (keySource) {
          try {
            keySource.disconnect(keyInput);
          } catch {
            /* already gone */
          }
          keySource = null;
        }
        input.disconnect();
        output.disconnect();
        target.disconnect();
        shaper.disconnect();
        amt.disconnect();
        inv.disconnect();
        keyFollower?.dispose();
        keyInput.disconnect();
        keyLp?.disconnect();
        rectifier?.disconnect();
        smoothLp?.disconnect();
        sens?.disconnect();
        clampShape?.disconnect();
      },
    };
  },
};

/* ---------------- Distortion ---------------- */
// Harder-hitting waveshaper than Saturation. Cubic clip curve produces more 3rd-order
// harmonic content for a recognisable "distortion" voice; tone stages the high end.

const distortion: EffectDefinition = {
  type: "distortion",
  name: "Distortion",
  category: "character",
  params: distortionParams,
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    // Pre-HPF (see saturation): keeps heavy bass out of the shaper so the
    // distortion generates harmonics of the mids instead of intermod mud.
    const preHP = ctx.createBiquadFilter();
    preHP.type = "highpass";
    preHP.frequency.value = instance.params.preHpfHz ?? 20;
    preHP.Q.value = 0.7;
    const pre = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "4x";
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    const out = ctx.createGain();
    mix.wet.connect(preHP).connect(pre).connect(shaper).connect(tone).connect(out).connect(mix.output);

    let mode = Math.round(instance.params.character ?? 3);
    let driveVal = instance.params.drive ?? 0.4;
    let biasVal = instance.params.bias ?? 0;
    const applyCurve = () => {
      shaper.curve = characterCurve(Math.max(0, Math.min(4, mode)) as CharacterMode, driveVal, biasVal);
    };
    applyCurve();
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "drive":
          driveVal = v;
          applyCurve();
          break;
        case "character":
          mode = Math.round(v);
          applyCurve();
          break;
        case "bias":
          biasVal = v;
          applyCurve();
          break;
        case "tone":
          smooth(tone.frequency, v, when);
          break;
        case "preHpfHz":
          smooth(preHP.frequency, v, when);
          break;
        case "mix":
          mix.setMix(v, when);
          break;
        case "output":
          smooth(out.gain, dbToLin(v), when);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => {
        mix.input.disconnect();
        mix.output.disconnect();
        preHP.disconnect();
        pre.disconnect();
        shaper.disconnect();
        tone.disconnect();
        out.disconnect();
      },
    };
  },
};

/* ---------------- Bitcrusher ---------------- */
// Bit-depth reduction via a stepped WaveShaper curve. `bits` controls the
// number of discrete output levels (2^bits). `downsample` is approximated by
// adjusting the curve's `n` (finer curves for `factor=1` produce the full
// quantised signal; larger factors widen each step, which behaves like a
// quantised ramp) — a coarse but AudioWorklet-free approximation.

const bitcrusher: EffectDefinition = {
  type: "bitcrusher",
  name: "Bitcrusher",
  category: "character",
  params: bitcrusherParams,
  factory(ctx, instance) {
    // Use AudioWorklet when modules are loaded for THIS context (fixes broken
    // downsample). OfflineAudioContexts must load their own modules first —
    // see loadWorkletModules().
    if (isWorkletReady("bitcrusher", ctx)) {
      return createBitcrusherNode(ctx, instance);
    }
    // Fallback: old WaveShaperNode implementation
    const mix = mixBus(ctx);
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "none";
    const out = ctx.createGain();
    mix.wet.connect(shaper).connect(out).connect(mix.output);

    let bitsVal = 8;
    let factorVal = 1;
    const buildCurve = (bits: number, factor: number): Float32Array<ArrayBuffer> => {
      // Curve must be monotonic for WaveShaper; quantise input into discrete
      // steps. n equals the step count so WaveShaper's linear interp between
      // samples doesn't smear the plateau (which would defeat quantisation).
      const steps = Math.max(2, Math.pow(2, Math.max(1, Math.round(bits))));
      const n = steps;
      const curve = new Float32Array(new ArrayBuffer(n * 4));
      const step = 2 / (steps - 1);
      for (let i = 0; i < n; i++) {
        const idx = i;
        const q = -1 + idx * step;
        curve[i] = q;
      }
      // `factor` not used inside the curve math (WaveShaper can't hold a value
      // across samples without a worklet), but we keep it in the closure so
      // the parameter is wired and a future AudioWorklet port can take over.
      void factor;
      return curve;
    };
    shaper.curve = buildCurve(bitsVal, factorVal);

    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "bits":
          bitsVal = Math.max(1, v);
          shaper.curve = buildCurve(bitsVal, factorVal);
          break;
        case "downsample":
          factorVal = Math.max(1, Math.round(v));
          shaper.curve = buildCurve(bitsVal, factorVal);
          break;
        case "mix":
          mix.setMix(v, when);
          break;
        case "output":
          smooth(out.gain, dbToLin(v), when);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      degraded: true,
      degradedReason: "Fallback quality — sample-and-hold downsampling inactive",
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => {
        mix.input.disconnect();
        mix.output.disconnect();
        shaper.disconnect();
        out.disconnect();
      },
    };
  },
};

/* ---------------- Chorus ---------------- */
// Two delay voices in true stereo (worklet); legacy native graph survives as
// the degraded fallback for contexts without AudioWorklet.

function chorusNativeFallback(ctx: BaseAudioContext, instance: EffectInstance): EffectRuntime {
  const mix = mixBus(ctx);
  const delay1 = ctx.createDelay(0.05);
  delay1.delayTime.value = 0.012;
  const delay2 = ctx.createDelay(0.05);
  delay2.delayTime.value = 0.018;
  const lfo1 = ctx.createOscillator();
  lfo1.type = "sine";
  lfo1.frequency.value = 0.6;
  const lfo1Depth = ctx.createGain();
  lfo1Depth.gain.value = 0.004;
  lfo1.connect(lfo1Depth).connect(delay1.delayTime);
  lfo1.start();
  const lfo2 = ctx.createOscillator();
  lfo2.type = "sine";
  lfo2.frequency.value = 0.9;
  const lfo2Depth = ctx.createGain();
  lfo2Depth.gain.value = 0.005;
  lfo2.connect(lfo2Depth).connect(delay2.delayTime);
  lfo2.start();
  const d1Mix = ctx.createGain();
  d1Mix.gain.value = 0.5;
  const d2Mix = ctx.createGain();
  d2Mix.gain.value = 0.5;
  mix.wet.connect(delay1).connect(d1Mix).connect(mix.output);
  mix.wet.connect(delay2).connect(d2Mix).connect(mix.output);
  const out = ctx.createGain();
  mix.output.connect(out);

  const apply = (id: string, v: number, when: number) => {
    switch (id) {
      case "rate": {
        lfo1.frequency.setTargetAtTime(v, when, 0.05);
        // Second LFO is offset for richer movement
        lfo2.frequency.setTargetAtTime(v * 1.4, when, 0.05);
        break;
      }
      case "depth": {
        const d = 0.001 + v * 0.008;
        lfo1Depth.gain.setTargetAtTime(d, when, 0.05);
        lfo2Depth.gain.setTargetAtTime(d * 1.25, when, 0.05);
        break;
      }
      case "mix":
        mix.setMix(v, when);
        break;
      case "output":
        smooth(out.gain, dbToLin(v), when);
        break;
      case "spread":
        break; // worklet-only — no native equivalent, parameter stays stored
    }
  };
  for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
  return {
    input: mix.input,
    output: out,
    degraded: true,
    degradedReason: "AudioWorklet unavailable — Chorus on legacy native graph",
    setParameter: (id, v) => apply(id, v, ctx.currentTime),
    setParameterAt: (id, v, when) => apply(id, v, when),
    syncBpm(bpm) {
      // Snap the LFO to 1/4-beat rate (musical default for chorus motion)
      const beatHz = bpm / 60 / 4;
      lfo1.frequency.setTargetAtTime(beatHz, ctx.currentTime, 0.05);
      lfo2.frequency.setTargetAtTime(beatHz * 1.4, ctx.currentTime, 0.05);
    },
    dispose: () => {
      try {
        lfo1.stop();
      } catch {
        /* not started */
      }
      try {
        lfo2.stop();
      } catch {
        /* not started */
      }
      lfo1.disconnect();
      lfo2.disconnect();
      lfo1Depth.disconnect();
      lfo2Depth.disconnect();
      delay1.disconnect();
      delay2.disconnect();
      d1Mix.disconnect();
      d2Mix.disconnect();
      mix.input.disconnect();
      mix.output.disconnect();
      out.disconnect();
    },
  };
}

const chorus: EffectDefinition = {
  type: "chorus",
  name: "Chorus",
  category: "movement",
  params: chorusParams,
  factory(ctx, instance, env) {
    if (isWorkletReady("chorus", ctx)) return createChorusNode(ctx, instance, env.bpm);
    return chorusNativeFallback(ctx, instance);
  },
};

/* ---------------- Phaser ---------------- */
// Cascade of allpass filters modulated by a single LFO; feedback + dry/wet mix.

const phaser: EffectDefinition = {
  type: "phaser",
  name: "Phaser",
  category: "movement",
  params: phaserParams,
  factory(ctx, instance, env) {
    const mix = mixBus(ctx);
    // TRUE STEREO: two all-pass chains (L / R) with their own oscillators.
    // The R oscillator runs at rate·(1 + 0.03·spread) — a slight detune that
    // makes the L/R notches drift apart over time (classic pseudo-stereo
    // phasing). spread 0 = identical chains = mono.
    const buildStages = (count: number): BiquadFilterNode[] => {
      const stages: BiquadFilterNode[] = [];
      for (let i = 0; i < count; i++) {
        const ap = ctx.createBiquadFilter();
        ap.type = "allpass";
        ap.frequency.value = instance.params.center ?? 800;
        ap.Q.value = 5;
        stages.push(ap);
      }
      for (let i = 0; i < stages.length - 1; i++) {
        stages[i].connect(stages[i + 1]);
      }
      return stages;
    };

    let stageCount =
      PHASER_STAGE_COUNTS[
        Math.max(0, Math.min(PHASER_STAGE_COUNTS.length - 1, Math.round(instance.params.stages ?? 1)))
      ];
    let stagesL = buildStages(stageCount);
    let stagesR = buildStages(stageCount);

    let centerHz = instance.params.center ?? 800;
    let spreadVal = instance.params.spread ?? 0.5;
    let rateHz = instance.params.rate ?? 0.4;

    const oscL = ctx.createOscillator();
    oscL.type = "sine";
    oscL.frequency.value = rateHz;
    const oscR = ctx.createOscillator();
    oscR.type = "sine";
    oscR.frequency.value = rateHz * (1 + 0.03 * spreadVal);
    const depthL = ctx.createGain();
    depthL.gain.value = 600;
    const depthR = ctx.createGain();
    depthR.gain.value = 600;
    oscL.connect(depthL);
    oscR.connect(depthR);
    oscL.start();
    oscR.start();

    const baseL = ctx.createGain();
    const baseR = ctx.createGain();
    baseL.gain.value = centerHz;
    baseR.gain.value = centerHz;

    const wireStages = (): void => {
      for (const g of [baseL, baseR, depthL, depthR]) {
        try {
          g.disconnect();
        } catch {
          /* nothing to disconnect */
        }
      }
      for (const stage of stagesL) {
        baseL.connect(stage.frequency);
        depthL.connect(stage.frequency);
      }
      for (const stage of stagesR) {
        baseR.connect(stage.frequency);
        depthR.connect(stage.frequency);
      }
    };
    wireStages();

    const fbL = ctx.createGain();
    const fbR = ctx.createGain();
    const setFeedback = (v: number, when: number): void => {
      fbL.gain.setTargetAtTime(v, when, 0.05);
      fbR.gain.setTargetAtTime(v, when, 0.05);
    };
    setFeedback(instance.params.feedback ?? 0.3, ctx.currentTime);
    const wetL = ctx.createGain();
    const wetR = ctx.createGain();

    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);

    const connectStages = (): void => {
      try {
        mix.wet.disconnect();
      } catch {
        /* nothing */
      }
      try {
        splitter.disconnect();
      } catch {
        /* nothing */
      }
      try {
        merger.disconnect();
      } catch {
        /* nothing */
      }
      for (const chain of [stagesL, stagesR]) {
        for (const stage of chain) {
          try {
            stage.disconnect();
          } catch {
            /* nothing */
          }
        }
      }
      try {
        fbL.disconnect();
        fbR.disconnect();
        wetL.disconnect();
        wetR.disconnect();
      } catch {
        /* nothing */
      }
      if (stageCount > 0) {
        mix.wet.connect(splitter);
        splitter.connect(stagesL[0], 0);
        splitter.connect(stagesR[0], 1);
        stagesL[stagesL.length - 1].connect(wetL).connect(merger, 0, 0);
        stagesR[stagesR.length - 1].connect(wetR).connect(merger, 0, 1);
        stagesL[stagesL.length - 1].connect(fbL).connect(stagesL[0]);
        stagesR[stagesR.length - 1].connect(fbR).connect(stagesR[0]);
        merger.connect(mix.output);
      } else {
        mix.wet.connect(mix.output);
      }
    };
    connectStages();

    const out = ctx.createGain();
    mix.output.connect(out);

    // C2 tempo-sync: the LFO locks to musical divisions when params.sync is
    // set; OFF keeps the user's Hz knob authoritative. The R oscillator
    // tracks the same writes with the spread detune applied.
    const writeRates = (hz: number, when: number): void => {
      const safe = Math.max(0.05, hz);
      oscL.frequency.setTargetAtTime(safe, when, 0.05);
      oscR.frequency.setTargetAtTime(safe * (1 + 0.03 * spreadVal), when, 0.05);
    };
    const lfoSync = createLfoSyncController({
      rateParamId: "rate",
      defaultRate: 0.4,
      initialRate: rateHz,
      initialSync: instance.params.sync,
      initialBpm: env.bpm,
      write: (_id, hz, when) => writeRates(hz, when ?? ctx.currentTime),
    });

    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "rate":
        case "sync":
          lfoSync.parameter(id, v, when);
          break;
        case "depth":
          depthL.gain.setTargetAtTime(1500 * v, when, 0.05);
          depthR.gain.setTargetAtTime(1500 * v, when, 0.05);
          break;
        case "center":
          centerHz = v;
          baseL.gain.setTargetAtTime(centerHz, when, 0.05);
          baseR.gain.setTargetAtTime(centerHz, when, 0.05);
          break;
        case "spread":
          spreadVal = v;
          writeRates(rateHz, when);
          break;
        case "feedback":
          setFeedback(v, when);
          break;
        case "stages": {
          const idx = Math.max(0, Math.min(PHASER_STAGE_COUNTS.length - 1, Math.round(v)));
          const newCount = PHASER_STAGE_COUNTS[idx];
          if (newCount === stageCount) return;
          stageCount = newCount;
          stagesL = buildStages(stageCount);
          stagesR = buildStages(stageCount);
          wireStages();
          connectStages();
          break;
        }
        case "mix":
          mix.setMix(v, when);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: out,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      syncBpm: (nextBpm) => lfoSync.syncBpm(nextBpm, ctx.currentTime),
      dispose: () => {
        try {
          oscL.stop();
        } catch {
          /* not started */
        }
        try {
          oscR.stop();
        } catch {
          /* not started */
        }
        oscL.disconnect();
        oscR.disconnect();
        depthL.disconnect();
        depthR.disconnect();
        baseL.disconnect();
        baseR.disconnect();
        fbL.disconnect();
        fbR.disconnect();
        wetL.disconnect();
        wetR.disconnect();
        splitter.disconnect();
        merger.disconnect();
        for (const chain of [stagesL, stagesR]) {
          for (const stage of chain) {
            try {
              stage.disconnect();
            } catch {
              /* already */
            }
          }
        }
        mix.input.disconnect();
        mix.output.disconnect();
        out.disconnect();
      },
    };
  },
};

// Ducks the main signal's gain based on the envelope of a separate audio source.
// Web Audio's DynamicsCompressorNode has no sidechain input, and ScriptProcessorNode
// is unreliable in OfflineAudioContext (which is what offline render + our
// browser-checks use). So we route the sidechain source through an AnalyserNode
// and run a JS-side envelope follower that writes `target.gain` via
// `setTargetAtTime`. This works in both realtime and offline contexts; the
// analysis is main-thread, not audio-rate, so ducking granularity is bounded
// by the JS timer — fine for musical sidechain but not for sub-10 ms precision.

const SIDE_UPDATE_MS = 10; // envelope refresh interval

const sidechain: EffectDefinition = {
  type: "sidechain",
  name: "Sidechain",
  category: "dynamics",
  params: sidechainParams,
  factory(ctx, instance) {
    // Use AudioWorklet when modules are loaded for THIS context (audio-rate
    // envelope, offline-safe)
    if (isWorkletReady("sidechain", ctx)) {
      return createSidechainNode(ctx, instance);
    }
    // Fallback: old setInterval + AnalyserNode implementation
    const input = ctx.createGain();
    const output = ctx.createGain();
    const target = ctx.createGain();
    target.gain.value = 1;
    input.connect(target).connect(output);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    const analyserBuf = new Float32Array(analyser.fftSize);

    let env = 0;
    let thresholdLin = Math.pow(10, -18 / 20);
    let ratio = 4;
    let amount = 1;
    let attackCoef = Math.exp(-1 / (ctx.sampleRate * 0.005));
    let releaseCoef = Math.exp(-1 / (ctx.sampleRate * 0.2));
    let sidechainNode: AudioNode | null = null;
    let active = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    const computeTargetGain = (): number => {
      if (sidechainNode === null) return 1;
      // Read current peak from the analyser buffer.
      analyser.getFloatTimeDomainData(analyserBuf);
      let peak = 0;
      for (let i = 0; i < analyserBuf.length; i++) {
        const v = Math.abs(analyserBuf[i]);
        if (v > peak) peak = v;
      }
      // Asymmetric envelope follower
      env = peak > env ? attackCoef * env + (1 - attackCoef) * peak : releaseCoef * env + (1 - releaseCoef) * peak;
      const envDb = 20 * Math.log10(Math.max(env, 1e-7));
      const threshDb = 20 * Math.log10(Math.max(thresholdLin, 1e-7));
      const overDb = Math.max(0, envDb - threshDb);
      const reductionDb = overDb * (1 - 1 / Math.max(1, ratio));
      const reduction = Math.pow(10, -reductionDb / 20);
      return Math.max(0, 1 - amount * (1 - reduction));
    };

    const tick = () => {
      if (!active) return;
      const g = computeTargetGain();
      target.gain.setTargetAtTime(g, ctx.currentTime, 0.005);
    };
    if (typeof setInterval === "function") {
      interval = setInterval(tick, SIDE_UPDATE_MS);
    }

    const apply = (id: string, v: number, _when: number) => {
      switch (id) {
        case "threshold":
          thresholdLin = Math.pow(10, v / 20);
          break;
        case "ratio":
          ratio = v;
          break;
        case "attack":
          attackCoef = Math.exp(-1 / (ctx.sampleRate * Math.max(0.001, v)));
          break;
        case "release":
          releaseCoef = Math.exp(-1 / (ctx.sampleRate * Math.max(0.001, v)));
          break;
        case "amount":
          amount = v;
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);

    return {
      input,
      output,
      degraded: true,
      degradedReason: "Fallback — 100 Hz envelope ducking (inactive in offline renders)",
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      setSidechainInput(node: AudioNode | null) {
        if (sidechainNode === node) return;
        if (sidechainNode) {
          try {
            sidechainNode.disconnect(analyser);
          } catch {
            /* not connected */
          }
        }
        sidechainNode = node;
        if (node) {
          env = 0;
          node.connect(analyser);
        } else {
          // When sidechain is removed, restore the target gain to neutral.
          target.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
        }
      },
      dispose: () => {
        active = false;
        if (interval !== null) {
          clearInterval(interval);
          interval = null;
        }
        if (sidechainNode) {
          try {
            sidechainNode.disconnect(analyser);
          } catch {
            /* not connected */
          }
          sidechainNode = null;
        }
        try {
          analyser.disconnect();
        } catch {
          /* already disconnected */
        }
        input.disconnect();
        target.disconnect();
        output.disconnect();
      },
    };
  },
};

/* ---------------- Core dynamics and utility ---------------- */

function createWorkletRuntime(
  ctx: BaseAudioContext,
  instance: EffectInstance,
  processor: "transient-processor" | "gate-processor",
  readyType: "transient" | "gate",
): EffectRuntime | null {
  if (!isWorkletReady(readyType, ctx)) return null;
  const node = new AudioWorkletNode(ctx, processor, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
  });
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);
  // The gate reports its look-ahead delay once at construction (transient
  // never posts) — surface it so the engine's PDC keeps tracks aligned.
  let latencySamples = 0;
  const latencyListeners = new Set<() => void>();
  node.port.onmessage = (event: MessageEvent<{ type?: string; samples?: number }>) => {
    const msg = event.data;
    if (msg?.type === "latency" && typeof msg.samples === "number") {
      latencySamples = msg.samples;
      for (const listener of latencyListeners) listener();
    }
  };
  const apply = (id: string, value: number, when: number) => {
    const param = node.parameters.get(id);
    if (param) param.setValueAtTime(value, when);
  };
  for (const [id, value] of Object.entries(instance.params)) apply(id, value, ctx.currentTime);
  return {
    input,
    output,
    getLatencySec: () => latencySamples / ctx.sampleRate,
    onLatencyChange(listener: () => void) {
      latencyListeners.add(listener);
      return () => {
        latencyListeners.delete(listener);
      };
    },
    setParameter: (id, value) => apply(id, value, ctx.currentTime),
    setParameterAt: apply,
    dispose: () => {
      node.port.onmessage = null;
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

const transient: EffectDefinition = {
  type: "transient",
  name: "Transient Shaper",
  category: "dynamics",
  params: transientParams,
  factory(ctx, instance) {
    const worklet = createWorkletRuntime(ctx, instance, "transient-processor", "transient");
    if (worklet) return worklet;
    // Transparent 1:1 bypass when AudioWorklet is unavailable — never silence,
    // always flagged so the UI can warn (see effectProcessorStatus).
    return bypassRuntime(ctx, "AudioWorklet unavailable — transient shaper bypassed (1:1 signal)");
  },
};

const gate: EffectDefinition = {
  type: "gate",
  name: "Gate",
  category: "dynamics",
  params: gateParams,
  factory(ctx, instance) {
    const worklet = createWorkletRuntime(ctx, instance, "gate-processor", "gate");
    if (worklet) return worklet;
    // Transparent 1:1 bypass fallback — the gate never silently stops gating
    // without the UI knowing (degraded flag → warning badge).
    return bypassRuntime(ctx, "AudioWorklet unavailable — gate bypassed (1:1 signal)");
  },
};

/* ---------------- Shimmer / Chime Exciter (universal instrument modifier) ---------------- */
// Universal "plugin" modifier for any instrument: HP exciter + shimmer tail.
// Use as track effect on any instrument bus — adds icy brightness without new kind.

const shimmer: EffectDefinition = {
  type: "shimmer",
  name: "Shimmer",
  category: "character",
  params: shimmerParams,
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2200 + (instance.params.tone ?? 0.5) * 7800;
    hp.Q.value = 0.7;
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "4x";
    const buildCurve = (drive: number) => {
      const k = 1 + drive * 10;
      const n = 1024;
      const c = new Float32Array(new ArrayBuffer(n * 4));
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = Math.tanh(x * k) * (1 - drive * 0.15) + x * drive * 0.15;
      }
      return c;
    };
    shaper.curve = buildCurve(instance.params.amount ?? 0.35);
    const exciteGain = ctx.createGain();
    exciteGain.gain.value = 0.7 + (instance.params.amount ?? 0.35) * 0.6;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.11;
    const fb = ctx.createGain();
    fb.gain.value = (instance.params.decay ?? 0.35) * 0.55;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 5200 + (instance.params.tone ?? 0.5) * 3000;
    // Pitch-shifted shimmer voice: a +12 (default) copy of the exciter feeds
    // the delay loop, so the SHIFTED tail recirculates — the defining
    // shimmer sound. Reuses the always-loaded pitchshift worklet (COLA
    // granular engine); without the worklet the effect degrades to the
    // plain exciter+tail, never to silence.
    let shiftNode: ReturnType<typeof createPitchShiftNode> | null = null;
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = instance.params.shimmer ?? 0.6;
    if (isWorkletReady("pitchShift", ctx)) {
      shiftNode = createPitchShiftNode(ctx, {
        id: instance.id ? `${instance.id}:shimmer` : "shimmer-voice",
        params: {
          semitones: instance.params.shift ?? 12,
          grainMs: 45,
          width: 0.4,
          mix: 1,
        },
      });
      exciteGain.connect(shiftNode.input);
      shiftNode.output.connect(shimmerGain).connect(delay);
    }
    // Chain: wet -> hp -> shaper -> exciteGain -> delay -> lp -> feedback -> delay loop
    // Wet tap to output: lp feeds back to mix output via wet path
    mix.wet.connect(hp).connect(shaper).connect(exciteGain).connect(delay);
    delay.connect(lp).connect(fb).connect(delay);
    // shimmer tail + direct exciter both feed wet path's output
    // mixBus: wet node will be summed to output via its internal dry/wet gains — we wire lp to mix output via wet
    lp.connect(mix.output);
    exciteGain.connect(mix.output);
    mix.setMix(instance.params.mix ?? 0.4, ctx.currentTime);

    return {
      input: mix.input,
      output: mix.output,
      setParameter(id: string, value: number) {
        switch (id) {
          case "amount":
            shaper.curve = buildCurve(value);
            exciteGain.gain.setTargetAtTime(0.7 + value * 0.6, ctx.currentTime, 0.02);
            break;
          case "tone":
            hp.frequency.setTargetAtTime(2200 + value * 7800, ctx.currentTime, 0.02);
            lp.frequency.setTargetAtTime(5200 + value * 3000, ctx.currentTime, 0.02);
            break;
          case "decay":
            fb.gain.setTargetAtTime(value * 0.55, ctx.currentTime, 0.02);
            break;
          case "shift":
            shiftNode?.setParameter("semitones", value);
            break;
          case "shimmer":
            shimmerGain.gain.setTargetAtTime(value, ctx.currentTime, 0.03);
            break;
          case "mix":
            mix.setMix(value, ctx.currentTime);
            break;
        }
      },
      setParameterAt(id: string, value: number, when: number) {
        switch (id) {
          case "amount":
            shaper.curve = buildCurve(value);
            exciteGain.gain.setValueAtTime(0.7 + value * 0.6, when);
            break;
          case "tone":
            hp.frequency.setValueAtTime(2200 + value * 7800, when);
            lp.frequency.setValueAtTime(5200 + value * 3000, when);
            break;
          case "decay":
            fb.gain.setValueAtTime(value * 0.55, when);
            break;
          case "shift":
            shiftNode?.setParameterAt?.("semitones", value, when);
            break;
          case "shimmer":
            shimmerGain.gain.setValueAtTime(value, when);
            break;
          case "mix":
            mix.setMix(value, when);
            break;
        }
      },
      dispose() {
        try {
          mix.input.disconnect();
        } catch {}
        try {
          mix.output.disconnect();
        } catch {}
        try {
          hp.disconnect();
        } catch {}
        try {
          shaper.disconnect();
        } catch {}
        try {
          delay.disconnect();
        } catch {}
        // The delay→lp→fb→delay feedback loop and the exciter feed must also
        // be severed — every other factory releases its full subgraph.
        try {
          lp.disconnect();
        } catch {}
        try {
          fb.disconnect();
        } catch {}
        try {
          exciteGain.disconnect();
        } catch {}
        try {
          shimmerGain.disconnect();
        } catch {}
        try {
          shiftNode?.dispose();
        } catch {}
      },
    };
  },
};

/* ---------------- FXEQ Multiband (VocalForge plugin, vendored DSP oracle) ---------------- */
// Multiband crossover (2-6 bands, LR4) feeding per-band Sat/LoFi/Mod/Delay/Rev
// chains with a final limiter. DSP runs in an AudioWorklet (vendored core is
// bit-exact with the VocalForge golden fixtures — tests/fxeq-golden.test.ts).
// The rack exposes the top-level surface; per-band editing lands with the
// EQ-paint panel.

const fxeq: EffectDefinition = {
  type: "fxeq",
  name: "PRISM",
  category: "character",
  params: fxeqParams,
  factory(ctx, instance, env) {
    // Worklet DSP when the module loaded for THIS context (offline renders
    // load it too); transparent degraded bypass otherwise — fxeq has no
    // meaningful main-thread fallback, and silence-in-waiting is worse than
    // an honest badge.
    if (isWorkletReady("fxeq", ctx)) {
      return createFxEqNode(ctx, instance, FXEQ_PARAM_DEFAULTS, env?.seed);
    }
    return bypassRuntime(ctx, "AudioWorklet unavailable — PRISM bypassed (1:1 signal)");
  },
};

/* ---------------- Ultina (VocalForge plugin, vendored DSP oracle) ---------------- */
// Neutron-class modular mixing suite: EQ, Comp, Gate, Exciter, Transient,
// Clipper, Density, Sculptor, Phase, Unmask + LUFS/autogain. DSP runs in an
// AudioWorklet (vendored core is bit-exact with the VocalForge vectors —
// tests/ultina-vectors.test.ts). The rack exposes the global surface and
// quick module toggles; per-module editing lands with the Ultina panel.

const ultina: EffectDefinition = {
  type: "ultina",
  name: "VLYX",
  category: "dynamics",
  params: ultinaParams,
  factory(ctx, instance) {
    if (isWorkletReady("ultina", ctx)) {
      return createUltinaNode(ctx, instance, ULTINA_PARAM_DEFAULTS);
    }
    return bypassRuntime(ctx, "AudioWorklet unavailable — VLYX bypassed (1:1 signal)");
  },
};
/* ---------------- Ozvena (VocalForge plugin, vendored DSP oracle) ---------------- */
// Neoverb-class three-engine reverb: E1 Reflections, E2 Plate/Chamber,
// E3 Hall + pre-delay/pre-EQ/reverb-EQ/mod/duck/safety limiter. DSP runs in
// an AudioWorklet (vendored core parity-checked via tests/ozvena-golden.test.ts).
// The rack exposes the global surface + blend pad + engine toggles; the
// XY Blend Pad canvas lands with the Ozvena panel.

const OZVENA_PARAM_DEFAULTS: Record<string, number> = {
  "global.inputGainDb": 0,
  "global.dryWet": 25,
  "global.outputGainDb": 0,
  "blendPad.x": 0.5,
  "blendPad.y": 0.5,
  "engines.e1.enabled": 1,
  "engines.e2.enabled": 1,
  "engines.e3.enabled": 1,
  // CPU lever: eco drops the safety limiter to 1× oversampling and the FDN
  // shimmer to a single grain — the cheapest way to run several Ozvenas in
  // one rack. Mapped to the string enum inside the worklet entry.
  "global.quality": 1,
};

/**
 * Ozvena's editor uses dotted paths into its canonical state tree. Keep the
 * key catalog next to the default state so A/B snapshots and project loads
 * can reject stale/corrupt paths before they reach the AudioWorklet.
 */

// Only audio state belongs in the effect's param map. `schemaVersion`, the
// assistant wizard and analyzer bookkeeping are serialized state metadata,
// not DSP controls and must not become automatable target ids by accident.

const ozvena: EffectDefinition = {
  type: "ozvena",
  name: "VØID",
  category: "space",
  params: ozvenaParams,
  factory(ctx, instance, env) {
    if (isWorkletReady("ozvena", ctx)) {
      // Initial BPM seeds the tempo-synced pre-delay so the first block
      // already matches the project tempo (syncBpm keeps it live after).
      return createOzvenaNode(ctx, instance, OZVENA_PARAM_DEFAULTS, env?.bpm ?? 120);
    }
    return bypassRuntime(ctx, "AudioWorklet unavailable — VØID bypassed (1:1 signal)");
  },
};

/* ---------------- MORPH DYNAMICS (dynamics-driven morph processor) ----------------
 * "Your sound becomes the modulator": transient/body/texture analysis becomes
 * the control system driving dynamics, character, motion and space. PRESSURE
 * is the signature macro — the depth of reactive transformation. DSP runs in
 * an AudioWorklet (first-party morph-dynamics-core; see the plugin docs in
 * src/effects/morph-dynamics/*.md and tests/morph-dynamics-*.test.ts). The
 * rack exposes the six macros; the full engine (dynamics, stages, mod matrix)
 * lives in the MORPH panel.
 */

const morphdynamics: EffectDefinition = {
  type: "morphdynamics",
  name: "MORPH",
  category: "dynamics",
  params: morphdynamicsParams,
  factory(ctx, instance) {
    if (isWorkletReady("morphdynamics", ctx)) {
      return createMorphDynamicsNode(ctx, instance, MORPH_PARAM_DEFAULTS);
    }
    return bypassRuntime(ctx, "AudioWorklet unavailable — MORPH bypassed (1:1 signal)");
  },
};

function bussCurve(drive: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(2048 * 4));
  const k = 1 + drive * 18;
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k);
  }
  return curve;
}

/* ---------------- Drum / Bass Buss glue ---------------- */
// Both busses drive their glue through the custom compressor worklet
// (per-sample PEAK/RMS detector, soft-knee, SC HPF) when the core bundle is
// loaded, and fall back to the legacy DynamicsCompressorNode mapping
// otherwise. Saturation runs 4× oversampled in both paths.

interface BussCompStage {
  input: AudioNode;
  output: AudioNode;
  applyComp: (kind: "threshold" | "ratio" | "attack" | "release", v: number, when: number) => void;
  getGr: () => number;
  native: boolean;
  dispose: () => void;
}

function createBussComp(
  ctx: BaseAudioContext,
  seed: { threshold: number; ratio: number; attack: number; release: number; detector: number },
): BussCompStage {
  if (isWorkletReady("compressor", ctx)) {
    const rt = createCompressorNode(ctx, {
      params: {
        threshold: seed.threshold,
        ratio: seed.ratio,
        attack: seed.attack,
        release: seed.release,
        knee: 6,
        detector: seed.detector,
        scHpf: 20,
        makeup: 0,
        mix: 1,
      },
    });
    return {
      input: rt.input,
      output: rt.output,
      applyComp: (kind, v, when) => rt.setParameterAt?.(kind, v, when),
      getGr: () => rt.getGainReductionDb?.() ?? 0,
      native: false,
      dispose: () => rt.dispose(),
    };
  }
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = seed.threshold;
  comp.ratio.value = seed.ratio;
  comp.attack.value = seed.attack;
  comp.release.value = seed.release;
  comp.knee.value = 6;
  const applyComp: BussCompStage["applyComp"] = (kind, v, when) => {
    switch (kind) {
      case "threshold":
        smooth(comp.threshold, v, when);
        break;
      case "ratio":
        smooth(comp.ratio, v, when);
        break;
      case "attack":
        smooth(comp.attack, v, when);
        break;
      case "release":
        smooth(comp.release, v, when);
        break;
    }
  };
  const getGr = () => {
    const raw = (comp as unknown as { reduction?: number | { value: number } }).reduction;
    const value =
      typeof raw === "number" ? raw : typeof raw === "object" && raw && typeof raw.value === "number" ? raw.value : 0;
    return Math.max(0, Number.isFinite(value) ? -value : 0);
  };
  return {
    input: comp,
    output: comp,
    applyComp,
    getGr,
    native: true,
    dispose: () => comp.disconnect(),
  };
}

const drumBuss: EffectDefinition = {
  type: "drumBuss",
  name: "Drum Buss",
  category: "character",
  params: drumBussParams,
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "4x";
    // REAL transient stage: a transient-processor worklet between the shaper
    // and the glue comp — the TRANSIENT knob now drives its attack/sustain
    // (0–50% tames sustain, 50–100% boosts attack) in addition to nudging
    // the comp attack, instead of only nudging comp attack.
    const transientNode = isWorkletReady("transient", ctx)
      ? new AudioWorkletNode(ctx, "transient-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
        })
      : null;
    const applyTransient = (value: number, when: number): void => {
      if (!transientNode) return;
      const t = Math.max(0, Math.min(1, value));
      // 0..0.5 → attack −1..0 (soften), 0.5..1 → attack 0..+1 (boost).
      const attackAmt = t < 0.5 ? t * 2 - 1 : (t - 0.5) * 2;
      const write = (id: string, v: number): void => {
        const param = transientNode.parameters.get(id);
        if (param && Number.isFinite(v)) param.setValueAtTime(v, when);
      };
      write("attack", attackAmt);
      write("sustain", t < 0.5 ? -t * 2 * 0.6 : 0);
      write("mix", 1);
    };
    // Glue through the custom worklet compressor (PEAK detector grabs drum
    // transients); legacy DCN mapping when the core bundle is missing.
    const glue = createBussComp(ctx, {
      threshold: -6 - (instance.params.compressor ?? 0.25) * 34,
      ratio: 1 + (instance.params.compressor ?? 0.25) * 9,
      attack: Math.max(0.001, 0.02 - (instance.params.transient ?? 0.15) * 0.015),
      release: 0.12,
      detector: 1,
    });
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    const boom = ctx.createBiquadFilter();
    boom.type = "lowshelf";
    const out = ctx.createGain();
    mix.wet.connect(shaper);
    if (transientNode) {
      shaper.connect(transientNode).connect(glue.input);
    } else {
      shaper.connect(glue.input);
    }
    glue.output.connect(tone).connect(boom).connect(out).connect(mix.output);
    const apply = (id: string, value: number, when: number) => {
      switch (id) {
        case "drive":
          shaper.curve = bussCurve(value);
          break;
        case "transient":
          applyTransient(value, when);
          glue.applyComp("attack", Math.max(0.001, 0.02 - value * 0.015), when);
          break;
        case "compressor":
          glue.applyComp("threshold", -6 - value * 34, when);
          glue.applyComp("ratio", 1 + value * 9, when);
          break;
        case "tone":
          smooth(tone.frequency, value, when);
          break;
        case "boomFrequency":
          smooth(boom.frequency, value, when);
          break;
        case "boomAmount":
          smooth(boom.gain, value * 8, when);
          break;
        case "mix":
          mix.setMix(value, when);
          break;
        case "output":
          smooth(out.gain, dbToLin(value), when);
          break;
      }
    };
    if (transientNode) applyTransient(instance.params.transient ?? 0.15, ctx.currentTime);
    for (const [id, value] of Object.entries(instance.params)) apply(id, value, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      ...(glue.native
        ? { degraded: true as const, degradedReason: "Buss compressor on native fallback — glue approximate" }
        : {}),
      setParameter: (id, value) => apply(id, value, ctx.currentTime),
      setParameterAt: (id, value, when) => apply(id, value, when),
      getGainReductionDb: () => glue.getGr(),
      dispose: () => {
        mix.input.disconnect();
        mix.output.disconnect();
        shaper.disconnect();
        transientNode?.disconnect();
        glue.dispose();
        tone.disconnect();
        boom.disconnect();
        out.disconnect();
      },
    };
  },
};

const bassBuss: EffectDefinition = {
  type: "bassBuss",
  name: "Bass Buss",
  category: "character",
  params: bassBussParams,
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "4x";
    // Glue through the custom worklet compressor (RMS detector for smooth
    // bass leveling); legacy DCN mapping when the core bundle is missing.
    const glue = createBussComp(ctx, {
      threshold: -8 - (instance.params.compression ?? 0.25) * 32,
      ratio: 1 + (instance.params.compression ?? 0.25) * 7,
      attack: instance.params.attack ?? 0.01,
      release: instance.params.release ?? 0.18,
      detector: 0,
    });
    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    const out = ctx.createGain();
    // Mono-bass crossover: below MONO BASS the summed (L+R)/2 lows feed BOTH
    // outputs — a true mono sub — while highs keep their stereo placement.
    // monoBassFrequency ≤ 0 routes everything through the untouched direct
    // path (the crossover idles at 20 Hz).
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const hpL = ctx.createBiquadFilter();
    const hpR = ctx.createBiquadFilter();
    const lpL = ctx.createBiquadFilter();
    const lpR = ctx.createBiquadFilter();
    hpL.type = "highpass";
    hpR.type = "highpass";
    lpL.type = "lowpass";
    lpR.type = "lowpass";
    hpL.frequency.value = 20;
    hpR.frequency.value = 20;
    lpL.frequency.value = 20;
    lpR.frequency.value = 20;
    const monoSum = ctx.createGain();
    monoSum.gain.value = 0;
    const crossoverGain = ctx.createGain();
    crossoverGain.gain.value = 0;
    const directGain = ctx.createGain();
    directGain.gain.value = 1;
    // Sub-octave voice: a ÷2 zero-crossing divider off the (already low)
    // shaper output — the generated sub joins AFTER the drive but BEFORE the
    // glue comp, so it gets leveled with everything else. Rides the
    // always-loaded core bundle (bassbuss-sub-processor).
    let subOsc: AudioWorkletNode | null = null;
    const subGain = ctx.createGain();
    const subAmount = instance.params.subOsc ?? 0;
    subGain.gain.value = subAmount * 0.7;
    if (isWorkletReady("bitcrusher", ctx)) {
      subOsc = new AudioWorkletNode(ctx, "bassbuss-sub-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelInterpretation: "speakers",
      });
      subOsc.port.postMessage({ type: "amount", value: subAmount });
      low.connect(subOsc);
      subOsc.connect(subGain).connect(out);
    }
    mix.wet.connect(shaper);
    shaper.connect(glue.input);
    glue.output.connect(low).connect(out);
    out.connect(directGain).connect(mix.output);
    // Upmix before the split: with a mono source the whole chain up to `out`
    // is 1-channel, and a bare splitter would leave the right leg's high band
    // silent (only the summed lows would reach it).
    const upmixIn = stereoUpmix(ctx);
    out.connect(upmixIn).connect(splitter);
    splitter.connect(hpL, 0);
    splitter.connect(hpR, 1);
    splitter.connect(lpL, 0);
    splitter.connect(lpR, 1);
    lpL.connect(monoSum);
    lpR.connect(monoSum);
    monoSum.connect(merger, 0, 0);
    monoSum.connect(merger, 0, 1);
    hpL.connect(merger, 0, 0);
    hpR.connect(merger, 0, 1);
    merger.connect(crossoverGain).connect(mix.output);
    const apply = (id: string, value: number, when: number) => {
      switch (id) {
        case "drive":
          shaper.curve = bussCurve(value);
          break;
        case "subEnhance":
          smooth(low.gain, value * 8, when);
          break;
        case "subOsc":
          subOsc?.port.postMessage({ type: "amount", value });
          subGain.gain.setTargetAtTime(value * 0.7, when, 0.05);
          break;
        case "subFrequency":
          smooth(low.frequency, value, when);
          break;
        case "compression":
          glue.applyComp("threshold", -8 - value * 32, when);
          glue.applyComp("ratio", 1 + value * 7, when);
          break;
        case "attack":
          glue.applyComp("attack", value, when);
          break;
        case "release":
          glue.applyComp("release", value, when);
          break;
        case "monoBassFrequency": {
          const active = value > 0;
          const frequency = Math.max(20, value || 20);
          smooth(hpL.frequency, frequency, when);
          smooth(hpR.frequency, frequency, when);
          smooth(lpL.frequency, frequency, when);
          smooth(lpR.frequency, frequency, when);
          smooth(monoSum.gain, active ? 0.5 : 0, when);
          smooth(crossoverGain.gain, active ? 1 : 0, when);
          smooth(directGain.gain, active ? 0 : 1, when);
          break;
        }
        case "mix":
          mix.setMix(value, when);
          break;
        case "output":
          smooth(out.gain, dbToLin(value), when);
          break;
      }
    };
    for (const [id, value] of Object.entries(instance.params)) apply(id, value, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      ...(glue.native
        ? { degraded: true as const, degradedReason: "Buss compressor on native fallback — glue approximate" }
        : {}),
      setParameter: (id, value) => apply(id, value, ctx.currentTime),
      setParameterAt: (id, value, when) => apply(id, value, when),
      getGainReductionDb: () => glue.getGr(),
      dispose: () => {
        mix.input.disconnect();
        mix.output.disconnect();
        shaper.disconnect();
        glue.dispose();
        low.disconnect();
        out.disconnect();
        upmixIn.disconnect();
        splitter.disconnect();
        merger.disconnect();
        hpL.disconnect();
        hpR.disconnect();
        lpL.disconnect();
        lpR.disconnect();
        monoSum.disconnect();
        crossoverGain.disconnect();
        directGain.disconnect();
        if (subOsc) subOsc.disconnect();
        subGain.disconnect();
      },
    };
  },
};

const utility: EffectDefinition = {
  type: "utility",
  name: "Utility",
  category: "tone",
  params: utilityParams,
  factory(ctx, instance) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const left = ctx.createGain();
    const right = ctx.createGain();
    const crossLeft = ctx.createGain();
    const crossRight = ctx.createGain();
    const highLeft = ctx.createBiquadFilter();
    const highRight = ctx.createBiquadFilter();
    const lowLeft = ctx.createBiquadFilter();
    const lowRight = ctx.createBiquadFilter();
    highLeft.type = "highpass";
    highRight.type = "highpass";
    lowLeft.type = "lowpass";
    lowRight.type = "lowpass";
    const monoLeft = ctx.createGain();
    const monoRight = ctx.createGain();
    // Upmix mono→stereo first: a bare splitter fed a mono source reports
    // channel 1 as silence, so the whole right side (and with it pan/width)
    // died for mono tracks.
    const upmixIn = stereoUpmix(ctx);
    input.connect(upmixIn).connect(splitter);
    splitter.connect(highLeft, 0);
    splitter.connect(highRight, 1);
    highLeft.connect(left).connect(merger, 0, 0);
    highRight.connect(right).connect(merger, 0, 1);
    highLeft.connect(crossLeft).connect(merger, 0, 1);
    highRight.connect(crossRight).connect(merger, 0, 0);
    // True mono low band: (L + R) × 0.5 feeds BOTH outputs. The previous
    // wiring kept the lows per-channel (attenuated but still stereo), so the
    // "MONO BASS" control never actually mono-ed anything.
    splitter.connect(lowLeft, 0).connect(monoLeft);
    splitter.connect(lowRight, 1).connect(monoRight);
    monoLeft.connect(merger, 0, 0);
    monoLeft.connect(merger, 0, 1);
    monoRight.connect(merger, 0, 0);
    monoRight.connect(merger, 0, 1);
    const pan = ctx.createStereoPanner();
    merger.connect(pan).connect(output);
    let widthValue = instance.params.width ?? 1;
    let phaseLeft = instance.params.phaseLeft === 1;
    let phaseRight = instance.params.phaseRight === 1;
    const applyWidth = (when: number) => {
      const width = Math.max(0, Math.min(2, widthValue));
      smooth(left.gain, ((1 + width) / 2) * (phaseLeft ? -1 : 1), when);
      smooth(right.gain, ((1 + width) / 2) * (phaseRight ? -1 : 1), when);
      smooth(crossLeft.gain, (1 - width) / 2, when);
      smooth(crossRight.gain, (1 - width) / 2, when);
    };
    const apply = (id: string, value: number, when: number) => {
      switch (id) {
        case "gain":
          smooth(output.gain, dbToLin(value), when);
          break;
        case "pan":
          smooth(pan.pan, value, when);
          break;
        case "width": {
          widthValue = value;
          applyWidth(when);
          break;
        }
        case "phaseLeft":
          phaseLeft = value >= 0.5;
          applyWidth(when);
          break;
        case "phaseRight":
          phaseRight = value >= 0.5;
          applyWidth(when);
          break;
        case "monoBassFrequency": {
          const frequency = Math.max(20, value || 20);
          smooth(highLeft.frequency, frequency, when);
          smooth(highRight.frequency, frequency, when);
          smooth(lowLeft.frequency, frequency, when);
          smooth(lowRight.frequency, frequency, when);
          const active = value > 0 ? 0.5 : 0;
          smooth(monoLeft.gain, active, when);
          smooth(monoRight.gain, active, when);
          break;
        }
      }
    };
    for (const [id, value] of Object.entries(instance.params)) apply(id, value, ctx.currentTime);
    return {
      input,
      output,
      setParameter: (id, value) => apply(id, value, ctx.currentTime),
      setParameterAt: (id, value, when) => apply(id, value, when),
      dispose: () => {
        input.disconnect();
        output.disconnect();
        upmixIn.disconnect();
        splitter.disconnect();
        merger.disconnect();
        left.disconnect();
        right.disconnect();
        crossLeft.disconnect();
        crossRight.disconnect();
        highLeft.disconnect();
        highRight.disconnect();
        lowLeft.disconnect();
        lowRight.disconnect();
        monoLeft.disconnect();
        monoRight.disconnect();
        pan.disconnect();
      },
    };
  },
};

/* ---------------- Look-ahead Limiter ---------------- */
// True brickwall limiting: a monotonic max-deque over the look-ahead window
// lets gain changes precede transients, so peaks never exceed CEILING (unlike
// the native master DynamicsCompressorNode with its 2 ms attack). Latency =
// exactly LOOKAHEAD — reported via getLatencySec and compensated by the
// engine's PDC. LOOKAHEAD defaults to 5 ms; drop it to 1 ms for insert use on
// individual tracks where minimal latency matters more than anticipation.

const limiter: EffectDefinition = {
  type: "limiter",
  name: "Limiter",
  category: "dynamics",
  params: limiterParams,
  factory(ctx, instance) {
    if (isWorkletReady("limiter", ctx)) return createLimiterNode(ctx, instance);
    // Transparent 1:1 bypass fallback — never fake-limit, always warn.
    return bypassRuntime(ctx, "AudioWorklet unavailable — limiter bypassed (1:1 signal)");
  },
};

/* ---------------- Step Gate (trance gate) ---------------- */
// Rhythmically gates the input on an editable 8/16/32-step pattern, synced to
// the transport grid via syncBpm/onTransportStarted (same hooks as Pump).
// Zero latency, deterministic offline (default anchor phase 0 @ time 0).
// The pattern lives on EffectInstance.steps (8/16/32 × 0..1 open amounts).

const stepGate: EffectDefinition = {
  type: "stepGate",
  name: "Step Gate",
  category: "movement",
  params: stepGateParams,
  factory(ctx, instance) {
    if (isWorkletReady("stepGate", ctx)) {
      const handle = createStepGateNode(ctx, instance);
      if (instance.steps && instance.steps.length > 0) handle.setPattern(instance.steps);
      return {
        input: handle.input,
        output: handle.output,
        setParameter: handle.setParameter,
        setParameterAt: handle.setParameterAt,
        syncBpm: handle.syncBpm,
        onTransportStarted: handle.onTransportStarted,
        dispose: handle.dispose,
      };
    }
    // Transparent 1:1 bypass fallback — a gate that doesn't gate silently
    // would be worse than no gate; the UI shows the warning badge.
    return bypassRuntime(ctx, "AudioWorklet unavailable — step gate bypassed (1:1 signal)");
  },
};

/* ---------------- SV Filter (TPT SVF) ---------------- */
// Zero-delay topology-preserving state variable filter (Andy Simper).
// LP/HP/BP/Notch modes, resonance up to self-oscillation, tanh drive.
// Unlike BiquadFilterNode, the feedback path has NO one-sample delay —
// modulated cutoff stays clean and the resonance behaviour is analog-like.

const svFilter: EffectDefinition = {
  type: "svFilter",
  name: "SV Filter",
  category: "tone",
  params: svFilterParams,
  factory(ctx, instance) {
    if (isWorkletReady("svFilter", ctx)) return createSvFilterNode(ctx, instance);
    // Transparent bypass fallback — the TPT resonance character can't be
    // faked by a BiquadFilterNode; a degraded approximation would be misleading.
    return bypassRuntime(ctx, "AudioWorklet unavailable — SV filter bypassed (1:1 signal)");
  },
};

/* ---------------- Flanger ---------------- */
// Per-sample modulated delay with ZERO-DELAY feedback (worklet feeds back
// within the same sample, unlike native DelayNode loops which add one render
// quantum). Stereo spread via L/R LFO phase offset.

const flanger: EffectDefinition = {
  type: "flanger",
  name: "Flanger",
  category: "movement",
  params: flangerParams,
  factory(ctx, instance, env) {
    if (isWorkletReady("flanger", ctx)) return createFlangerNode(ctx, instance, env.bpm);
    return bypassRuntime(ctx, "AudioWorklet unavailable — flanger bypassed (1:1 signal)");
  },
};

/* ---------------- Tremolo ---------------- */
// Amplitude modulation via LFO. AM mode = classic tremolo, Auto-Pan mode
// pans between channels. Shape morphs sine→square for harder rhythmic feel.

const tremolo: EffectDefinition = {
  type: "tremolo",
  name: "Tremolo",
  category: "movement",
  params: tremoloParams,
  factory(ctx, instance, env) {
    if (isWorkletReady("tremolo", ctx)) return createTremoloNode(ctx, instance, env.bpm);
    return bypassRuntime(ctx, "AudioWorklet unavailable — tremolo bypassed (1:1 signal)");
  },
};

/* ---------------- Autowah ---------------- */
// Envelope follower drives a Chamberlin SVF's cutoff per-sample. Playing
// harder opens the filter; release closes it gradually. Resonance gives the
// classic vocal "wah" quality. Single worklet — truly zero-delay.

const autowah: EffectDefinition = {
  type: "autowah",
  name: "Autowah",
  category: "movement",
  params: autowahParams,
  factory(ctx, instance) {
    if (isWorkletReady("autowah", ctx)) return createAutowahNode(ctx, instance);
    return bypassRuntime(ctx, "AudioWorklet unavailable — autowah bypassed (1:1 signal)");
  },
};

/* ---------------- Stutter ---------------- */
// BPM-synced loop-repeat: reads from one full loop cycle behind and gates
// the delayed signal with a 16-step pattern. Because the underlying beat is
// repetitive, hearing the same gated segments each cycle creates the classic
// stutter/glitch feel. Feedback intensifies the loop.

const stutter: EffectDefinition = {
  type: "stutter",
  name: "Stutter",
  category: "movement",
  params: stutterParams,
  factory(ctx, instance) {
    if (isWorkletReady("stutter", ctx)) {
      const handle = createStutterNode(ctx, instance);
      if (instance.steps && instance.steps.length > 0) handle.setPattern(instance.steps);
      return {
        input: handle.input,
        output: handle.output,
        setParameter: handle.setParameter,
        setParameterAt: handle.setParameterAt,
        syncBpm: handle.syncBpm,
        onTransportStarted: handle.onTransportStarted,
        dispose: handle.dispose,
      };
    }
    return bypassRuntime(ctx, "AudioWorklet unavailable — stutter bypassed (1:1 signal)");
  },
};

/* ---------------- Comb Filter ---------------- */
// Static feedback comb — tuned delay with damping, metallic / hollow resonances.
// LFO-less cousin of Flanger: delay sets comb fundamental (pitch), feedback
// sets resonance depth (positive = harmonic, negative = odd), damp tames highs.

const comb: EffectDefinition = {
  type: "comb",
  name: "Comb",
  category: "movement",
  params: combParams,
  factory(ctx, instance) {
    if (isWorkletReady("comb", ctx)) return createCombNode(ctx, instance);
    return bypassRuntime(ctx, "AudioWorklet unavailable — comb bypassed (1:1 signal)");
  },
};

/* ---------------- Vowel / Formant Filter ---------------- */
// 3× peaking cascade morphing across A-E-I-O-U (log-interpole). Resonance scales
// Q (3.5→9) and peak gain (7→15 dB). True vowel movement for beat textures.

const vowel: EffectDefinition = {
  type: "vowel",
  name: "Vowel",
  category: "movement",
  params: vowelParams,
  factory(ctx, instance) {
    if (isWorkletReady("vowel", ctx)) return createVowelNode(ctx, instance);
    return bypassRuntime(ctx, "AudioWorklet unavailable — vowel bypassed (1:1 signal)");
  },
};

/* ---------------- Ducking Delay ---------------- */
// Delay whose wet tail ducks under the dry signal so repeats bloom in gaps.
// One envelope follower ducks the damp-filtered delay tap; feedback is not
// ducked so the tail preserves its own decay when the dry comes back.

const duckDelay: EffectDefinition = {
  type: "duckDelay",
  name: "Duck Delay",
  category: "space",
  params: duckDelayParams,
  factory(ctx, instance) {
    if (isWorkletReady("duckDelay", ctx)) return createDuckingDelayNode(ctx, instance);
    return bypassRuntime(ctx, "AudioWorklet unavailable — ducking delay bypassed (1:1 signal)");
  },
};

/* ────────────── FX Expansion (beatmaking pass) ────────────── */
/* docs/FX-EXPANSION-ROADMAP.md — Tape Stop, Ring Mod, Freq Shift,
   Pitch Shift, Vinyl, Beat Mangler. All six run their DSP in the
   always-loaded core worklet bundle; without worklets they fall back to an
   honest 1:1 bypass (never silence). */

const ringMod: EffectDefinition = {
  type: "ringMod",
  name: "Ring Mod",
  category: "movement",
  params: ringModParams,
  factory(ctx, instance) {
    if (isWorkletReady("ringMod", ctx)) return createRingModNode(ctx, instance);
    return bypassRuntime(ctx, "AudioWorklet unavailable — ring modulator bypassed (1:1 signal)");
  },
};

const tapeStop: EffectDefinition = {
  type: "tapeStop",
  name: "Tape Stop",
  category: "movement",
  params: tapeStopParams,
  factory(ctx, instance) {
    if (isWorkletReady("tapeStop", ctx)) return createTapeStopNode(ctx, instance);
    return bypassRuntime(ctx, "AudioWorklet unavailable — tape stop bypassed (1:1 signal)");
  },
};

const freqShifter: EffectDefinition = {
  type: "freqShifter",
  name: "Freq Shift",
  category: "movement",
  params: freqShifterParams,
  factory(ctx, instance, env) {
    if (isWorkletReady("freqShifter", ctx)) return createFreqShiftNode(ctx, instance, env.bpm);
    return bypassRuntime(ctx, "AudioWorklet unavailable — frequency shifter bypassed (1:1 signal)");
  },
};

const MULTITAP_BAR_MULTS = [2, 4 / 3, 1, 2 / 3, 0.5, 1 / 3, 0.25, 1 / 6];
/** Same values read as "beats per division": the labels above are note
 * values (1/2 note = 2 beats …), so the delay seconds = beats × seconds/beat.
 * Multiplying a BAR length by these values made every tap 4× too long. */
export const multitapDelaySec = (divisionIndex: number, bpm: number): number => {
  const beats = MULTITAP_BAR_MULTS[Math.max(0, Math.min(MULTITAP_BAR_MULTS.length - 1, divisionIndex))];
  return Math.max(0.02, (60 / (bpm || 124)) * beats);
};

/**
 * Multi-tap delay (FX expansion): four tempo-synced taps, each with its own
 * division / gain / pan, sharing a tone-shaped feedback path. Pure native
 * Web Audio — no worklet.
 */
const multiTapDelay: EffectDefinition = {
  type: "multiTapDelay",
  name: "Multi-Tap",
  category: "space",
  params: multiTapDelayParams,
  factory(ctx, instance, env) {
    const paramDef = (id: string) => EFFECT_DEFS.multiTapDelay.params.find((pd) => pd.id === id)!;
    const clampParam = (id: string, raw: number) => {
      const def = paramDef(id);
      if (!Number.isFinite(raw)) return def.default;
      return Math.min(def.max, Math.max(def.min, raw));
    };
    const p = (id: string) => clampParam(id, instance.params[id]);
    let tapCount = Math.round(p("taps"));
    let spread = p("spread");
    let bpm = Number.isFinite(env.bpm) && env.bpm > 0 ? env.bpm : 124;
    const divisions = Array.from({ length: 4 }, (_, t) => Math.round(p(`t${t + 1}Div`)));
    const input = ctx.createGain();
    const output = ctx.createGain();
    const wet = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = p("tone");

    const panFor = (index: number) => (tapCount <= 1 ? 0 : (index / (tapCount - 1)) * 2 - 1) * spread * 0.9;

    const tapNodes: { delay: DelayNode; gain: GainNode; pan: StereoPannerNode }[] = [];
    for (let t = 0; t < 4; t++) {
      const delay = ctx.createDelay(8);
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      delay.delayTime.value = multitapDelaySec(divisions[t], bpm);
      gain.gain.value = t < tapCount ? 1 / Math.sqrt(t + 1) : 0;
      pan.pan.value = panFor(t);
      input.connect(delay).connect(gain).connect(pan).connect(tone);
      tapNodes.push({ delay, gain, pan });
    }

    // Shared feedback loop around the tone stage.
    const feedbackGain = ctx.createGain();
    let feedback = p("feedback");
    const feedbackLoopGain = () => {
      let sum = 0;
      for (let t = 0; t < tapCount; t++) sum += 1 / Math.sqrt(t + 1);
      return Math.max(1, sum);
    };
    // The feedback loop fans back into every active tap. Normalize the return
    // gain by their summed gains so four taps cannot turn a safe feedback
    // setting into a runaway loop.
    const effectiveFeedback = () => feedback / feedbackLoopGain();
    feedbackGain.gain.value = effectiveFeedback();
    tone.connect(feedbackGain).connect(input);

    tone.connect(wet).connect(output);
    // Dry passthrough — wet mixes over the input like the stock delay.
    input.connect(output);

    const applyMix = (v: number, when?: number) => {
      wet.gain.setValueAtTime(v, when ?? ctx.currentTime);
    };
    applyMix(p("mix"));

    const applyFeedback = (value: number, when?: number) => {
      feedback = clampParam("feedback", value);
      const normalized = effectiveFeedback();
      if (when !== undefined) feedbackGain.gain.setValueAtTime(normalized, when);
      else feedbackGain.gain.value = normalized;
    };

    const setDivision = (tapIndex: number, rawDivisionIndex: number, when?: number) => {
      const divisionIndex = Math.round(clampParam(`t${tapIndex + 1}Div`, rawDivisionIndex));
      divisions[tapIndex] = divisionIndex;
      const delayTime = tapNodes[tapIndex].delay.delayTime;
      if (when !== undefined) delayTime.setValueAtTime(multitapDelaySec(divisionIndex, bpm), when);
      else delayTime.setTargetAtTime(multitapDelaySec(divisionIndex, bpm), ctx.currentTime, 0.01);
    };

    /** Keep the spread cache and all tap positions in sync for UI + automation. */
    const applySpread = (value: number, when?: number) => {
      spread = clampParam("spread", value);
      tapNodes.forEach((tap, t) => {
        const pan = panFor(t);
        if (when !== undefined) tap.pan.pan.setValueAtTime(pan, when);
        else tap.pan.pan.value = pan;
      });
    };

    const applyTapCount = (value: number, when?: number) => {
      tapCount = Math.round(clampParam("taps", value));
      for (let t = 0; t < 4; t++) {
        const gain = t < tapCount ? 1 / Math.sqrt(t + 1) : 0;
        if (when !== undefined) tapNodes[t].gain.gain.setValueAtTime(gain, when);
        else tapNodes[t].gain.gain.value = gain;
      }
      applyFeedback(feedback, when);
      applySpread(spread, when);
    };

    const setParameter = (id: string, value: number, when?: number) => {
      if (id === "mix") {
        applyMix(clampParam(id, value), when);
        return;
      }
      if (id === "feedback") {
        applyFeedback(value, when);
        return;
      }
      if (id === "tone") {
        const frequency = clampParam(id, value);
        if (when !== undefined) tone.frequency.setValueAtTime(frequency, when);
        else tone.frequency.value = frequency;
        return;
      }
      if (id === "spread") {
        applySpread(value, when);
        return;
      }
      if (id === "taps") {
        applyTapCount(value, when);
        return;
      }
      const tapMatch = /^t([1-4])Div$/.exec(id);
      if (tapMatch) setDivision(Number(tapMatch[1]) - 1, value, when);
    };

    return {
      input,
      output,
      setParameter: (id, v) => setParameter(id, v),
      setParameterAt: (id, v, when) => setParameter(id, v, when),
      syncBpm: (nextBpm) => {
        bpm = Number.isFinite(nextBpm) && nextBpm > 0 ? nextBpm : 124;
        for (let t = 0; t < 4; t++) {
          tapNodes[t].delay.delayTime.setTargetAtTime(multitapDelaySec(divisions[t], bpm), ctx.currentTime, 0.05);
        }
      },
      dispose() {
        input.disconnect();
        tone.disconnect();
        feedbackGain.disconnect();
        wet.disconnect();
        output.disconnect();
        for (const { delay, gain, pan } of tapNodes) {
          delay.disconnect();
          gain.disconnect();
          pan.disconnect();
        }
      },
    };
  },
};

const pitchShift: EffectDefinition = {
  type: "pitchShift",
  name: "Pitch Shift",
  category: "character",
  params: pitchShiftParams,
  factory(ctx, instance) {
    if (isWorkletReady("pitchShift", ctx)) return createPitchShiftNode(ctx, instance);
    return bypassRuntime(ctx, "AudioWorklet unavailable — pitch shifter bypassed (1:1 signal)");
  },
};

const vinyl: EffectDefinition = {
  type: "vinyl",
  name: "Vinyl Suite",
  category: "character",
  params: vinylParams,
  factory(ctx, instance, env) {
    if (isWorkletReady("vinyl", ctx)) return createVinylNode(ctx, instance, env);
    return bypassRuntime(ctx, "AudioWorklet unavailable — vinyl suite bypassed (1:1 signal)");
  },
};

/** Stable beat-repeat division ids. Existing projects start with 1/1…1/32;
 * dotted and triplet ids are appended so saved parameter values stay valid. */

const beatMangler: EffectDefinition = {
  type: "beatMangler",
  name: "Beat Mangler",
  category: "movement",
  params: beatManglerParams,
  // Envelope data lives on EffectInstance.volumeSteps / pitchSteps (16/32
  // values, sanitized by normalizeEffects) — it flows to the runtime via the
  // engine's setSteps sync path, not through this params table.
  factory(ctx, instance, env) {
    if (isWorkletReady("beatMangler", ctx)) return createBeatManglerNode(ctx, instance, env.bpm, env.seed ?? 0);
    return bypassRuntime(ctx, "AudioWorklet unavailable — beat mangler bypassed (1:1 signal)");
  },
};

/* ────────────── Vocoder — carrier/modulator filterbank ────────────── */
// Carrier = this track's signal (input 0); modulator = the track routed via
// `EffectInstance.sidechainTrackId` (input 1, the sidechain precedent). The
// processor runs an 8/12/16-band analysis/synthesis filterbank with a real
// formant shift on the modulator bank and a sibilance passthrough so
// consonants survive. No modulator wired → carrier passes 1:1 (degraded).

const vocoder: EffectDefinition = {
  type: "vocoder",
  name: "Vocoder",
  category: "character",
  params: vocoderParams,
  factory(ctx, instance) {
    if (isWorkletReady("vocoder", ctx)) return createVocoderNode(ctx, instance);
    return bypassRuntime(ctx, "AudioWorklet unavailable — vocoder bypassed (1:1 signal)");
  },
};

/* ────────────── Reverse Swell — live reverse-envelope riser ────────────── */
// Records continuously; an `engaged` latch plays the last `reach` seconds
// BACKWARDS under a rising envelope — the reverse-cymbal riser built from the
// track's own audio, no reversed sample needed. `time` = swell duration,
// `reach` = how much material it plays (their ratio sets the reverse rate).

const reverseSwell: EffectDefinition = {
  type: "reverseSwell",
  name: "Reverse Swell",
  category: "movement",
  params: reverseSwellParams,
  factory(ctx, instance) {
    if (isWorkletReady("reverseSwell", ctx)) return createReverseSwellNode(ctx, instance);
    return bypassRuntime(ctx, "AudioWorklet unavailable — reverse swell bypassed (1:1 signal)");
  },
};

/* ────────────── Granular Freeze — send-bus texture hold ────────────── */
// Records continuously; a `freeze` latch locks a `window` of the recording
// and a granular cloud plays it forever (drift walks the head, scatter jitters
// the grains, pitch/tone shape the cloud). The dry path is ducked by the same
// envelope, so the send bus becomes a live texture pad instead of a layer.

const granularFreeze: EffectDefinition = {
  type: "granularFreeze",
  name: "Granular Freeze",
  category: "space",
  params: granularFreezeParams,
  factory(ctx, instance, env) {
    if (isWorkletReady("granularFreeze", ctx)) return createGranularFreezeNode(ctx, instance, env);
    return bypassRuntime(ctx, "AudioWorklet unavailable — granular freeze bypassed (1:1 signal)");
  },
};

/* ────────────── KYX Kaskáda — character stereo delay ────────────── */

const kaskada: EffectDefinition = {
  type: "kaskada",
  name: "RYFT",
  category: "space",
  params: kaskadaParams,
  factory(ctx, instance) {
    if (isWorkletReady("kaskada", ctx)) return createKaskadaNode(ctx, instance);
    return bypassRuntime(ctx, "AudioWorklet unavailable — RYFT delay bypassed (1:1 signal)");
  },
};

/* ---------------- registry ---------------- */

export const EFFECT_DEFS: Record<EffectType, EffectDefinition> = {
  eq,
  compressor,
  saturation,
  tapeSat,
  clipper,
  limiter,
  stepGate,
  svFilter,
  flanger,
  tremolo,
  autowah,
  stutter,
  comb,
  vowel,
  duckDelay,
  reverb,
  delay,
  pump,
  distortion,
  bitcrusher,
  chorus,
  phaser,
  sidechain,
  transient,
  drumBuss,
  bassBuss,
  msEq,
  haasWidener,
  multiband,
  utility,
  gate,
  shimmer,
  fxeq,
  ultina,
  ozvena,
  kaskada,
  morphdynamics,
  multiTapDelay,
  ringMod,
  tapeStop,
  freqShifter,
  pitchShift,
  vinyl,
  beatMangler,
  vocoder,
  reverseSwell,
  granularFreeze,
};

/** Effects intentionally exposed in the new mixer Add Effect menu. */

/** Flagship plugin suites exposed alongside the core effects. */

/**
 * Core effects grouped by their registry category for the Add Effect menu —
 * one optgroup per category (Tone / Dynamics / Character / Movement / Space),
 * order inside each group follows CORE_EFFECT_ORDER.
 */
export const CORE_EFFECT_GROUP_ORDER = ["tone", "dynamics", "character", "movement", "space"] as const;
export type CoreEffectGroupKey = (typeof CORE_EFFECT_GROUP_ORDER)[number];
export const CORE_EFFECT_GROUP_LABELS: Record<CoreEffectGroupKey, string> = {
  tone: "TONE",
  dynamics: "DYNAMICS",
  character: "CHARACTER",
  movement: "MOVEMENT",
  space: "SPACE",
};
export interface CoreEffectGroup {
  key: CoreEffectGroupKey;
  label: string;
  types: EffectType[];
}
export const CORE_EFFECT_GROUPS: CoreEffectGroup[] = CORE_EFFECT_GROUP_ORDER.map((key) => ({
  key,
  label: CORE_EFFECT_GROUP_LABELS[key],
  types: CORE_EFFECT_ORDER.filter((type) => EFFECT_DEFS[type].category === key),
}));

const DEVICE_MENU_EFFECTS = new Set<EffectType>([...CORE_EFFECT_ORDER, ...FLAGSHIP_EFFECT_ORDER]);
export const ADDITIONAL_EFFECT_GROUPS: CoreEffectGroup[] = CORE_EFFECT_GROUP_ORDER.map((key) => ({
  key,
  label: `MORE ${CORE_EFFECT_GROUP_LABELS[key]}`,
  types: EFFECT_ORDER.filter((type) => !DEVICE_MENU_EFFECTS.has(type) && EFFECT_DEFS[type].category === key),
})).filter((group) => group.types.length > 0);

/**
 * Validate the FULL parameter map of a flagship plugin effect (ultina/fxeq/
 * ozvena) from persisted state. These plugins expose deep, namespaced
 * parameters ("eq.band3.gainDb", "band2.satDriveDb", "engines.e1.mix"…)
 * authored by their panels, far beyond the registry's rack param list —
 * `normalizeEffects` must not silently strip them on project load or every
 * saved plugin mix resets itself.
 *
 * Returns the complete validated param map (rack defaults + deep params),
 * or null for effect types without a plugin-deep surface (caller falls back
 * to rack-default retention). Unknown ids are dropped; every retained value
 * is finite; ultina/fxeq values are clamped to their authoritative DSP
 * schemas, ozvena values are validated at the worklet's setPath boundary.
 */
