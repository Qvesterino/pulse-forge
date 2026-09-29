import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createDefaultProject } from "../../src/project-model/schema";
import { normalizeIntent } from "../../src/intent/normalize";
import { planGeneration } from "../../src/intent/plan";
import * as featureExtractor from "../../src/ai/features/pattern-features";
import { FEATURE_COUNT, FEATURE_NAMES, type PatternFeatureVector } from "../../src/ai/features/pattern-features";
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
      globalScore: 0.7 - variant * 0.1,
      globalScoreVersion: "global-selector.v1:heuristic",
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProducerDnaCompare", () => {
  it("offers a blind A/B probe for a confounded pair and records no vote until confirmed", () => {
    // The product changed here: a confounded pair used to be refused outright
    // ("v tomto banku niet nového páru"). It now degrades to a BLIND A/B
    // comparison, which is the better call for music — when the score cannot
    // separate two takes, the human ear is the tiebreaker, and the panel says
    // so explicitly ("nič sa neuloží, kým nepotvrdíš voľbu").
    //
    // What must NOT regress is the safety property underneath: no preference
    // is written until the user actually decides. That is the assertion this
    // test now leads with, because it is the one that can silently rot.
    const { project, result } = buildFixture();
    render(<ProducerDnaCompare project={project} result={result} onAudition={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "NAVRHNÚŤ TASTE PROBE" }));

    expect(localStorage.getItem(PREFERENCE_LEDGER_KEY)).toBeNull();

    const status = screen.getByRole("status");
    // The confound is explained rather than hidden: random assignment, which
    // measured axis differs, and by how much.
    expect(status).toHaveTextContent(/náhodne priradené/i);
    expect(status).toHaveTextContent(/nič sa neuloží/i);
    // Both sides are offered so the user can listen — a probe with no
    // auditionable sides would be a dead end. The accessible names carry the
    // play glyph (▶ A / ▶ B). Note the previous version of this assertion
    // matched name "A" exactly, which matched NOTHING when the probe was
    // refused — it passed vacuously instead of checking anything.
    expect(screen.getAllByRole("button", { name: /A$/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /B$/ }).length).toBeGreaterThan(0);
    // Neither side is pre-committed: the user must press one.
    expect(
      screen.getAllByRole("button", { name: /A$/ }).some((b) => b.getAttribute("aria-pressed") === "true"),
    ).toBe(false);
  });

  it("randomizes suggested A/B sides, hides rank/source, and records the displayed side", () => {
    const { project, result } = buildFixture();
    const syncopationIndex = FEATURE_NAMES.indexOf("drums.syncopation");
    vi.spyOn(featureExtractor, "extractPatternFeatures").mockImplementation(({ pattern }) => {
      const values = new Float32Array(FEATURE_COUNT).fill(0.5);
      values[syncopationIndex] = pattern.id === "dna-pattern-0" ? 0.1 : pattern.id === "dna-pattern-1" ? 0.9 : 0.5;
      return {
        version: "features.v1",
        values,
        names: FEATURE_NAMES,
        finite: true,
        clippedCount: 0,
        featureHash: "taste-probe-test",
      } satisfies PatternFeatureVector;
    });
    vi.spyOn(window.crypto, "getRandomValues").mockReturnValue(new Uint8Array([1]) as never);
    const onAudition = vi.fn();
    render(<ProducerDnaCompare project={project} result={result} onAudition={onAudition} />);

    fireEvent.click(screen.getByRole("button", { name: "NAVRHNÚŤ TASTE PROBE" }));

    expect(screen.getByRole("status")).toHaveTextContent(/strany a\/b sú náhodne priradené/i);
    expect(screen.queryByText(/TPL|PRIOR/)).not.toBeInTheDocument();
    expect(screen.queryByText(/A #\d|B #\d/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "▶ A" }));
    expect(onAudition).toHaveBeenCalledWith(result.bank?.[1]);

    fireEvent.click(screen.getByRole("button", { name: "Nechal by som A" }));
    const stored = JSON.parse(localStorage.getItem(PREFERENCE_LEDGER_KEY) ?? "[]");
    expect(stored[0].candidateA.contentHash).toBe("candidate-hash-0");
    expect(stored[0].choice).toBe("b");
    expect(screen.getByText(/#1 · TPL/)).toBeInTheDocument();
  });

  it("lets the producer skip a suggested pair and proposes a different one next", () => {
    const { project, result } = buildFixture();
    const probeResult: GenerationResult = {
      ...result,
      bank: result.bank?.map((candidate, index) => ({ ...candidate, globalScore: 0.7 - index * 0.02 })),
    };
    const syncopationIndex = FEATURE_NAMES.indexOf("drums.syncopation");
    vi.spyOn(featureExtractor, "extractPatternFeatures").mockImplementation(({ pattern }) => {
      const values = new Float32Array(FEATURE_COUNT).fill(0.5);
      values[syncopationIndex] = pattern.id === "dna-pattern-0" ? 0.1 : pattern.id === "dna-pattern-1" ? 0.9 : 0.5;
      return {
        version: "features.v1",
        values,
        names: FEATURE_NAMES,
        finite: true,
        clippedCount: 0,
        featureHash: "taste-probe-test",
      } satisfies PatternFeatureVector;
    });
    vi.spyOn(window.crypto, "getRandomValues").mockReturnValue(new Uint8Array([0]) as never);
    const onAudition = vi.fn();
    render(<ProducerDnaCompare project={project} result={probeResult} onAudition={onAudition} />);
    fireEvent.click(screen.getByRole("button", { name: "NAVRHNÚŤ TASTE PROBE" }));
    fireEvent.click(screen.getByRole("button", { name: "Zrušiť slepé porovnanie" }));

    expect(screen.getByRole("status")).toHaveTextContent(/slepé porovnanie zrušené/i);
    expect(screen.getByText(/#1 · TPL/)).toBeInTheDocument();
    expect(localStorage.getItem(PREFERENCE_LEDGER_KEY)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "NAVRHNÚŤ TASTE PROBE" }));
    fireEvent.click(screen.getByRole("button", { name: "▶ A" }));
    fireEvent.click(screen.getByRole("button", { name: "▶ B" }));
    const nextPair = new Set(onAudition.mock.calls.slice(-2).map(([candidate]) => candidate.pattern.id));
    expect(nextPair).not.toEqual(new Set(["dna-pattern-0", "dna-pattern-1"]));
  });

  it("records only the explicit A/B vote and keeps prompt/seed out of the ledger", () => {
    const { project, result } = buildFixture();
    render(<ProducerDnaCompare project={project} result={result} onAudition={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "A" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "B" })[1]);
    expect(screen.getByText(/ktorý take by si nechal/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Nechal by som A" }));

    const stored = localStorage.getItem(PREFERENCE_LEDGER_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toHaveLength(1);
    expect(stored).not.toContain("test-private-seed");
    expect(stored).not.toContain("private prompt");
    expect(JSON.parse(stored!)[0].candidateA.globalScoreVersion).toBe("global-selector.v1:heuristic");
    expect(JSON.parse(stored!)[0].candidateA.globalScore).toBe(0.7);
    expect(screen.getByRole("status")).toHaveTextContent(/všeobecná preferencia.*aspoň 2 porovnania/i);
  });

  it("does not advertise unsupported preference reasons as learnable", () => {
    const { project, result } = buildFixture();
    render(<ProducerDnaCompare project={project} result={result} onAudition={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "A" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "B" })[1]);

    expect(screen.getByRole("option", { name: /basa \(ranker zatiaľ nemeria\)/i })).toBeDisabled();
    expect(screen.getByRole("option", { name: /harmónia \(ranker zatiaľ nemeria\)/i })).toBeDisabled();
    expect(screen.getByRole("option", { name: /priestor frázy/i })).toBeEnabled();
  });

  it("records the chosen reason and explains the minimum signal before it affects ranking", () => {
    const { project, result } = buildFixture();
    render(<ProducerDnaCompare project={project} result={result} onAudition={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "A" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "B" })[1]);
    fireEvent.change(screen.getByRole("combobox", { name: /optional reason/i }), { target: { value: "groove" } });
    fireEvent.click(screen.getByRole("button", { name: "Nechal by som B" }));

    const stored = JSON.parse(localStorage.getItem(PREFERENCE_LEDGER_KEY) ?? "[]");
    expect(stored[0].reason).toBe("groove");
    expect(screen.getByRole("status")).toHaveTextContent(
      /voľba B uložená pre „groove“.*aspoň 2 relevantných porovnaniach/i,
    );
  });

  it("does not collect votes while learning is paused", () => {
    const { project, result } = buildFixture();
    render(<ProducerDnaCompare project={project} result={result} onAudition={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Učenie zapnuté/i }));
    fireEvent.click(screen.getAllByRole("button", { name: "A" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "B" })[1]);
    expect(screen.getByRole("button", { name: "Nechal by som A" })).toBeDisabled();
    expect(localStorage.getItem(PREFERENCE_LEDGER_KEY)).toBeNull();
  });
});
