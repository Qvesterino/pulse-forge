/**
 * LADIČ native fallback runtime (ADR 0055 §8) — used only when the worklet
 * module is unavailable (pre-worklet browser, failed fetch, the jsdom graph
 * audit). A real audible 2-op FM voice: modulator osc → gain →
 * carrier.frequency (frequency modulation ≈ phase modulation for sine at
 * moderate index) with a gain envelope. Reads op1/op2 ratio/level from the
 * patch so the fallback follows the patch's core character. Never a dead
 * graph.
 */

import type { InstrumentTrack } from "../project-model/types";
import type { InstrumentRuntime } from "./types";
import { holdParamAt } from "./envelope";

interface FallbackVoice {
  modulator: OscillatorNode;
  carrier: OscillatorNode;
  depth: GainNode;
  vca: GainNode;
}

export function createLadicFallbackRuntime(ctx: BaseAudioContext, track: InstrumentTrack): InstrumentRuntime {
  const output = ctx.createGain();
  let params: Record<string, number> = { ...track.params };
  const voices = new Map<number, FallbackVoice>();

  const param = (name: string, fallback: number): number =>
    Number.isFinite(params[name]) ? (params[name] as number) : fallback;

  const stopVoice = (pitch: number, when: number) => {
    const voice = voices.get(pitch);
    if (!voice) return;
    voices.delete(pitch);
    const release = Math.max(0.02, param("op1Rel", 0.3));
    try {
      holdParamAt(voice.vca.gain, when);
      voice.vca.gain.setTargetAtTime(0, when, release * 0.35);
      voice.modulator.stop(when + release * 2 + 0.05);
      voice.carrier.stop(when + release * 2 + 0.05);
    } catch {
      /* already stopped */
    }
  };

  return {
    output,
    noteOn(pitch, velocity, when) {
      const baseHz = 440 * Math.pow(2, (pitch - 69) / 12);
      const carrier = ctx.createOscillator();
      carrier.type = "sine";
      carrier.frequency.setValueAtTime(baseHz, when);
      const modulator = ctx.createOscillator();
      modulator.type = "sine";
      modulator.frequency.setValueAtTime(baseHz * param("op2Ratio", 2), when);
      const depth = ctx.createGain();
      // op2 level × the carrier frequency ≈ the FM index in Hz.
      depth.gain.setValueAtTime(baseHz * param("op2Level", 0.4) * 2, when);
      modulator.connect(depth).connect(carrier.frequency);
      const vca = ctx.createGain();
      const level = param("level", 0.8) * 0.25 * velocity;
      const attack = Math.min(2, Math.max(0.001, param("op1Atk", 0.005)));
      vca.gain.setValueAtTime(0.0001, when);
      vca.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), when + attack);
      vca.connect(output);
      carrier.connect(vca);
      modulator.start(when);
      carrier.start(when);
      voices.set(pitch, { modulator, carrier, depth, vca });
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
