/**
 * TSAR runtime bridge (docs/TSAR-ROADMAP.md T1/T5, ADR 0023).
 *
 * Two paths, ONE engine:
 *
 *  - LIVE: an `AudioWorkletNode("tsar-processor")` is created immediately,
 *    its output connects to the track input, and timed events relay through
 *    `port.postMessage` with absolute context times.
 *
 *  - OFFLINE: Chromium does NOT pump worklet message queues during an
 *    `OfflineAudioContext` render — port messages sent before
 *    `startRendering()` surface only after the buffer is done (the wtvoice
 *    silent-export defect). This runtime therefore BUFFERS every timed event
 *    while the renderer schedules notes and, at `prepareOfflineRender()`,
 *    creates the worklet node with `processorOptions.events` seeded. Same
 *    events, same interpreter, same sound (invariant #3).
 *
 * Graph shape is identical on both paths: `output` is a GainNode that the
 * engine connects to the track input. Live, the worklet connects into
 * `output` at build time. Offline, `output` stays silent until the renderer
 * calls `prepareOfflineRender()`, which builds the worklet (seeded with the
 * buffered events) and connects it into `output` — before `startRendering`,
 * so the very first sample renders.
 *
 * Source data: slot A reads `track.sampleId`, slot B `track.sampleIdB`. Each
 * slot uploads BOTH a wavetable (mip level 0 frames) and raw PCM, so the
 * `srcAEngine`/`srcBEngine` params can flip at runtime with no re-upload.
 */

import type { InstrumentRuntime } from "./types";
import type { InstrumentTrack } from "../project-model/types";
import { buildWavetableMips, extractWavetable, FACTORY_WAVETABLES, FRAME_SIZE } from "./wavetables";
import type { TsarEvent } from "../tsar/dsp/tsarProcessor";

export interface TsarRuntime extends InstrumentRuntime {
  /** OFFLINE ONLY — build the seeded worklet and connect it into `output`. */
  prepareOfflineRender?: () => void;
  /** Second source identity (Source B); mirrors `setSample` for slot A. */
  setSampleB?: (id: string | null) => void;
}

export interface TsarRuntimeOptions {
  /** The context's `createGain`/`AudioWorkletNode` access (never a raw ctx import). */
  createGain: () => GainNode;
  createNode: (processorOptions: Record<string, unknown>) => AudioWorkletNode;
  offline: boolean;
  track: InstrumentTrack;
  getSample(id: string | null): AudioBuffer | undefined;
}

export interface TsarFallbackOptions {
  /** The graph factory's context (createGain/createBiquadFilter/createOscillator). */
  ctx: BaseAudioContext;
  track: InstrumentTrack;
}

/**
 * NATIVE FALLBACK VOICE — used only when the TSAR worklet module is not
 * available on the context (a pre-worklet browser; the jsdom graph audit;
 * a failed module fetch). It is a real, audible subtractive voice so the
 * instrument is never a dead graph: oscillator (morph opens a second detuned
 * copy) -> biquad low-pass -> gain envelope. The worklet is the engine; this
 * keeps the promise "a track never silently disappears" when the platform
 * cannot run it. Live↔offline parity is unaffected in any context that HAS
 * the worklet, because the fallback never runs there.
 */
