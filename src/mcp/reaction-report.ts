/**
 * F2 — the reaction report AS AN AGENT SEES IT (kyx_diagnose_mix section).
 *
 * Pure formatting + the one place that reads the process-wide ledger. The
 * learning maths stays in `src/intent/reaction-learning.ts`; this module only
 * turns it into a block of text and decides whether to say anything at all.
 *
 * SILENCE IS THE DEFAULT. With no decided reactions this returns null and no
 * line is added — a diagnose call about an empty ledger should look exactly
 * like a diagnose call before F1 existed. A report that always speaks teaches
 * an agent to ignore it.
 */
import { activeReactionLedger } from "../intent/reaction-ledger";
import { buildReactionReport, retrainGate, topRejections, type ReactionReport } from "../intent/reaction-learning";

const MAX_KINDS = 4;
const MAX_REJECTIONS = 3;

export interface ReactionReportSection {
  text: string;
  data: ReactionReport & { retrain: ReturnType<typeof retrainGate> };
}

/** null when there is nothing resolved to report. Never throws. */
export function reactionReportForAgent(): ReactionReportSection | null {
  const ledger = activeReactionLedger();
  // REDUNDANT TODAY, KEPT DELIBERATELY: `activeReactionLedger()` already
  // returns null when the flag is off, so removing this line changes no
  // observable behaviour — falsified and confirmed (the "speaks when the
  // ledger is switched off" mutation produced no red test). It stays as a
  // boundary guard for the day the accessor stops consulting the flag.
  if (!ledger) return null;
  let report: ReactionReport;
  try {
    report = buildReactionReport(ledger.entries());
  } catch {
    return null;
  }
  if (report.decided === 0) return null;

  const gate = retrainGate(report.decided, null);
  const lines: string[] = [];
  const { totals } = report;
  lines.push(
    `proposals the owner reacted to (local F1 ledger): ${totals.decided} decided · keep ${percent(
      totals.keepRate,
    )} · ${totals.undone} returned · ${totals.tweaked} tweaked · ${totals.pending} awaiting`,
  );

  const kinds = Object.entries(report.byRouteKind)
    .sort((a, b) => b[1].decided - a[1].decided || a[0].localeCompare(b[0]))
    .slice(0, MAX_KINDS);
  if (kinds.length > 0) {
    lines.push(
      `  by route kind: ${kinds
        .map(([kind, stat]) => `${kind} ${stat.decided} (keep ${percent(stat.keepRate)})`)
        .join(" · ")}`,
    );
  }

  const rejected = topRejections(report, MAX_REJECTIONS);
  if (rejected.length > 0) {
    // Weight-only: these are orders, not bans. The action set is unchanged.
    lines.push(
      `  least welcome (reorder only, do not treat as a ban): ${rejected
        .map((stat) => `${stat.routeKind} ${stat.action} (weight ${stat.weight}, n=${stat.decided})`)
        .join(" · ")}`,
    );
  }

  lines.push(`  model gate: ${gate.eligible ? "ELIGIBLE" : `not eligible — ${gate.reasons.join("; ")}`}`);

  return { text: lines.join("\n"), data: { ...report, retrain: gate } };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
