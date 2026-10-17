import {
  generateGoldenVoice,
  multivoiceHash,
  MULTIVOICE_GOLDEN_CASES,
  MULTIVOICE_GOLDEN_EXPECTED,
} from "../fixtures/multivoice-golden";
import { AI_BASELINE_CASES, BASELINE_STEP_COUNTS, baselineOptions } from "../fixtures/ai-baseline";
import { AI_CORRECTNESS_EXPECTED } from "../fixtures/ai-correctness.expected";
import { createDefaultProject } from "../../src/project-model/schema";
import { generatePattern } from "../../src/ai/generator";
import { canonicalizePattern, contentHash, measurePattern } from "../../src/ai/evaluation";
import type { MultiVoiceResult } from "../../src/intent/multi-voice";

/**
 * GOLDEN DOCTOR (Package 3, 2026-10-17)
 *
 * Re-pinning a frozen artifact used to be an opaque hash swap: the reviewer
 * saw `4e733b49 → 4cc8313b` and nothing about WHAT changed musically — five
 * artifacts were re-pinned in one session, each discovered by hand-writing a
 * throwaway debug spec. This helper turns that into reviewable evidence:
 *
 *   - `diffRecords` — field-level from→to for metric-shaped pins;
 *   - `summarizeVoice` — the semantic shape of a generated multi-voice case
 *     (role note counts + progression), the thing the hash actually covers;
 *   - `collectGoldenDoctor` — recompute every doctor-covered artifact live and
 *     report hash status plus the semantic diff;
 *   - `formatGoldenDoctor` — the printable report.
 *
 * `npm run goldens:doctor` prints it; `npm run goldens:doctor -- --bless`
 * refreshes the committed summaries that make the NEXT re-pin readable.
 */

export interface FieldDiff {
  field: string;
  from: number | string | null;
  to: number | string | null;
}

/** Field-level diff of two flat record-shaped values (metrics, summaries). */
export function diffRecords(
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): FieldDiff[] {
  const fields = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  const diffs: FieldDiff[] = [];
  for (const field of fields) {
    const from = (expected[field] ?? null) as number | string | null;
    const to = (actual[field] ?? null) as number | string | null;
    const same =
      typeof from === "number" && typeof to === "number"
        ? Math.abs(from - to) < 1e-9
        : JSON.stringify(from) === JSON.stringify(to);
    if (!same) diffs.push({ field, from, to });
  }
  return diffs;
}

export interface VoiceSummary {
  bass: number;
  chord: number;
  lead: number;
  progression: string;
  degree: number;
}

/** The semantic shape of one generated multi-voice case — what the hash covers. */
export function summarizeVoice(result: MultiVoiceResult): VoiceSummary {
  return {
    bass: result.bass.length,
    chord: result.chord.length,
    lead: result.lead.length,
    progression: result.progressionName,
    degree: result.progressionDegree,
  };
}

export interface VoiceSummaryFile {
  schemaVersion: 1;
  note: string;
  cases: ReadonlyArray<{ caseId: string; summary: VoiceSummary }>;
}

const VOICE_SUMMARY_NOTE =
  "Semantic shape of each frozen multi-voice case (role note counts + progression). " +
  "Maintained by `npm run goldens:doctor -- --bless`; the doctor diff against this file is what makes a " +
  "hash re-pin reviewable — refresh it together with the hash when the change is intended.";

/** Current live summaries for every frozen multi-voice case. */
export function collectVoiceSummaries(): VoiceSummaryFile {
  return {
    schemaVersion: 1,
    note: VOICE_SUMMARY_NOTE,
    cases: MULTIVOICE_GOLDEN_CASES.map((testCase) => ({
      caseId: testCase.id,
      summary: summarizeVoice(generateGoldenVoice(testCase)),
    })),
  };
}

