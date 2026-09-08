import type { EffectRuntime } from "../effects/types";
import type { EffectInstance } from "../project-model/types";
import { capUserIrFrames } from "./ozvena-params";
import { generateFactoryIr, generateFactoryIr4 } from "./ozvena-core/modules/factoryIr";

/**
 * Build the interleaved factory-IR payload for the worklet (same shape
 * logic as the core's inline default provider: the 4-channel true-stereo
 * IR when the catalogue has one, mono broadcast to interleaved stereo
 * otherwise). Runs on the MAIN thread — single-digit ms per (id, rate),
 * off the audio rendering thread; the generator's own bounded cache makes
 * repeated requests free.
 */
function buildFactoryIrPayload(
  irId: string,
  sampleRate: number,
): { samples: Float32Array; channels: 1 | 2 | 4 } | null {
  const quad = generateFactoryIr4(irId, sampleRate);
  if (quad) return { samples: quad, channels: 4 };
  const mono = generateFactoryIr(irId, sampleRate);
  if (!mono) return null;
  const stereo = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    stereo[2 * i] = mono[i];
    stereo[2 * i + 1] = mono[i];
  }
  return { samples: stereo, channels: 2 };
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
    const msg = event.data as
      | { type?: string; samples?: number; irId?: string; sampleRate?: number }
      | null;
    if (msg?.type === "latency" && typeof msg.samples === "number") {
      latencySamples = msg.samples;
      if (!disposed) for (const listener of latencyListeners) listener();
    } else if (msg?.type === "irNeeded" && typeof msg.irId === "string") {
      // The worklet's factory-IR provider asks the main thread to generate
      // (audio-thread-free selection). Reply with the payload — cloned, not
      // transferred, so the generator's bounded cache stays reusable.
      if (disposed) return;
      const sr =
        typeof msg.sampleRate === "number" && Number.isFinite(msg.sampleRate) && msg.sampleRate > 0
          ? msg.sampleRate
          : ctx.sampleRate;
      const payload = buildFactoryIrPayload(msg.irId, sr);
      node.port.postMessage(
        payload
          ? { type: "factoryIr", irId: msg.irId, samples: payload.samples, channels: payload.channels }
          : { type: "factoryIr", irId: msg.irId, samples: null, channels: 1 },
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
      // Time-based cap: a mistaken long file must not be interleaved,
      // transferred and convolved in full (the worklet re-clamps at its own
      // boundary — this avoids shipping the wasted payload at all).
      const len = capUserIrFrames(ir.length, ir.sampleRate);
      if (len <= 0) return;
      const interleaved = new Float32Array(len * chCount);
      const left = ir.getChannelData(0);
      const right = chCount === 2 ? ir.getChannelData(1) : left;
      for (let i = 0; i < len; i++) {
        interleaved[i * 2] = left[i];
        interleaved[i * 2 + 1] = right[i];
      }
      node.port.postMessage(
        { type: "loadIr", samples: interleaved, channels: chCount },
        [interleaved.buffer],
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
