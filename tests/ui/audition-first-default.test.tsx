import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { renderWithContext } from "../helpers";
import { LEAN_CANDIDATE_COUNT } from "../../src/intent/candidate-budget";
import * as candidateBudget from "../../src/intent/candidate-budget";

/**
 * WAVE A — AUDITION-FIRST DEFAULT, through the REAL panel.
 *
 * The taste loop's fuel is the user choosing between alternatives, so these
 * specs enter `runGeneration` the way a user does (type the brief, press DO IT)
 * and assert what the default actually produces: a real candidate bank with
 * more than one auditionable option, the E1 rationale on the winner, and NO
 * single-result fallback (that button is reserved for the constrained path).
 *
 * The negative spec proves the budget REACHES the request instead of being
 * decoration: under the lean budget the same gesture yields one un-auditionable
 * result and the honest `USE RESULT` apply — the trade a constrained device
 * makes, with nothing silently different.
 *
 * `rerankTopBySound` is stubbed to the identity (the established pattern in
 * IntentPanel.test.tsx): the audio rerank ORDER is not under test here, the
 * BANK built underneath it is.
 */

vi.mock("../../src/intent/ranking-v3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intent/ranking-v3")>();
  return { ...actual, rerankTopBySound: vi.fn(async (_doc, bank) => [...bank]) };
});

function askAndDo(prompt: string): void {
  fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: prompt } });
  fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
}

describe("audition-first default (Wave A)", () => {
  it("DO IT yields a tasting flight: several auditionable candidates, one explained winner, no single-result fallback", async () => {
    renderWithContext(<IntentPanel />);

    askAndDo("dark trap at 142");

    const useButtons = await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });
    expect(useButtons.length).toBeGreaterThanOrEqual(2);
    // Every candidate is auditionable — that is what makes the bank a tasting
    // flight rather than a list.
    expect(screen.getAllByTitle("Audition this candidate").length).toBe(useButtons.length);
    // One winner, one explanation — the E1 layer reached the bank surface.
    expect(screen.getAllByText("★ best")).toHaveLength(1);
    expect(document.querySelector(".intent-candidate-rationale")?.textContent ?? "").toMatch(
      /fit score|ranker|auditioning the render|lead|Tied|produced this pattern directly/,
    );
    // The single-result fallback belongs to the lean path only.
    expect(screen.queryByRole("button", { name: "USE RESULT" })).toBeNull();
  }, 40000);

  it("NEGATIVE: under the lean budget the same gesture offers one result, not an audition", async () => {
    const spy = vi.spyOn(candidateBudget, "intentCandidateBudget").mockReturnValue({
      candidateCount: LEAN_CANDIDATE_COUNT,
      symbolicCandidates: 0,
      lean: true,
    });
    try {
      renderWithContext(<IntentPanel />);
      askAndDo("dark trap at 142");

      const useResult = await screen.findByRole("button", { name: "USE RESULT" }, { timeout: 20000 });
      expect(useResult).toBeEnabled();
      // No bank, so nothing to audition and nothing to explain at the bank —
      // the constrained path is honest about being a single pick.
      expect(screen.queryAllByRole("button", { name: /^USE$/ })).toHaveLength(0);
      expect(document.querySelector(".intent-candidate-rationale")).toBeNull();
      expect(spy).toHaveBeenCalled();
      await waitFor(() => expect(screen.getByText(/pattern generated/)).toBeInTheDocument());
    } finally {
      spy.mockRestore();
    }
  }, 40000);
});
