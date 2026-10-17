import { afterEach, describe, expect, it } from "vitest";
import {
  ReactionLedger,
  setActiveReactionLedger,
  setReactionLedgerEnabled,
  type ReactionActionInput,
  type ReactionStorage,
} from "../src/intent/reaction-ledger";
import { orderClarificationChoices } from "../src/intent/reaction-choice-bias";
import type { IntentClarificationChoice } from "../src/intent/route";

/**
 * WAVE B — THE BIAS GUARD AT THE HUMAN CHOICE SURFACE (F2 closure).
 *
 * The pre-registered rule is "reactions REORDER gated candidates, never create,
 * drop or edit one". These specs drive a REAL ledger (with a controllable
 * clock) and pin: the reorder happens when there is evidence, the input is
 * returned untouched when there is not, and the member/length guarantee holds
 * in every case.
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

const SEND_ACTION: ReactionActionInput = { verb: "adjust", subject: "effect", relative: true };
const FADER_ACTION: ReactionActionInput = { verb: "adjust", subject: "trackGain", relative: true };

function register(ledger: ReactionLedger, routeKind: string, action: ReactionActionInput, depth: number): void {
  ledger.register({
    routeKind,
    action,
    trackIds: [],
    beforeHash: "before-hash",
    afterHash: "after-hash",
    undoDepth: depth,
  });
}

function choices(): IntentClarificationChoice[] {
  return [
    { label: "Adjust the reverb return", route: { kind: "fader", intent: { direction: "up", targets: ["drums"] } } },
    { label: "Increase reverb send on drums", route: { kind: "sendIntent", intent: { direction: "more" } } },
  ] as unknown as IntentClarificationChoice[];
}

afterEach(() => {
  setActiveReactionLedger(null);
  setReactionLedgerEnabled(true);
  localStorage.clear();
});

describe("orderClarificationChoices (bias guard)", () => {
  it("returns the input array itself when no ledger is active (identity, not a copy)", () => {
    setActiveReactionLedger(null);
    const input = choices();
    expect(orderClarificationChoices(input)).toBe(input);
  });

  it("returns the input array itself when the ledger has no decided reactions", () => {
    const { ledger } = makeLedger();
    setActiveReactionLedger(ledger);
    const input = choices();
    expect(orderClarificationChoices(input)).toBe(input);
  });

  it("puts the interpretation this owner actually keeps first — and keeps every member", () => {
    const { ledger, advance } = makeLedger();
    // Three kept sends…
    register(ledger, "sendIntent", SEND_ACTION, 10);
    register(ledger, "sendIntent", SEND_ACTION, 11);
    register(ledger, "sendIntent", SEND_ACTION, 12);
    advance(10_000);
    ledger.noteTransportProgress();
    // …and three undone faders.
    register(ledger, "fader", FADER_ACTION, 0);
    register(ledger, "fader", FADER_ACTION, 1);
    register(ledger, "fader", FADER_ACTION, 2);
    advance(10_000);
    ledger.noteUndo(0);
    ledger.noteUndo(1);
    ledger.noteUndo(2);
    setActiveReactionLedger(ledger);

    const input = choices();
    const ordered = orderClarificationChoices(input);

    expect(ordered).toHaveLength(input.length);
    expect([...ordered].sort((a, b) => a.label.localeCompare(b.label))).toEqual(
      [...input].sort((a, b) => a.label.localeCompare(b.label)),
    );
    expect(ordered[0]!.label).toBe("Increase reverb send on drums");
    expect(ordered[1]!.label).toBe("Adjust the reverb return");
  });

  it("keeps the original order when the weights tie", () => {
    const { ledger, advance } = makeLedger();
    register(ledger, "sendIntent", SEND_ACTION, 0);
    register(ledger, "sendIntent", SEND_ACTION, 1);
    advance(10_000);
    ledger.noteTransportProgress();
    register(ledger, "fader", FADER_ACTION, 5);
    register(ledger, "fader", FADER_ACTION, 6);
    advance(10_000);
    ledger.noteTransportProgress();
    setActiveReactionLedger(ledger);

    const input = choices();
    expect(orderClarificationChoices(input).map((choice) => choice.label)).toEqual(input.map((choice) => choice.label));
  });

  it("respects the kill switch: a disabled ledger reorders nothing", () => {
    const { ledger, advance } = makeLedger();
    register(ledger, "sendIntent", SEND_ACTION, 0);
    register(ledger, "sendIntent", SEND_ACTION, 1);
    advance(10_000);
    ledger.noteTransportProgress();
    setActiveReactionLedger(ledger);
    setReactionLedgerEnabled(false);

    const input = choices();
    expect(orderClarificationChoices(input)).toBe(input);
  });
});
