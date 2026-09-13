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
  /**
   * MPE timbre (CC74). Convention: 0..1 bipolar, 0.5 = the note's own base —
   * instruments scale their brightness control (filter cutoff ×0.5..1.5;
   * FM scales INDEX the same way) for the matching pitch only.
   */
  polyTimbre?(pitch: number, timbre: number, when: number): void;
  /** Optional scheduled time used by runtimes with graph-backed live controls. */
  setParameter(id: string, value: number, when?: number): void;
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