export interface DoctorCase {
  artifact: "multivoice" | "ai-baseline";
  label: string;
  expectedHash: string;
  actualHash: string;
  hashChanged: boolean;
  /** Semantic diff: metric fields (ai-baseline) or voice summary (multivoice). */
  diffs: FieldDiff[];
  /** For multivoice only: whether the change is structural (summary moved) or values-only. */
  summaryStatus?: "match" | "changed" | "unblessed";
}

/** Recompute every doctor-covered frozen artifact live and diff it semantically. */
export function collectGoldenDoctor(expectedSummaries?: VoiceSummaryFile | null): DoctorCase[] {
  const cases: DoctorCase[] = [];

  for (const testCase of MULTIVOICE_GOLDEN_CASES) {
    const result = generateGoldenVoice(testCase);
    const actualHash = multivoiceHash(result);
    const expected = MULTIVOICE_GOLDEN_EXPECTED.find((item) => item.caseId === testCase.id);
    const expectedHash = expected?.hash ?? "(missing)";
    const blessed = expectedSummaries?.cases.find((item) => item.caseId === testCase.id)?.summary ?? null;
    const summary = summarizeVoice(result);
    const diffs = blessed
      ? diffRecords(blessed as unknown as Record<string, unknown>, summary as unknown as Record<string, unknown>)
      : [];
    cases.push({
      artifact: "multivoice",
      label: testCase.id,
      expectedHash,
      actualHash,
      hashChanged: expectedHash !== actualHash,
      diffs,
      summaryStatus: blessed ? (diffs.length === 0 ? "match" : "changed") : "unblessed",
    });
  }

  for (const testCase of AI_BASELINE_CASES) {
    for (const stepCount of BASELINE_STEP_COUNTS) {
      const expected = AI_CORRECTNESS_EXPECTED.find(
        (item) => item.caseId === testCase.id && item.stepCount === stepCount,
      );
      const doc = createDefaultProject();
      const pattern = generatePattern(doc, baselineOptions(testCase, stepCount));
      const actualHash = contentHash(canonicalizePattern(doc, pattern));
      const metrics = measurePattern(pattern) as unknown as Record<string, unknown>;
      cases.push({
        artifact: "ai-baseline",
        label: `${testCase.id}/${stepCount}`,
        expectedHash: expected?.contentHash ?? "(missing)",
        actualHash,
        hashChanged: expected?.contentHash !== actualHash,
        diffs: expected ? diffRecords(expected.metrics as unknown as Record<string, unknown>, metrics) : [],
      });
    }
  }

  return cases;
}

/** Printable report: hash status first, then the semantic diff per case. */
export function formatGoldenDoctor(cases: readonly DoctorCase[]): string {
  const lines: string[] = [];
  const changed = cases.filter((item) => item.hashChanged);
  const drifted = cases.filter((item) => !item.hashChanged && item.diffs.length > 0);
  lines.push(
    `golden doctor — ${cases.length} frozen cases · ${changed.length} hash change(s) · ${drifted.length} semantic drift(s)`,
  );
  for (const item of cases) {
    if (!item.hashChanged && item.diffs.length === 0 && item.summaryStatus !== "unblessed") continue;
    lines.push(
      `- [${item.artifact}] ${item.label}: hash ${item.expectedHash} → ${item.actualHash}${item.hashChanged ? " (CHANGED)" : " (same)"}`,
    );
    if (item.summaryStatus === "unblessed") {
      lines.push(
        "    summary: not blessed yet — run `npm run goldens:doctor -- --bless` once, and review the diff it prints then",
      );
    } else if (item.summaryStatus === "changed") {
      lines.push("    STRUCTURAL (summary moved — re-pin the hash AND the summary together):");
    } else if (item.summaryStatus === "match" && item.hashChanged) {
      lines.push("    values-only drift: the summary held, the sample values moved");
    }
    for (const diff of item.diffs) {
      lines.push(`    ${diff.field}: ${String(diff.from)} → ${String(diff.to)}`);
    }
  }
  if (lines.length === 1) lines.push("✓ clean — every frozen artifact matches its committed hash and summary");
  return lines.join("\n");
}
