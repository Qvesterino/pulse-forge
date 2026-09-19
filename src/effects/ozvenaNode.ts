import type { EffectRuntime } from "../effects/types";
import type { EffectInstance } from "../project-model/types";
import { capUserIrFrames } from "./ozvena-params";
import { generateFactoryIr, generateFactoryIr4 } from "./ozvena-core/modules/factoryIr";
import {
  createZeroedBlockSpectra,
  numPartitionsFor,
  partitionSizeForIr,
  precomputeConvolverSpectra,
  type PrecomputedIrSet,
} from "./ozvena-core/dsp/fftPartitioned";

interface PrecomputedIrPayload {
  channels: 1 | 2 | 4;
  /** One set per convolver slot in the engine's stereo-bus layout:
   *  mono IR → 2 sets sharing one irSpectra; stereo → 2; quad → 4. */
  sets: PrecomputedIrSet[];
}

interface PrecomputedIrTemplate {
  channels: 1 | 2 | 4;
  frames: number;
  partitionSize: number;
  numPartitions: number;
  /** Immutable main-thread spectra, cloned into each transferable payload. */
  spectra: Float64Array[];
}

// A worklet convolver owns a mutable input-spectrum ring, so a cached factory
// IR cannot be handed directly to another instance. Keep the immutable spectra
// on the main side instead and mint fresh spectra + rings for every delivery.
// This preserves fast re-selection without allowing a cache hit to allocate on
// the audio thread. The cap is deliberately small: true-stereo spectra are
// sizeable and factoryIr.ts already keeps a bounded time-domain cache.
const FACTORY_TEMPLATE_CACHE_MAX = 4;
const factoryTemplateCache = new Map<string, PrecomputedIrTemplate>();

/**
 * FFT the per-source-channel IR data into partition spectra — ON THE MAIN
 * THREAD. The per-partition forward-FFT batch (hundreds of FFT-2048s for a
 * multi-second IR) used to run inside the worklet's port handler, i.e. ON
 * THE AUDIO THREAD: a 2–8 ms stall on the first selection of every IR —
 * the kind of dropout users read as "this tool crashes sound". The result
 * ships to the worklet as transferables; arming the convolver there does
 * no FFT work. (Reconciled from Pulse Forge hardening audit, 2026-09-09.)
 */
function makePrecomputedIrTemplate(perChannel: Float32Array[], frames: number): PrecomputedIrTemplate {
  const channels = (perChannel.length >= 4 ? 4 : perChannel.length >= 2 ? 2 : 1) as 1 | 2 | 4;
  const ps = partitionSizeForIr(frames);
  const np = numPartitionsFor(frames, ps);
  const spectra = perChannel
    .slice(0, Math.max(1, Math.min(channels, perChannel.length)))
    .map((ch) => precomputeConvolverSpectra(ch, { partitionSize: ps, irLengthSamples: frames }).irSpectra);
  return { channels, frames, partitionSize: ps, numPartitions: np, spectra };
}

function buildPrecomputedIrPayload(template: PrecomputedIrTemplate): PrecomputedIrPayload {
  // `irSpectra` is immutable and may be retained in the template, but every
  // payload needs its own transferable copy. `blockSpectra` is mutable and
  // must always be newly zeroed for each convolver slot/instance.
  const spectra = template.spectra.map((source) => source.slice());
  const { channels, frames, partitionSize, numPartitions } = template;
  const slots = channels === 1 ? 2 : channels;
  const sets: PrecomputedIrSet[] = [];
  for (let slot = 0; slot < slots; slot++) {
    const srcIdx = Math.min(slot, spectra.length - 1);
    sets.push({
      irSpectra: spectra[srcIdx],
      blockSpectra: createZeroedBlockSpectra(numPartitions, partitionSize),
      numPartitions,
      partitionSize,
      irLengthSamples: frames,
    });
  }
  return { channels, sets };
}

function factoryPrecomputedIrPayload(irId: string, sampleRate: number): PrecomputedIrPayload | null {
  const key = `${irId}:${sampleRate}`;
  const cached = factoryTemplateCache.get(key);
  if (cached) {
    // Map insertion order is our tiny LRU: refresh a hit before returning.
    factoryTemplateCache.delete(key);
    factoryTemplateCache.set(key, cached);
    return buildPrecomputedIrPayload(cached);
  }

  const quad = generateFactoryIr4(irId, sampleRate);
  let template: PrecomputedIrTemplate | null = null;
  if (quad) {
    const frames = quad.length / 4;
    const perChannel = [0, 1, 2, 3].map((channel) => {
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) out[i] = quad[i * 4 + channel];
      return out;
    });
    template = makePrecomputedIrTemplate(perChannel, frames);
  } else {
    const mono = generateFactoryIr(irId, sampleRate);
    if (mono) template = makePrecomputedIrTemplate([mono], mono.length);
  }
  if (!template) return null;

  factoryTemplateCache.set(key, template);
  while (factoryTemplateCache.size > FACTORY_TEMPLATE_CACHE_MAX) {
    const oldest = factoryTemplateCache.keys().next().value;
    if (oldest === undefined) break;
    factoryTemplateCache.delete(oldest);
  }
  return buildPrecomputedIrPayload(template);
}

/** Unique transferable buffers across a payload (shared irSpectra must be
 *  listed once — a duplicate transfer entry throws DataCloneError). */
