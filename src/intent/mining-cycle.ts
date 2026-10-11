/**
 * INTENT MINING CYCLE (2026-10-11) — closes the mining→retraining loop.
 *
 * Before this module the mined producer sentences lived in a BROWSER
 * localStorage ring buffer (failure-log.ts) and reached the corpus only by
 * copy-pasting an export into a hand-written corpus list — which nobody did
 * twice. This module turns an export into cycle artifacts:
 *
 *   1. AGGREGATE the export (the topIntentMisses view: clarify + model-miss
 *      events, consecutive repeats collapsed).
 *   2. CLASSIFY each unique miss against TODAY's intent engine — a mined
 *      sentence that now routes to a real action is RESOLVED (a parser or
 *      engine fix landed since it was mined); one that still falls to
 *      pattern/clarify is STILL-FAILING (it needs a human label or an
 *      engine fix before it can teach anything).
 *   3. RESOLVED rows become the mined regression corpus — the dataset
 *      generator appends them as teacher pairs, so every past failure that
 *      the engine learned to handle is PINNED against regression, and the
 *      training pipeline can run on top.
 *
 * Pure by contract: no fs, no localStorage, no clock — the caller feeds
 * events in and gets artifacts out.
 */
import { routeIntentText, type RoutedIntent } from "./route";
import type { ProjectDocument } from "../project-model/types";
import type { IntentMiningEvent } from "./failure-log";

export interface MinedCycleRow {
  prompt: string;
  outcome: "clarify" | "model-miss";
  /** Summed collapsed count — how often the ask failed. */
  hits: number;
  routeKind: string;
  /** Compact summary of the routed action (the teacher's answer). */
  routed: string;
}

export interface MinedCycleReport {
  /** Events read from the export. */
  totalEvents: number;
  /** Unique clarify + model-miss prompts (the mining view). */
  misses: number;
  /** Misses that route to a real action TODAY — dataset-ready. */
  resolved: MinedCycleRow[];
  /** Misses that still fall through — need a label or an engine fix. */
  stillFailing: MinedCycleRow[];
  /** Model-hit events (informational — the model's wins are not misses). */
  modelHits: number;
}

function routedSummary(route: RoutedIntent): string {
  // Terse per-kind summaries for the cycle report — the route KIND plus the
  // most identifying field, tolerating shapes this module does not know.
  const detail = (route as Record<string, unknown>).intent as Record<string, unknown> | undefined;
  const ops = (route as Record<string, unknown>).ops as Array<{ kind?: string }> | undefined;
  const opsText = Array.isArray(ops) ? ops.map((op) => op.kind ?? "?").join(",") : "";
  switch (route.kind) {
    case "sectionFlow":
      return `sectionFlow: ${route.targetRole} ${route.flow}`;
    case "sectionTransition":
      return `sectionTransition: ${route.transition} → ${route.targetRole}`;
    case "mix":
      return `mix: ${detail && detail.overrides ? Object.keys(detail.overrides).join(",") : "overrides"}`;
    case "arrange":
    case "clips":
      return `${route.kind}: ${opsText}`;
    default:
      return route.kind + (detail && typeof detail.kind === "string" ? `: ${detail.kind}` : "");
  }
}

const NON_TEACHING_KINDS: ReadonlySet<string> = new Set(["pattern", "clarify", "revise"]);

/**
 * Aggregate + classify a mining export against the CURRENT engine.
 * `doc` is the routing document (the fixed dataset doc keeps this stable).
 */
export function buildMiningCycleReport(events: IntentMiningEvent[], doc: ProjectDocument): MinedCycleReport {
  const misses = new Map<string, MinedCycleRow>();
  let modelHits = 0;
  let totalEvents = 0;
  for (const event of events) {
    totalEvents += 1;
    if (event.outcome === "model-hit") {
      modelHits += 1;
      continue;
    }
    if (event.outcome !== "clarify" && event.outcome !== "model-miss") continue;
    const key = `${event.outcome}::${event.prompt}`;
    const hits = event.count ?? 1;
    const existing = misses.get(key);
    if (existing) {
      existing.hits += hits;
      continue;
    }
    misses.set(key, {
      prompt: event.prompt,
      outcome: event.outcome,
      hits,
      routeKind: "",
      routed: "",
    });
  }

  const resolved: MinedCycleRow[] = [];
  const stillFailing: MinedCycleRow[] = [];
  for (const row of misses.values()) {
    const route = routeIntentText(row.prompt, doc);
    const routeKind = route.kind;
    if (NON_TEACHING_KINDS.has(routeKind)) {
      stillFailing.push({ ...row, routeKind });
    } else {
      resolved.push({ ...row, routeKind, routed: routedSummary(route) });
    }
  }
  resolved.sort((a, b) => b.hits - a.hits);
  stillFailing.sort((a, b) => b.hits - a.hits);
  return { totalEvents, misses: misses.size, resolved, stillFailing, modelHits };
}

/** The dataset-generator sidecar: one JSON object with the resolved rows. */
export interface MinedCorpusFile {
  version: 1;
  generatedAt: number;
  source: "intent-mining-cycle";
  rows: Array<{ lang: "en" | "sk"; instruction: string; kind: string; routed: string; hits: number }>;
}

/** Language guess for the corpus rows (SK diacritic stems vs EN). */
export function guessLang(prompt: string): "en" | "sk" {
  return /[^(a-z)]*(?:[áäčďéíĺľňóôŕšťúýž])|(?:\bpridaj\b|\bviac\b|\bmenej\b|\bhustejsi\b|\benergickejsi\b)/i.test(
    prompt,
  )
    ? "sk"
    : "en";
}

export function buildMinedCorpus(report: MinedCycleReport): MinedCorpusFile {
  return {
    version: 1,
    generatedAt: 0, // the caller stamps the clock — pure module
    source: "intent-mining-cycle",
    rows: report.resolved.map((row) => ({
      lang: guessLang(row.prompt),
      instruction: row.prompt,
      kind: row.routeKind,
      routed: row.routed,
      hits: row.hits,
    })),
  };
}
