import type { EffectRuntime } from "../effects/types";
import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * GROW (bassHarmonic) node wrapper — plain AudioParam surface, same
 * contract as the M2 mastering nodes (zenit-m2-nodes.ts): every parameter
 * is an AudioParam on the processor, so live writes and offline automation
 * (`setParameterAt` → setValueAtTime) both work without port messages.
 *
 * Two inputs: [0] main audio, [1] sidechain KEY (PUMP/DUCK). `setSidechainInput`
 * follows the duck-typed engine contract (AudioEngine.syncFxSidechains) used
 * by sidechain-node/compressor-node: identical repoints early-return because
 * the engine re-asserts wiring on every project sync.
 *
 * The processor posts a small throttled telemetry frame (`type:"koren"`) for
 * the GROW panel visualizer and the rack mini meter. The node caches the
 * last validated frame; `getMeters()` is the only consumer surface. Telemetry
 * needs no enable gate — it is a few scalars at ~20 Hz, same discipline as
 * the compressor's gain-reduction frames.
 *
 * The processor module is a LAZY worklet (public/bass-harmonic-worklet.js):
 * the registry factory only calls this when `isWorkletReady("bassHarmonic")`
 * is true; unloaded contexts get the honest 1:1 bypass from the factory.
 */
const BASS_HARMONIC_PARAMS = [
  "drive",
  "focusHz",
  "harmonics",
  "subAnchor",
  "lowCut",
  "range",
  "attack",
  "release",
  "sustain",
  "retrig",
  "character",
  "phase",
  "tilt",
  "width",
  "presence",
  "keyMode",
  "hintHz",
  "mix",
  "output",
] as const;

/**
 * `audition` is deliberately NOT in that list: it is the monitor-only
 * audition switch, written by the engine at runtime and never projected from
 * the project, so an export can never inherit it. See the engine's
 * `setFxAudition` and ADR 0034's monitor A/B addendum.
 *
 * The guard below is not a comment but a BARRIER: the project sync calls
 * `setParameter` for every key it finds in `fx.params`, and a hand-edited or
 * migrated document could carry `audition: 2`. If that reached the worklet,
 * an export would render the generated branch alone. So `setParameter`
 * refuses the id and only `setAudition` (the engine's runtime path) writes it.
 */
const AUDITION_PARAM_ID = "audition";

/** Validated live telemetry frame for panels/meters. */
export interface KorenMeterFrame {
  f0: number;
  clarity: number;
  harm: number;
  key: number;
  /** 1 while the engine pitch hint (`hintHz`) owns acquisition. */
  hint: number;
  partials: Float32Array | null;
  /** The monitor-only audition mode: 0 = normal, 1 = dry, 2 = harmonics. */
  audition: number;
  /** The level match the processor applied to the auditioned path, in dB. */
  matchDb: number;
  /**
   * The auditioned path's level relative to the normal path, in dB.
   * 0 = already matched, negative = quieter than the normal path, and
   * −120 = there is no signal to compare (silence or an empty generated
   * branch).
   */
  audDb: number;
}

export function createBassHarmonicNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "bass-harmonic-processor", {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });
  attachProcessorErrorGuard(node, "bass-harmonic-processor");

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);

  for (const id of BASS_HARMONIC_PARAMS) {
    safeApplyAudioParam(node, id, instance.params[id] ?? 0);
  }

  // Current key feed on worklet input 1 — tracked so a repoint (or dispose)
  // detaches the PREVIOUS source; otherwise the old subgraph stays connected
  // into the key envelope forever and both feeds sum.
  let sidechainSource: AudioNode | null = null;
  let meters: KorenMeterFrame | null = null;
  let disposed = false;

  node.port.onmessage = (event) => {
    const msg = event.data as {
      type?: unknown;
      f0?: unknown;
      clarity?: unknown;
      harm?: unknown;
      key?: unknown;
      hint?: unknown;
      partials?: unknown;
      audition?: unknown;
      matchDb?: unknown;
      audDb?: unknown;
    } | null;
    if (msg?.type !== "koren") return;
    const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    if (!finite(msg.f0) || !finite(msg.clarity) || !finite(msg.harm) || !finite(msg.key)) return;
    meters = {
      f0: msg.f0,
      clarity: msg.clarity,
      harm: msg.harm,
      key: msg.key,
      hint: finite(msg.hint) ? msg.hint : 0,
      partials: msg.partials instanceof Float32Array ? msg.partials : null,
      audition: finite(msg.audition) ? Math.round(msg.audition) : 0,
      matchDb: finite(msg.matchDb) ? msg.matchDb : 0,
      audDb: finite(msg.audDb) ? msg.audDb : 0,
    };
  };

  return {
    input,
    output,
    setParameter(id, value) {
      // The audition switch is NOT reachable from project state — see the
      // barrier note above.
      if (id === AUDITION_PARAM_ID) return;
      safeApplyAudioParam(node, id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      if (id === AUDITION_PARAM_ID) return;
      safeApplyAudioParam(node, id, value, when);
    },
    /**
     * MONITOR-ONLY audition: 0 = the normal path, 1 = DRY (the input alone),
     * 2 = HARMONICS (the generated branch alone). The processor level-matches
     * the auditioned path to the normal path, so the comparison is about
     * timbre, not loudness.
     */
    setAudition(mode: number) {
      const next = Number.isFinite(mode) ? Math.max(0, Math.min(2, Math.round(mode))) : 0;
      // `p.value` (not a scheduled write): the switch takes effect at the
      // next block, and the processor crossfades it over 10 ms.
      safeApplyAudioParam(node, AUDITION_PARAM_ID, next);
    },
    setSidechainInput(source: AudioNode | null) {
      const next = source ?? null;
      // The engine re-runs sidechain wiring on EVERY project sync — tearing
      // the live edge down on each committed fader move would re-attack the
      // key envelope. Identical repoints must be a no-op.
      if (next === sidechainSource) return;
      if (sidechainSource) {
        try {
          sidechainSource.disconnect(node, 0, 1);
        } catch {
          /* not connected */
        }
        sidechainSource = null;
      }
      if (next) {
        next.connect(node, 0, 1);
        sidechainSource = next;
      }
    },
    getMeters: () => meters,
    dispose() {
      if (disposed) return; // idempotent — engine rebuild paths may re-dispose
      disposed = true;
      meters = null;
      if (sidechainSource) {
        try {
          sidechainSource.disconnect(node, 0, 1);
        } catch {
          /* not connected */
        }
        sidechainSource = null;
      }
      // No port.close(): a dropped MessagePort can discard already-queued
      // messages; dropping the last JS reference closes it after delivery
      // (same note as kaskada-node/ultinaNode).
      node.port.onmessage = null;
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}
