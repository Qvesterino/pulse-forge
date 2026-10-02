import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCreativeTaskRequestV1,
  MAX_CREATIVE_TASK_PROMPT_LENGTH,
  validateCreativeTaskOutput,
  validateCreativeTaskOutputForRequest,
  type CreativeTaskOperation,
  type CreativeTaskOutputV1,
} from "../src/intent/creative-task-contract";
import { compileBriefContract } from "../src/intent/brief-contract";
import { parseIntentText } from "../src/intent/text-parser";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN_PATH = path.join(ROOT, "scripts", "data", "creative-task-v1-golden.jsonl");
export const MAX_REVIEW_CORPUS_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_ROW_BYTES = 64 * 1024;
const CASE_ID = /^case-[0-9a-f]{32}$/;
const FAMILY_ID = /^[a-z0-9]+(?:-[a-z0-9]+){1,7}$/;
const REVIEWER_KEY = /^reviewer-[a-z0-9][a-z0-9-]{2,31}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SPLITS = ["train", "validation", "held-out"] as const;
const LANGUAGES = ["en", "sk"] as const;
const OPERATIONS = ["generate", "revise"] as const;
const PURPOSES = ["model-training", "evaluation"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;
const RESOLUTIONS = ["consensus", "adjudicated"] as const;
const ADJUDICATION_REASONS = [
  "conflicting-instructions",
  "critical-unknown",
  "style-ambiguity",
  "parser-disagreement",
  "out-of-scope",
  "other",
] as const;

type ReviewSplit = (typeof SPLITS)[number];
type ReviewLanguage = (typeof LANGUAGES)[number];

interface ReviewAnnotation {
  reviewerKey: string;
  confidence: (typeof CONFIDENCES)[number];
  output: CreativeTaskOutputV1;
}

interface ReviewedCase {
  version: 1;
  id: string;
  family: string;
  split: ReviewSplit;
  language: ReviewLanguage;
  operation: CreativeTaskOperation;
  prompt: string;
  consent: {
    affirmative: true;
    purposes: (typeof PURPOSES)[number][];
    privacyReviewed: true;
    promptRedacted: true;
    includesAudio: false;
    includesLyrics: false;
    receiptSha256: string;
    recordedAt: string;
  };
  annotations: [ReviewAnnotation, ReviewAnnotation];
  adjudication: {
    reviewerKey: string;
    resolution: (typeof RESOLUTIONS)[number];
    reasonCodes: (typeof ADJUDICATION_REASONS)[number][];
    output: CreativeTaskOutputV1;
  };
}

export interface HumanCorpusSummary {
  formatVersion: 1;
  task: "creative-task-v1";
  inputSha256: string;
  rows: number;
  bySplit: Record<ReviewSplit, { rows: number; families: number }>;
  byLanguage: Record<ReviewLanguage, number>;
  consentedHumanReviewed: true;
  examplesPrinted: false;
  trainingExported: false;
}

interface ValidationIssue {
  line: number;
  code: string;
}

export class HumanCorpusValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const listed = issues
      .slice(0, 30)
      .map(({ line, code }) => `line ${line}: ${code}`)
      .join("; ");
    super(`Human review corpus rejected (${issues.length} issue(s)): ${listed}`);
    this.name = "HumanCorpusValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePrompt(prompt: string): string {
  return prompt.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function readGoldenIndex(): { families: Set<string>; prompts: Set<string> } {
  const families = new Set<string>();
  const prompts = new Set<string>();
  const bytes = readFileSync(GOLDEN_PATH);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row: unknown = JSON.parse(line);
    if (!isRecord(row) || typeof row.family !== "string" || typeof row.prompt !== "string") {
      throw new Error("Creative held-out golden index is malformed.");
    }
    families.add(row.family);
    prompts.add(normalizePrompt(row.prompt));
  }
  return { families, prompts };
}

function validateConsent(value: unknown, split: ReviewSplit): value is ReviewedCase["consent"] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "affirmative",
      "purposes",
      "privacyReviewed",
      "promptRedacted",
      "includesAudio",
      "includesLyrics",
      "receiptSha256",
      "recordedAt",
    ])
  ) {
    return false;
  }
  if (
    value.affirmative !== true ||
    value.privacyReviewed !== true ||
    value.promptRedacted !== true ||
    value.includesAudio !== false ||
    value.includesLyrics !== false ||
    typeof value.receiptSha256 !== "string" ||
    !SHA256.test(value.receiptSha256) ||
    typeof value.recordedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value.recordedAt) ||
    !Number.isFinite(Date.parse(value.recordedAt)) ||
    !Array.isArray(value.purposes) ||
    value.purposes.length !== 1 ||
    new Set(value.purposes).size !== 1
  ) {
    return false;
  }
  const requiredPurpose = split === "train" ? "model-training" : "evaluation";
  return value.purposes[0] === requiredPurpose;
}

