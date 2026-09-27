import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CandidateLaneReceipt } from "../../src/ui/CandidateLaneReceipt";
import type { GenerationPlan, RankedCandidate } from "../../src/intent/types";

function planWithSlots(
  templateCount: number,
  symbolicCount = 0,
): Pick<GenerationPlan, "candidateSeeds" | "symbolicSeeds"> {
  return {
    candidateSeeds: Array.from({ length: templateCount }, (_, index) => `template-${index}`),
    symbolicSeeds: Array.from({ length: symbolicCount }, (_, index) => `symbolic-${index}`),
  };
}

function candidate(
  candidateIndex: number,
  lane: "safe" | "personal" | "experimental",
  mode: "baseline" | "personalized" | "cold-start" | "experimental",
  family: "baseline" | "soft-axis" | "alternate-groove" | "personal-groove" | "evolving-hook" = "soft-axis",
): RankedCandidate {
  return {
    candidateIndex,
    seed: `seed-${candidateIndex}`,
    source: "template",
    status: "accepted",
    repairs: [],
    score: 0.5,
    modelScore: null,
    contentHash: `hash-${candidateIndex}`,
    pattern: {} as RankedCandidate["pattern"],
    search: { version: 1, lane, mode, family, variant: 0 },
  };
}

describe("CandidateLaneReceipt", () => {
  it("shows only the lanes that produced surviving candidates and marks PERSONAL cold-start", () => {
    render(
      <CandidateLaneReceipt
        plan={planWithSlots(3)}
        candidates={[
          candidate(0, "safe", "baseline", "baseline"),
          candidate(1, "personal", "cold-start"),
          candidate(2, "experimental", "experimental", "evolving-hook"),
        ]}
        warnings={[]}
      />,
    );

    expect(screen.getByText("SAFE")).toBeInTheDocument();
    expect(screen.getAllByText("1 platný kandidát")).toHaveLength(3);
    expect(screen.getByText(/cold-start — zatiaľ bez použiteľného osobného feedbacku/)).toBeInTheDocument();
    expect(screen.getByText(/obmieňaná kadencia hooku/)).toBeInTheDocument();
  });

  it("explains why a planned lane produced no surviving candidate", () => {
    render(
      <CandidateLaneReceipt
        plan={planWithSlots(3)}
        candidates={[candidate(0, "safe", "baseline", "baseline"), candidate(1, "personal", "cold-start")]}
        warnings={["candidate-bank-skipped:candidate-2:invariant-gate"]}
      />,
    );

    expect(screen.getByText("bez výsledku")).toBeInTheDocument();
    expect(screen.getByText("variant neprešiel hard validáciou")).toBeInTheDocument();
  });

  it("distinguishes a lane omitted from this run from one that failed", () => {
    render(
      <CandidateLaneReceipt
        plan={planWithSlots(2)}
        candidates={[candidate(0, "safe", "baseline", "baseline"), candidate(1, "personal", "cold-start")]}
        warnings={[]}
      />,
    );

    expect(screen.getByText("tento smer nebol v tomto behu plánovaný")).toBeInTheDocument();
    expect(screen.getByText("neplánovaný")).toBeInTheDocument();
  });

  it("explains when audio fit displaced the first-pass winner using visible bank positions", () => {
    render(
      <CandidateLaneReceipt
        plan={planWithSlots(3)}
        candidates={[
          candidate(8, "experimental", "experimental"),
          candidate(3, "safe", "baseline", "baseline"),
          candidate(1, "personal", "cold-start"),
        ]}
        warnings={[]}
        selection={{ audioRerank: { displacedCandidateIndex: 3, selectedCandidateIndex: 8 } }}
      />,
    );

    expect(screen.getByLabelText("Audio rerank explanation")).toHaveTextContent(/posunul kandidáta #1 pred #2/);
    expect(screen.getByLabelText("Audio rerank explanation")).toHaveTextContent(/nie objektívna známka kvality/);
  });

  it("does not add a lane summary to a single-candidate run", () => {
    const { container } = render(
      <CandidateLaneReceipt plan={planWithSlots(1)} candidates={[candidate(0, "safe", "baseline")]} warnings={[]} />,
    );

    expect(container.firstChild).toBeNull();
  });
});
