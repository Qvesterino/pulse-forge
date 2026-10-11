/**
 * KOPA runtime bridge (KOPA plan §3.2).
 *
 * Two paths, ONE engine:
 *
 *  - LIVE: an `AudioWorkletNode("kopa-processor")` is created immediately,
 *    its output connects to the track input, and timed events relay through
 *    `port.postMessage` with absolute context times.
 *
 *  - OFFLINE: Chromium does NOT pump worklet message queues during an
 *    `OfflineAudioContext` render. This runtime therefore BUFFERS every
 *    timed event while the renderer schedules notes and, at
 *    `prepareOfflineRender()`, creates the worklet node with
 *    `processorOptions.events` seeded. Same events, same interpreter, same
 *    sound (invariant #3).
 *
 * Graph shape is identical on both paths: `output` is a GainNode that the
 * engine connects to the track input. Live, the worklet connects into
 * `output` at build time. Offline, `output` stays silent until the renderer
 * calls `prepareOfflineRender()`.
 *
 * The NATIVE FALLBACK voice (no worklet available: jsdom graph audit, a
 * pre-worklet browser, a failed fetch) is a real audible kick — oscillator
 * with a pitch ramp plus a noise click shaped by a waveshaper — never a dead
 * graph (the tsarNode precedent).
 */

import type { InstrumentRuntime } from "./types";
import type { InstrumentTrack } from "../project-model/types";
import type { KopaEvent } from "../kopa/dsp/kopaProcessor";

function clampParam(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function harmonicPartialWeight(partial: number, maxPartial: number, tone: number): number {
  if (partial === 2) return maxPartial >= 3 ? 1 - tone : 1;
  if (partial === 3) return tone;
  return 0.25 / (partial - 1);
}

function makeHarmonicCharacterCurve(character: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(257);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = character === 1 ? Math.tanh(x * 1.7) * 0.86 : Math.sin(x * Math.PI);
  }
  return curve;
}

export interface KopaRuntime extends InstrumentRuntime {
  /** OFFLINE ONLY — build the seeded worklet and connect it into `output`. */
  prepareOfflineRender?: () => void;
}

export interface KopaRuntimeOptions {
  /** The context's `createGain`/`AudioWorkletNode` access (never a raw ctx import). */
  createGain: () => GainNode;
  createNode: (processorOptions: Record<string, unknown>) => AudioWorkletNode;
  offline: boolean;
  track: InstrumentTrack;
}

export interface KopaFallbackOptions {
  /** The graph factory's context (createGain/createOscillator/createBufferSource). */
  ctx: BaseAudioContext;
  track: InstrumentTrack;
}

/**
 * NATIVE FALLBACK VOICE — a real kick: body oscillator with an exponential
 * pitch ramp (pitchAmount over pitchTime), a decaying sub sine, and a short
 * noise click through a waveshaper (drive). Every layer is a plain Web Audio
 * node so the graph audit sees a live, reachable chain.
 */
