/**
 * STRUNA native fallback runtime (ADR 0061 §7) — used only when the worklet
 * module is unavailable. A detuned saw through one static bandpass at the
 * A-vowel F1 (800 Hz): audible, vocal-ISH, never a dead graph.
 */

import type { InstrumentTrack } from "../project-model/types";
import type { InstrumentRuntime } from "./types";

interface FallbackVoice {
  osc: OscillatorNode;
  noise: OscillatorNode;
  bp: BiquadFilterNode;
  vca: GainNode;
}

export function createStrunaFallbackRuntime(ctx: BaseAudioContext, track: InstrumentTrack): InstrumentRuntime {
  const output = ctx.createGain();
  let params: Record<string, number> = { ...track.params };
  const voices = new Map<number, FallbackVoice>();

  const param = (name: string, fallback: number): number =>
    Number.isFinite(params[name]) ? (params[name] as number) : fallback;

  const stopVoice = (pitch: number, when: number) => {
    const voice = voices.get(pitch);
    if (!voice) return;
    voices.delete(pitch);
    const release = Math.max(0.02, param("release", 0.25));
    try {
      voice.vca.gain.cancelScheduledValues(when);
      voice.vca.gain.setTargetAtTime(0, when, release * 0.35);
      voice.osc.stop(when + release * 2 + 0.05);
      voice.noise.stop(when + release * 2 + 0.05);
    } catch {
      /* already stopped */
    }
  };

  return {
    output,
    noteOn(pitch, velocity, when) {
      const baseHz = 440 * Math.pow(2, (pitch - 69) / 12);
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(baseHz, when);
      // The breath stand-in: an inaudible-frequency oscillator into the same
      // filter reads as air once the bandpass shapes it.
      const noise = ctx.createOscillator();
      noise.type = "triangle";
      noise.frequency.setValueAtTime(baseHz * 1.004, when);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(640, when);
      bp.Q.value = 2.5;
      const vca = ctx.createGain();
      const level = param("level", 0.8) * 0.3 * velocity;
      vca.gain.setValueAtTime(0.0001, when);
      vca.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), when + Math.min(1, param("attack", 0.02)));
      osc.connect(bp);
      noise.connect(bp);
      bp.connect(vca).connect(output);
      osc.start(when);
      noise.start(when);
      voices.set(pitch, { osc, noise, bp, vca });
    },
    noteOff(pitch, when) {
      stopVoice(pitch, when);
    },
    polyPressure() {},
    polyTimbre() {},
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