function validateAnnotation(value: unknown): value is ReviewAnnotation {
  if (!isRecord(value) || !hasExactKeys(value, ["reviewerKey", "confidence", "output"])) return false;
  if (
    typeof value.reviewerKey !== "string" ||
    !REVIEWER_KEY.test(value.reviewerKey) ||
    typeof value.confidence !== "string" ||
    !CONFIDENCES.includes(value.confidence as (typeof CONFIDENCES)[number])
  ) {
    return false;
  }
  return validateCreativeTaskOutput(value.output).ok;
}

function validateAdjudication(value: unknown): value is ReviewedCase["adjudication"] {
  if (!isRecord(value) || !hasExactKeys(value, ["reviewerKey", "resolution", "reasonCodes", "output"])) return false;
  return (
    typeof value.reviewerKey === "string" &&
    REVIEWER_KEY.test(value.reviewerKey) &&
    typeof value.resolution === "string" &&
    RESOLUTIONS.includes(value.resolution as (typeof RESOLUTIONS)[number]) &&
    Array.isArray(value.reasonCodes) &&
    value.reasonCodes.every(
      (reason): reason is (typeof ADJUDICATION_REASONS)[number] =>
        typeof reason === "string" && ADJUDICATION_REASONS.includes(reason as (typeof ADJUDICATION_REASONS)[number]),
    ) &&
    new Set(value.reasonCodes).size === value.reasonCodes.length &&
    validateCreativeTaskOutput(value.output).ok
  );
}

function validateCase(value: unknown, line: number, issues: ValidationIssue[]): ReviewedCase | null {
  const issue = (code: string) => issues.push({ line, code });
  const keys = [
    "version",
    "id",
    "family",
    "split",
    "language",
    "operation",
    "prompt",
    "consent",
    "annotations",
    "adjudication",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue("invalid-row-shape");
    return null;
  }
  if (value.version !== 1) issue("unsupported-row-version");
  if (typeof value.id !== "string" || !CASE_ID.test(value.id)) issue("invalid-anonymous-case-id");
  if (typeof value.family !== "string" || !FAMILY_ID.test(value.family)) issue("invalid-family-key");
  if (typeof value.split !== "string" || !SPLITS.includes(value.split as ReviewSplit)) issue("invalid-split");
  if (typeof value.language !== "string" || !LANGUAGES.includes(value.language as ReviewLanguage)) {
    issue("invalid-language");
  }
  if (typeof value.operation !== "string" || !OPERATIONS.includes(value.operation as CreativeTaskOperation)) {
    issue("invalid-operation");
  }
  if (
    typeof value.prompt !== "string" ||
    value.prompt.trim().length === 0 ||
    value.prompt.length > MAX_CREATIVE_TASK_PROMPT_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.prompt)
  ) {
    issue("invalid-or-oversized-prompt");
  }

  const split = SPLITS.includes(value.split as ReviewSplit) ? (value.split as ReviewSplit) : null;
  const language = LANGUAGES.includes(value.language as ReviewLanguage) ? (value.language as ReviewLanguage) : null;
  const operation = OPERATIONS.includes(value.operation as CreativeTaskOperation)
    ? (value.operation as CreativeTaskOperation)
    : null;
  if (!split || !validateConsent(value.consent, split)) issue("invalid-or-insufficient-consent");

  if (
    !Array.isArray(value.annotations) ||
    value.annotations.length !== 2 ||
    !value.annotations.every(validateAnnotation)
  ) {
    issue("requires-two-independent-valid-annotations");
  }
  if (!validateAdjudication(value.adjudication)) issue("invalid-adjudication-shape");

  if (
    typeof value.id !== "string" ||
    typeof value.family !== "string" ||
    typeof value.prompt !== "string" ||
    !split ||
    !language ||
    !operation ||
    !Array.isArray(value.annotations) ||
    value.annotations.length !== 2 ||
    !value.annotations.every(validateAnnotation) ||
    !validateAdjudication(value.adjudication)
  ) {
    return null;
  }
  const [first, second] = value.annotations;
  const adjudication = value.adjudication;
  if (
    first.reviewerKey === second.reviewerKey ||
    adjudication.reviewerKey === first.reviewerKey ||
    adjudication.reviewerKey === second.reviewerKey
  ) {
    issue("reviewers-must-be-independent");
  }
  const annotationsAgree = stableJson(first.output) === stableJson(second.output);
  const adjudicatedOutput = validateCreativeTaskOutput(adjudication.output);
  if (!adjudicatedOutput.ok) {
    issue("invalid-adjudicated-output");
  } else {
    if (adjudication.resolution === "consensus") {
      if (
        !annotationsAgree ||
        adjudication.reasonCodes.length > 0 ||
        stableJson(first.output) !== stableJson(adjudicatedOutput.output)
      ) {
        issue("invalid-consensus-record");
      }
    } else if (annotationsAgree || adjudication.reasonCodes.length === 0) {
      issue("invalid-adjudication-record");
    }
    try {
      const parsed = parseIntentText(value.prompt);
      const request = createCreativeTaskRequestV1({
        operation,
        prompt: value.prompt,
        intent: parsed.input,
        contract: compileBriefContract(parsed),
      });
      if (!request.ok || !validateCreativeTaskOutputForRequest(adjudicatedOutput.output, request.request).ok) {
        issue("adjudicated-output-violates-request-context");
      }
    } catch {
      issue("brief-contract-construction-failed");
    }
  }

  return {
    version: 1,
    id: value.id,
    family: value.family,
    split,
    language,
    operation,
    prompt: value.prompt,
    consent: value.consent as ReviewedCase["consent"],
    annotations: value.annotations as [ReviewAnnotation, ReviewAnnotation],
    adjudication: adjudication as ReviewedCase["adjudication"],
  };
}