export function createKopaFallbackRuntime(ctx: BaseAudioContext, track: InstrumentTrack): KopaRuntime {
  const output = ctx.createGain();
  let params: Record<string, number> = { ...track.params };
  const voices = new Map<number, { osc: OscillatorNode[]; gain: GainNode }>();
  let voiceId = 0;

  const stopVoice = (id: number, when: number) => {
    const voice = voices.get(id);
    if (!voice) return;
    voices.delete(id);
    const release = 0.02;
    try {
      voice.gain.gain.cancelScheduledValues(when);
      voice.gain.gain.setTargetAtTime(0, when, release);
      for (const osc of voice.osc) osc.stop(when + release * 4 + 0.05);
    } catch {
      /* already stopped */
    }
  };

  return {
    output,
    noteOn(pitch, velocity, when) {
      const keyTrack = (params.keyTrack ?? 1) >= 0.5;
      const base = keyTrack ? 440 * Math.pow(2, (pitch - 69) / 12) : 65.40639132514966;
      const bodyF = base * Math.pow(2, (params.bodyTune ?? 0) / 12);
      const pitchAmount = params.pitchAmount ?? 24;
      const pitchTime = Math.max(0.005, (params.pitchTime ?? 40) / 1000);
      const level = Math.pow(10, (params.level ?? -6) / 20);
      const vel = velocity > 0 ? velocity : 1;
      const harmonicLevel = clampParam(params.harmonicLevel ?? 0.25, 0, 1);
      const harmonicRange = Math.round(clampParam(params.harmonicRange ?? 2, 1, 4));
      const harmonicMaxPartial = Math.pow(2, harmonicRange);
      const harmonicTone = clampParam(params.harmonicTone ?? 0.35, 0, 1);
      const harmonicCharacter = Math.round(clampParam(params.harmonicCharacter ?? 0, 0, 2));
      const harmonicDecay = clampParam(params.harmonicDecay ?? 0.25, 0.03, 2);
      const id = voiceId++;
      const gain = ctx.createGain();
      gain.connect(output);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, 0.9 * vel * level), when + 0.002);
      const oscs: OscillatorNode[] = [];
      // Body with pitch ramp.
      const body = ctx.createOscillator();
      body.type = "sine";
      body.frequency.setValueAtTime(bodyF * Math.pow(2, pitchAmount / 12), when);
      body.frequency.exponentialRampToValueAtTime(Math.max(10, bodyF), when + pitchTime);
      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(0.9, when);
      bodyGain.gain.setTargetAtTime(0, when, Math.max(0.01, (params.bodyDecay ?? 0.35) * 0.33));
      body.connect(bodyGain).connect(gain);
      body.start(when);
      oscs.push(body);
      // Match the KOPA kick-harmonic layer: partials follow the body's pitch sweep,
      // all share its phase, and the fundamental itself is never re-added.
      if (harmonicLevel > 0.001) {
        const firstBodyF = bodyF * Math.pow(2, pitchAmount / 12);
        const partials: { partial: number; weight: number }[] = [];
        let weightSum = 0;
        for (let partial = 2; partial <= harmonicMaxPartial; partial++) {
          if (firstBodyF * partial >= ctx.sampleRate * 0.45) continue;
          const weight = harmonicPartialWeight(partial, harmonicMaxPartial, harmonicTone);
          if (weight <= 0) continue;
          partials.push({ partial, weight });
          weightSum += weight;
        }
        if (weightSum > 0) {
          const harmonicBus = ctx.createGain();
          const harmonicShaper = harmonicCharacter > 0 ? ctx.createWaveShaper() : null;
          if (harmonicShaper) {
            harmonicShaper.curve = makeHarmonicCharacterCurve(harmonicCharacter);
            harmonicShaper.oversample = "2x";
            harmonicBus.connect(harmonicShaper);
          }
          const harmonicEnvelope = ctx.createGain();
          harmonicEnvelope.gain.setValueAtTime(harmonicLevel * 0.55 * vel, when);
          harmonicEnvelope.gain.setTargetAtTime(0, when, Math.max(0.01, harmonicDecay * 0.33));
          if (harmonicShaper) harmonicShaper.connect(harmonicEnvelope);
          else harmonicBus.connect(harmonicEnvelope);
          harmonicEnvelope.connect(gain);

          for (const { partial, weight } of partials) {
            const harmonic = ctx.createOscillator();
            harmonic.type = "sine";
            harmonic.frequency.setValueAtTime(firstBodyF * partial, when);
            harmonic.frequency.exponentialRampToValueAtTime(bodyF * partial, when + pitchTime);
            const partialGain = ctx.createGain();
            partialGain.gain.value = weight / weightSum;
            harmonic.connect(partialGain).connect(harmonicBus);
            harmonic.start(when);
            oscs.push(harmonic);
          }
        }
      }
      // Sub, phase-locked by construction (starts with the body).
      const subLevel = params.subLevel ?? 0.3;
      if (subLevel > 0.001) {
        const sub = ctx.createOscillator();
        sub.type = "sine";
        sub.frequency.setValueAtTime(Math.max(10, bodyF / 2), when);
        const subGain = ctx.createGain();
        subGain.gain.setValueAtTime(0.0001, when);
        subGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, subLevel * 0.5), when + 0.004);
        subGain.gain.setTargetAtTime(0, when, Math.max(0.01, (params.tailDecay ?? 0.4) * 0.33));
        sub.connect(subGain).connect(gain);
        sub.start(when);
        oscs.push(sub);
      }
      // Tail.
      const tailLevel = params.tailLevel ?? 0.25;
      if (tailLevel > 0.001) {
        const tail = ctx.createOscillator();
        tail.type = "sine";
        tail.frequency.setValueAtTime(Math.max(10, bodyF * Math.pow(2, (params.tailTune ?? 0) / 12)), when);
        const tailGain = ctx.createGain();
        tailGain.gain.setValueAtTime(Math.max(0.0001, tailLevel * 0.9), when);
        tailGain.gain.setTargetAtTime(0, when, Math.max(0.01, (params.tailDecay ?? 0.4) * 0.33));
        tail.connect(tailGain).connect(gain);
        tail.start(when);
        oscs.push(tail);
      }
      // Click.
      const clickLevel = params.clickLevel ?? 0.35;
      if (clickLevel > 0.001) {
        const length = Math.max(1, Math.round(((params.clickDecay ?? 3) / 1000) * 4 * ctx.sampleRate));
        const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        let seed = (0x9e3779b9 + id * 0x85ebca6b) >>> 0;
        for (let i = 0; i < length; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          data[i] = ((seed / 0xffffffff) * 2 - 1) * (1 - i / length);
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const clickGain = ctx.createGain();
        clickGain.gain.value = clickLevel * vel;
        source.connect(clickGain).connect(gain);
        source.start(when);
      }
      voices.set(id, { osc: oscs, gain });
    },
    noteOff(_pitch, when) {
      // One-shot kick: noteOff chokes every sounding voice.
      for (const [id] of [...voices]) stopVoice(id, when);
    },
    setParameter(id, value) {
      if (Number.isFinite(value)) params = { ...params, [id]: value };
    },
    panic() {
      for (const id of [...voices.keys()]) stopVoice(id, ctx.currentTime);
    },
    dispose() {
      this.panic();
      output.disconnect();
    },
  };
}

