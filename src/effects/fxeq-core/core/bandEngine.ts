/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/fxeq. Do not edit by hand — this is a
 * byte-faithful copy of the upstream DSP oracle so Pulse Forge and VocalForge
 * validate against the SAME golden fixtures (tests/fxeq-golden/). Fix DSP
 * issues upstream, then re-vendor via scripts/vendor-fxeq.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// FXEQ — Band engine
//
// One per band. Owns the 5 creative module instances (sat, lofi, mod,
// delay, rev) plus band-level gain/mix. Processes a single band's
// channel buffer in place: band gain → module chain → band mix.
//
// Parameters are stored in the parent processor's flat store; the band
// engine exposes set/get for its own (unprefixed) IDs and routes module
// params to the right module instance. Band gain is smoothed to avoid
// clicks when the EQ mask moves.
// ═══════════════════════════════════════════════════════════

import type { ModuleProcessor } from "../dsp/types.js";
import { clamp, dbToLinear, flushDenormal } from "../dsp/mathUtils.js";
import { createSmoother } from "../dsp/envelope.js";
import { MODULE_FACTORIES, MODULE_KEYS, ENV_MOD_TARGETS, type ModuleKey } from "./signalFlow.js";
import { BAND_SCALAR_DEFS } from "./parameterSchema.js";
import { assertAudioBlock } from "../dsp/audioBlockContract.js";
import {
  createDynamicState,
  processEnvelope,
  computeGain,
  rangeDbToLin,
  type DynamicState,
} from "../dsp/dynamics.js";

/** Schema ranges per band-scalar id, for setBandParam clamping (M3). */
const BAND_PARAM_RANGES = new Map(BAND_SCALAR_DEFS.map((d) => [d.id, d]));

export interface BandEngine {
  prepare(sampleRate: number, channelCount: number, maxBlockSize: number): void;
  reset(): void;
  /**
   * Process a band buffer in place.
   * @param sidechain Optional external sidechain signal for dynamic EQ envelope.
   *                  When provided and sidechainMode=1, the envelope follower
   *                  tracks this signal instead of the band's own signal.
   */
  process(channels: Float32Array[], frameCount: number, sidechain?: Float32Array[]): void;
  /** Set a band scalar param (gainDb/enabled/mix). */
  setBandParam(id: string, value: number): void;
  /** Set a module param, routing to the correct module by key prefix. */
  setModuleParam(moduleKey: ModuleKey, paramId: string, value: number): void;
  /** Host tempo notification (Q2) — forwarded to tempo-aware modules. */
  setTempo(bpm: number): void;
  getBandParam(id: string): number;
  getModuleParam(moduleKey: ModuleKey, paramId: string): number;
  /** Collect all params for serialization (unprefixed). */
  getAllParams(): Record<string, number>;
  /** Get the current peak level of this band (linear, for metering). */
  getBandPeak(): number;
  /**
   * Total latency of this band's serial module chain (for inter-band
   * alignment in the processor). Modules report 0 when disabled.
   */
  getLatencySamples(): number;
}

