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
// FXEQ — Top-level processor (portable, host-agnostic)
//
// Wires the multiband crossover, per-band engines, global wet/dry mix,
// FX-Only mode, and the output limiter. Implements a clean surface that
// the host adapter (hostAdapter.ts) wraps into a DspProcessor.
//
// Signal flow:
//   input → input gain → crossover → [N band engines] → sum
//         → global mix (or FX-only) → limiter → output gain → out
// ═══════════════════════════════════════════════════════════

import type { FxEqParamDef } from "../dsp/types.js";
import { clamp, dbToLinear, DEFAULT_SAMPLE_RATE } from "../dsp/mathUtils.js";
import { createCrossoverBank, DEFAULT_CROSSOVER_FREQS, MAX_BANDS } from "./crossover.js";
import { createBandEngine } from "./bandEngine.js";
import { createLimiterModule } from "../modules/limiter.js";
import { buildSchema, BAND_SCALAR_DEFS, type RouteEntry } from "./parameterSchema.js";
import { createCommandHistory, type CommandHistory } from "./commandHistory.js";
import { assertAudioBlock } from "../dsp/audioBlockContract.js";

export interface FxEqProcessor {
  readonly parameterDefs: readonly FxEqParamDef[];
  prepare(sampleRate: number, channelCount: number, maxBlockSize: number): void;
  process(channels: Float32Array[], frameCount: number): void;
  reset(): void;
  getLatencySamples(): number;
  setParameter(id: string, value: number): void;
  getParameter(id: string): number;
  getParameters(): Record<string, number>;
  loadParameters(params: Record<string, number>): void;
  /**
   * Set external sidechain input for spectral ducking.
   * When provided, bands with sidechainMode=1 use this signal
   * for their dynamic EQ envelope follower instead of the band's own signal.
   * Call before process() each block. Pass null to disable.
   */
  setSidechain(channels: Float32Array[] | null): void;
  /**
   * Host tempo notification (quality roadmap Q2). Forwarded to every band
   * engine; only tempo-synced modules (delay/mod with syncMode > 0) react.
   * Allocation-free.
   */
  setTempo(bpm: number): void;
  /** Undo the last parameter change. Returns the restored entry or null. */
  undo(): { id: string; value: number } | null;
  /** Redo the last undone change. Returns the restored entry or null. */
  redo(): { id: string; value: number } | null;
  /** Check if undo/redo is available. */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /**
   * Start an A/B morph between current state and target parameters.
   * `target` is a flat parameter map. `durationSec` is the morph time.
   * The morph interpolates all parameters linearly over time.
   * Call startMorph again to interrupt and start a new morph.
   */
  startMorph(target: Record<string, number>, durationSec: number): void;
  /** Check if a morph is currently active. */
  readonly isMorphing: boolean;
  /** Get per-band peak levels (linear) for metering. */
  getBandPeaks(): Float32Array;
}

export interface FxEqProcessorOptions {
  /** Stable host seed for all stateful random DSP streams. */
  seed?: number;
}

