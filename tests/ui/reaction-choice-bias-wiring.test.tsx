import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { mockServices, renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import {
  ReactionLedger,
  setActiveReactionLedger,
  setReactionLedgerEnabled,
  type ReactionActionInput,
  type ReactionStorage,
} from "../../src/intent/reaction-ledger";

/**
 * REACTION TASTE BIAS — PANEL-LEVEL GATE (Package 2, 2026-10-17)
 *
 * `reaction-choice-bias.test.ts` proves the ORDERING FUNCTION. The seam
 * ledger's own lesson applies: a function test is not a test of the panel, and
 * the F2 rule ("reactions REORDER gated candidates, never create, drop or edit
 * one") is only true of the product if the CHIPS a human clicks are reordered.
 * These specs drive the real IntentPanel with a real, seeded ledger and pin:
 *
 *   - an owner who kept the RETURN fader and returned the SEND asks sees the
 *     return interpretation FIRST (the router's own order is the opposite);
 *   - the same history with the ledger switched OFF changes nothing;
 *   - a ledger with no decided rows changes nothing;
 *   - the chip SET is identical in every case (reorder, never create/drop).
 */

function seededLedger(seed: "inverted" | "none") {
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
  let now = 1_000_000;
  let idCounter = 0;
  const ledger = new ReactionLedger({ now: () => now, storage, newId: () => `rx-${++idCounter}` });
  const advance = (ms: number) => (now += ms);
  const register = (routeKind: string, action: ReactionActionInput, depth: number) =>
    ledger.register({
      routeKind,
      action,
      trackIds: [],
      beforeHash: "before-hash",
      afterHash: "after-hash",
      undoDepth: depth,
    });

  if (seed === "inverted") {
    // Kept: the RETURN fader (what the router lists SECOND).
    register("fader", { verb: "adjust", subject: "trackGain", relative: true }, 0);
    register("fader", { verb: "adjust", subject: "trackGain", relative: true }, 1);
    register("fader", { verb: "adjust", subject: "trackGain", relative: true }, 2);
    advance(10_000);
    ledger.noteTransportProgress();
    // Undone: the SEND asks (what the router lists FIRST).
    register("sendIntent", { verb: "adjust", subject: "effect", relative: true }, 10);
    register("sendIntent", { verb: "adjust", subject: "effect", relative: true }, 11);
    register("sendIntent", { verb: "adjust", subject: "effect", relative: true }, 12);
    advance(10_000);
    ledger.noteUndo(10);
    ledger.noteUndo(11);
    ledger.noteUndo(12);
  }
  return ledger;
}

async function askAndChips() {
  const project = createProjectFromTemplate("trap");
  const services = mockServices(project);
  renderWithContext(<IntentPanel />, { services });
  fireEvent.change(screen.getByLabelText(/Intent description/i), {
    target: { value: "Increase the lead delay return." },
  });
  fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
  const region = await screen.findByLabelText("Nearest interpretations");
  await screen.findByRole("button", { name: "Increase delay send on lead" });
  return within(region)
    .getAllByRole("button")
    .map((button) => button.textContent ?? "");
}

afterEach(() => {
  setActiveReactionLedger(null);
  setReactionLedgerEnabled(true);
  localStorage.clear();
});

describe("reaction taste bias at the panel chips (Package 2)", () => {
  it("keeps the router's own order when the ledger has no decisions (identity)", async () => {
    setActiveReactionLedger(seededLedger("none"));
    const order = await askAndChips();
    expect(order).toEqual(["Increase delay send on lead", "Raise Delay return level"]);
  });

  it("puts the interpretation this owner actually keeps FIRST", async () => {
    setActiveReactionLedger(seededLedger("inverted"));
    const order = await askAndChips();
    expect(order, "the kept RETURN fader must outrank the returned SEND asks").toEqual([
      "Raise Delay return level",
      "Increase delay send on lead",
    ]);
  });

  it("NEGATIVE: the kill switch reaches the panel — the same history reorders nothing", async () => {
    setActiveReactionLedger(seededLedger("inverted"));
    setReactionLedgerEnabled(false);
    const order = await askAndChips();
    expect(order).toEqual(["Increase delay send on lead", "Raise Delay return level"]);
    // The ledger answers null, so nothing can be learned while it is off.
    expect(screen.getByRole("button", { name: /Reaction ledger: off/ })).toBeInTheDocument();
  });

  it("NEGATIVE: pending-only history reorders nothing", async () => {
    const ledger = new ReactionLedger({ now: () => 1_000_000, newId: () => "rx-p" });
    for (let i = 0; i < 5; i += 1) {
      ledger.register({
        routeKind: "sendIntent",
        action: { verb: "adjust", subject: "effect", relative: true },
        trackIds: [],
        beforeHash: "b",
        afterHash: "a",
        undoDepth: i,
      });
    }
    setActiveReactionLedger(ledger);
    const order = await askAndChips();
    expect(order).toEqual(["Increase delay send on lead", "Raise Delay return level"]);
    await waitFor(() => expect(screen.getByRole("button", { name: /Reaction ledger: on/ })).toBeInTheDocument());
  });
});
