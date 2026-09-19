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
  /**
   * Step-envelope sync (FX expansion: beatMangler; adoptable by
   * stepGate/stutter). The engine calls this on every project sync with the
   * instance's current steps array REFERENCE — implementations must ignore
   * same-reference calls (cheap pointer compare) so untouched envelopes
   * never re-upload to the audio thread.
   */
  setSteps?(volume: readonly number[] | undefined, pitch: readonly number[] | undefined): void;
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
   * Roadmap O7: load a user impulse response into convolution-capable
   * effects (Ozvena). The runtime owns resampling/interleaving; the IR is
   * already at the context sample rate (decodeAudioData guarantees it).
   */
  loadUserIr?(ir: AudioBuffer): void;
  /** Remove a previously loaded user IR (fall back to factory selection). */
  clearUserIr?(): void;
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
  /**
   * Subscribe to asynchronous latency changes (e.g. a worklet reporting DSP
   * latency over its port after construction, or a param edit flipping an
   * oversampling stage). The engine re-runs its PDC whenever this fires so
   * compensation does not wait for the next document sync. Returns an
   * unsubscribe function; implementations must stop notifying (and never
   * notify a disposed runtime's listeners) after dispose().
   */
  onLatencyChange?(listener: () => void): () => void;
  /** Latest gain reduction in dB (dynamics processors), for metering. */
  getGainReductionDb?(): number;
  /** Live meter snapshot (spectrum, LUFS, GR…) — plugins with analysis DSP. */
  getMeters?(): unknown;
  /**
   * Toggle an effect's internal metering analysis. Heavy DSP panels (Ultina)
   * keep a metering pipeline running on the audio thread; the engine flips it
   * on while a consumer (panel) is mounted and off otherwise, so closed
   * panels cost nothing. Effects without metering simply omit this.
   */
  setMetersEnabled?(enabled: boolean): void;
  /**
   * Gate plugin-internal undo-history recording around engine bulk syncs.
   * Document loads, preset applies and project loads replay every param in
   * one sweep — none of that is a user gesture, and without the gate it
   * would flood (and evict) the plugin's own history. Effects without an
   * internal history simply omit these.
   */
  beginParamSync?(): void;
  endParamSync?(): void;
  /**
   * In-plugin parameter undo/redo (live tweak history). The restored entry
   * arrives ASYNCHRONOUSLY via the callback (a port round-trip) so the
   * caller can write it through to the document; null = nothing to undo.
   */
  undoParam?(onApplied: (entry: { id: string; value: number } | null) => void): void;
  redoParam?(onApplied: (entry: { id: string; value: number } | null) => void): void;
  /**
   * PRISM A/B morph slots. Snapshots live in the runtime (a rebuilt runtime
   * starts with empty slots); morphToSnapshot glides the audio to a slot
   * via the core's precompiled morph, morphBlendSnapshots scrubs between
   * the two (t = 0 → a, 1 → b) with a short tracking glide.
   */
  /** Pass null to clear a slot when persisted A/B state is removed. */
  setMorphSnapshot?(slot: 0 | 1, params: Record<string, number> | null): void;
  getMorphSnapshot?(slot: 0 | 1): Record<string, number> | null;
  morphToSnapshot?(slot: 0 | 1, durationSec: number): void;
  morphBlendSnapshots?(a: 0 | 1, b: 0 | 1, t: number, durationSec: number): void;
  /** AudioParam for direct audio-rate modulation bus connection. */
  getAudioParam?(paramId: string): AudioParam | null;
  dispose(): void;
}

export interface EffectEnv {
  bpm: number;
  /** Stable project/track/effect seed shared by live and offline DSP. */
  seed?: number;
}

export type EffectFactory = (ctx: BaseAudioContext, instance: EffectInstance, env: EffectEnv) => EffectRuntime;

export interface EffectDefinition {
  type: EffectType;
  name: string;
  category: "tone" | "dynamics" | "character" | "space" | "movement";
  params: ParamDef[];
  factory: EffectFactory;
}