function payloadTransfers(payload: PrecomputedIrPayload): Transferable[] {
  const out: ArrayBuffer[] = [];
  for (const s of payload.sets) {
    for (const arr of [s.irSpectra, s.blockSpectra]) {
      const buf = arr?.buffer as ArrayBuffer | undefined;
      if (buf && !out.includes(buf)) out.push(buf);
    }
  }
  return out;
}

/**
 * Main-thread Ozvena node: an AudioWorkletNode wrapping the vendored
 * three-engine reverb DSP (E1 Reflections, E2 Plate/Chamber, E3 Hall +
 * pre-delay/EQ/mod/duck/limiter). All audio runs on the worklet; parameters
 * travel over the message port as dotted state paths ("blendPad.x").
 */
export function createOzvenaNode(
  ctx: BaseAudioContext,
  instance: EffectInstance,
  defaults: Record<string, number>,
  initialBpm = 120,
): EffectRuntime {
  const initial: Record<string, number> = { ...defaults, ...instance.params };

  const node = new AudioWorkletNode(ctx, "ozvena-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
    processorOptions: { params: initial, bpm: initialBpm },
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);

  // DSP latency arrives asynchronously over the port — the engine subscribes
  // via onLatencyChange to re-sync PDC the moment it lands instead of
  // waiting for the next document sync.
  let latencySamples = 0;
  const latencyListeners = new Set<() => void>();
  let disposed = false;
  node.port.onmessage = (event) => {
    const msg = event.data as { type?: string; samples?: number; irId?: string; sampleRate?: number } | null;
    if (msg?.type === "latency" && typeof msg.samples === "number") {
      latencySamples = msg.samples;
      if (!disposed) for (const listener of latencyListeners) listener();
    } else if (msg?.type === "irNeeded" && typeof msg.irId === "string") {
      // The worklet's factory-IR provider asks the main thread to generate.
      // Reply with PRECOMPUTED spectra (generation + FFT batch here, off
      // the audio thread); the arrays are transferred, not copied.
      if (disposed) return;
      const sr =
        typeof msg.sampleRate === "number" && Number.isFinite(msg.sampleRate) && msg.sampleRate > 0
          ? msg.sampleRate
          : ctx.sampleRate;
      const payload = factoryPrecomputedIrPayload(msg.irId, sr);
      node.port.postMessage(
        payload
          ? { type: "factoryIr", irId: msg.irId, channels: payload.channels, sets: payload.sets }
          : { type: "factoryIr", irId: msg.irId, samples: null, channels: 1 },
        payload ? payloadTransfers(payload) : [],
      );
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
    setParameter(id: string, value: number) {
      if (disposed) return;
      node.port.postMessage({ type: "param", id, value });
    },
    /**
     * Time-stamped parameter set (automation lanes, offline render). The
     * worklet queues the event and applies it when the render clock reaches
     * `when` — otherwise every point would land at the moment it was
     * posted and exports would lose automation timing entirely.
     */
    setParameterAt(id: string, value: number, when: number) {
      if (disposed) return;
      node.port.postMessage({ type: "paramAt", id, value, when });
    },
    /**
     * Roadmap O7: load a user impulse response (convolution mode). The
     * buffer is interleaved to (1|2) channels and posted as a transferable;
     * the core expects it already at the context sample rate (which
     * decodeAudioData guarantees). Latency re-syncs over the port.
     */
    loadUserIr(ir: AudioBuffer) {
      if (disposed) return;
      const chCount = (ir.numberOfChannels >= 2 ? 2 : 1) as 1 | 2;
      // Time-based cap: a mistaken long file must not be decoded into
      // spectra and convolved in full (the worklet re-clamps at its own
      // boundary — this avoids the wasted FFT work at all).
      const len = capUserIrFrames(ir.length, ir.sampleRate);
      if (len <= 0) return;
      // Per-source-channel copies, then the partition-FFT batch HERE on
      // the main thread (it used to run on the audio thread inside the
      // worklet — a 2–8 ms dropout per load). Ships spectra as
      // transferables.
      const perChannel: Float32Array[] = [];
      for (let c = 0; c < chCount; c++) {
        const src = ir.getChannelData(c);
        const out = new Float32Array(len);
        for (let i = 0; i < len; i++) out[i] = src[i];
        perChannel.push(out);
      }
      const payload = buildPrecomputedIrPayload(makePrecomputedIrTemplate(perChannel, len));
      node.port.postMessage(
        { type: "loadIr", channels: payload.channels, sets: payload.sets },
        payloadTransfers(payload),
      );
    },
    /** Remove a previously loaded user IR (fall back to factory selection). */
    clearUserIr() {
      if (disposed) return;
      node.port.postMessage({ type: "clearIr" });
    },
    /**
     * Live tempo changes: the tempo-synced pre-delay must follow the
     * project BPM (the core clamps 20..300 and re-computes the delay).
     */
    syncBpm(bpm: number) {
      if (disposed || !Number.isFinite(bpm)) return;
      node.port.postMessage({ type: "bpm", bpm });
    },
    dispose() {
      if (disposed) return; // idempotent — engine rebuild paths may re-dispose
      disposed = true;
      latencyListeners.clear();
      node.port.onmessage = null;
      try {
        // The processor's core keeps a module-global IPC peer entry (duck
        // controller) that pins state forever unless explicitly released.
        // The port must NOT be closed here: closing a MessagePort may drop
        // already-queued messages (engine-dependent), which would silently
        // discard this terminal teardown and leak one registry entry per
        // disposed instance over a long session. Dropping the last JS
        // reference to the node lets the implementation close the port
        // after the message has been delivered.
        node.port.postMessage({ type: "dispose" });
      } catch {
        // port already closed
      }
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
