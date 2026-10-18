import type { EffectInstance, EffectType } from "../project-model/types";

export interface ParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
  /**
   * WHAT this parameter does, in one sentence — for an agent (or a new user)
   * that sees only `id: 0..1, default 0` otherwise. Exposed by
   * `kyx_catalog subject:effect`; a dead-simple completeness pin
   * (`tests/koren-catalog.test.ts`) requires it on every KOREŇ param, so a
   * new knob cannot ship undocumented.
   */
  description?: string;
  format?: (value: number) => string;
  options?: { value: number; label: string }[];
  /** Explicit value kind when a numeric range alone is ambiguous. */
  kind?: "continuous" | "enum" | "toggle" | "discrete" | "unknown";
  /** Quantization interval for explicitly discrete parameters. */
  step?: number;
  /**
   * Slider taper: "log" maps the drag position logarithmically so Hz-domain
   * knobs (cutoff, EQ bands, tone) spend their travel musically instead of
   * bunching everything at the left end. Falls back to linear when min ≤ 0.
   */
  taper?: "linear" | "log";
  /**
   * A secondary line under the knob, given the WHOLE parameter set rather than
   * this param's value alone. It exists for controls whose displayed number is
   * not the number the engine delivers: wow & flutter request depth in cents,
   * but below ~0.5 Hz the delay ring's swing budget cannot carry them, so the
   * honest readout is what the swing plan actually achieved. Return undefined
   * to render nothing, which is the common case — when the request is fully
   * achievable there is nothing to warn about.
   */
  secondary?: (values: Record<string, number>) => string | undefined;
  /**
   * Legacy compatibility id: accepted on old documents (the command layer
   * remaps it to `aliasOf`), but excluded from automation target lists and
   * UI pickers — new code must always use the canonical id.
   */
  deprecated?: boolean;
  /** Canonical id this deprecated alias maps to. */
  aliasOf?: string;
}

