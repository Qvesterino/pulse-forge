import {
  validateCreativeTaskOutput,
  type CreativeTaskOutputV1,
  type CreativeTaskOperation,
} from "./creative-task-contract";

export interface CreativeTaskGoldenCaseV1 {
  version: 1;
  id: string;
  family: string;
  language: "en" | "sk";
  split: "held-out";
  operation: CreativeTaskOperation;
  prompt: string;
  expected: CreativeTaskOutputV1;
}

export interface CreativeTaskPredictionV1 {
  id: string;
  output: unknown;
}

export interface BinaryFieldMetrics {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface CreativeTaskEvaluationReportV1 {
  evaluatorVersion: 1;
  taskBoundary: "creative-brief interpretation only; not musical-quality evaluation";
  cases: number;
  predictions: number;
  missingPredictions: number;
  unexpectedPredictions: number;
  duplicatePredictionIds: number;
  validPredictions: number;
  invalidPredictions: number;
  decisionAccuracy: number;
  hardFieldExactRate: number;
  protectionFieldExactRate: number;
  preferenceFieldExactRate: number;
  hardFields: BinaryFieldMetrics;
  protectionFields: BinaryFieldMetrics;
  preferenceFields: BinaryFieldMetrics;
  criticalUnknownFields: BinaryFieldMetrics;
  criticalUnknownCases: number;
  roleSafetyFailures: number;
  byLanguage: Record<"en" | "sk", { cases: number; decisionAccuracy: number; hardFieldExactRate: number }>;
}

const HARD_FIELDS = ["bpmRange", "key", "lengthSteps", "targetRoles", "preserveRoles", "prohibitedRoles"] as const;
const PROTECTION_FIELDS = ["targetRoles", "preserveRoles", "prohibitedRoles"] as const;
const PREFERENCE_FIELDS = ["genre", "style", "mood", "energy", "density", "complexity", "variation"] as const;

function owns(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function f1(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null) return null;
  return precision + recall === 0 ? 0 : Number(((2 * precision * recall) / (precision + recall)).toFixed(4));
}

function emptyCounts() {
  return { truePositive: 0, falsePositive: 0, falseNegative: 0 };
}

function scoreFields(
  expected: Record<string, unknown>,
  actual: Record<string, unknown> | null,
  fields: readonly string[],
): ReturnType<typeof emptyCounts> {
  const counts = emptyCounts();
  for (const field of fields) {
    const hasExpected = owns(expected, field);
    const hasActual = actual !== null && owns(actual, field);
    if (hasExpected && hasActual && same(expected[field], actual?.[field])) counts.truePositive += 1;
    else {
      if (hasExpected) counts.falseNegative += 1;
      if (hasActual) counts.falsePositive += 1;
    }
  }
  return counts;
}

function finishMetrics(counts: ReturnType<typeof emptyCounts>): BinaryFieldMetrics {
  const precision = rate(counts.truePositive, counts.truePositive + counts.falsePositive);
  const recall = rate(counts.truePositive, counts.truePositive + counts.falseNegative);
  return { ...counts, precision, recall, f1: f1(precision, recall) };
}

function exactFields(
  expected: Record<string, unknown>,
  actual: Record<string, unknown> | null,
  fields: readonly string[],
) {
  return fields.every((field) => {
    const expectedHas = owns(expected, field);
    const actualHas = actual !== null && owns(actual, field);
    return expectedHas === actualHas && (!expectedHas || same(expected[field], actual?.[field]));
  });
}

function hasRoleConflict(output: CreativeTaskOutputV1): boolean {
  const { targetRoles = [], preserveRoles = [], prohibitedRoles = [] } = output.suggestions;
  return (
    targetRoles.some((role) => preserveRoles.includes(role) || prohibitedRoles.includes(role)) ||
    preserveRoles.some((role) => prohibitedRoles.includes(role))
  );
}

/**
 * Evaluate one prediction per held-out prompt. Hard constraints, soft
 * preferences, uncertainty and routing decisions remain separate metrics;
 * no aggregate score claims musical quality or listener preference.
 */
export function evaluateCreativeTaskPredictions(
  golden: readonly CreativeTaskGoldenCaseV1[],
  predictions: readonly CreativeTaskPredictionV1[],
): CreativeTaskEvaluationReportV1 {
  const goldenById = new Map(golden.map((entry) => [entry.id, entry]));
  const grouped = new Map<string, CreativeTaskPredictionV1[]>();
  for (const prediction of predictions) {
    const entries = grouped.get(prediction.id) ?? [];
    entries.push(prediction);
    grouped.set(prediction.id, entries);
  }
  const duplicates = [...grouped.values()].filter((entries) => entries.length > 1).length;
  const unexpectedPredictions = predictions.filter((prediction) => !goldenById.has(prediction.id)).length;
  const missingPredictions = golden.filter((entry) => !grouped.has(entry.id)).length;
  const counts = {
    hard: emptyCounts(),
    protection: emptyCounts(),
    preferences: emptyCounts(),
    unknown: emptyCounts(),
  };
  const language = {
    en: { cases: 0, decisionCorrect: 0, hardExact: 0 },
    sk: { cases: 0, decisionCorrect: 0, hardExact: 0 },
  };
  let validPredictions = 0;
  let invalidPredictions = 0;
  let decisionCorrect = 0;
  let hardExact = 0;
  let protectionExact = 0;
  let preferenceExact = 0;
  let criticalUnknownCases = 0;
  let roleSafetyFailures = 0;

  for (const entry of golden) {
    const bucket = language[entry.language];
    bucket.cases += 1;
    const rows = grouped.get(entry.id) ?? [];
    const duplicate = rows.length > 1;
    const validation = rows.length === 1 ? validateCreativeTaskOutput(rows[0]?.output) : null;
    const prediction = validation?.ok ? validation.output : null;
    const actualSuggestions = prediction?.suggestions ?? null;
    if (prediction) validPredictions += 1;
    else if (rows.length === 1) invalidPredictions += 1;

    const decisionMatches = prediction?.status === entry.expected.status;
    if (decisionMatches) {
      decisionCorrect += 1;
      bucket.decisionCorrect += 1;
    }
    const hardMatches = !duplicate && exactFields(entry.expected.suggestions, actualSuggestions, HARD_FIELDS);
    const protectionMatches =
      !duplicate && exactFields(entry.expected.suggestions, actualSuggestions, PROTECTION_FIELDS);
    const preferenceMatches =
      !duplicate && exactFields(entry.expected.suggestions, actualSuggestions, PREFERENCE_FIELDS);
    if (hardMatches) {
      hardExact += 1;
      bucket.hardExact += 1;
    }
    if (protectionMatches) protectionExact += 1;
    if (preferenceMatches) preferenceExact += 1;

    const hardCounts = scoreFields(entry.expected.suggestions, actualSuggestions, HARD_FIELDS);
    counts.hard.truePositive += hardCounts.truePositive;
    counts.hard.falsePositive += hardCounts.falsePositive;
    counts.hard.falseNegative += hardCounts.falseNegative;
    const protectionCounts = scoreFields(entry.expected.suggestions, actualSuggestions, PROTECTION_FIELDS);
    counts.protection.truePositive += protectionCounts.truePositive;
    counts.protection.falsePositive += protectionCounts.falsePositive;
    counts.protection.falseNegative += protectionCounts.falseNegative;
    const preferenceCounts = scoreFields(entry.expected.suggestions, actualSuggestions, PREFERENCE_FIELDS);
    counts.preferences.truePositive += preferenceCounts.truePositive;
    counts.preferences.falsePositive += preferenceCounts.falsePositive;
    counts.preferences.falseNegative += preferenceCounts.falseNegative;

    if (entry.expected.status === "clarify" || entry.expected.status === "abstain") {
      criticalUnknownCases += 1;
      // Treat unresolved fields as a set: order has no semantic significance.
      const expectedUnknown = [...entry.expected.unknownFields].sort();
      const predictedUnknown = prediction ? [...prediction.unknownFields].sort() : [];
      counts.unknown.truePositive += expectedUnknown.filter((field) => predictedUnknown.includes(field)).length;
      counts.unknown.falseNegative += expectedUnknown.filter((field) => !predictedUnknown.includes(field)).length;
      counts.unknown.falsePositive += predictedUnknown.filter((field) => !expectedUnknown.includes(field)).length;
    }

    if (prediction && hasRoleConflict(prediction) && prediction.status !== "clarify") roleSafetyFailures += 1;
    if (!prediction && rows.length > 0) roleSafetyFailures += 1;
  }

  const metric = finishMetrics(counts.hard);
  const protectionMetric = finishMetrics(counts.protection);
  const preferenceMetric = finishMetrics(counts.preferences);
  const unknownMetric = finishMetrics(counts.unknown);
  return {
    evaluatorVersion: 1,
    taskBoundary: "creative-brief interpretation only; not musical-quality evaluation",
    cases: golden.length,
    predictions: predictions.length,
    missingPredictions,
    unexpectedPredictions,
    duplicatePredictionIds: duplicates,
    validPredictions,
    invalidPredictions,
    decisionAccuracy: rate(decisionCorrect, golden.length) ?? 0,
    hardFieldExactRate: rate(hardExact, golden.length) ?? 0,
    protectionFieldExactRate: rate(protectionExact, golden.length) ?? 0,
    preferenceFieldExactRate: rate(preferenceExact, golden.length) ?? 0,
    hardFields: metric,
    protectionFields: protectionMetric,
    preferenceFields: preferenceMetric,
    criticalUnknownFields: unknownMetric,
    criticalUnknownCases,
    roleSafetyFailures,
    byLanguage: {
      en: {
        cases: language.en.cases,
        decisionAccuracy: rate(language.en.decisionCorrect, language.en.cases) ?? 0,
        hardFieldExactRate: rate(language.en.hardExact, language.en.cases) ?? 0,
      },
      sk: {
        cases: language.sk.cases,
        decisionAccuracy: rate(language.sk.decisionCorrect, language.sk.cases) ?? 0,
        hardFieldExactRate: rate(language.sk.hardExact, language.sk.cases) ?? 0,
      },
    },
  };
}
