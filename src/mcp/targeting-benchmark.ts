import type { ProjectDocument } from "../project-model/types";
import { createHeadlessMcpHost, type HeadlessHost } from "./headless-host";
import type { McpToolResult } from "./tools";

/**
 * E9 — the MCP targeting benchmark: measure GROUNDING, not fluency.
 *
 * Given a seeded document and a task (an NL instruction through kyx_intent,
 * or a direct tool call), does the AI surface act on the RIGHT object with a
 * VALID action — or refuse, or ask? The harness scores receipts, never text
 * quality:
 *
 * - `mutated` — did the document change (the tool's own claim is not trusted;
 *   the doc before/after is diffed);
 * - `errorCode` — the typed refusal contract (INVALID_ARGUMENTS,
 *   UNKNOWN_TARGET, POLICY_REFUSED, ...);
 * - `changedDocFields` / `changedTracks` — WHICH top-level document fields
 *   and WHICH track ids actually moved, so "mute the drums" fails when it
 *   also silences the bass;
 * - `textContains` / `textNotContains` — for the disclosure/clarify
 *   sentences that are part of the contract (E5 masking story, clarify
 *   human-sentence rule).
 *
 * Determinism is the gate: the same seeded docs must produce byte-identical
 * reports (`reportsIdentical`). This module is PURE — scenario catalogs live
 * beside the fixtures they build (tests/mcp-targeting-scenarios.ts) and are
 * fed in by the vitest pin and scripts/mcp-targeting-benchmark.mts alike.
 */

export type TargetingScenarioCategory = "targeting" | "adversarial" | "refusal" | "verification";

export interface TargetingExpectation {
  mutated: boolean;
  errorCode?: string;
  textContains?: string[];
  textNotContains?: string[];
  /** EXACT set of top-level document fields that must differ after the call. */
  changedDocFields?: string[];
  /** None of these top-level fields may differ (checked on top of exact sets). */
  unchangedDocFields?: string[];
  /** EXACT set of track ids whose serialized content moved. */
  changedTracks?: string[];
  /** Execute the call a second time with the same args: the second receipt must be a replay and change nothing. */
  replayWithSameRequestId?: boolean;
}

export interface TargetingScenario {
  id: string;
  category: TargetingScenarioCategory;
  description: string;
  /** A FRESH document per run (catalogs close over a template and clone). */
  doc: () => ProjectDocument;
  call: { kind: "intent"; instruction: string } | { kind: "tool"; name: string; args: Record<string, unknown> };
  host?: { allowDestructive?: boolean; allowMutations?: boolean };
  expect: TargetingExpectation;
}

export interface TargetingScenarioResult {
  id: string;
  category: TargetingScenarioCategory;
  description: string;
  passed: boolean;
  failures: string[];
  observed: {
    mutated: boolean;
    isError: boolean;
    errorCode?: string;
    changedDocFields: string[];
    changedTracks: string[];
    textHead: string;
  };
}

export interface TargetingBenchmarkReport {
  total: number;
  passed: number;
  failed: number;
  byCategory: Record<TargetingScenarioCategory, { passed: number; total: number }>;
  results: TargetingScenarioResult[];
}

/** Top-level document fields whose serialized content differs. */
export function diffDocFields(before: ProjectDocument, after: ProjectDocument): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(before[key as keyof ProjectDocument]) !== JSON.stringify(after[key as keyof ProjectDocument])) {
      changed.push(key);
    }
  }
  return changed.sort();
}

/** Track ids added, removed, or whose serialized content moved. */
export function diffTrackIds(before: ProjectDocument, after: ProjectDocument): string[] {
  const beforeById = new Map(before.tracks.map((track) => [track.id, track]));
  const afterById = new Map(after.tracks.map((track) => [track.id, track]));
  const changed: string[] = [];
  for (const [id, track] of beforeById) {
    if (!afterById.has(id) || JSON.stringify(track) !== JSON.stringify(afterById.get(id))) changed.push(id);
  }
  for (const id of afterById.keys()) if (!beforeById.has(id)) changed.push(id);
  return changed.sort();
}

