import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { renderWithContext, mockServices } from "../helpers";
import {
  activeReactionLedger,
  sanitizeAction,
  setActiveReactionLedger,
  setReactionLedgerEnabled,
  type ReactionLedger,
} from "../../src/intent/reaction-ledger";
import type { Services } from "../../src/services";

/**
 * F2 CLOSURE — THE APPLY SURFACE IS IN THE LEDGER.
 *
 * Before this wave the single biggest action in the panel (the human applying
 * a generated candidate) was not recorded at all, so the rerank fit could only
 * assume the engine's delivered winner was what the human kept. This spec
 * enters the REAL panel, presses DO IT then USE, and asserts the recorded row
 * carries the generation identity and the applied bank index — the two fields
 * the fit joins on — plus the negative that the kill switch still silences it.
 *
 * `rerankTopBySound` is the identity (the established jsdom pattern): the
 * pipeline still derives and stamps the generation id from the first-pass
 * bank, which is exactly what the apply surface reads.
 */

vi.mock("../../src/intent/ranking-v3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intent/ranking-v3")>();
  return { ...actual, rerankTopBySound: vi.fn(async (_doc, bank) => [...bank]) };
});

interface WitnessRow {
  routeKind: string;
  action: string;
  generationId?: string;
  candidateIndex?: number;
  beforeHash: string;
  afterHash: string;
  undoDepth: number;
}

function witnessLedger() {
  const rows: WitnessRow[] = [];
  const fake = {
    register: (input: { routeKind: string; action: unknown; beforeHash: string; afterHash: string }) => {
      rows.push({
        ...input,
        // The real ledger sanitizes the action envelope into the closed
        // vocabulary string; the witness does the same so the assertion is
        // about what would actually be stored.
        action: sanitizeAction(input.action),
      } as WitnessRow);
      return { id: `witness-${rows.length}`, outcome: "pending", resolvedAt: null, createdAt: 1, ...input };
    },
    entries: () => [...rows],
    pendingCount: () => rows.length,
  } as unknown as ReactionLedger;
  setActiveReactionLedger(fake);
  return { rows };
}

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

async function generateAndUse(prompt: string): Promise<HTMLElement[]> {
  fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: prompt } });
  fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
  const useButtons = await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });
  expect(useButtons.length).toBeGreaterThanOrEqual(1);
  fireEvent.click(useButtons[0]!);
  return useButtons;
}

afterEach(() => {
  cleanup();
  setActiveReactionLedger(null);
  localStorage.clear();
});

describe("candidate use reaches the reaction ledger (F2 join)", () => {
  it("USE records the applied candidate with its generation identity and bank index", async () => {
    setup();
    const { rows } = witnessLedger();

    const useButtons = await generateAndUse("dark trap at 142");
    // Audition-first: there IS a bank to choose from (Wave A).
    expect(useButtons.length).toBeGreaterThanOrEqual(2);

    await waitFor(() => expect(rows).toHaveLength(1));
    const row = rows[0]!;
    expect(row.routeKind).toBe("candidateUse");
    expect(row.action).toBe("generate:pattern:abs");
    expect(row.generationId).toMatch(/^gen-\d+$/);
    expect(Number.isInteger(row.candidateIndex)).toBe(true);
    expect(row.candidateIndex).toBeGreaterThanOrEqual(0);
    expect(row.beforeHash).not.toBe(row.afterHash);
    expect(Number.isInteger(row.undoDepth)).toBe(true);
  }, 40000);

  it("NEGATIVE: with the ledger off the same gesture records nothing", async () => {
    setup();
    const { rows } = witnessLedger();
    setReactionLedgerEnabled(false);

    // A DIFFERENT brief than the first spec: the session-context module is a
    // singleton, and repeating the same prompt would route through the
    // follow-up resolution instead of a fresh generation.
    await generateAndUse("dark phonk at 92");

    expect(activeReactionLedger()).toBeNull();
    expect(rows).toHaveLength(0);
  }, 40000);
});
