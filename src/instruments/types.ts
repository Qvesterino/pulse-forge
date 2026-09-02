import type { InstrumentKind, InstrumentTrack, SampleLayer } from "../project-model/types";
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
  /**
   * MPE poly aftertouch. Convention: pressure 0..1 opens the matching
   * notes' own filter up to +50% over its per-note base (keytrack/V-FLT
   * included); pressure 0 restores the base. Per-voice on instruments that
   * track a filter->pitch map; a no-op for pitches with no live voice.
   */
  polyPressure?(pitch: number, pressure: number, when: number): void;
  setParameter(id: string, value: number): void;
  setParameterAt?(id: string, value: number, when: number): void;
  setSample?(id: string | null): void;
  /** Replace the sampler's velocity/round-robin layers (see SampleLayer). */
  setVelocityLayers?(layers: SampleLayer[]): void;
  /** Tempo changed — re-derive tempo-synced modulators (LFO sync, delay time…). */
  syncBpm?(bpm: number): void;
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