export function createKopaRuntime(options: KopaRuntimeOptions): KopaRuntime {
  const { offline } = options;
  const output = options.createGain();
  const pendingEvents: KopaEvent[] = [];
  let currentTrack = { ...options.track };
  let node: AudioWorkletNode | null = null;

  const paramsSnapshot = (): Record<string, number> => ({ ...currentTrack.params });

  const connectNode = (built: AudioWorkletNode) => {
    built.connect(output);
    node = built;
  };

  if (!offline) {
    connectNode(options.createNode({ params: paramsSnapshot() }));
  }

  const forward = (event: KopaEvent) => {
    if (node) {
      node.port.postMessage({
        type: event.type,
        when: event.when,
        pitch: event.pitch,
        velocity: event.velocity,
        name: event.name,
        value: event.value,
      });
    } else {
      pendingEvents.push(event);
    }
  };

  const runtime: KopaRuntime = {
    output,
    noteOn(pitch, velocity, when) {
      forward({ type: "noteOn", pitch, velocity, when });
    },
    noteOff(pitch, when) {
      forward({ type: "noteOff", pitch, when });
    },
    setVelocityLayers() {
      // Keyzones / round-robin are sampler features, not KOPA.
    },
    syncBpm() {
      // KOPA has no tempo-synced layer (deterministic one-shot).
    },
    setParameter(name, value) {
      if (!Number.isFinite(value)) return;
      currentTrack = { ...currentTrack, params: { ...currentTrack.params, [name]: value } };
      if (node) node.port.postMessage({ type: "param", name, value });
      else pendingEvents.push({ type: "param", when: 0, name, value });
    },
    panic() {
      forward({ type: "panic", when: 0 });
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
      connectNode(options.createNode({ params: paramsSnapshot(), events: pendingEvents.slice() }));
    };
  }

  return runtime;
}
