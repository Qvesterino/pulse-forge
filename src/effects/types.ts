import type { EffectInstance, EffectType } from "../project-model/types";

export interface ParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
  format?: (value: number) => string;
  options?: { value: number; label: string }[];
}

export interface EffectRuntime {
  input: AudioNode;
  output: AudioNode;
  setParameter(id: string, value: number): void;
  setParameterAt?(id: string, value: number, when: number): void;
  syncBpm?(bpm: number): void;
  onTransportStarted?(time: number, beatPhase: number): void;
  /**
   * Optional sidechain feed for sidechain-aware effects (e.g. Sidechain Compressor).
   * Engine calls this once after construction (when `EffectInstance.sidechainTrackId`
   * resolves to a live track) and again with `null` to clear the feed. Implementation
   * is responsible for safe (dis)connection of the feed node.
   */
  setSidechainInput?(node: AudioNode | null): void;
  /**
   * True when this runtime runs a reduced or bypassed fallback because the
   * AudioWorklet DSP is unavailable in this context. The engine reports these
   * (getDegradedFx) so the UI can show a warning badge — fallbacks must never
   * degrade silently.
   */
  degraded?: boolean;
  /** Human-readable explanation shown in the UI badge when `degraded`. */
  degradedReason?: string;
  /**
   * Inherent latency introduced by the effect in seconds (look-ahead etc.).
   * Polled every sync by the engine's minimal PDC (see AudioEngine.syncPdc).
   */
  getLatencySec?(): number;
  /** Latest gain reduction in dB (dynamics processors), for metering. */
  getGainReductionDb?(): number;
  dispose(): void;
}

export interface EffectEnv {
  bpm: number;
}

export type EffectFactory = (ctx: BaseAudioContext, instance: EffectInstance, env: EffectEnv) => EffectRuntime;

export interface EffectDefinition {
  type: EffectType;
  name: string;
  category: "tone" | "dynamics" | "character" | "space" | "movement";
  params: ParamDef[];
  factory: EffectFactory;
}
