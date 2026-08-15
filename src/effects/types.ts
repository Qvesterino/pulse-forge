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
  syncBpm?(bpm: number): void;
  onTransportStarted?(time: number, beatPhase: number): void;
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
