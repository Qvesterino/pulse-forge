/**
 * CHORÁL native fallback runtime (ADR 0054 §6) — used only when the worklet
 * module is unavailable on the context (pre-worklet browser, failed fetch,
 * the jsdom graph audit). It is a REAL audible choir: each harmony tone is a
 * detuned saw+triangle pair through a lowpass, so the instrument is never a
 * dead graph. Live↔offline parity is unaffected wherever the worklet exists,
 * because the fallback never runs there.
 */

import type { InstrumentTrack } from "../project-model/types";
import type { ChoralRuntime } from "./choralNode";
import { holdParamAt } from "./envelope";

interface FallbackVoice {
  oscs: OscillatorNode[];
  gain: GainNode;
  filter: BiquadFilterNode;
  basePitch: number;
}

export function createChoralFallbackRuntime(ctx: BaseAudioContext, track: InstrumentTrack): ChoralRuntime {
  const output = ctx.createGain();
  let params: Record<string, number> = { ...track.params };
  const voices = new Map<number, FallbackVoice[]>();

  const stackIntervals = (): number[] => {
    const mode = Math.round(params.stackMode ?? 3);
    if (mode === 0) return [0];
    if (mode === 1) return [0, -12, 12];
    if (mode === 2) return [0, 7, -5];
    return [0, 4, 7]; // TRIAD without a context: major (the worklet snaps)
  };

  const stopVoice = (pitch: number, when: number) => {
    const group = voices.get(pitch);
    if (!group) return;
    voices.delete(pitch);
    const release = Math.max(0.02, params.release ?? 0.6);
    for (const voice of group) {
      try {
        holdParamAt(voice.gain.gain, when);
        voice.gain.gain.setTargetAtTime(0, when, release * 0.35);
        for (const osc of voice.oscs) osc.stop(when + release * 2 + 0.05);
      } catch {
        /* already stopped */
      }
    }
  };

  return {
    output,
    noteOn(pitch, velocity, when) {
      const group: FallbackVoice[] = [];
      const baseHz = 440 * Math.pow(2, (pitch - 69) / 12);
      const stackLevel = Math.max(0, Math.min(1, params.stackLevel ?? 0.6));
      for (const [index, interval] of stackIntervals().entries()) {
        const hz = 440 * Math.pow(2, (pitch + interval - 69) / 12);
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(Math.min(9000, 2500 + baseHz * 4), when);
        const level = (params.level ?? 0.8) * (index === 0 ? 1 : stackLevel) * 0.35 * velocity;
        gain.gain.setValueAtTime(0.0001, when);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), when + Math.min(2, params.attack ?? 0.08));
        gain.connect(filter).connect(output);
        const oscs: OscillatorNode[] = [];
        const detune = index === 0 ? 0 : (index % 2 === 0 ? 1 : -1) * (params.stackDetune ?? 8);
        for (const type of ["sawtooth", "triangle"] as const) {
          const osc = ctx.createOscillator();
          osc.type = type;
          osc.frequency.setValueAtTime(hz, when);
          osc.detune.setValueAtTime(detune, when);
          osc.connect(gain);
          osc.start(when);
          oscs.push(osc);
        }
        group.push({ oscs, gain, filter, basePitch: pitch });
      }
      voices.set(pitch, group);
    },
    noteOff(pitch, when) {
      stopVoice(pitch, when);
    },
    polyPressure() {},
    setSample() {
      // The fallback synthesizes; only the worklet replays a source.
    },
    setHarmonyContext() {
      // TRIAD without the worklet: fixed major third (documented in ADR 0054).
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