export function createBandEngine(seed?: number): BandEngine {
  const moduleSeed = (salt: number): number | undefined =>
    seed === undefined ? undefined : mixSeed(seed, salt);
  const modules: Record<ModuleKey, ModuleProcessor> = {
    eq: MODULE_FACTORIES.eq(undefined, moduleSeed(0x4551)),
    sat: MODULE_FACTORIES.sat(undefined, moduleSeed(0x534154)),
    dyn: MODULE_FACTORIES.dyn(undefined, moduleSeed(0x44594e)),
    lofi: MODULE_FACTORIES.lofi(undefined, moduleSeed(0x4c4f46)),
    mod: MODULE_FACTORIES.mod(undefined, moduleSeed(0x4d4f44)),
    delay: MODULE_FACTORIES.delay(undefined, moduleSeed(0x44454c)),
    rev: MODULE_FACTORIES.rev(undefined, moduleSeed(0x524556)),
  };

  let bandGainDb = 0;
  let bandEnabled = 1;
  let bandMix = 100;
  /** M/S mode: 0=stereo (L/R), 1=mid only, 2=side only. */
  let bandMidSide = 0;
  let bandSolo = 0;
  let bandMute = 0;
  let bandPhaseInvert = 0;
  let bandSidechainMode = 0;
  let bandQuality = 1; // 0=eco, 1=standard, 2=high, 3=render
  let appliedSatQuality = 1;
  let bandLinkGroup = 0; // 0=unlinked, 1-5=link group
  let gainSmoother = createSmoother(44100, 30);
  let mixSmoother = createSmoother(44100, 30);
  let prepared = false;
  let preparedMaxBlockSize = 1;
  let preparedSr = 44100; // stored sample rate for dynamic EQ coefs

  // Dynamic EQ state.
  let dynEnable = 0;
  let dynThresholdDb = -20;
  let dynRangeDb = -6;
  let dynAttackMs = 10;
  let dynReleaseMs = 100;
  const dynState: DynamicState = createDynamicState();
  let bandPeakLin = 0; // current band peak level (for metering)

  // Scratch buffers for M/S encoding/decoding (lazily allocated).
  let msBufA: Float32Array = new Float32Array(0);
  let msBufB: Float32Array = new Float32Array(0);

  // Cached dynamic-EQ envelope coefficients. Recomputing them every block
  // allocates a {attack, release} object per block per band — small, but
  // the audio thread should not allocate at all. Invalidated when the
  // attack/release params or sample rate change.
  let dynAttackCoef = 0;
  let dynReleaseCoef = 0;
  let dynCoefAttackMs = -1;
  let dynCoefReleaseMs = -1;
  let dynCoefSr = 0;

  function refreshDynCoefs(): void {
    if (dynCoefAttackMs === dynAttackMs && dynCoefReleaseMs === dynReleaseMs && dynCoefSr === preparedSr) {
      return;
    }
    dynAttackCoef = Math.exp(-1 / ((dynAttackMs / 1000) * preparedSr));
    dynReleaseCoef = Math.exp(-1 / ((dynReleaseMs / 1000) * preparedSr));
    dynCoefAttackMs = dynAttackMs;
    dynCoefReleaseMs = dynReleaseMs;
    dynCoefSr = preparedSr;
  }

  // ── Q6: per-band envelope routing ─────────────────────────
  // The band's own envelope (peak follower on the crossover output,
  // normalized against full scale) drives one routed parameter around its
  // base value. Routing is off (envModTarget 0) unless the host enables
  // it — every default render stays bit-identical.
  //
  // Architecture note: routed MODULE parameters are written per block as
  // base + offset, with the base cached here (updated by every
  // setModuleParam for that parameter — user edits, presets, morphs, link
  // groups). The processor's flat store is never touched by the modulation,
  // so serialization always reports the base. Disabling the routing (target
  // off, depth 0, band mute) restores the cached base exactly once.
  let envTarget = 0; // index into ENV_MOD_TARGETS; 0 = off
  let envDepth = 0; // -100..100 %
  let envAtkMs = 10;
  let envRelMs = 150;
  let modEnvValue = 0; // follower state (linear amplitude)
  let envRoutedModule: ModuleKey | null = null;
  let envRoutedParam: string | null = null;
  let envModBase = 0;
  let envModApplied = false; // last block wrote an offset into the module
  let envGainOffset = 0; // offset applied to bandGainDb this block
  let envAtkCoef = 0;
  let envRelCoef = 0;
  let envCoefAtkMs = -1;
  let envCoefRelMs = -1;
  let envCoefSr = 0;

  function refreshEnvCoefs(): void {
    if (envCoefAtkMs === envAtkMs && envCoefRelMs === envRelMs && envCoefSr === preparedSr) {
      return;
    }
    envAtkCoef = 1 - Math.exp(-1 / ((envAtkMs / 1000) * preparedSr));
    envRelCoef = 1 - Math.exp(-1 / ((envRelMs / 1000) * preparedSr));
    envCoefAtkMs = envAtkMs;
    envCoefRelMs = envRelMs;
    envCoefSr = preparedSr;
  }

  /** Switch the routed target; restores the previous target's base first. */
  function retargetEnv(next: number): void {
    if (envRoutedModule && envRoutedParam && envModApplied) {
      modules[envRoutedModule].setParameter(envRoutedParam, envModBase);
    }
    envModApplied = false;
    envGainOffset = 0;
    const def = ENV_MOD_TARGETS[next] ?? null;
    if (def && def.moduleKey && def.paramId) {
      envRoutedModule = def.moduleKey;
      envRoutedParam = def.paramId;
      // The module currently holds its base (modulation was either off or
      // just restored above).
      envModBase = modules[def.moduleKey].getParameter(def.paramId);
    } else {
      envRoutedModule = null;
      envRoutedParam = null;
    }
  }

  return {
    prepare(sr, cc, maxBlockSize) {
      preparedMaxBlockSize = Math.max(1, maxBlockSize);
      for (const key of MODULE_KEYS) modules[key].prepare(sr, cc, maxBlockSize);
      gainSmoother = createSmoother(sr, 30);
      mixSmoother = createSmoother(sr, 30);
      gainSmoother.reset(dbToLinear(bandGainDb));
      mixSmoother.reset(clamp(bandMix, 0, 100) / 100);
      preparedSr = sr;
      // Preallocate the M/S scratch here so the FIRST processed block never
      // allocates on the audio thread (the old lazy allocation inside
      // process() did exactly that on its first M/S block).
      if (msBufA.length < preparedMaxBlockSize) {
        msBufA = new Float32Array(preparedMaxBlockSize);
        msBufB = new Float32Array(preparedMaxBlockSize);
      }
      refreshDynCoefs();
      prepared = true;
    },

    reset() {
      for (const key of MODULE_KEYS) modules[key].reset();
      if (prepared) {
        gainSmoother.reset(dbToLinear(bandGainDb));
        mixSmoother.reset(clamp(bandMix, 0, 100) / 100);
      }
      // Q6: reset the follower — routed modules keep their params, and the
      // next process() reapplies base + fresh envelope from zero.
      modEnvValue = 0;
      envGainOffset = 0;
    },

    process(channels, frameCount, sidechain) {
      if (!prepared) return;
      assertAudioBlock(channels, frameCount, preparedMaxBlockSize, "band engine", channels.length);
      if (sidechain) assertAudioBlock(sidechain, frameCount, preparedMaxBlockSize, "band engine sidechain");
      if (frameCount === 0) return;

      // Mute or disabled band contributes nothing.
      if (bandEnabled < 0.5 || bandMute >= 0.5) {
        for (let c = 0; c < channels.length; c++) channels[c].fill(0, 0, frameCount);
        return;
      }

      // Denormal flushing: flush subnormal values at the start of each
      // block to prevent CPU spikes on x86 (FTZ equivalent for JS).
      for (let c = 0; c < channels.length; c++) {
        const buf = channels[c];
        for (let i = 0; i < frameCount; i++) {
          buf[i] = flushDenormal(buf[i]);
        }
      }

      // Q6: track the band envelope on the crossover output (before gain,
      // dynEQ and modules — stable, no feedback into the detector) and
      // apply the routed modulation for this block. Depth 0 / target 0
      // skips the pass entirely and restores the routed base once.
      const targetDef = ENV_MOD_TARGETS[envTarget] ?? null;
      envGainOffset = 0;
      if (targetDef && envDepth !== 0) {
        refreshEnvCoefs();
        let env = modEnvValue;
        for (let i = 0; i < frameCount; i++) {
          let peak = 0;
          for (let c = 0; c < channels.length; c++) {
            const a = channels[c][i] < 0 ? -channels[c][i] : channels[c][i];
            if (a > peak) peak = a;
          }
          env += (peak > env ? envAtkCoef : envRelCoef) * (peak - env);
        }
        modEnvValue = env;
        // Full-scale band level (1.0) sweeps the full depth swing.
        const envNorm = env < 1 ? env : 1;
        const offset = envNorm * (envDepth / 100) * targetDef.swing;
        if (envRoutedModule && envRoutedParam) {
          modules[envRoutedModule].setParameter(envRoutedParam, envModBase + offset);
          envModApplied = true;
        } else if (targetDef.bandScalar === "gainDb") {
          envGainOffset = offset;
        }
      } else if (envRoutedModule && envModApplied) {
        modules[envRoutedModule].setParameter(envRoutedParam!, envModBase);
        envModApplied = false;
      }

      // Dynamic EQ: compute envelope and gain reduction.
      if (dynEnable >= 0.5 && channels.length >= 2) {
        const threshLin = dbToLinear(dynThresholdDb);
        const rangeLin = rangeDbToLin(dynRangeDb);
        // Cached coefficients — no per-block allocation (see refreshDynCoefs).
        refreshDynCoefs();
        let dynGain = 1;

        // Determine envelope source: sidechain or band signal.
        const useSidechain = bandSidechainMode >= 0.5 && sidechain && sidechain.length >= 2;

        for (let i = 0; i < frameCount; i++) {
          // Compute peak level from the envelope source.
          let peak = 0;
          if (useSidechain) {
            // Sidechain: use the external signal for envelope detection.
            for (let c = 0; c < sidechain.length; c++) {
              const a = sidechain[c][i] < 0 ? -sidechain[c][i] : sidechain[c][i];
              if (a > peak) peak = a;
            }
          } else {
            // Internal: use the band's own signal.
            for (let c = 0; c < channels.length; c++) {
              const a = channels[c][i] < 0 ? -channels[c][i] : channels[c][i];
              if (a > peak) peak = a;
            }
          }
          // Envelope follower.
          processEnvelope(peak, dynState, dynAttackCoef, dynReleaseCoef);
          // Gain computer.
          dynGain = computeGain(dynState.envelope, threshLin, rangeLin);
          dynState.smoothedGain = dynGain;
          dynState.gainReductionDb = dynGain < 1 ? 20 * Math.log10(dynGain) : 0;
          // Apply dynamic gain to both channels.
          for (let c = 0; c < channels.length; c++) {
            channels[c][i] *= dynGain;
          }
        }
      }

      // Apply smoothed band gain. Audit M6: the smoother must advance
      // once per SAMPLE and apply the same value to every channel — the
      // old per-channel advance made the right ear's ramp run a whole
      // block ahead of the left during gain moves. Q6: an envelope
      // routing to the band gain (target 9) adds its offset to the
      // base dB here — the base itself stays untouched.
      const targetGain = dbToLinear(bandGainDb + envGainOffset);
      {
        let g = gainSmoother.getValue();
        for (let i = 0; i < frameCount; i++) {
          g = gainSmoother.processValue(targetGain);
          for (let c = 0; c < channels.length; c++) {
            channels[c][i] *= g;
          }
        }
      }

      // M/S encoding: L/R → M/S if midSide mode is active. The module
      // chain then runs on the M/S-domain signals and we decode back to
      // L/R at the end. Both M and S go through every module — the
      // per-mode reordering below just controls which orthogonal pair
      // (M,S) sits in (channels[0], channels[1]).
      if (bandMidSide >= 1 && channels.length >= 2) {
        const L = channels[0];
        const R = channels[1];
        if (msBufA.length < frameCount) {
          msBufA = new Float32Array(frameCount);
          msBufB = new Float32Array(frameCount);
        }
        const inv = 1 / Math.SQRT2;
        for (let i = 0; i < frameCount; i++) {
          msBufA[i] = (L[i] + R[i]) * inv; // M
          msBufB[i] = (L[i] - R[i]) * inv; // S
        }
        if (bandMidSide === 1) {
          // Mid mode: channels[0] = M, channels[1] = S.
          for (let i = 0; i < frameCount; i++) {
            channels[0][i] = msBufA[i];
            channels[1][i] = msBufB[i];
          }
        } else {
          // Side mode (bandMidSide === 2): channels[0] = S, channels[1] = M.
          for (let i = 0; i < frameCount; i++) {
            channels[0][i] = msBufB[i];
            channels[1][i] = msBufA[i];
          }
        }
      }

      // Run the module chain in order.
      for (const key of MODULE_KEYS) {
        modules[key].process(channels, frameCount);
      }

      // M/S decoding: M/S → L/R if midSide mode was active. The module
      // chain has produced processed M and processed S in channels[0]
      // and channels[1] (in mode-dependent order); we read them in the
      // right order per mode and apply the inverse orthogonal transform
      //   L = (M + S) / √2
      //   R = (M − S) / √2
      // to recover the stereo signal.
      if (bandMidSide >= 1 && channels.length >= 2) {
        const inv = 1 / Math.SQRT2;
        if (bandMidSide === 1) {
          // Mid mode: channels[0] = processed M, channels[1] = processed S.
          for (let i = 0; i < frameCount; i++) {
            const m = channels[0][i];
            const s = channels[1][i];
            channels[0][i] = (m + s) * inv;
            channels[1][i] = (m - s) * inv;
          }
        } else {
          // Side mode: channels[0] = processed S, channels[1] = processed M.
          for (let i = 0; i < frameCount; i++) {
            const s = channels[0][i];
            const m = channels[1][i];
            channels[0][i] = (m + s) * inv;
            channels[1][i] = (m - s) * inv;
          }
        }
      }

      // Track band peak for metering.
      let peak = 0;
      for (let c = 0; c < channels.length; c++) {
        for (let i = 0; i < frameCount; i++) {
          const a = channels[c][i] < 0 ? -channels[c][i] : channels[c][i];
          if (a > peak) peak = a;
        }
      }
      bandPeakLin = peak;

      // Phase invert: flip sign of all channels.
      if (bandPhaseInvert >= 0.5) {
        for (let c = 0; c < channels.length; c++) {
          const buf = channels[c];
          for (let i = 0; i < frameCount; i++) buf[i] = -buf[i];
        }
      }

      // Apply band mix (scales the band's contribution to the final sum).
      // Same per-sample smoothing as the gain above (audit M6).
      const targetMix = clamp(bandMix, 0, 100) / 100;
      {
        let m = mixSmoother.getValue();
        for (let i = 0; i < frameCount; i++) {
          m = mixSmoother.processValue(targetMix);
          for (let c = 0; c < channels.length; c++) {
            channels[c][i] *= m;
          }
        }
      }
    },

    setBandParam(id, value) {
      // Audit M3: band scalars are consumed raw (gain smoothing, dyn EQ
      // thresholds, solo/mute flags), so any value arriving from a host
      // or preset path must be finite and inside the schema range before
      // it can reach DSP state.
      const def = BAND_PARAM_RANGES.get(id);
      if (!def) return;
      if (!Number.isFinite(value)) return;
      const v = Math.max(def.minValue, Math.min(def.maxValue, value));
      switch (id) {
        case "gainDb": bandGainDb = v; break;
        case "enabled": bandEnabled = v; break;
        case "mix": bandMix = v; break;
        case "midSide": bandMidSide = Math.round(v); break;
        case "dynEnable": dynEnable = v; break;
        case "dynThresholdDb": dynThresholdDb = v; break;
        case "dynRangeDb": dynRangeDb = v; break;
        case "dynAttackMs": dynAttackMs = v; break;
        case "dynReleaseMs": dynReleaseMs = v; break;
        case "solo": bandSolo = v; break;
        case "mute": bandMute = v; break;
        case "phaseInvert": bandPhaseInvert = v; break;
        case "sidechainMode": bandSidechainMode = v; break;
        case "quality": {
          const nextQuality = Math.round(v);
          bandQuality = nextQuality;
          // `quality` is a host scalar rather than a saturation parameter.
          // Push it only when it changes: constructing the compatibility
          // parameter object once per band per audio block was a hidden
          // render-thread allocation and caused p95 jitter under full load.
          if (nextQuality !== appliedSatQuality) {
            modules.sat.loadParameters({ quality: nextQuality });
            appliedSatQuality = nextQuality;
          }
          break;
        }
        case "linkGroup": bandLinkGroup = Math.round(v); break;
        case "envModTarget": {
          const next = Math.round(clamp(v, 0, ENV_MOD_TARGETS.length - 1));
          if (next !== envTarget) retargetEnv(next);
          envTarget = next;
          break;
        }
        case "envModDepth": envDepth = v; break;
        case "envModAtkMs": envAtkMs = v; break;
        case "envModRelMs": envRelMs = v; break;
      }
    },

    setModuleParam(moduleKey, paramId, value) {
      // Q6: the routed parameter's base is maintained here — user edits,
      // presets, morphs and link groups all flow through setModuleParam,
      // so the modulation always orbits the CURRENT base value. The
      // module momentarily receives the unmodulated value; the next
      // process() reapplies base + fresh envelope offset.
      if (envRoutedModule === moduleKey && envRoutedParam === paramId) {
        envModBase = value;
      }
      modules[moduleKey].setParameter(paramId, value);
    },

    setTempo(bpm) {
      // Only delay and modulation are tempo-aware today; the optional call
      // keeps this forwarding future-proof without touching other modules.
      for (const key of MODULE_KEYS) modules[key].setTempo?.(bpm);
    },

    getBandParam(id) {
      if (id === "gainDb") return bandGainDb;
      if (id === "enabled") return bandEnabled;
      if (id === "mix") return bandMix;
      if (id === "midSide") return bandMidSide;
      if (id === "dynEnable") return dynEnable;
      if (id === "dynThresholdDb") return dynThresholdDb;
      if (id === "dynRangeDb") return dynRangeDb;
      if (id === "dynAttackMs") return dynAttackMs;
      if (id === "dynReleaseMs") return dynReleaseMs;
      if (id === "solo") return bandSolo;
      if (id === "mute") return bandMute;
      if (id === "phaseInvert") return bandPhaseInvert;
      if (id === "sidechainMode") return bandSidechainMode;
      if (id === "quality") return bandQuality;
      if (id === "linkGroup") return bandLinkGroup;
      if (id === "envModTarget") return envTarget;
      if (id === "envModDepth") return envDepth;
      if (id === "envModAtkMs") return envAtkMs;
      if (id === "envModRelMs") return envRelMs;
      return 0;
    },

    getModuleParam(moduleKey, paramId) {
      // Q6: the routed parameter reports its BASE, not the last modulated
      // value — introspection and serialization must not see the swing.
      if (envRoutedModule === moduleKey && envRoutedParam === paramId) {
        return envModBase;
      }
      return modules[moduleKey].getParameter(paramId);
    },

    getBandPeak() {
      return bandPeakLin;
    },

    getLatencySamples() {
      // Modules are chained serially inside a band, so latencies add.
      // Disabled modules report 0 (saturation gates on `enabled`).
      let total = 0;
      for (const key of MODULE_KEYS) {
        const m = modules[key];
        if (m.getLatencySamples) total += m.getLatencySamples();
      }
      return total;
    },

    getAllParams() {
      const out: Record<string, number> = {
        gainDb: bandGainDb,
        enabled: bandEnabled,
        mix: bandMix,
        midSide: bandMidSide,
        dynEnable,
        dynThresholdDb,
        dynRangeDb,
        dynAttackMs,
        dynReleaseMs,
        solo: bandSolo,
        mute: bandMute,
        phaseInvert: bandPhaseInvert,
        sidechainMode: bandSidechainMode,
        quality: bandQuality,
        linkGroup: bandLinkGroup,
        envModTarget: envTarget,
        envModDepth: envDepth,
        envModAtkMs: envAtkMs,
        envModRelMs: envRelMs,
      };
      const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      for (const key of MODULE_KEYS) {
        const mp = modules[key].getParameters();
        for (const k of Object.keys(mp)) {
          // Q6: a routed (currently modulated) parameter reports its base.
          if (envRoutedModule === key && envRoutedParam === k) {
            out[key + cap(k)] = envModBase;
            continue;
          }
          out[key + cap(k)] = mp[k];
        }
      }
      return out;
    },
  };
}

function mixSeed(seed: number, salt: number): number {
  let value = (seed ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = (value ^ (value >>> 16)) >>> 0;
  return value === 0 ? 0x1 : value;
}