function evaluate(
  scenario: TargetingScenario,
  result: McpToolResult,
  before: ProjectDocument,
  after: ProjectDocument,
  replay?: { result: McpToolResult; changedDocFields: string[] },
): TargetingScenarioResult {
  const failures: string[] = [];
  const changedDocFields = diffDocFields(before, after);
  const changedTracks = diffTrackIds(before, after);
  const { expect } = scenario;

  if (result.mutated !== expect.mutated) {
    failures.push(`mutated: expected ${expect.mutated}, got ${result.mutated}`);
  }
  if (expect.errorCode !== undefined && result.errorCode !== expect.errorCode) {
    failures.push(`errorCode: expected ${expect.errorCode}, got ${result.errorCode ?? "none"}`);
  }
  for (const fragment of expect.textContains ?? []) {
    if (!result.text.includes(fragment)) failures.push(`text missing: "${fragment}"`);
  }
  for (const fragment of expect.textNotContains ?? []) {
    if (result.text.includes(fragment)) failures.push(`text unexpectedly contains: "${fragment}"`);
  }
  if (expect.changedDocFields !== undefined) {
    const expected = [...expect.changedDocFields].sort();
    if (JSON.stringify(changedDocFields) !== JSON.stringify(expected)) {
      failures.push(`changedDocFields: expected ${JSON.stringify(expected)}, got ${JSON.stringify(changedDocFields)}`);
    }
  }
  for (const field of expect.unchangedDocFields ?? []) {
    if (changedDocFields.includes(field)) failures.push(`field ${field} changed but must not`);
  }
  if (expect.changedTracks !== undefined) {
    const expected = [...expect.changedTracks].sort();
    if (JSON.stringify(changedTracks) !== JSON.stringify(expected)) {
      failures.push(`changedTracks: expected ${JSON.stringify(expected)}, got ${JSON.stringify(changedTracks)}`);
    }
  }
  if (expect.replayWithSameRequestId && replay) {
    if (replay.result.replayed !== true) {
      failures.push(`replay: expected replayed=true, got ${String(replay.result.replayed)}`);
    }
    if (replay.changedDocFields.length > 0) {
      failures.push(`replay changed the document: ${JSON.stringify(replay.changedDocFields)}`);
    }
  }

  return {
    id: scenario.id,
    category: scenario.category,
    description: scenario.description,
    passed: failures.length === 0,
    failures,
    observed: {
      mutated: result.mutated,
      isError: result.isError === true,
      errorCode: result.errorCode,
      changedDocFields,
      changedTracks,
      // Run-generated UUIDs (marker ids, note ids) are legitimate per-run
      // state; scrubbing them keeps receipts comparable across runs.
      textHead: result.text
        .slice(0, 200)
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>"),
    },
  };
}

/**
 * The planId a reviewed dry run handed back, if it handed one back.
 *
 * `data` is `unknown` on the wire, so it is narrowed here rather than cast.
 */
function reviewedPlanId(result: McpToolResult): string | null {
  const data = result.data;
  if (data == null || typeof data !== "object" || Array.isArray(data)) return null;
  const planId = (data as Record<string, unknown>).planId;
  return typeof planId === "string" && planId.trim() !== "" ? planId.trim() : null;
}

async function executeCall(host: HeadlessHost, scenario: TargetingScenario): Promise<McpToolResult> {
  if (scenario.call.kind === "intent") {
    const instruction = scenario.call.instruction;
    // MCP document edits require the REVIEWED two-step flow: a dry run returns a
    // reviewable plan plus a planId, and the same instruction with that planId
    // applies the exact proposal against the same project state. This benchmark
    // measures GROUNDING, so it speaks the protocol an external agent must
    // speak — the review step is transport, not grounding. A refusal, a clarify
    // or a no-op carries no planId and IS the answer.
    const preview = await host.call("kyx_intent", { instruction, dry_run: true });
    const planId = reviewedPlanId(preview);
    if (planId == null) return preview;
    return host.call("kyx_intent", { instruction, planId });
  }
  return host.call(scenario.call.name, scenario.call.args);
}

