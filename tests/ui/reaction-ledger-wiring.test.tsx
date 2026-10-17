import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { renderWithContext, mockServices } from "../helpers";
import {
  activeReactionLedger,
  setActiveReactionLedger,
  setReactionLedgerEnabled,
  type ReactionLedger,
} from "../../src/intent/reaction-ledger";
import type { Services } from "../../src/services";

/**
 * REACTION LEDGER PANEL WIRING GATE (seam: reaction-ledger-panel-wiring)
 *
 * The seam ledger listed this OPEN for a specific reason: the panel call site
 * was "guarded" by a SOURCE-TEXT substring check, and the panel spec clicked
 * DO IT without ever installing a ledger — so the call silently no-oped.
 * Traversal without assertion. These specs install the REAL ledger (and a REAL
 * `ProjectStore`, because the bridge refuses to register a proposal whose
 * before/after state hashes are equal) and assert the recorded row.
 */

function setup() {
  localStorage.clear();
  setActiveReactionLedger(null);
  setReactionLedgerEnabled(true);
  const doc = createProjectFromTemplate("house");
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  renderWithContext(<IntentPanel />, { services });
  return { project };
}

/** A ledger stand-in whose only job is to witness the panel's call. */
function spyLedger() {
  const register = vi.fn((input: unknown) => ({ id: "witness", ...(input as object) }));
  const rows: unknown[] = [];
  const fake = {
    register: (input: unknown) => {
      const entry = register(input);
      rows.unshift(entry);
      return entry;
    },
    // The panel's own refresh path reads entries() to build the chip report.
    entries: () => [...rows],
  } as unknown as ReactionLedger;
  setActiveReactionLedger(fake);
  return { register };
}

function askAndDo(prompt: string) {
  fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: prompt } });
  fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
}

afterEach(() => {
  cleanup();
  setActiveReactionLedger(null);
  localStorage.clear();
});

describe("reaction ledger panel wiring (seam: reaction-ledger-panel-wiring)", () => {
  it("DO IT records the proposal through the real panel entry point", async () => {
    const { project } = setup();
    const before = JSON.stringify(project.doc);

    askAndDo("Turn the drums up a bit");

    // The route really executed against the real store…
    await waitFor(() => expect(JSON.stringify(project.doc)).not.toBe(before));
    // …and the panel registered the proposal it executed.
    const ledger = activeReactionLedger();
    expect(ledger, "ledger unavailable — install it before rendering the panel").not.toBeNull();
    await waitFor(() => expect(ledger!.entries()).toHaveLength(1));
    const entry = ledger!.entries()[0]!;
    expect(entry.outcome).toBe("pending");
    expect(entry.routeKind.length).toBeGreaterThan(0);
    expect(entry.beforeHash).not.toBe(entry.afterHash);
    // The privacy boundary holds at the call site too: the compact action is
    // sanitized vocabulary, never the prompt prose.
    expect(entry.action).not.toContain("drums up");
  });

  it("the panel calls the ledger's register for the route it executed", async () => {
    const { project } = setup();
    const { register } = spyLedger();
    const before = JSON.stringify(project.doc);

    askAndDo("Turn the drums up a bit");

    await waitFor(() => expect(JSON.stringify(project.doc)).not.toBe(before));
    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    const input = register.mock.calls[0]![0] as {
      routeKind: string;
      beforeHash: string;
      afterHash: string;
      undoDepth: number;
    };
    expect(input.routeKind.length).toBeGreaterThan(0);
    expect(input.beforeHash).not.toBe(input.afterHash);
    expect(Number.isInteger(input.undoDepth)).toBe(true);
  });

  it("NEGATIVE: with the ledger off the same gesture never reaches register", async () => {
    const { project } = setup();
    const { register } = spyLedger();
    // The kill switch wins over the installed ledger: activeReactionLedger()
    // must answer null, so the bridge's `if (!ledger) return` fires.
    setReactionLedgerEnabled(false);
    const before = JSON.stringify(project.doc);

    askAndDo("Turn the drums up a bit");

    // The route still ran (no vacuous negative)…
    await waitFor(() => expect(JSON.stringify(project.doc)).not.toBe(before));
    // …and nothing was registered.
    expect(activeReactionLedger()).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });
});
