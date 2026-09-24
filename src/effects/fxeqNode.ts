import { snapCrossoverOrder } from "./fxeq-core/dsp/crossoverStage";
import type { EffectRuntime } from "../effects/types";
import type { EffectInstance } from "../project-model/types";

/**
 * Rack ↔ core parameter-id translation. The rack surface (registry params,
 * stored in documents as instance.params) uses `mix`; the vendored core
 * schema names the same control `globalMix`. Without this map the rack's
 * MIX knob is silently dead — the core drops unknown ids (setParameter
 * routes through schema.routes.get). Add an entry here whenever a rack id
 * diverges from its core id; tests/fxeq-rack-contract.test.ts enforces that
 * every registry param resolves through this map or the schema directly.
 */
const RACK_TO_CORE: Record<string, string> = {
  mix: "globalMix",
};

function toCoreId(id: string): string {
  return RACK_TO_CORE[id] ?? id;
}

function normalizeHostValue(id: string, value: number): number {
  if (id === "bandCount") return Math.round(value);
  if (id === "crossoverOrder") return snapCrossoverOrder(value);
  if (id === "crossoverEqualize") return value >= 0.5 ? 1 : 0;
  // Quality backlog A6: doc mix params are 0..1; the deep DSP expects
  // 0..100 — the node bridges at the doc→worklet boundary.
  if (toCoreId(id) === "globalMix") return value * 100;
  return value;
}

/** Morph slot index: 0 = A, 1 = B. */
export type MorphSlot = 0 | 1;

/**
 * Interpolate two snapshot maps for a morph target. Structural crossover
 * settings are excluded because interpolating them would rebuild filter
 * topology or switch the phase path mid-morph (the core's morph perf gate
 * excludes them for the same reason). Non-finite entries ride along from `a` unchanged; the
 * worklet re-clamps every id against the schema on arrival. Exported so the
 * panel commits the SAME blend it scrubbed (what you hear is what the
 * document stores).
 */
export function blendParams(a: Record<string, number>, b: Record<string, number>, t: number): Record<string, number> {
  const out: Record<string, number> = {};
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of ids) {
    if (id === "bandCount" || id === "crossoverOrder" || id === "crossoverEqualize") continue;
    const from = a[id];
    const to = b[id];
    if (typeof from === "number" && Number.isFinite(from) && typeof to === "number" && Number.isFinite(to)) {
      out[id] = from + (to - from) * t;
    } else if (typeof from === "number" && Number.isFinite(from)) {
      out[id] = from;
    } else if (typeof to === "number" && Number.isFinite(to)) {
      out[id] = to;
    }
  }
  return out;
}

/**
 * Main-thread FXEQ node: an AudioWorkletNode wrapping the vendored fxeq DSP
 * (multiband crossover + per-band Sat/LoFi/Mod/Delay/Rev + limiter). All
 * audio runs on the worklet; parameters travel over the message port.
 *
 * The registry exposes a small top-level param surface (input/output gain,
 * band count, global mix, limiter) — the full per-band palette arrives with
 * the EQ-paint editor panel.
 *
 * Input 1 is the optional sidechain feed for spectral ducking: the engine
 * attaches a source via setSidechainInput when the effect's sidechainTrackId
 * resolves; the worklet hands it to the core each block (mono feeds are
 * upmixed) and bands with sidechainMode=1 drive their dynamic EQ from it.
 */
