import { beforeEach, describe, expect, it } from "vitest";
import { noteIntentProposal } from "../src/intent/reaction-bridge";
import {
  REACTION_KEEP_WINDOW_MS,
  ReactionLedger,
  isReactionLedgerEnabled,
  setActiveReactionLedger,
  setReactionLedgerEnabled,
} from "../src/intent/reaction-ledger";
import { routeIntentText } from "../src/intent/route";
import { testDoc } from "./fixtures/doc";

/**
 * F1 GLUE — the bridge between intent dispatch and the Reaction Ledger
 * (docs/INTENT-REACTION-LISTENING-PLAN.md F1). The ledger itself is tested
 * in reaction-ledger.test.ts; here we pin the PANEL-side contract:
 * every mutating intent route registers a proposal at undoDepth+1 (one
 * snapshot per intent apply), non-mutating routes never register, and the
 * keep/undo windows resolve through the store hooks the same way the
 * services wiring resolves them.
 */

let now = 1_000_000;
const advance = (ms: number) => {
  now += ms;
};
let storageBacked: Record<string, string> = {};

function freshLedger(): ReactionLedger {
  storageBacked = {};
  const storage = {
    load: async () => [],
    save: async () => undefined,
    clear: async () => undefined,
    getItem: (key: string) => storageBacked[key] ?? null,
    setItem: (key: string, value: string) => {
      storageBacked[key] = value;
    },
    removeItem: (key: string) => {
      delete storageBacked[key];
    },
  };
  return new ReactionLedger({ storage: storage as Storage, now: () => now, cap: 64 });
}

const doc = testDoc();

describe("noteIntentProposal (reaction bridge)", () => {
  beforeEach(() => {
    now = 1_000_000;
    localStorage.removeItem("pf:reaction-ledger");
    setReactionLedgerEnabled(true);
    setActiveReactionLedger(null);
  });

  it("registers a mutating route as a pending proposal at undoDepth+1", () => {
    const ledger = freshLedger();
    setActiveReactionLedger(ledger);
    const route = routeIntentText("set delay time to 375 ms on the lead", doc);
    noteIntentProposal(route, doc, doc, 7);
    advance(6_000); // past the mash guard, inside the keep window
    // undo at depth 7 (the predicted post-apply depth) resolves it as undone
    const undone = ledger.noteUndo(7);
    expect(undone).not.toBeNull();
    expect(undone?.routeKind).toBe("paramIntent");
    expect(undone?.outcome).toBe("undone");
  });

  it("a non-mutating route (clarify) never registers", () => {
    const ledger = freshLedger();
    setActiveReactionLedger(ledger);
    const route = routeIntentText("co modulears", doc);
    noteIntentProposal(route, doc, doc, 3);
    expect(ledger.noteUndo(3)).toBeNull();
  });

  it("after the keep window the proposal resolves as kept", () => {
    const ledger = freshLedger();
    setActiveReactionLedger(ledger);
    const route = routeIntentText("more delay on the lead", doc);
    noteIntentProposal(route, doc, doc, 5);
    advance(REACTION_KEEP_WINDOW_MS + 1);
    ledger.sweep();
    const pack = ledger.exportPack();
    expect(pack.entries.some((entry) => entry.outcome === "kept")).toBe(true);
  });

  it("flag off = the bridge is a silent no-op", () => {
    setReactionLedgerEnabled(false);
    expect(isReactionLedgerEnabled()).toBe(false);
    const route = routeIntentText("more delay on the lead", doc);
    expect(() => noteIntentProposal(route, doc, doc, 5)).not.toThrow();
    setActiveReactionLedger(null);
  });
});
