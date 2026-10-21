/**
 * ADJUSTMENT RECORDING — the call-site adapter for the session ledger.
 *
 * The ledger itself (`adjustment-ledger.ts`) stores ONE relative fader move and
 * is deliberately fader-only: a factor is the one number that can be replayed
 * ("same again") and halved ("half as much") without inventing a second scale.
 *
 * This module measures what ACTUALLY landed from the before/after documents and
 * writes it after a successful command. Two consequences are deliberate:
 *
 *   - an ABSOLUTE set is not replayable, so it CLEARS the ledger (otherwise
 *     "half that adjustment" would halve an older, unrelated fader move);
 *   - an effect/param change also CLEARS it: the last adjustment is now outside
 *     the ledger's vocabulary, so the reference must decline rather than point
 *     at the previous fader move.
 *
 * Nothing here mutates the project; execution still goes through the canonical
 * appliers and the store's one undo step.
 */
import type { DrumTrack, ProjectDocument } from "../project-model/types";
import { clearAdjustments, rememberAdjustment } from "./adjustment-ledger";
import { trackIdsForTarget, type FaderIntent } from "./conversation";
import type { EffectIntent } from "./mix";
import type { ParamIntent } from "./param-intent";

/** Undo/redo and any non-recordable mutation invalidate the remembered move. */
export function clearAdjustmentLedger(): void {
  clearAdjustments();
}

interface GainPair {
  before: number;
  after: number;
}

function changedGains(before: ProjectDocument, after: ProjectDocument, intent: FaderIntent): GainPair[] {
  const changes: GainPair[] = [];
  const pair = (previous: number | undefined, next: number | undefined): GainPair | null =>
    previous != null && next != null && previous !== next ? { before: previous, after: next } : null;
  const add = (previous: number | undefined, next: number | undefined): void => {
    const hit = pair(previous, next);
    if (hit) changes.push(hit);
  };

  for (const target of intent.targets) {
    if (target === "master") {
      add(before.master?.masterGain ?? 1, after.master?.masterGain ?? 1);
      continue;
    }
    for (const trackId of trackIdsForTarget(before, target)) {
      add(
        before.tracks.find((track) => track.id === trackId)?.gain,
        after.tracks.find((track) => track.id === trackId)?.gain,
      );
    }
  }
  for (const trackId of intent.trackIds ?? []) {
    add(
      before.tracks.find((track) => track.id === trackId)?.gain,
      after.tracks.find((track) => track.id === trackId)?.gain,
    );
  }
  for (const returnId of intent.returnIds ?? []) {
    add(
      before.returns.find((item) => item.id === returnId)?.gain,
      after.returns.find((item) => item.id === returnId)?.gain,
    );
  }
  if ((intent.pads?.length ?? 0) > 0) {
    const drumBefore = before.tracks.find((track): track is DrumTrack => track.kind === "drum");
    const drumAfter = after.tracks.find((track): track is DrumTrack => track.kind === "drum");
    if (!drumBefore || !drumAfter) return changes;
    for (const [index, pad] of drumBefore.pads.entries()) {
      add(pad.gain, drumAfter.pads[index]?.gain);
    }
  }
  return changes;
}

/**
 * Record the relative fader move that landed. No record for an absolute set, a
 * zero baseline, or a multi-target move whose actual factors differ (usually
 * because a target hit a bound): none of those can be replayed with one factor.
 * A stale record is worse than none.
 */
export function recordFaderAdjustment(
  docId: string,
  intent: FaderIntent,
  before: ProjectDocument,
  after: ProjectDocument,
): void {
  if (intent.direction === "set") {
    clearAdjustmentLedger();
    return;
  }
  const changes = changedGains(before, after, intent);
  if (changes.length === 0 || changes.some(({ before: previous }) => previous <= 0)) {
    clearAdjustmentLedger();
    return;
  }
  const factors = changes.map(({ before: previous, after: next }) => next / previous);
  const factor = factors[0];
  if (
    factor == null ||
    !Number.isFinite(factor) ||
    factor <= 0 ||
    factors.some((candidate) => !Number.isFinite(candidate) || Math.abs(candidate - factor) > Number.EPSILON * 8)
  ) {
    // A single replay factor would misrepresent at least one target when the
    // original operation hit different bounds. Keep the successful command,
    // but make a follow-up clarify instead of replaying the first target's
    // measured delta across every target.
    clearAdjustmentLedger();
    return;
  }
  rememberAdjustment({
    docId,
    direction: intent.direction,
    factor,
    targets: [...intent.targets],
    pads: [...(intent.pads ?? [])],
    trackIds: [...(intent.trackIds ?? [])],
    returnIds: [...(intent.returnIds ?? [])],
  });
}

/** The ledger is fader-only by design; this change supersedes its record. */
export function recordEffectAdjustment(
  _docId: string,
  _intent: EffectIntent,
  _before: ProjectDocument,
  _after: ProjectDocument,
): void {
  clearAdjustmentLedger();
}

/** The ledger is fader-only by design; this change supersedes its record. */
export function recordParamAdjustment(
  _docId: string,
  _intent: ParamIntent,
  _before: ProjectDocument,
  _after: ProjectDocument,
): void {
  clearAdjustmentLedger();
}
