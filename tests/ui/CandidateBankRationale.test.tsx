import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CandidateBank } from "../../src/ui/intent/CandidateBank";
import type { GenerationResult, RankedCandidate } from "../../src/intent/types";

/**
 * WAVE E1 — the rationale surface. The ★ best row must carry the measured
 * "why", and must stay silent when there is none (no decorative explanation).
 */

function candidate(index: number): RankedCandidate {
  return {
    candidateIndex: index,
    source: "template",
    status: "accepted",
    repairs: [],
    score: 0.5,
    contentHash: `hash-${index}`,
  } as unknown as RankedCandidate;
}

function bankResult(options: { rationale?: string; winnerIndex?: number } = {}): GenerationResult {
  const winnerIndex = options.winnerIndex ?? 0;
  return {
    status: "accepted",
    bank: [{ candidateIndex: winnerIndex }],
    selection: {
      featureVersion: "features.v1",
      rankerVersion: "heuristic",
      modelHash: null,
      mode: "off",
      source: "fallback",
      selectedIndex: winnerIndex,
      ...(options.rationale !== undefined ? { rationale: options.rationale } : {}),
    },
  } as unknown as GenerationResult;
}

function renderBank(result: GenerationResult, candidates: RankedCandidate[]) {
  return render(
    <CandidateBank
      hidden={false}
      candidates={candidates}
      bankResult={result}
      playingIndex={null}
      renderingIndex={null}
      onToggleAudition={vi.fn()}
      onUseCandidate={vi.fn()}
      onIterate={vi.fn()}
      onSendToAudiotool={vi.fn()}
    />,
  );
}

describe("CandidateBank rationale", () => {
  it("shows the measured why next to the winning candidate", () => {
    const rationale = "Highest deterministic fit score in the bank (0.900). Clear lead over the runner-up (+0.300).";
    renderBank(bankResult({ rationale }), [candidate(0), candidate(1)]);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(rationale);
    expect(note).toHaveAttribute("title", rationale);
  });

  it("stays silent without a rationale (no decorative explanation)", () => {
    renderBank(bankResult(), [candidate(0), candidate(1)]);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("attaches the rationale to the WINNER, not to every row", () => {
    renderBank(bankResult({ rationale: "Tied with the runner-up.", winnerIndex: 1 }), [candidate(0), candidate(1)]);
    const notes = screen.getAllByRole("note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent("Tied with the runner-up.");
  });
});
