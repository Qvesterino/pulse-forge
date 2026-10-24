/**
 * ŠTRK native fallback (ADR 0060 §7) — a noise burst through a bandpass +
 * a short sine body: audible, never a dead graph.
 */

import type { InstrumentTrack } from "../project-model/types";
import type { InstrumentRuntime } from "./types";

interface FallbackVoice {
  body: OscillatorNode;
  noiseOsc: OscillatorNode;
  bp: BiquadFilterNode;
  vca: GainNode;
}

export function createStrkFallbackRuntime(ctx: BaseAudioContext, track: InstrumentTrack): InstrumentRuntime {
  const output = ctx.createGain();
  let params: Record<string, number> = { ...track.params };
  const voices = new Map<number, FallbackVoice>();

  const param = (name: string, fallback: number): number =>
    Number.isFinite(params[name]) ? (params[name] as number) : fallback;

  const stopVoice = (pitch: number, when: number) => {
    const voice = voices.get(pitch);
    if (!voice) return;
    voices.delete(pitch);
    const release = Math.max(0.02, param("wireDecay", 0.18));
    try {
      voice.vca.gain.cancelScheduledValues(when);
      voice.vca.gain.setTargetAtTime(0, when, release * 0.3);
      voice.body.stop(when + release * 2 + 0.05);
      voice.noiseOsc.stop(when + release * 2 + 0.05);
    } catch {
      /* already stopped */
    }
  };

  return {
    output,
    noteOn(pitch, velocity, when) {
      const bodyHz = 190 * Math.pow(2, (param("tune", 0) + (pitch - 60)) / 12);
      const body = ctx.createOscillator();
      body.type = "triangle";
      body.frequency.setValueAtTime(bodyHz, when);
      const noiseOsc = ctx.createOscillator();
      noiseOsc.type = "sawtooth";
      noiseOsc.frequency.setValueAtTime(bodyHz * 4, when);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(param("wireTone", 3500), when);
      bp.Q.value = 0.9;
      const vca = ctx.createGain();
      const level = param("level", 0.8) * 0.4 * velocity;
      vca.gain.setValueAtTime(0.0001, when);
      vca.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), when + 0.002);
      vca.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.05, param("wireDecay", 0.18)));
      body.connect(vca);
      noiseOsc.connect(bp).connect(vca);
      vca.connect(output);
      body.start(when);
      noiseOsc.start(when);
      voices.set(pitch, { body, noiseOsc, bp, vca });
    },
    noteOff(pitch, when) {
      stopVoice(pitch, when);
    },
    polyPressure() {},
    setSample() {},
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
