import { describe, expect, it } from "vitest";
import { ReactionLedger, type ReactionStorage } from "../src/intent/reaction-ledger";
import { attachReactionTransportSettle } from "../src/services/reactionTransportSettle";
import { Transport } from "../src/transport/Transport";

/**
 * WAVE B — THE TRANSPORT SETTLE SEAM, WIRED (F2 closure).
 *
 * F1 shipped this seam unwired with a structural reason (the ledger exists
 * before the transport does). The wiring now lives in one function so it can be
 * driven against a REAL Transport and a REAL ledger — including the two cases
 * that matter: the initial subscribe notification must NOT settle anything, and
 * a genuine play/stop transition must.
 */

function makeLedger(startAt = 1_000_000) {
  let now = startAt;
  const rows: Array<unknown> = [];
  const storage: ReactionStorage = {
    load: async () => rows as never,
    save: async (entries) => {
      rows.length = 0;
      rows.push(...entries);
    },
    clear: async () => {
      rows.length = 0;
    },
  };
  let idCounter = 0;
  const ledger = new ReactionLedger({ now: () => now, storage, newId: () => `rx-${++idCounter}` });
  return { ledger, advance: (ms: number) => (now += ms) };
}

function register(ledger: ReactionLedger, depth: number): void {
  ledger.register({
    routeKind: "fader",
    action: { verb: "adjust", subject: "trackGain", relative: true },
    trackIds: [],
    beforeHash: "before-hash",
    afterHash: "after-hash",
    undoDepth: depth,
  });
}

function ledgerWithPending() {
  const clock = makeLedger();
  register(clock.ledger, 0);
  clock.advance(10_000); // past the 5 s mash guard
  return clock;
}

describe("attachReactionTransportSettle", () => {
  it("subscribes to nothing when the ledger is off (null in, null out)", () => {
    const transport = new Transport({ now: () => 0 }, 120);
    expect(attachReactionTransportSettle(null, transport)).toBeNull();
  });

  it("does NOT settle on the initial notification the subscription always emits", () => {
    const { ledger } = ledgerWithPending();
    const transport = new Transport({ now: () => 0 }, 120);
    attachReactionTransportSettle(ledger, transport);

    expect(ledger.summary().pending).toBe(1);
    expect(ledger.summary().kept).toBe(0);
  });

  it("settles a heard proposal as kept when playback starts", () => {
    const { ledger } = ledgerWithPending();
    const transport = new Transport({ now: () => 0 }, 120);
    attachReactionTransportSettle(ledger, transport);

    transport.play();

    expect(ledger.summary()).toMatchObject({ kept: 1, pending: 0 });
  });

  it("also settles when playback stops after a listen (the second half of 'moved on')", () => {
    const { ledger, advance } = ledgerWithPending();
    const transport = new Transport({ now: () => 0 }, 120);
    attachReactionTransportSettle(ledger, transport);

    transport.play();
    register(ledger, 1); // a second proposal, registered mid-playback
    advance(10_000); // heard through the guard window
    transport.stop();

    expect(ledger.summary()).toMatchObject({ kept: 2, pending: 0 });
  });

  it("stops settling once the caller detaches", () => {
    const { ledger } = ledgerWithPending();
    const transport = new Transport({ now: () => 0 }, 120);
    const detach = attachReactionTransportSettle(ledger, transport);
    detach?.();

    transport.play();

    expect(ledger.summary()).toMatchObject({ kept: 0, pending: 1 });
  });
});