export function createTsarFallbackRuntime(ctx: BaseAudioContext, track: InstrumentTrack): TsarRuntime {
  const output = ctx.createGain();
  let params: Record<string, number> = { ...track.params };
  const voices = new Map<number, { osc: OscillatorNode[]; gain: GainNode; filter: BiquadFilterNode }>();

  const stopVoice = (pitch: number, when: number) => {
    const voice = voices.get(pitch);
    if (!voice) return;
    voices.delete(pitch);
    const release = Math.max(0.01, params.srcARel ?? 0.4);
    try {
      voice.gain.gain.cancelScheduledValues(when);
      voice.gain.gain.setTargetAtTime(0, when, release * 0.35);
      for (const osc of voice.osc) osc.stop(when + release * 2 + 0.05);
    } catch {
      /* already stopped */
    }
  };

  return {
    output,
    noteOn(pitch, velocity, when) {
      const freq = 440 * Math.pow(2, (pitch - 69) / 12);
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(Math.min(18000, params.srcACutoff ?? 12000), when);
      filter.Q.value = Math.max(0.0001, (params.srcAQ ?? 0.8) * 0.2);
      const level = (params.srcALevel ?? 0.8) * (params.level ?? 0.8);
      const attack = Math.max(0.001, params.srcAAtk ?? 0.005);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level * velocity), when + attack);
      gain.connect(filter).connect(output);
      const oscCount = (params.srcAUnison ?? 1) >= 2 ? 2 : 1;
      const oscs: OscillatorNode[] = [];
      for (let i = 0; i < oscCount; i++) {
        const osc = ctx.createOscillator();
        osc.type = (params.srcAMorph ?? 0) > 0.5 ? "sawtooth" : "square";
        const detune = (params.srcAFine ?? 0) + (i === 1 ? (params.srcASpread ?? 0) : 0);
        osc.frequency.setValueAtTime(freq, when);
        osc.detune.setValueAtTime(detune, when);
        osc.connect(gain);
        osc.start(when);
        oscs.push(osc);
      }
      voices.set(pitch, { osc: oscs, gain, filter });
    },
    noteOff(pitch, when) {
      stopVoice(pitch, when);
    },
    setSample() {
      // The fallback has no sample playback; the worklet owns that.
    },
    setVelocityLayers() {},
    syncBpm() {},
    setParameter(id, value) {
      if (Number.isFinite(value)) params = { ...params, [id]: value };
    },
    panic() {
      for (const pitch of [...voices.keys()]) stopVoice(pitch, ctx.currentTime);
    },
    dispose() {
      this.panic();
      output.disconnect();
    },
  };
}

interface SlotUpload {
  wavetable: { slot: 0 | 1; frames: Float32Array; frameCount: number };
  sample: { slot: 0 | 1; pcm: Float32Array; rootHz: number };
}

/** Flatten a mip level's frames (Float32Array[]) into one contiguous buffer. */
function flattenFrames(frames: Float32Array[], frameSize: number): Float32Array {
  const flat = new Float32Array(frames.length * frameSize);
  for (let f = 0; f < frames.length; f++) flat.set(frames[f]!, f * frameSize);
  return flat;
}