/** A labelled gain-reduction reading for multi-stage dynamics processors. */
export interface EffectGainReductionReading {
  label: string;
  /** Positive dB amount removed by this stage. */
  gainReductionDb: number;
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
  /**
   * Step-pattern sync (stepGate / stutter). The engine calls this on every
   * project sync with the instance's `steps` array REFERENCE — same
   * pointer-compare contract as `setSteps`: unchanged patterns must not
   * re-upload to the audio thread. Without it, editing the pattern after the
   * first chain build was silent: the constructor snapshot was all the
   * processor ever saw.
   */
  setPattern?(steps: readonly number[]): void;
  /**
   * TWIST (SKRUTKA): apply the two stored curve snapshots to the live runtime
   * after a device-state edit. Snapshot data remains outside project params so
   * the automatable MORPH amount stays a single numeric parameter.
   */
  setCurves?(a: Record<string, number> | null, b: Record<string, number> | null): void;
  /**
   * REZONANS (ADR 0040 §4.3c): re-push the key/chord lane. The context also
   * rides `processorOptions` at construction, so this exists for the LIVE path
   * — a chord edited while playing must reach the worklet without rebuilding
   * the chain. Optional; no other effect implements it.
   */
  setHarmonyContext?(context: HarmonyContextInit): void;
  /**
   * The engine calls this before an offline render starts, once the graph is
   * armed and before `startRendering()`. Runtimes with their own musical or
   * positional state seed it here — REZONANS (ADR 0040 §4.3b) starts its
   * clock at position 0, because the renderer replays tempo per window and
   * never calls `onTransportStarted`.
   *
   * Declared here because the engine already invoked it unconditionally at
   * `AudioEngine.prepareOfflineRender()`; it was an undeclared optional member
   * until REZONANS needed it.
   */
  prepareOfflineRender?(): void;
  /**
   * Tempo changed — re-derive tempo-synced modulators (LFO sync, delay time…).
   * `when` (audio-context time) schedules the change for offline renders so
   * each clip window's scene BPM lands at its own window start instead of the
   * last-processed window winning the whole export. AudioParam-backed runtimes
   * honor it; message-port runtimes apply immediately (live paths always pass
   * undefined).
   */
  syncBpm?(bpm: number, when?: number): void;
  onTransportStarted?(time: number, beatPhase: number, positionBeats?: number): void;
  /** Engine-owned post-effect gain used for preset level matching and output trim. */
  setOutputTrimDb?(gainDb: number): void;
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
  /** True after an asynchronous worklet latency report has arrived. */
  hasLatencyReport?(): boolean;
  /**
   * Subscribe to asynchronous latency changes (e.g. a worklet reporting DSP
   * latency over its port after construction, or a param edit flipping an
   * oversampling stage). The engine re-runs its PDC whenever this fires so
   * compensation does not wait for the next document sync. Returns an
   * unsubscribe function; implementations must stop notifying (and never
   * notify a disposed runtime's listeners) after dispose().
   */
  onLatencyChange?(listener: () => void): () => void;
  /**
   * Wait until a worklet has delivered its initial latency report. Offline
   * rendering uses this to size PDC from measured processor latency instead
   * of racing AudioWorklet startup. Returns false when the report times out
   * or the runtime is disposed first.
   */
  waitForLatencyReport?(timeoutMs: number): Promise<boolean>;
  /** Latest gain reduction in dB (dynamics processors), for metering. */
  getGainReductionDb?(): number;
  /** Separate gain-reduction readings when one device contains multiple dynamics stages. */
  getGainReductionBreakdown?(): readonly EffectGainReductionReading[];
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
  /**
   * MORPH DYNAMICS morph scenes: glide the engine audibly toward a full
   * target parameter map over `durationSec` (smoothstep-eased, block-rate).
   * The caller owns scene storage (deviceState) and commits the target to
   * the document as one undoable command; the runtime only performs the
   * audible glide. Globals and routes.* inside the map are ignored by the
   * core (scenes are behavior, not wiring or loudness).
   */
  morphToParams?(params: Record<string, number>, durationSec: number): void;
  /** AudioParam for direct audio-rate modulation bus connection. */
  getAudioParam?(paramId: string): AudioParam | null;
  dispose(): void;
}

export interface EffectEnv {
  bpm: number;
  /** Stable project/track/effect seed shared by live and offline DSP. */
  seed?: number;
  /**
   * REZONANS (ADR 0040 §4.3a): project musical context for key-aware harmony.
   *
   * `doc.key` has never reached audio before — its own docstring says
   * "display + scorepack" and nothing in `src/audio-engine/` reads it. This
   * field is the whole bridge, and it is deliberately the ONLY engine surface
   * REZONANS needs: it rides `processorOptions` at construction, so the
   * scheduler, the automation bridge and the renderer are all untouched.
   *
   * Masks are computed HOST-SIDE from `SCALE_INTERVALS` / `CHORD_INTERVALS`;
   * the worklet receives masks and never a scale table, which is what makes an
   * arbitrary user scale a parameter change rather than a worklet rebuild.
   */
  harmonyContext?: HarmonyContextInit;
}

/** Host-resolved musical context handed to an effect factory. */
export interface HarmonyContextInit {
  /** Key root pitch class 0–11 (0 = C). */
  keyRootPc: number;
  /** 12-bit scale mask: bit n set = pitch class n is in the scale. */
  scaleMask: number;
  /** Arrangement chord lane, ordered by `startBar`. */
  chords: ReadonlyArray<{
    /** Absolute integer bar (ChordEvent.startBar). */
    startBar: number;
    lengthBars: number;
    rootPc: number;
    /** 12-bit pitch-class mask for this chord. */
    chordMask: number;
  }>;
}

export type EffectFactory = (ctx: BaseAudioContext, instance: EffectInstance, env: EffectEnv) => EffectRuntime;

export interface EffectDefinition {
  type: EffectType;
  name: string;
  category: "tone" | "dynamics" | "character" | "space" | "movement";
  params: ParamDef[];
  factory: EffectFactory;
}
