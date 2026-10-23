/**
 * MASTER ASSISTANT CORRECTIONS — the learning loop's capture layer.
 *
 * When op:assist proposes mastering parameters and the user (or a later op)
 * changes them, the DELTA between proposed and actual is a training data
 * point. This module detects those deltas, bounds them, and produces
 * privacy-bounded correction events for the producer-memory ledger.
 *
 * The detection is LAZY: corrections are found on the NEXT op:assist call,
 * when the planner's new proposals are compared against the ACTUAL values
 * in the doc. Any param where the actual ≠ the previously proposed value
 * means the user corrected it in between. This avoids watching every
 * param set and closes the loop on each assist call.
 *
 * Privacy: no prompts, no file names, no user content — only param ids,
 * numeric values, and the track/device context. Bounded at 256 events.
 */

export interface AssistProposedParam {
  trackId: string;
  device: string;
  paramId: string;
  proposedValue: number;
}

export interface MasteringCorrectionEvent {
  trackId: string;
  device: string;
  paramId: string;
  proposedValue: number;
  actualValue: number;
  /** Delta = actual − proposed (positive = user pushed higher). */
  delta: number;
  detectedAt: number;
}

/** Compare proposed params against the doc's actual values → corrections. */
export function detectCorrections(
  proposed: AssistProposedParam[],
  doc: {
    tracks: Array<{
      id: string;
      effects: Array<{ id: string; type: string; params: Record<string, number>; outputTrimDb?: number }>;
    }>;
  },
): MasteringCorrectionEvent[] {
  const corrections: MasteringCorrectionEvent[] = [];
  const now = Date.now();
  for (const p of proposed) {
    const track = doc.tracks.find((t) => t.id === p.trackId);
    if (!track) continue;
    const instance = track.effects.find((fx) => fx.id === p.device || fx.type === p.device);
    if (!instance) continue;
    const actual = instance.params[p.paramId] ?? instance.outputTrimDb ?? undefined;
    if (actual === undefined || actual === p.proposedValue) continue;
    corrections.push({
      trackId: p.trackId,
      device: p.device,
      paramId: p.paramId,
      proposedValue: p.proposedValue,
      actualValue: actual,
      delta: actual - p.proposedValue,
      detectedAt: now,
    });
  }
  return corrections;
}

/** Bound the correction log (same cap pattern as the intent mining ring). */
export function boundCorrections(events: MasteringCorrectionEvent[], cap = 256): MasteringCorrectionEvent[] {
  return events.length > cap ? events.slice(events.length - cap) : events;
}

/**
 * THE LEARNING LOOP'S MEMORY — the params the LAST assist proposal asked
 * for, keyed by the assisted track set.
 *
 * The next assist compares them against the document: a param whose value
 * the user changed is a correction, and the delta is training data.
 *
 * Bounded on purpose. The signal is the LAST proposal per track set, so the
 * oldest entries are the least useful ones; a long session that assisted
 * many different track sets must not grow this without limit.
 */
const MAX_TRACK_SETS = 32;
const MAX_PROPOSALS_PER_SET = 256;

export const masterCorrectionProposals = new Map<string, AssistProposedParam[]>();

/**
 * Remember a proposal set for a track set, dropping the oldest one past the
 * bound. Re-remembering a track set REPLACES its entry (the newest proposal
 * is the one the next call compares against) and keeps it at the newest end.
 */
export function rememberProposals(key: string, proposals: AssistProposedParam[]): void {
  const bounded =
    proposals.length > MAX_PROPOSALS_PER_SET ? proposals.slice(proposals.length - MAX_PROPOSALS_PER_SET) : proposals;
  masterCorrectionProposals.delete(key);
  masterCorrectionProposals.set(key, bounded);
  while (masterCorrectionProposals.size > MAX_TRACK_SETS) {
    const oldest = masterCorrectionProposals.keys().next();
    if (oldest.done) break;
    masterCorrectionProposals.delete(oldest.value);
  }
}
