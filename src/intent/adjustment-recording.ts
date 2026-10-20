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

function changedGain(before: ProjectDocument, after: ProjectDocument, intent: FaderIntent): GainPair | null {
  const pair = (previous: number | undefined, next: number | undefined): GainPair | null =>
    previous != null && next != null && previous !== next ? { before: previous, after: next } : null;

  for (const target of intent.targets) {
    if (target === "master") {
      const hit = pair(before.master?.masterGain ?? 1, after.master?.masterGain ?? 1);
      if (hit) return hit;
      continue;
    }
    for (const trackId of trackIdsForTarget(before, target)) {
      const hit = pair(
        before.tracks.find((track) => track.id === trackId)?.gain,
        after.tracks.find((track) => track.id === trackId)?.gain,
      );
      if (hit) return hit;
    }
  }
  for (const trackId of intent.trackIds ?? []) {
    const hit = pair(
      before.tracks.find((track) => track.id === trackId)?.gain,
      after.tracks.find((track) => track.id === trackId)?.gain,
    );
    if (hit) return hit;
  }
  for (const returnId of intent.returnIds ?? []) {
    const hit = pair(
      before.returns.find((item) => item.id === returnId)?.gain,
      after.returns.find((item) => item.id === returnId)?.gain,
    );
    if (hit) return hit;
  }
  if ((intent.pads?.length ?? 0) > 0) {
    const drumBefore = before.tracks.find((track): track is DrumTrack => track.kind === "drum");
    const drumAfter = after.tracks.find((track): track is DrumTrack => track.kind === "drum");
    if (!drumBefore || !drumAfter) return null;
    for (const [index, pad] of drumBefore.pads.entries()) {
      const hit = pair(pad.gain, drumAfter.pads[index]?.gain);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Record the relative fader move that landed. No record for an absolute set or
 * a zero baseline: neither can be safely scaled, and a stale record is worse
 * than none.
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
  const change = changedGain(before, after, intent);
  if (!change || change.before <= 0) {
    clearAdjustmentLedger();
    return;
  }
  rememberAdjustment({
    docId,
    direction: intent.direction,
    factor: change.after / change.before,
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
