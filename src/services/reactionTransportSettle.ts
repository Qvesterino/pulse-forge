/**
 * F2 CLOSURE — THE F1 TRANSPORT SETTLE SEAM, WIRED AT LAST (Wave B).
 *
 * F1 shipped three settle seams and wired two; the third — "the transport
 * played or moved on → the proposal was heard and kept" — was deferred with a
 * structural reason (the reaction ledger is created inside `openProject`
 * BEFORE the Transport exists, so the subscription belongs after the transport
 * is constructed, not in the F1 block). This module is that missing piece, as
 * one function so it can be tested against a REAL Transport and a REAL ledger
 * instead of a copy of the wiring.
 *
 * WHAT COUNTS AS "MOVED"
 * ----------------------
 * Any play-state CHANGE, in either direction:
 *   - play started → the user is hearing it now
 *   - playback stopped after playing → they listened through and stopped
 * Both are the human moving on. `subscribePlaying` fires ONCE immediately with
 * the current state, so the initial notify is not a change and settles nothing;
 * the ledger's own 5 s mash guard still applies — `noteTransportProgress`
 * settles only proposals older than it — so a play pressed instantly after an
 * apply does not count as a verdict. The next transition or the 90 s window
 * does.
 *
 * Returns an unsubscribe; the caller owns the lifetime (services disposes it).
 */
import type { ReactionLedger } from "../intent/reaction-ledger";
import type { Transport } from "../transport/Transport";

export function attachReactionTransportSettle(
  ledger: ReactionLedger | null,
  transport: Pick<Transport, "subscribePlaying">,
): (() => void) | null {
  if (!ledger) return null;
  let wasPlaying = false;
  return transport.subscribePlaying((playing) => {
    const moved = playing || wasPlaying;
    wasPlaying = playing;
    if (!moved) return;
    try {
      ledger.noteTransportProgress();
    } catch (error) {
      // Settling is bookkeeping; it must never break playback.
      console.error("[reaction] transport settle failed:", error);
    }
  });
}
