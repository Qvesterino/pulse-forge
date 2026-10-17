/**
 * STATUS REPORT — the public proof page's data.
 *
 * The page answers one question with measurements, not adjectives: *which
 * claims does this project make, what command proves each one, and what did it
 * say the last time it ran?* It is deliberately NOT marketing: a row renders as
 * PASS only from a real exit code, an unrun check says so, and a manual gate
 * the owner has not closed renders as PENDING — never as a pass.
 *
 * Two kinds of rows, and the difference is stated on the page:
 *  - `freshness: "drift-checked"` — re-run and compared by `npm run drift:check`,
 *    so a stale row turns the drift gate red.
 *  - `freshness: "at-generation"` — recorded when `npm run status:report` ran;
 *    the page shows WHEN, and never pretends it was re-verified since.
 *
 * Pure: rows in, markdown + JSON out. The generator shell lives in
 * `scripts/status-report.mts`.
 */
export const STATUS_FORMAT = "kyx-status/1";

export type StatusCheckState = "pass" | "fail" | "pending" | "not-run";

export interface StatusClaim {
  id: string;
  /** The claim in one sentence, in plain language. */
  claim: string;
  /** The exact command that proves it. */
  command: string;
  state: StatusCheckState;
  /** One line of measured detail (an exit code, a count, a score). */
  summary: string;
  freshness: "drift-checked" | "at-generation";
}

export interface ManualGate {
  id: string;
  claim: string;
  command: string;
  state: StatusCheckState;
  /** Owner-filled note (evidence, date, or why it is still open). */
  note: string;
}

export interface StatusReportInput {
  generatedAt: Date;
  claims: readonly StatusClaim[];
  manualGates: readonly ManualGate[];
  /** Commands that are deliberately NOT run here (too slow), listed so the
   *  page never implies they were. */
  runByCi: readonly { claim: string; command: string }[];
}

export interface StatusReport {
  format: string;
  /** The stable payload the drift gate compares (no timestamps, no durations). */
  json: { claims: StatusClaim[]; manualGates: ManualGate[]; runByCi: Array<{ claim: string; command: string }> };
  markdown: string;
  counts: { pass: number; fail: number; pending: number; notRun: number };
}

const STATE_GLYPH: Record<StatusCheckState, string> = {
  pass: "✓ PASS",
  fail: "✗ FAIL",
  pending: "… PENDING",
  "not-run": "· NOT RUN",
};

export function buildStatusReport(input: StatusReportInput): StatusReport {
  const claims = [...input.claims];
  const manualGates = [...input.manualGates];
  const counts = { pass: 0, fail: 0, pending: 0, notRun: 0 };
  for (const row of [...claims, ...manualGates]) {
    if (row.state === "pass") counts.pass += 1;
    else if (row.state === "fail") counts.fail += 1;
    else if (row.state === "pending") counts.pending += 1;
    else counts.notRun += 1;
  }

  const lines: string[] = [];
  lines.push("# KYX STATUS — the claims, and the commands that check them");
  lines.push("");
  lines.push(
    `Generated ${input.generatedAt.toISOString()} · **${counts.pass} pass · ${counts.fail} fail · ${counts.pending} pending · ${counts.notRun} not run**`,
  );
  lines.push("");
  lines.push("> This page is a measurement table, not marketing. A row is PASS only from a real exit code.");
  lines.push("> `drift-checked` rows are re-run and compared by `npm run drift:check`; `at-generation` rows show");
  lines.push("> when they were recorded and are never implied to be fresher than that.");
  lines.push("");
  lines.push("## Claims");
  lines.push("");
  lines.push("| State | Claim | Command | Measured | Freshness |");
  lines.push("| ----- | ----- | ------- | -------- | --------- |");
  for (const row of claims) {
    lines.push(`| ${STATE_GLYPH[row.state]} | ${row.claim} | \`${row.command}\` | ${row.summary} | ${row.freshness} |`);
  }
  lines.push("");
  lines.push("## Manual gates (the owner's hands — pending is pending)");
  lines.push("");
  if (manualGates.length === 0) {
    lines.push("- (none listed)");
  } else {
    for (const gate of manualGates) {
      lines.push(
        `- ${STATE_GLYPH[gate.state]} **${gate.claim}** — \`${gate.command}\`${gate.note ? ` · ${gate.note}` : ""}`,
      );
    }
  }
  lines.push("");
  lines.push("## Deliberately not run by this command (too slow for a report)");
  lines.push("");
  for (const entry of input.runByCi) {
    lines.push(`- ${entry.claim} — \`${entry.command}\``);
  }
  lines.push("");
  lines.push("## Regenerate");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run status:report     # re-runs the cheap claims and rewrites this page");
  lines.push("npm run drift:check       # fails when a drift-checked row is stale");
  lines.push("```");
  lines.push("");

  return {
    format: STATUS_FORMAT,
    json: { claims, manualGates, runByCi: [...input.runByCi] },
    markdown: lines.join("\n"),
    counts,
  };
}