export function createTsarRuntime(options: TsarRuntimeOptions): TsarRuntime {
  const { offline, getSample } = options;
  const output = options.createGain();
  const pendingEvents: TsarEvent[] = [];
  let pendingBpm: number | null = null;
  let currentTrack = { ...options.track };
  let node: AudioWorkletNode | null = null;

  /** Root frequency per slot: the per-slot ROOT param is the real contract. */
  const rootHzFor = (slot: 0 | 1): number => {
    const midi = (slot === 0 ? currentTrack.params.srcARoot : currentTrack.params.srcBRoot) ?? 60;
    return 440 * Math.pow(2, ((Number.isFinite(midi) ? midi : 60) - 69) / 12);
  };

  const uploadFor = (slot: 0 | 1, sampleId: string | null): SlotUpload | null => {
    const buffer = sampleId ? getSample(sampleId) : undefined;
    if (!buffer) return null;
    const pcm = buffer.getChannelData(0);
    const table = extractWavetable(pcm, buffer.sampleRate) ?? FACTORY_WAVETABLES[0]!;
    const mips = buildWavetableMips(table.frames);
    return {
      wavetable: {
        slot,
        frames: flattenFrames(mips.levels[0] ?? table.frames, FRAME_SIZE),
        frameCount: table.frames.length,
      },
      sample: { slot, pcm: new Float32Array(pcm), rootHz: rootHzFor(slot) },
    };
  };

  const uploadAll = () =>
    [uploadFor(0, currentTrack.sampleId), uploadFor(1, currentTrack.sampleIdB ?? null)].filter(
      (u): u is SlotUpload => u !== null,
    );

  /** Param snapshot the engine pushed at build time. */
  const paramsSnapshot = (): Record<string, number> => ({ ...currentTrack.params });

  const connectNode = (built: AudioWorkletNode) => {
    built.connect(output);
    node = built;
  };

  if (!offline) {
    const uploads = uploadAll();
    connectNode(
      options.createNode({
        params: paramsSnapshot(),
        wavetables: uploads.map((u) => u.wavetable),
        samples: uploads.map((u) => u.sample),
        bpm: pendingBpm ?? undefined,
      }),
    );
  }

  const forward = (event: TsarEvent) => {
    if (node) {
      node.port.postMessage({
        type: event.type,
        when: event.when,
        pitch: event.pitch,
        velocity: event.velocity,
        value: event.value,
        name: event.name,
      });
    } else {
      pendingEvents.push(event);
    }
  };

  const runtime: TsarRuntime = {
    output,
    noteOn(pitch, velocity, when) {
      forward({ type: "noteOn", pitch, velocity, when });
    },
    noteOff(pitch, when) {
      forward({ type: "noteOff", pitch, when });
    },
    polyPressure(pitch, pressure, when) {
      forward({ type: "pressure", pitch, when, value: pressure });
    },
    setSample(id) {
      currentTrack = { ...currentTrack, sampleId: id };
      if (!node) return;
      const upload = uploadFor(0, id);
      if (upload) {
        node.port.postMessage({ type: "wavetable", ...upload.wavetable });
        node.port.postMessage({ type: "sample", ...upload.sample });
      }
    },
    setSampleB(id) {
      currentTrack = { ...currentTrack, sampleIdB: id };
      if (!node) return;
      const upload = uploadFor(1, id);
      if (upload) {
        node.port.postMessage({ type: "wavetable", ...upload.wavetable });
        node.port.postMessage({ type: "sample", ...upload.sample });
      }
    },
    setVelocityLayers() {
      // Keyzones / round-robin are sampler features, not TSAR.
    },
    syncBpm(bpm) {
      // The arp clock derives its step length from the project tempo; relay
      // it to the worklet (live and offline both — offline the tempo map is
      // applied by the renderer before startRendering).
      if (!Number.isFinite(bpm) || bpm <= 0) return;
      if (node) node.port.postMessage({ type: "bpm", bpm });
      else pendingBpm = bpm;
    },
    setParameter(name, value) {
      if (!Number.isFinite(value)) return;
      currentTrack = { ...currentTrack, params: { ...currentTrack.params, [name]: value } };
      if (node) {
        node.port.postMessage({ type: "param", name, value });
        // ROOT changes re-derive the slot's PCM root without re-uploading.
        if (name === "srcARoot" || name === "srcBRoot") {
          const slot: 0 | 1 = name === "srcARoot" ? 0 : 1;
          const upload = uploadFor(slot, slot === 0 ? currentTrack.sampleId : (currentTrack.sampleIdB ?? null));
          if (upload) node.port.postMessage({ type: "sample", ...upload.sample });
        }
      } else {
        pendingEvents.push({ type: "param", when: 0, name, value });
      }
    },
    panic() {
      forward({ type: "panic", when: 0 });
      if (!node) pendingEvents.push({ type: "panic", when: 0 });
    },
    dispose() {
      if (node) {
        node.port.postMessage({ type: "panic" });
        node.disconnect();
      }
      output.disconnect();
      node = null;
    },
  };

  if (offline) {
    runtime.prepareOfflineRender = () => {
      if (node) return;
      const uploads = uploadAll();
      connectNode(
        options.createNode({
          params: paramsSnapshot(),
          events: pendingEvents.slice(),
          wavetables: uploads.map((u) => u.wavetable),
          samples: uploads.map((u) => u.sample),
          bpm: pendingBpm ?? undefined,
        }),
      );
    };
  }

  return runtime;
}
