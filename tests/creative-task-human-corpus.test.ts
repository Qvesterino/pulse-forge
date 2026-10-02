import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileCreativeTaskHumanTrainingCorpus,
  HumanCorpusValidationError,
  validateCreativeTaskHumanCorpus,
} from "../scripts/creative-task-human-corpus";

type HumanRow = {
  version: number;
  id: string;
  family: string;
  split: "train" | "validation" | "held-out";
  language: string;
  operation: string;
  prompt: string;
  consent: { affirmative: boolean; [key: string]: unknown };
  annotations: Array<{ reviewerKey: string; confidence: string; output: unknown }>;
  [key: string]: unknown;
};

function reviewedRow(args?: {
  id?: string;
  family?: string;
  split?: "train" | "validation" | "held-out";
  prompt?: string;
  genre?: string;
  mood?: string;
}): HumanRow {
  const split = args?.split ?? "train";
  const output = {
    version: 1,
    status: "proposal",
    suggestions: {
      genre: args?.genre ?? "trap",
      mood: args?.mood ?? "dark",
    },
    unknownFields: [],
  };
  return {
    version: 1,
    id: args?.id ?? "case-0123456789abcdef0123456789abcdef",
    family: args?.family ?? "consented-brief-alpha",
    split,
    language: "en",
    operation: "generate",
    prompt: args?.prompt ?? "Make a dark trap loop.",
    consent: {
      affirmative: true,
      purposes: [split === "train" ? "model-training" : "evaluation"],
      privacyReviewed: true,
      promptRedacted: true,
      includesAudio: false,
      includesLyrics: false,
      receiptSha256: "a".repeat(64),
      recordedAt: "2026-10-01T12:00:00Z",
    },
    annotations: [
      { reviewerKey: "reviewer-alpha", confidence: "high", output },
      { reviewerKey: "reviewer-beta", confidence: "high", output },
    ],
    adjudication: {
      reviewerKey: "reviewer-gamma",
      resolution: "consensus",
      reasonCodes: [],
      output,
    },
  };
}

function corpusBytes(rows: readonly HumanRow[]): Buffer {
  return Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function captureValidationError(bytes: Uint8Array): HumanCorpusValidationError {
  try {
    validateCreativeTaskHumanCorpus(bytes);
  } catch (error) {
    if (error instanceof HumanCorpusValidationError) return error;
    throw error;
  }
  throw new Error("Expected human corpus validation to fail.");
}

describe("consented creative-task human corpus gate", () => {
  it("accepts a double-reviewed, adjudicated, consent-scoped row without exporting examples", () => {
    const bytes = corpusBytes([reviewedRow()]);
    const summary = validateCreativeTaskHumanCorpus(bytes);

    expect(summary).toMatchObject({
      task: "creative-task-v1",
      rows: 1,
      bySplit: { train: { rows: 1, families: 1 }, validation: { rows: 0, families: 0 } },
      byLanguage: { en: 1, sk: 0 },
      consentedHumanReviewed: true,
      examplesPrinted: false,
      trainingExported: false,
    });
    expect(summary.inputSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects absent consent and does not echo the prompt or case id in errors", () => {
    const row = reviewedRow();
    row.consent.affirmative = false;
    const error = captureValidationError(corpusBytes([row]));

    expect(error.message).toContain("invalid-or-insufficient-consent");
    expect(error.message).not.toContain(row.prompt);
    expect(error.message).not.toContain(row.id);
  });

  it("requires training consent only for rows placed in the training split", () => {
    const row = reviewedRow({ split: "held-out" });
    row.consent.purposes = ["model-training"];
    const error = captureValidationError(corpusBytes([row]));

    expect(error.message).toContain("invalid-or-insufficient-consent");
  });

  it("requires independent annotators and a separate adjudicator", () => {
    const row = reviewedRow();
    row.annotations[1].reviewerKey = row.annotations[0].reviewerKey;
    const error = captureValidationError(corpusBytes([row]));

    expect(error.message).toContain("reviewers-must-be-independent");
  });

  it("rejects family leakage across train and held-out splits", () => {
    const train = reviewedRow();
    const heldOut = reviewedRow({
      id: "case-1123456789abcdef0123456789abcdef",
      split: "held-out",
      prompt: "Create a warm house groove.",
      genre: "house",
      mood: "warm",
    });
    heldOut.family = train.family;
    const error = captureValidationError(corpusBytes([train, heldOut]));

    expect(error.message).toContain("family-leaks-across-splits");
  });

  it("rejects families already reserved for the synthetic held-out golden", () => {
    const golden = readFileSync(path.join(process.cwd(), "scripts", "data", "creative-task-v1-golden.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { family: string })[0];
    expect(golden).toBeDefined();
    const row = reviewedRow({ family: golden!.family });
    const error = captureValidationError(corpusBytes([row]));

    expect(error.message).toContain("family-overlaps-synthetic-held-out-golden");
  });

  it("rejects an adjudicated label that changes a parser-confirmed explicit genre", () => {
    const row = reviewedRow();
    const houseOutput = {
      version: 1,
      status: "proposal",
      suggestions: { genre: "house", mood: "dark" },
      unknownFields: [],
    };
    row.annotations[0].output = houseOutput;
    row.annotations[1].output = houseOutput;
    row.adjudication = {
      reviewerKey: "reviewer-gamma",
      resolution: "consensus",
      reasonCodes: [],
      output: houseOutput,
    };
    const error = captureValidationError(corpusBytes([row]));

    expect(error.message).toContain("adjudicated-output-violates-request-context");
  });

  it("compiles only training and validation rows while excluding held-out prompts", () => {
    const train = reviewedRow();
    const validation = reviewedRow({
      id: "case-1123456789abcdef0123456789abcdef",
      family: "consented-brief-beta",
      split: "validation",
      prompt: "Make a warm house loop.",
      genre: "house",
      mood: "warm",
    });
    const heldOut = reviewedRow({
      id: "case-2123456789abcdef0123456789abcdef",
      family: "consented-brief-gamma",
      split: "held-out",
      prompt: "Make a dark trap groove.",
    });
    const compiled = compileCreativeTaskHumanTrainingCorpus(corpusBytes([train, validation, heldOut]));
    const serialized = JSON.stringify({ manifest: compiled, rows: compiled.rows });

    expect(compiled.rows.train).toHaveLength(1);
    expect(compiled.rows.validation).toHaveLength(1);
    expect(compiled.rows.train[0]).toMatchObject({
      id: train.id,
      split: "train",
      source: "consented-human-adjudicated-v1",
      consentPurpose: "model-training",
    });
    expect(compiled.rows.validation[0]).toMatchObject({
      id: validation.id,
      split: "validation",
      consentPurpose: "evaluation",
    });
    expect(compiled.heldOutRowsExcluded).toBe(1);
    expect(compiled.splits.train.caseIds).toEqual([train.id]);
    expect(serialized).not.toContain(heldOut.id);
    expect(serialized).not.toContain(heldOut.prompt);
    expect(compiled.eligibleForModelPromotion).toBe(false);
  });

  it("rejects arbitrary metadata that could carry participant identity or raw review text", () => {
    const row = reviewedRow();
    row.participantEmail = "creator@example.invalid";
    const error = captureValidationError(corpusBytes([row]));

    expect(error.message).toContain("invalid-row-shape");
    expect(error.message).not.toContain("creator@example.invalid");
  });
});
