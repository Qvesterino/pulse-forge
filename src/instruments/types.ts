import type { InstrumentKind, InstrumentTrack } from "../project-model/types";
import type { ParamDef } from "../effects/types";

export interface InstrumentRuntime {
  output: AudioNode;
  noteOn(
    pitch: number,
    velocity: number,
    when: number,
    durationSec: number,
    slideFrom?: { pitch: number; when: number },
  ): void;
  noteOff?(pitch: number, when: number): void;
  polyPressure?(pitch: number, pressure: number, when: number): void;
  setParameter(id: string, value: number): void;
  setParameterAt?(id: string, value: number, when: number): void;
  setSample?(id: string | null): void;
  panic(): void;
  dispose(): void;
}

export interface InstrumentEnv {
  bpm: number;
  getSample(id: string | null): AudioBuffer | undefined;
}

export type InstrumentFactory = (
  ctx: BaseAudioContext,
  track: InstrumentTrack,
  env: InstrumentEnv,
) => InstrumentRuntime;

export interface InstrumentDefinition {
  kind: InstrumentKind;
  name: string;
  params: ParamDef[];
  factory: InstrumentFactory;
}
