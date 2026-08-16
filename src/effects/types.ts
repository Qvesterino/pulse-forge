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
