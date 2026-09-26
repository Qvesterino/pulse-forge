import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createDefaultProject } from "../../src/project-model/schema";
import { normalizeIntent } from "../../src/intent/normalize";
import { planGeneration } from "../../src/intent/plan";
import { ProducerDnaCompare } from "../../src/ui/ProducerDnaCompare";
import type { GenerationResult, RankedCandidate } from "../../src/intent/types";
import type { Pattern } from "../../src/project-model/types";
import { PREFERENCE_LEDGER_KEY } from "../../src/intent/preference-ledger";

function buildFixture(): { result: GenerationResult; project: ReturnType<typeof createDefaultProject> } {
  const project = createDefaultProject();
  const intent = normalizeIntent({ genre: "trap", seed: "test-private-seed", roles: ["drums"], candidateCount: 3 });
  const plan = planGeneration(intent, project);
  const source = project.patterns[0];
  const bank: RankedCandidate[] = [0, 1, 2].map((variant) => {
    const pattern: Pattern = {
      ...source,
      id: `dna-pattern-${variant}`,
      rows: Object.fromEntries(
        Object.entries(source.rows).map(([padId, row], rowIndex) => [
          padId,
          row.map((value, step) => (step === variant + rowIndex ? (value > 0 ? 0 : 0.8) : value)),
        ]),
      ),
    };
    return {
      candidateIndex: variant,
      seed: `candidate-${variant}`,
      source: "template",
      status: "accepted",
      repairs: [],
      score: 0.7 - variant * 0.1,
      modelScore: null,
      contentHash: `candidate-hash-${variant}`,
      pattern,
    };
  });
  const diagnostics = { warnings: [], repairs: [], errors: [] };
  return {
    project,
    result: {
      status: "accepted",
      plan,
      proposal: { pattern: bank[0].pattern, diagnostics, status: "accepted" },
      diagnostics,
      provider: { id: "test", version: "1" },
      bank,
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("ProducerDnaCompare", () => {
  it("records only the explicit A/B vote and keeps prompt/seed out of the ledger", () => {
    const { project, result } = buildFixture();
    render(<ProducerDnaCompare project={project} result={result} onAudition={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "A" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "B" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "A sedí viac" }));

    const stored = localStorage.getItem(PREFERENCE_LEDGER_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toHaveLength(1);
    expect(stored).not.toContain("test-private-seed");
    expect(stored).not.toContain("private prompt");
    expect(screen.getByRole("status")).toHaveTextContent(/väčšiu váhu/i);
  });

  it("does not collect votes while learning is paused", () => {
    const { project, result } = buildFixture();
    render(<ProducerDnaCompare project={project} result={result} onAudition={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Učenie zapnuté/i }));
    fireEvent.click(screen.getAllByRole("button", { name: "A" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "B" })[1]);
    expect(screen.getByRole("button", { name: "A sedí viac" })).toBeDisabled();
    expect(localStorage.getItem(PREFERENCE_LEDGER_KEY)).toBeNull();
  });
});