export function createFxEqProcessor(
  params?: Record<string, number>,
  options?: FxEqProcessorOptions,
): FxEqProcessor {
  let bandCount = 6;
  let schema = buildSchema(bandCount);

  // Flat value store.
  let values: Record<string, number> = { ...schema.defaultParams };
  if (params) {
    for (const id of Object.keys(values)) {
      const incoming = params[id];
      if (incoming === undefined) continue;
      // Same boundary validation as loadParameters: constructor params can
      // arrive from host state, and per-block consumers (input/output gain)
      // read `values` raw — an out-of-range value must never land there.
      if (typeof incoming !== "number" || !Number.isFinite(incoming)) continue;
      const def = schema.defById.get(id);
      values[id] = def
        ? Math.max(def.minValue, Math.min(def.maxValue, incoming))
        : incoming;
    }
  }

  const crossover = createCrossoverBank(bandCount, 4, [...DEFAULT_CROSSOVER_FREQS]);
  const bands = Array.from({ length: MAX_BANDS }, (_, index) =>
    createBandEngine(options?.seed === undefined ? undefined : mixSeed(options.seed, index + 1)),
  );
  const limiter = createLimiterModule({ ceilDb: values["limiterCeilDb"] ?? -0.3 });

  let sampleRate = DEFAULT_SAMPLE_RATE;
  let channelCount = 2;
  let maxBlockSize = 0;
  let prepared = false;

  // DC-blocking HP filter state (1st-order, cutoff ~15 Hz).
  // y[n] = x[n] - x[n-1] + alpha * y[n-1]
  let dcAlpha = 0; // computed in prepare()
  let dcPrevIn: Float32Array = new Float32Array(0);  // [channel]
  let dcPrevOut: Float32Array = new Float32Array(0); // [channel]

  // External sidechain input for spectral ducking (set by host via setSidechain).
  let sidechainChannels: Float32Array[] | null = null;

  // Crossover frequency smoothing (eliminates zipper noise on param changes).
  const xoverFreqTarget: number[] = [...DEFAULT_CROSSOVER_FREQS];
  const xoverFreqCurrent: number[] = [...DEFAULT_CROSSOVER_FREQS];
  let xoverSmoothCoef = 0;

  // Quality roadmap Q5: the schema ranges allow neighbouring splits to cross
  // (f2 max 800 > f3 min 300), which would invert band order inside the
  // cascade tree and desync the paint-mask semantics. Splits are clamped to
  // ascending order with a minimum gap — deterministic forward pass on bulk
  // loads, neighbour clamp on single changes.
  const XOVER_MIN_GAP_HZ = 40;

  /** Force ascending order with a minimum gap (forward pass, deterministic). */
  function monotonicClampFreqs(freqs: number[]): void {
    let prev = 40;
    for (let i = 0; i < freqs.length; i++) {
      const clamped = Math.max(prev + XOVER_MIN_GAP_HZ, freqs[i]);
      freqs[i] = clamped;
      prev = clamped;
    }
  }

  /**
   * Clamp one split against its stored neighbours so band order cannot
   * invert. Neighbours come from the flat store (always monotonic after the
   * applyAllParams writeback); a missing upper neighbour (top split) leaves
   * the upper bound open.
   */
  function clampXoverTarget(idx: number, value: number): number {
    let lo = 80;
    for (let i = 0; i < idx; i++) {
      const f = values[`crossoverFreq${i + 2}`];
      if (typeof f === "number" && Number.isFinite(f)) lo = Math.max(lo, f + XOVER_MIN_GAP_HZ);
    }
    for (let i = idx + 1; i < bandCount - 1; i++) {
      const f = values[`crossoverFreq${i + 2}`];
      if (typeof f === "number" && Number.isFinite(f)) {
        return Math.max(lo, Math.min(f - XOVER_MIN_GAP_HZ, value));
      }
    }
    return Math.max(lo, value);
  }

  // Command history for undo/redo.
  const history: CommandHistory = createCommandHistory();

  // A/B morph state. The morph is PRECOMPILED at startMorph() into routed
  // entries; process() only interpolates and routes those. The old path
  // re-ran applyAllParams() every block — a full schema walk PLUS an
  // unconditional crossover stage rebuild (~140 coefficient sets with
  // sin/cos) on the audio thread for the entire morph duration, even when
  // the morph did not touch a single crossover frequency.
  interface MorphEntry {
    id: string;
    route: RouteEntry;
    start: number;
    end: number;
  }
  let morphEntries: MorphEntry[] | null = null;
  let morphDuration = 0;
  let morphElapsed = 0;
  let morphing = false;

  // Scratch: dry buffer + wet-sum buffer + per-band scratch (allocated in prepare).
  let dryBuf: Float32Array[] = [];
  let wetBuf: Float32Array[] = [];
  // bandScratch[b][c] — preallocated so process() never allocates.
  let bandScratch: Float32Array[][] = [];

  // Inter-band latency alignment (audit C2): a band running oversampled
  // saturation is delayed ~8 samples relative to its siblings, which
  // comb-filtered the band sum. Bands are delayed to the loudest (max)
  // band latency, and the dry snapshot is delayed by the same amount so
  // the global wet/dry mix stays aligned too.
  const ALIGN_MAX = 8;
  let bandDelayRing: Float32Array[][] = [];
  let bandDelayPos: number[][] = [];
  let dryDelayRing: Float32Array[] = [];
  let dryDelayPos: number[] = [];
  // Once ANY latency has been active mid-stream, the alignment rings must
  // keep clocking through zero-latency periods too: a later 0→8 transition
  // (saturation enable toggle, drive crossing the oversample threshold)
  // would otherwise replay the previous latency period's ring content as a
  // stale audio burst. Cleared on prepare/reset — a fresh processor's
  // zeroed rings behave exactly like the old startup path (golden parity).
  let ringsLive = false;

  function allocBuffers(maxBlockSize: number): void {
    dryBuf = [];
    wetBuf = [];
    for (let c = 0; c < channelCount; c++) {
      dryBuf.push(new Float32Array(maxBlockSize));
      wetBuf.push(new Float32Array(maxBlockSize));
      dryDelayRing.push(new Float32Array(ALIGN_MAX));
      dryDelayPos.push(0);
    }
    bandScratch = [];
    bandDelayRing = [];
    bandDelayPos = [];
    for (let b = 0; b < MAX_BANDS; b++) {
      const chans: Float32Array[] = [];
      const rings: Float32Array[] = [];
      const poss: number[] = [];
      for (let c = 0; c < channelCount; c++) {
        chans.push(new Float32Array(maxBlockSize));
        rings.push(new Float32Array(ALIGN_MAX));
        poss.push(0);
      }
      bandScratch.push(chans);
      bandDelayRing.push(rings);
      bandDelayPos.push(poss);
    }
  }

  function clearAlignRings(): void {
    for (const r of dryDelayRing) r.fill(0);
    for (let c = 0; c < dryDelayPos.length; c++) dryDelayPos[c] = 0;
    for (const rings of bandDelayRing) for (const r of rings) r.fill(0);
    for (const poss of bandDelayPos) for (let c = 0; c < poss.length; c++) poss[c] = 0;
  }

  /** Max latency across the active bands (0 or 8 today). */
  function maxBandLatency(): number {
    let maxLat = 0;
    for (let b = 0; b < bandCount; b++) {
      const lat = bands[b].getLatencySamples();
      if (lat > maxLat) maxLat = lat;
    }
    return Math.min(ALIGN_MAX, maxLat);
  }

  /** Push current stored values down to the active sub-components. */
  function applyAllParams(): void {
    // Crossover config. Bulk loads (constructor, presets, state restore) can
    // carry crossing splits — the schema ranges allow it — so the resolved
    // set is clamped ascending before it reaches the bank, and the clamped
    // values are written back so the flat store stays the single source of
    // truth for serialization and neighbour lookups.
    const freqs = [
      values["crossoverFreq2"],
      values["crossoverFreq3"],
      values["crossoverFreq4"],
      values["crossoverFreq5"],
    ].filter((f) => f !== undefined);
    const resolvedFreqs = freqs.length ? freqs : [...DEFAULT_CROSSOVER_FREQS];
    monotonicClampFreqs(resolvedFreqs);
    crossover.setCrossoverFreqs(resolvedFreqs);
    for (let i = 0; i < resolvedFreqs.length && i < xoverFreqTarget.length; i++) {
      values[`crossoverFreq${i + 2}`] = resolvedFreqs[i];
      xoverFreqTarget[i] = resolvedFreqs[i];
      xoverFreqCurrent[i] = resolvedFreqs[i];
    }

    // Limiter.
    limiter.setParameter("enabled", values["limiterEnabled"] ?? 1);
    limiter.setParameter("ceilDb", values["limiterCeilDb"] ?? -0.3);
    limiter.setParameter("truePeak", values["limiterTruePeak"] ?? 1);
    limiter.setParameter("lookaheadMs", values["limiterLookaheadMs"] ?? 2);
    limiter.setParameter("pdr", values["limiterPdr"] ?? 0);

    // Bands.
    for (let b = 1; b <= bandCount; b++) {
      const eng = bands[b - 1];
      // Push every band-scalar parameter down to the engine. The
      // previous version of this loop only pushed gainDb / enabled /
      // mix, which silently dropped all of the dynamic EQ, M/S, mute,
      // solo, phase-invert, sidechain, quality and link-group values
      // supplied via the params object at construction time. Now we
      // walk BAND_SCALAR_DEFS so any future scalar is picked up too.
      for (const def of BAND_SCALAR_DEFS) {
        const fullId = `band${b}.${def.id}`;
        eng.setBandParam(def.id, values[fullId] ?? def.defaultValue);
      }
      // Module params: scan schema routes for this band's module entries.
      for (const [fullId, route] of schema.routes) {
        if (route.band === b && route.kind === "module" && route.moduleKey) {
          eng.setModuleParam(route.moduleKey, route.rawId, values[fullId] ?? 0);
        }
      }
    }
  }

  function rebuildForBandCount(count: number): void {
    bandCount = clamp(Math.round(count), 2, MAX_BANDS);
    schema = buildSchema(bandCount);
    // Merge: keep existing values, add new defaults for newly-added params.
    const merged: Record<string, number> = { ...schema.defaultParams };
    for (const k of Object.keys(values)) if (k in merged) merged[k] = values[k];
    values = merged;
    crossover.setBandCount(bandCount);
  }

  return {
    get parameterDefs() {
      return schema.defs;
    },

    prepare(sr, cc, maxBs) {
      sampleRate = clamp(sr, 8000, 192000);
      channelCount = Math.max(1, cc);
      maxBlockSize = Math.max(1, maxBs);
      allocBuffers(maxBlockSize);
      crossover.prepare(sampleRate, channelCount, maxBlockSize);
      for (let b = 0; b < MAX_BANDS; b++) bands[b].prepare(sampleRate, channelCount, maxBlockSize);
      limiter.prepare(sampleRate, channelCount, maxBlockSize);

      // DC-blocking HP filter: 1st-order, cutoff ~15 Hz.
      // y[n] = x[n] - x[n-1] + alpha * y[n-1]
      // alpha = exp(-2π * fc / sr) ≈ exp(-2π * 15 / sr)
      dcAlpha = Math.exp((-2 * Math.PI * 15) / sampleRate);
      dcPrevIn = new Float32Array(channelCount);
      dcPrevOut = new Float32Array(channelCount);

      xoverSmoothCoef = 1 - Math.exp((-2 * Math.PI * 10) / sampleRate);

      applyAllParams();
      prepared = true;
    },

    process(channels, frameCount) {
      if (!prepared) return;

      // Validate before touching the input or any state. The legacy core is a
      // bounded DSP entrypoint; host adapters must chunk oversized blocks.
      // This replaces the old dev-only throw / production clamp, which could
      // sanitize and mutate part of an invalid block before rejecting it.
      assertAudioBlock(channels, frameCount, maxBlockSize, "FXEQ legacy processor", channelCount);
      if (frameCount === 0) return;

      // Sanitize input: contain NaN/Inf from host.
      for (let c = 0; c < channelCount; c++) {
        const buf = channels[c];
        for (let i = 0; i < frameCount; i++) {
          if (!Number.isFinite(buf[i])) buf[i] = 0;
        }
      }

      // DC-blocking HP filter (~15 Hz) — removes DC offset that would
      // otherwise be amplified by saturation, reverb, and other nonlinear
      // effects. Standard 1st-order: y[n] = x[n] - x[n-1] + α·y[n-1]
      if (dcPrevIn.length >= channelCount) {
        for (let c = 0; c < channelCount; c++) {
          const buf = channels[c];
          let prevIn = dcPrevIn[c];
          let prevOut = dcPrevOut[c];
          for (let i = 0; i < frameCount; i++) {
            const x = buf[i];
            const y = x - prevIn + dcAlpha * prevOut;
            prevIn = x;
            prevOut = y;
            buf[i] = y;
          }
          dcPrevIn[c] = prevIn;
          dcPrevOut[c] = prevOut;
        }
      }

      // A/B morph: interpolate the precompiled parameter set and route only
      // the morphed entries (see the morph state comment — no per-block
      // applyAllParams on the audio thread).
      if (morphing && morphEntries) {
        const blockDur = frameCount / sampleRate;
        morphElapsed += blockDur;
        const t = Math.min(1, morphElapsed / morphDuration);
        const entries = morphEntries;
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const v = entry.start + (entry.end - entry.start) * t;
          values[entry.id] = v;
          routeParam(entry.route, v);
        }
        if (t >= 1) {
          morphing = false;
          morphEntries = null;
          // Pin the exact end state once (and snap the crossover frequency
          // smoothing to it) instead of leaving it to the next param event.
          if (prepared) applyAllParams();
        }
      }

      // Input gain on the working signal first (audit M2): the dry
      // snapshot below must capture the GAINED signal so input gain
      // affects both legs of the global wet/dry mix — matching the v2
      // processor's semantics.
      const inGain = dbToLinear(values["inputGainDb"] ?? 0);
      if (inGain !== 1) {
        for (let c = 0; c < channelCount; c++) {
          const buf = channels[c];
          for (let i = 0; i < frameCount; i++) buf[i] *= inGain;
        }
      }

      // Snapshot dry signal (post input-gain).
      for (let c = 0; c < channelCount; c++) {
        dryBuf[c].set(channels[c].subarray(0, frameCount));
      }

      // Smooth crossover frequencies to eliminate zipper noise.
      let xoverDirty = false;
      for (let i = 0; i < bandCount - 1; i++) {
        const diff = xoverFreqTarget[i] - xoverFreqCurrent[i];
        if (Math.abs(diff) > 0.01) {
          xoverFreqCurrent[i] += xoverSmoothCoef * diff;
          xoverDirty = true;
        } else if (diff !== 0) {
          xoverFreqCurrent[i] = xoverFreqTarget[i];
          xoverDirty = true;
        }
      }
      if (xoverDirty) {
        for (let i = 0; i < bandCount - 1; i++) {
          crossover.setCrossoverFreq(i, xoverFreqCurrent[i]);
        }
      }

      // Split into bands (writes into crossover internal buffers).
      crossover.process(channels, frameCount);

      // Solo logic: if ANY band has solo=1, only soloed bands contribute.
      let anySolo = false;
      for (let b = 0; b < bandCount; b++) {
        if (bands[b].getBandParam("solo") >= 0.5) { anySolo = true; break; }
      }

      // Sum band outputs into wetBuf, aligning every band to the loudest
      // band latency so a delay-carrying band (oversampled saturation)
      // no longer combs against zero-latency siblings (audit C2).
      const alignLat = maxBandLatency();
      if (alignLat > 0) ringsLive = true;
      for (let c = 0; c < channelCount; c++) wetBuf[c].fill(0, 0, frameCount);
      for (let b = 0; b < bandCount; b++) {
        const bandChannels = crossover.getBand(b);
        const scratch = bandScratch[b];
        // Copy band data into preallocated scratch (no allocation).
        for (let c = 0; c < channelCount; c++) {
          scratch[c].set(bandChannels[c].subarray(0, frameCount));
        }
        // Pass sidechain to band engine if available. Soloed-out bands (when
        // any other band is soloed) KEEP CLOCKING here — their delay/reverb
        // tails, LFOs and envelopes stay live and their meters keep tracking —
        // and only their contribution to the sum is muted below. The old code
        // skipped process() entirely for soloed-out bands, which froze the
        // band mid-tail: un-soloing resumed stale content. Solo is a
        // temporary monitoring state, so the extra CPU is bounded to the
        // solo window.
        bands[b].process(scratch, frameCount, sidechainChannels ?? undefined);
        // If any band is soloed, mute non-soloed bands (after clocking).
        if (anySolo && bands[b].getBandParam("solo") < 0.5) {
          for (let c = 0; c < channelCount; c++) scratch[c].fill(0, 0, frameCount);
        }
        const bandLat = Math.min(
          ALIGN_MAX,
          Math.max(0, bands[b].getLatencySamples()),
        );
        const dly = Math.max(0, alignLat - bandLat);
        for (let c = 0; c < channelCount; c++) {
          const dst = wetBuf[c];
          const src = scratch[c];
          // While a latency period is (or has been) live, the ring is
          // clocked EVERY block — even at dly === 0 — so it always holds
          // the band's live 8-sample history for the next 0→8 transition.
          // Before the first latency period (ringsLive false) the direct
          // path is bit-identical to the old behaviour.
          if (dly === 0 && !ringsLive) {
            for (let i = 0; i < frameCount; i++) dst[i] += src[i];
          } else {
            const ring = bandDelayRing[b][c];
            let pos = bandDelayPos[b][c];
            if (dly === 0) {
              for (let i = 0; i < frameCount; i++) {
                ring[pos] = src[i];
                pos = (pos + 1) % ALIGN_MAX;
                dst[i] += src[i];
              }
            } else {
              for (let i = 0; i < frameCount; i++) {
                const delayed = ring[(pos - dly + ALIGN_MAX) % ALIGN_MAX];
                ring[pos] = src[i];
                pos = (pos + 1) % ALIGN_MAX;
                dst[i] += delayed;
              }
            }
            bandDelayPos[b][c] = pos;
          }
        }
      }

      // Global wet/dry mix, or FX-only (drop dry). The dry snapshot is
      // delayed by the shared band alignment latency so dry and wet stay
      // on one timeline (audit C2).
      const fxOnly = (values["fxOnly"] ?? 0) >= 0.5;
      const wetGain = clamp(values["globalMix"] ?? 100, 0, 100) / 100;
      const dryGain = fxOnly ? 0 : 1 - wetGain;
      for (let c = 0; c < channelCount; c++) {
        const out = channels[c];
        const wet = wetBuf[c];
        const dry = dryBuf[c];
        // Same ringsLive rule as the band rings: the dry ring keeps live
        // history through zero-latency periods once one has been live, so
        // the delayed dry read never replays the previous period's content.
        if (alignLat === 0 && !ringsLive) {
          for (let i = 0; i < frameCount; i++) {
            out[i] = dry[i] * dryGain + wet[i] * wetGain;
          }
        } else {
          const ring = dryDelayRing[c];
          let pos = dryDelayPos[c];
          if (alignLat === 0) {
            for (let i = 0; i < frameCount; i++) {
              ring[pos] = dry[i];
              pos = (pos + 1) % ALIGN_MAX;
              out[i] = dry[i] * dryGain + wet[i] * wetGain;
            }
          } else {
            for (let i = 0; i < frameCount; i++) {
              const delayedDry = ring[(pos - alignLat + ALIGN_MAX) % ALIGN_MAX];
              ring[pos] = dry[i];
              pos = (pos + 1) % ALIGN_MAX;
              out[i] = delayedDry * dryGain + wet[i] * wetGain;
            }
          }
          dryDelayPos[c] = pos;
        }
      }

      // Output limiter.
      limiter.process(channels, frameCount);

      // Output gain.
      const outGain = dbToLinear(values["outputGainDb"] ?? 0);
      if (outGain !== 1) {
        for (let c = 0; c < channelCount; c++) {
          const buf = channels[c];
          for (let i = 0; i < frameCount; i++) buf[i] *= outGain;
        }
      }

      // Final output sanitization.
      for (let c = 0; c < channelCount; c++) {
        const buf = channels[c];
        for (let i = 0; i < frameCount; i++) {
          if (!Number.isFinite(buf[i])) buf[i] = 0;
        }
      }
    },

    reset() {
      crossover.reset();
      for (const b of bands) b.reset();
      limiter.reset();
      dcPrevIn.fill(0);
      dcPrevOut.fill(0);
      clearAlignRings();
      ringsLive = false;
    },

    getLatencySamples() {
      // Shared band alignment delay + limiter latency. Hosts use this for
      // PDC; the band alignment ring delays both dry and wet by the same
      // amount, so the reported figure matches the audible timeline.
      return maxBandLatency() + limiter.getLatencySamples();
    },

    setParameter(id, value) {
      const route = schema.routes.get(id);
      if (!route) return;
      // Same guard as loadParameters (audit C4): automation curves must not
      // be able to poison band scalar state — and the same schema-range
      // clamp: per-block consumers (input/output gain) read `values` raw,
      // so an out-of-range value must never land in the flat store.
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      const def = schema.defById.get(id);
      if (def) value = Math.max(def.minValue, Math.min(def.maxValue, value));
      // Record previous value for undo.
      const oldValue = values[id] ?? 0;
      if (oldValue !== value) history.push(id, oldValue);
      values[id] = value;
      routeParam(route, value);
    },

    getParameter(id) {
      return values[id] ?? 0;
    },

    getParameters() {
      return { ...values };
    },

    loadParameters(p) {
      // Handle bandCount changes first (rebuilds schema/routes).
      if (p["bandCount"] !== undefined && p["bandCount"] !== bandCount) {
        rebuildForBandCount(p["bandCount"]);
      }
      for (const id of Object.keys(p)) {
        const route = schema.routes.get(id);
        if (!route) continue;
        const incoming = p[id];
        // Audit C4 (v1 surface): a NaN/±Infinity from a corrupt preset or
        // host state used to land in `values` verbatim — band scalars are
        // consumed raw (gain smoothing, dyn EQ thresholds), so one NaN
        // poisoned the band until reset. Clamp to the schema range and
        // drop non-finite values; module params re-clamp downstream.
        if (typeof incoming !== "number" || !Number.isFinite(incoming)) continue;
        const def = schema.defById.get(id);
        values[id] = def
          ? Math.max(def.minValue, Math.min(def.maxValue, incoming))
          : incoming;
      }
      applyAllParams();
    },

    setSidechain(channels) {
      sidechainChannels = channels;
    },

    setTempo(nextBpm) {
      if (typeof nextBpm !== "number" || !Number.isFinite(nextBpm)) return;
      const bpm = Math.min(999, Math.max(20, nextBpm));
      // Every engine, not just the active bands: a bandCount change later
      // must find the current tempo already in place.
      for (let b = 0; b < MAX_BANDS; b++) bands[b].setTempo(bpm);
    },

    get canUndo() { return history.canUndo; },
    get canRedo() { return history.canRedo; },

    undo() {
      const entry = history.undo();
      if (!entry) return null;
      values[entry.id] = entry.value;
      const route = schema.routes.get(entry.id);
      if (route && prepared) routeParam(route, entry.value);
      return entry;
    },

    redo() {
      const entry = history.redo();
      if (!entry) return null;
      values[entry.id] = entry.value;
      const route = schema.routes.get(entry.id);
      if (route && prepared) routeParam(route, entry.value);
      return entry;
    },

    get isMorphing() { return morphing; },

    getBandPeaks() {
      const peaks = new Float32Array(bandCount);
      for (let b = 0; b < bandCount; b++) {
        peaks[b] = bands[b].getBandPeak();
      }
      return peaks;
    },

    startMorph(target, durationSec) {
      // Precompile once: resolve every target id to its route snapshot and
      // capture the start value. Non-finite targets are dropped here so a
      // corrupt morph cannot poison DSP state mid-interpolation (same guard
      // as loadParameters), and the schema range is clamped so interpolated
      // `values` stay valid for per-block raw consumers (same clamp as
      // setParameter). Unknown ids are skipped, matching setParameter.
      const entries: MorphEntry[] = [];
      for (const id of Object.keys(target)) {
        let end = target[id];
        if (typeof end !== "number" || !Number.isFinite(end)) continue;
        const route = schema.routes.get(id);
        if (!route) continue;
        const def = schema.defById.get(id);
        if (def) end = Math.max(def.minValue, Math.min(def.maxValue, end));
        entries.push({ id, route, start: values[id] ?? 0, end });
      }
      morphEntries = entries;
      morphDuration = Math.max(0.01, durationSec);
      morphElapsed = 0;
      morphing = true;
    },
  };

  /** Route a single parameter change to the relevant sub-component. */
  function routeParam(route: RouteEntry, value: number): void {
    // bandCount rebuilds the schema/routes regardless of prepare state —
    // it only touches data structures, not the DSP runtime.
    if (route.kind === "global" && route.rawId === "bandCount") {
      rebuildForBandCount(value);
      if (prepared) applyAllParams();
      return;
    }
    if (!prepared) return;
    if (route.kind === "global") {
      switch (route.rawId) {
        case "crossoverFreq2":
        case "crossoverFreq3":
        case "crossoverFreq4":
        case "crossoverFreq5": {
          const idx = Number(route.rawId.slice(-1)) - 2;
          // Q5: clamp against stored neighbours and write back, so the flat
          // store, the smoothing target and the crossover never disagree.
          const clamped = clampXoverTarget(idx, value);
          values[route.rawId] = clamped;
          xoverFreqTarget[idx] = clamped;
          break;
        }
        case "limiterEnabled":
          limiter.setParameter("enabled", value);
          break;
        case "limiterCeilDb":
          limiter.setParameter("ceilDb", value);
          break;
        case "limiterTruePeak":
          limiter.setParameter("truePeak", value);
          break;
        case "limiterLookaheadMs":
          limiter.setParameter("lookaheadMs", value);
          break;
        case "limiterPdr":
          limiter.setParameter("pdr", value);
          break;
        // inputGainDb/outputGainDb/globalMix/fxOnly are read each block.
        default:
          break;
      }
      return;
    }
    if (route.kind === "bandScalar") {
      const srcBand = route.band - 1;
      bands[srcBand]?.setBandParam(route.rawId, value);

      // Link group propagation: if the source band belongs to a non-zero
      // link group, apply the same parameter change to all other bands
      // in the same group. This avoids recursion (we only propagate from
      // bandScalar params, not from the propagation itself).
      const srcGroup = bands[srcBand]?.getBandParam("linkGroup") ?? 0;
      if (srcGroup > 0 && route.rawId !== "linkGroup") {
        for (let b = 0; b < bandCount; b++) {
          if (b === srcBand) continue;
          if ((bands[b].getBandParam("linkGroup") ?? 0) === srcGroup) {
            bands[b].setBandParam(route.rawId, value);
            // Also update the flat value store for serialization.
            const linkedId = `band${b + 1}.${route.rawId}`;
            if (values[linkedId] !== undefined) values[linkedId] = value;
          }
        }
      }
      return;
    }
    if (route.kind === "module" && route.moduleKey) {
      bands[route.band - 1]?.setModuleParam(route.moduleKey, route.rawId, value);
    }
  }
}

function mixSeed(seed: number, salt: number): number {
  let value = (seed ^ Math.imul(salt, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = (value ^ (value >>> 16)) >>> 0;
  return value === 0 ? 0x1 : value;
}