/** Run ONE scenario against a fresh headless host and score its receipts. */
export async function runTargetingScenario(scenario: TargetingScenario): Promise<TargetingScenarioResult> {
  const host = createHeadlessMcpHost({
    document: scenario.doc(),
    ...(scenario.host?.allowDestructive !== undefined ? { allowDestructive: scenario.host.allowDestructive } : {}),
    ...(scenario.host?.allowMutations !== undefined ? { allowMutations: scenario.host.allowMutations } : {}),
  });
  const before = host.store.doc;
  const result = await executeCall(host, scenario);
  const after = host.store.doc;
  let replay: { result: McpToolResult; changedDocFields: string[] } | undefined;
  if (scenario.expect.replayWithSameRequestId && scenario.call.kind === "tool") {
    const replayResult = await executeCall(host, scenario);
    replay = { result: replayResult, changedDocFields: diffDocFields(after, host.store.doc) };
  }
  return evaluate(scenario, result, before, after, replay);
}

/** Run a catalog in order and aggregate per-category pass counts. */
export async function runTargetingScenarios(
  scenarios: readonly TargetingScenario[],
): Promise<TargetingBenchmarkReport> {
  // Cold-start warm-up: the FIRST mutating call in a fresh process pays the
  // on-demand module compilation of the whole write path, which on a loaded
  // machine can exceed the 30 s MCP call deadline — the call comes back
  // CANCELLED (nothing changed) and a retry succeeds. The benchmark measures
  // targeting, not cold start, so one sacrificial call primes the module
  // graph before any scenario is scored.
  if (scenarios.length > 0) {
    try {
      const warmup = createHeadlessMcpHost({ document: scenarios[0]!.doc() });
      const firstTrack = warmup.store.doc.tracks[0];
      if (firstTrack) {
        await warmup.call("kyx_tracks", { op: "setGain", trackId: firstTrack.id, gainDb: -0.5 });
      }
    } catch {
      // A failed warm-up must not fail the run — the scored scenarios will
      // surface any real problem.
    }
  }
  const results: TargetingScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runTargetingScenario(scenario));
  }
  const byCategory = {} as TargetingBenchmarkReport["byCategory"];
  for (const result of results) {
    const bucket = (byCategory[result.category] ??= { passed: 0, total: 0 });
    bucket.total += 1;
    if (result.passed) bucket.passed += 1;
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    byCategory,
    results,
  };
}

/** Two runs over the same catalog must agree receipt-for-receipt (E9's determinism gate). */
export function reportsIdentical(
  a: TargetingBenchmarkReport,
  b: TargetingBenchmarkReport,
): { identical: boolean; firstDivergence?: string } {
  const left = JSON.stringify(a.results);
  const right = JSON.stringify(b.results);
  if (left === right) return { identical: true };
  const aByid = new Map(a.results.map((result) => [result.id, result]));
  for (const result of b.results) {
    const twin = aByid.get(result.id);
    if (!twin) return { identical: false, firstDivergence: `result ${result.id} missing from first run` };
    if (JSON.stringify(twin) !== JSON.stringify(result)) {
      return { identical: false, firstDivergence: `result ${result.id} receipts differ` };
    }
  }
  return { identical: false, firstDivergence: "result sets differ" };
}

/** One line per failure for a readable CI dump. */
export function formatReport(report: TargetingBenchmarkReport): string {
  const lines = [
    `targeting benchmark: ${report.passed}/${report.total} passed`,
    ...Object.entries(report.byCategory).map(([category, counts]) => `  ${category}: ${counts.passed}/${counts.total}`),
  ];
  for (const result of report.results.filter((candidate) => !candidate.passed)) {
    lines.push(`  FAIL ${result.id} (${result.category}) — ${result.description}`);
    for (const failure of result.failures) lines.push(`    · ${failure}`);
    lines.push(`    · text: ${result.observed.textHead}`);
  }
  return lines.join("\n");
}
