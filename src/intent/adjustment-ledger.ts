/**
 * ADJUSTMENT LEDGER — what the producer changed last, addressable by name.
 *
 * "half as much as last time", "same again but on the hats" ask about an
 * EARLIER change. The engine had no memory of one: the prior-delta guard
 * (`src/intent/reference-delta.ts`) declined those sentences, and the reuse
 * forms fell through to PATTERN GENERATION — which replaces the producer's
 * song. The guard's own comment asked for exactly this ledger.
 *
 * Session-scoped and NOT persisted, like `session-context.ts` (which keeps the
 * last GENERATION addressable the same way): a reload legitimately forgets the
 * working context. The store lives in the intent layer, one module, one home.
 *
 * WHAT IS RECORDED — only a RELATIVE fader change:
 *
 *   - it has a FACTOR (the multiplicative gain change), so "as much again" and
 *     "half as much" are numbers the resolver can scale;
 *   - it has a DIRECTION, so "same again" does not have to guess which way.
 *
 * An absolute set ("set the bass to 50%") has no factor to repeat, and an
 * effect change has its own amount vocabulary. Recording either would promise
 * a replay the resolver cannot deliver, so neither is recorded — the caller
 * CLEARS the ledger instead, and the references keep declining, honestly.
 *
 * WHAT IS NOT DONE HERE — the recording, and the reading of the ledger into a
 * new intent. The recording is done by the CALLER (see `adjustment-recording.ts`)
 * after a change actually LANDED; a ledger that filled up from every parse
 * would remember changes that never happened. The reading is done by
 * `prior-adjustment.ts`, which turns this record into a validated fader intent.
 *
 * This module is deliberately a STORE and nothing else: one record, one
 * writer's contract, no parsing and no policy.
 */
import type { EffectType } from "../project-model/types";
import type { FaderPadFamily, FaderTarget } from "./conversation";
import type { DegreeLevel } from "./degree";
import type { MixTarget } from "./mix";
import type { ParamRole } from "./param-intent";

/** One remembered relative change, in the form the resolver can replay. */
export type AdjustmentRecord = FaderRecord | EffectRecord | ParamRecord;

export interface FaderRecord {
  kind: "fader";
  /**
   * The document the change happened in. "Last time" means "in this project":
   * a track id from another project names a track that does not exist here.
   */
  docId: string;
  /** The direction of the change. */
  direction: "up" | "down";
  /**
   * The applied multiplicative gain factor — 1.35 is +35 % gain, 0.70 is
   * −30 %. This is the GROUND TRUTH of the change: the fold may have computed
   * it from a percent, a degree or an amount bucket, and only the factor is
   * the same number in every case.
   */
  factor: number;
  /** Family targets ("bass", "drums"). */
  targets: readonly FaderTarget[];
  /** Pad families ("hat"). */
  pads: readonly FaderPadFamily[];
  /** The producer's own tracks, when the change hit them. */
  trackIds?: readonly string[];
  /** Return buses, when the change hit one. */
  returnIds?: readonly string[];
}

export interface EffectRecord {
  kind: "effect";
  docId: string;
  effectType: EffectType;
  direction: "more" | "less";
  targets: readonly MixTarget[];
  /** Explicit/original track ids (ordinal targeting) when the ask used one. */
  trackIds?: readonly string[];
  /** Measured |after − before| / knob range on the primary knob. */
  stepFraction: number;
  /** The semantic rung the original ask named (or the amount-class default). */
  degreeLevel: DegreeLevel;
}

export interface ParamRecord {
  kind: "param";
  docId: string;
  effectType: EffectType;
  role: ParamRole;
  paramId: string;
  mode: "more" | "less";
  targets: readonly MixTarget[];
  /** Explicit/original track ids (ordinal targeting) when the ask used one. */
  trackIds?: readonly string[];
  /** Measured |after − before| as a fraction of the param range, in its domain. */
  fraction: number;
  degreeLevel: DegreeLevel;
}

let last: AdjustmentRecord | null = null;

/** Remember a change that actually landed. */
export function rememberAdjustment(record: AdjustmentRecord): void {
  last = record;
}

/**
 * The last remembered change — null when there is none, or when it happened
 * in a DIFFERENT project (its track ids would name tracks that do not exist
 * here).
 */
export function lastAdjustment(docId?: string): AdjustmentRecord | null {
  if (!last) return null;
  if (docId != null && last.docId !== docId) return null;
  return last;
}

/** Forget the ledger — an undo, a different kind of change, a new session. */
export function clearAdjustments(): void {
  last = null;
}