export function createFxEqNode(
  ctx: BaseAudioContext,
  instance: EffectInstance,
  defaults: Record<string, number>,
  seed?: number,
): EffectRuntime {
  // Initial params ride processorOptions so the very first block is already
  // in the right state; later changes go over the port. Defaults first, then
  // EVERY instance param — the fxeq parameter space includes dotted
  // per-band ids ("band2.satDriveDb"…) beyond the rack's top-level surface.
  const initial: Record<string, number> = {};
  for (const [id, value] of Object.entries({ ...defaults, ...instance.params })) {
    initial[toCoreId(id)] = normalizeHostValue(id, value);
  }

  const node = new AudioWorkletNode(ctx, "fxeq-processor", {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
    processorOptions: { params: initial, seed },
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);

  // The worklet reports DSP latency (oversampled bands) after prepare and
  // whenever params change it — consumed by the engine's PDC via
  // getLatencySec() so fxeq tracks stay in phase with the rest of the mix.
  // The report arrives ASYNCHRONOUSLY over the port, so the engine also
  // subscribes via onLatencyChange to re-sync PDC the moment it lands
  // (syncPdc would otherwise compensate 0 until the next document sync).
  let latencySamples = 0;
  // Band-peak metering + limiter gain reduction — pushed by the worklet only
  // while the panel has metering enabled (see setMetersEnabled), polled by
  // the panel through getMeters()/getGainReductionDb().
  let bandPeaks: Float32Array | null = null;
  let gainReductionDb = 0;
  const latencyListeners = new Set<() => void>();

  // A/B morph snapshots (runtime lifetime — they ride chain rebuilds by
  // design: a rebuilt runtime is a fresh plugin instance). The resolved
  // blend is computed HERE, per gesture, and posted as a precompiled morph
  // target so the audio thread only interpolates.
  const morphSlots: [Record<string, number> | null, Record<string, number> | null] = [null, null];

  // History replies are asynchronous. Queue requests so a double-click on
  // undo/redo cannot overwrite the callback belonging to the first reply.
  type HistoryCallback = (entry: { id: string; value: number } | null) => void;
  const historyQueue: { action: "undo" | "redo"; callback: HistoryCallback }[] = [];
  let historyCallback: ((entry: { id: string; value: number } | null) => void) | null = null;
  let historyInFlight = false;

  const pumpHistory = () => {
    if (disposed || historyInFlight || historyQueue.length === 0) return;
    const request = historyQueue.shift()!;
    historyInFlight = true;
    historyCallback = request.callback;
    try {
      node.port.postMessage({ type: request.action });
    } catch {
      const callback = historyCallback;
      historyCallback = null;
      historyInFlight = false;
      try {
        callback?.(null);
      } finally {
        pumpHistory();
      }
    }
  };

  // Sidechain source bookkeeping for clean (dis)connection — the engine
  // attaches/removes track feeds and the runtime must release them on
  // dispose without throwing when already gone.
  let sidechainSource: AudioNode | null = null;

  let disposed = false;
  node.port.onmessage = (event) => {
    const msg = event.data as {
      type?: string;
      samples?: number;
      peaks?: Float32Array;
      gr?: number;
      action?: string;
      id?: string | null;
      value?: number;
    } | null;
    if (msg?.type === "latency" && typeof msg.samples === "number") {
      latencySamples = msg.samples;
      if (!disposed) for (const listener of latencyListeners) listener();
    } else if (msg?.type === "bandPeaks" && msg.peaks instanceof Float32Array) {
      bandPeaks = msg.peaks;
      gainReductionDb = typeof msg.gr === "number" && Number.isFinite(msg.gr) ? msg.gr : 0;
    } else if (msg?.type === "history" && historyCallback) {
      const cb = historyCallback;
      historyCallback = null;
      try {
        cb(typeof msg.id === "string" && typeof msg.value === "number" ? { id: msg.id, value: msg.value } : null);
      } finally {
        historyInFlight = false;
        pumpHistory();
      }
    }
  };

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
    getMeters: () => (bandPeaks ? { bandPeaks, gainReductionDb } : null),
    getGainReductionDb: () => gainReductionDb,
    setMetersEnabled(enabled: boolean) {
      if (disposed) return;
      node.port.postMessage({ type: "setMetersEnabled", enabled });
    },
    setParameter(id: string, value: number) {
      if (disposed) return;
      // The worklet's setParameter validates ids — forward everything,
      // including dotted per-band ids outside the rack surface. Rack ids
      // that diverge from core ids are translated (see RACK_TO_CORE).
      node.port.postMessage({
        type: "param",
        id: toCoreId(id),
        value: normalizeHostValue(id, value),
      });
    },
    /** Time-stamped parameter set for live/offline automation parity. */
    setParameterAt(id: string, value: number, when: number) {
      if (disposed) return;
      node.port.postMessage({
        type: "paramAt",
        id: toCoreId(id),
        value: normalizeHostValue(id, value),
        when,
      });
    },
    /**
     * Gate plugin-internal undo-history recording around engine bulk syncs
     * (document loads, preset applies, project loads replay EVERY param —
     * none of that is a user gesture). The port preserves message order, so
     * params sent between begin and end are never recorded.
     */
    beginParamSync() {
      if (disposed) return;
      node.port.postMessage({ type: "historyRecording", enabled: false });
    },
    endParamSync() {
      if (disposed) return;
      node.port.postMessage({ type: "historyRecording", enabled: true });
    },
    /** In-plugin undo of live parameter tweaks; the restored entry arrives
     *  asynchronously via the callback so the host can write it through. */
    undoParam(onApplied) {
      if (disposed) return;
      historyQueue.push({ action: "undo", callback: onApplied });
      pumpHistory();
    },
    redoParam(onApplied) {
      if (disposed) return;
      historyQueue.push({ action: "redo", callback: onApplied });
      pumpHistory();
    },
    /** Store a full param snapshot into morph slot A (0) or B (1). */
    setMorphSnapshot(slot: MorphSlot, params: Record<string, number> | null) {
      morphSlots[slot] = params ? { ...params } : null;
    },
    getMorphSnapshot(slot: MorphSlot) {
      const snap = morphSlots[slot];
      return snap ? { ...snap } : null;
    },
    /** Glide the plugin to a stored snapshot over durationSec (audio-thread
     *  interpolation via the core's precompiled morph path). */
    morphToSnapshot(slot: MorphSlot, durationSec: number) {
      if (disposed) return;
      const snap = morphSlots[slot];
      if (!snap) return;
      node.port.postMessage({ type: "morph", params: snap, durationSec });
    },
    /** Scrub between snapshots: t = 0 → slot a, 1 → slot b. The blend is
     *  resolved here (main thread) and posted as a short morph target so
     *  the audio thread tracks the gesture without zipper noise. */
    morphBlendSnapshots(a: MorphSlot, b: MorphSlot, t: number, durationSec: number) {
      if (disposed) return;
      const from = morphSlots[a];
      const to = morphSlots[b];
      if (!from || !to) return;
      const clamped = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
      node.port.postMessage({
        type: "morph",
        params: blendParams(from, to, clamped),
        durationSec,
      });
    },
    /**
     * Attach/detach the sidechain feed (engine-side track routing). The
     * source connects to worklet input 1; disconnect mirrors the compressor
     * runtime's tolerant semantics (never throws when already gone).
     */
    setSidechainInput(source: AudioNode | null) {
      if (disposed) return;
      if (sidechainSource === source) return;
      if (sidechainSource) {
        try {
          sidechainSource.disconnect(node);
        } catch {
          /* not connected */
        }
        sidechainSource = null;
      }
      if (source) {
        try {
          source.connect(node, 0, 1);
          sidechainSource = source;
        } catch {
          // A source may disappear during a graph rebuild. Treat it as no
          // sidechain rather than taking down the audio engine.
        }
      }
    },
    syncBpm(bpm: number) {
      // Q2 tempo sync: forwarded to the worklet, which notifies the
      // tempo-aware modules (delay/modulation). Latency is unaffected.
      if (disposed || !Number.isFinite(bpm)) return;
      node.port.postMessage({ type: "bpm", bpm });
    },
    dispose() {
      disposed = true;
      latencyListeners.clear();
      bandPeaks = null;
      gainReductionDb = 0;
      morphSlots[0] = null;
      morphSlots[1] = null;
      historyQueue.length = 0;
      historyInFlight = false;
      historyCallback = null;
      if (sidechainSource) {
        try {
          sidechainSource.disconnect(node);
        } catch {
          /* already gone */
        }
        sidechainSource = null;
      }
      node.port.onmessage = null;
      try {
        node.port.close();
      } catch {
        // already closed
      }
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