export function validateCreativeTaskHumanCorpus(bytes: Uint8Array): HumanCorpusSummary {
  if (bytes.byteLength > MAX_REVIEW_CORPUS_BYTES) {
    throw new HumanCorpusValidationError([{ line: 0, code: "corpus-exceeds-8-mib" }]);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HumanCorpusValidationError([{ line: 0, code: "invalid-utf8" }]);
  }

  const issues: ValidationIssue[] = [];
  const rows: ReviewedCase[] = [];
  const ids = new Set<string>();
  const prompts = new Set<string>();
  const familyBySplit: Record<ReviewSplit, Set<string>> = {
    train: new Set(),
    validation: new Set(),
    "held-out": new Set(),
  };
  const golden = readGoldenIndex();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const lineNumber = index + 1;
    if (Buffer.byteLength(line, "utf8") > MAX_REVIEW_ROW_BYTES) {
      issues.push({ line: lineNumber, code: "row-exceeds-64-kib" });
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      issues.push({ line: lineNumber, code: "invalid-json" });
      continue;
    }
    const row = validateCase(value, lineNumber, issues);
    if (!row) continue;
    if (ids.has(row.id)) issues.push({ line: lineNumber, code: "duplicate-case-id" });
    if (prompts.has(normalizePrompt(row.prompt)))
      issues.push({ line: lineNumber, code: "duplicate-normalized-prompt" });
    if (golden.families.has(row.family))
      issues.push({ line: lineNumber, code: "family-overlaps-synthetic-held-out-golden" });
    if (golden.prompts.has(normalizePrompt(row.prompt)))
      issues.push({ line: lineNumber, code: "prompt-overlaps-synthetic-held-out-golden" });
    ids.add(row.id);
    prompts.add(normalizePrompt(row.prompt));
    familyBySplit[row.split].add(row.family);
    rows.push(row);
  }
  if (rows.length === 0) issues.push({ line: 0, code: "empty-corpus" });

  const splitFamilies = new Map<string, ReviewSplit>();
  for (const split of SPLITS) {
    for (const family of familyBySplit[split]) {
      const previous = splitFamilies.get(family);
      if (previous && previous !== split) {
        issues.push({ line: 0, code: "family-leaks-across-splits" });
      } else {
        splitFamilies.set(family, split);
      }
    }
  }
  if (issues.length > 0) throw new HumanCorpusValidationError(issues);

  const bySplit = Object.fromEntries(
    SPLITS.map((split) => [
      split,
      { rows: rows.filter((row) => row.split === split).length, families: familyBySplit[split].size },
    ]),
  ) as HumanCorpusSummary["bySplit"];
  const byLanguage = Object.fromEntries(
    LANGUAGES.map((language) => [language, rows.filter((row) => row.language === language).length]),
  ) as HumanCorpusSummary["byLanguage"];
  return {
    formatVersion: 1,
    task: "creative-task-v1",
    inputSha256: hash(bytes),
    rows: rows.length,
    bySplit,
    byLanguage,
    consentedHumanReviewed: true,
    examplesPrinted: false,
    trainingExported: false,
  };
}
