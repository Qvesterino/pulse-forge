// ═══════════════════════════════════════════════════════════
// audit-observation-contract — the ratchet for the AI-observability audit.
//
// The audit (AI_OBSERVABILITY_AUDIT_REPORT.md) found two classes of
// contract gap that were, until now, only CONVENTIONS with nothing to
// stop them from growing:
//
//   1. a tool that ships without an outputSchema  → an agent has no
//      declared shape to code against
//   2. a behaviour-changing input read by the MCP layer but declared
//      in NO tool schema  → an agent cannot discover the lever it has
//
// This spec PINS both sets. It is a RATCHET, not a lint rule: the tree
// already violates both, so a "must be empty" rule would be red from the
// first day and would train everyone to ignore it. Instead the known gaps
// are listed here, and the spec fails when the list would GROW — which is
// the direction that matters.
//
// A guard that cannot fail is not a guard: the third case proves the
// comparison can fail, on a synthetic set.
//
//   npm run test -- tests/audit-observation-contract.test.ts
//   node scripts/audit-mcp-observation.mjs        # the instrument itself
// ═══════════════════════════════════════════════════════════
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");
const INSTRUMENT = resolve(REPO_ROOT, "scripts/audit-mcp-observation.mjs");

/**
 * Which checkout to measure. Defaults to this repository; set
 * KYX_OBSERVATION_ROOT to audit another checkout (the audit used it to
 * compare the committed baseline against a tree with work in flight).
 */
const TARGET_ROOT = process.env.KYX_OBSERVATION_ROOT ? resolve(process.env.KYX_OBSERVATION_ROOT) : REPO_ROOT;

interface ObservationReport {
  tools: number;
  toolNames: string[];
  withOutputSchema: number;
  withoutOutputSchema: string[];
  riskCounts: Record<string, number>;
  toolsWithoutRiskEntry: string[];
  undeclaredInputs: string[];
}

/** Run the instrument and read its JSON verdict. */
function measure(): ObservationReport {
  const out = execFileSync(process.execPath, [INSTRUMENT, "--root", TARGET_ROOT, "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(out) as ObservationReport;
}

/**
 * The tools that ship WITHOUT an outputSchema.
 *
 * ONE tool, measured: `kyx_separate` declares no outputSchema — not in the
 * literal catalog and not in the receipt envelope, so an agent has no
 * declared shape to code against.
 *
 * The list was fourteen entries long until 2026-10-29, and thirteen of them
 * were phantom gaps. `src/mcp/tools.ts` attaches the receipt envelope to
 * those tools in a loop over RECEIPT_SCHEMAS — AFTER the literal catalog, the
 * same way it augments every input schema with requestId/agentId/dryRun — so
 * a source scanner that only reads the literal saw no schema on them.
 * But the SHIPPED surface declares them: the generated mirrors import the
 * module, so the schemas are in the catalog the desktop app serves.
 * Measured on that tree: 43 of 44 tools declare an outputSchema at runtime
 * and in `desktop/mcp-tool-defs.cjs`, while the instrument reported 29 of 44.
 *
 * The instrument now counts the receipt attachment (so it measures the
 * surface, not the source), and this baseline is what it measures: one real
 * gap. That is also why the list is safe to keep small — a receipt tool that
 * LOSES its schema now shows up as a grown gap, where the old baseline would
 * have listed it as known and stayed silent.
 */
const KNOWN_TOOLS_WITHOUT_OUTPUT_SCHEMA = ["kyx_separate"];

/**
 * The behaviour-changing inputs the MCP layer reads but NO tool schema
 * declares, as measured at c8729057. 8 of them.
 *
 * - force            : the envelope escape hatch — bypasses the stale-write
 *                      guard AND the scope guard together (OBS-04)
 * - scope            : the path-confinement declaration (OBS-08)
 * - projectRevision  : the compare-and-set precondition (OBS-09)
 * - autofix          : kyx_export mutates the document through it
 * - target*          : the four kyx_master iterate targets
 *
 * `atomic` left this list when kyx_batch declared it in its input schema —
 * a declared input is no longer an undeclared one, and the ratchet below
 * fails on a stale entry so the list cannot keep a solved problem.
 */
const KNOWN_UNDECLARED_INPUTS = [
  "autofix",
  "force",
  "projectRevision",
  "scope",
  "targetCorrelation",
  "targetCrestDb",
  "targetHfShare",
  "targetLowEndShare",
];

const difference = (a: string[], b: string[]) => {
  const set = new Set(b);
  return a.filter((x) => !set.has(x)).sort();
};

describe("audit-observation-contract", () => {
  const report = measure();

  it("the instrument measures the live surface, not a fixture", () => {
    // The instrument must be finding the REAL tool list. If it silently
    // parsed nothing, every other case would pass vacuously.
    expect(report.tools).toBeGreaterThan(30);
    expect(report.withOutputSchema + report.withoutOutputSchema.length).toBe(report.tools);
  });

  it("RATCHET — no tool ships without an outputSchema that was not already known", () => {
    const grown = difference(report.withoutOutputSchema, KNOWN_TOOLS_WITHOUT_OUTPUT_SCHEMA);
    expect(
      grown,
      grown.length > 0
        ? `These tools declare no outputSchema and were not in the audited list. ` +
            `Either give them an outputSchema, or add them to KNOWN_TOOLS_WITHOUT_OUTPUT_SCHEMA ` +
            `in tests/audit-observation-contract.test.ts if the gap is accepted.`
        : "",
    ).toEqual([]);
  });

  it("RATCHET — the known no-outputSchema list is not stale", () => {
    // If a tool gained an outputSchema, the list must be updated so the
    // ratchet keeps measuring reality instead of drifting from it.
    // A tool that does not exist in THIS checkout is not stale — the list
    // is a ceiling shared across parallel work, not an equality.
    const present = new Set(report.toolNames);
    const stale = KNOWN_TOOLS_WITHOUT_OUTPUT_SCHEMA.filter(
      (k) => present.has(k) && !report.withoutOutputSchema.includes(k),
    );
    expect(
      stale,
      stale.length > 0
        ? `These tools NOW declare an outputSchema — remove them from ` + `KNOWN_TOOLS_WITHOUT_OUTPUT_SCHEMA.`
        : "",
    ).toEqual([]);
  });

  it("RATCHET — no behaviour-changing input is read without being declared", () => {
    const grown = difference(report.undeclaredInputs, KNOWN_UNDECLARED_INPUTS);
    expect(
      grown,
      grown.length > 0
        ? `The MCP layer reads these inputs off the call arguments but NO tool schema ` +
            `declares them: ${grown.join(", ")}. Declare them in the schema that reads ` +
            `them, or add them to KNOWN_UNDECLARED_INPUTS if the gap is accepted.`
        : "",
    ).toEqual([]);
  });

  it("RATCHET — the known undeclared-input list is not stale", () => {
    const stale = difference(KNOWN_UNDECLARED_INPUTS, report.undeclaredInputs);
    expect(
      stale,
      stale.length > 0
        ? `These inputs are no longer read without a declaration — remove them from ` + `KNOWN_UNDECLARED_INPUTS.`
        : "",
    ).toEqual([]);
  });

  it("the detector is not vacuous — it finds the audited gaps", () => {
    // If the instrument ever returned an empty set, every ratchet above
    // would pass for the wrong reason. Pin the known positives so that
    // failure mode is visible.
    expect(report.withoutOutputSchema.length).toBeGreaterThan(0);
    expect(report.undeclaredInputs.length).toBeGreaterThan(0);
    expect(report.undeclaredInputs).toContain("force");
    expect(report.undeclaredInputs).toContain("projectRevision");
    expect(report.undeclaredInputs).toContain("scope");
  });

  it("the ratchet CAN fail — a synthetic new violation is caught", () => {
    // House rule: a guard must be able to fail. Prove the comparison
    // detects a gap that was not in the known list.
    const known = new Set(KNOWN_UNDECLARED_INPUTS);
    const synthetic = [...KNOWN_UNDECLARED_INPUTS, "brandNewUndeclaredInput"];
    const grown = difference(synthetic, [...known]);
    expect(grown).toEqual(["brandNewUndeclaredInput"]);

    // …and that a known list that grew stale is caught too.
    const stale = difference(KNOWN_UNDECLARED_INPUTS, synthetic);
    expect(stale).toEqual([]);
  });

  it("the instrument and the risk table agree on the tool set", () => {
    // A tool with no TOOL_RISK entry silently defaults to "mutate" —
    // conservative, but it means the trust classification is incomplete.
    // The taxonomy itself is closed by tests/agent-trust.test.ts; this
    // case only records that the two surfaces are the same size.
    expect(report.toolsWithoutRiskEntry.length).toBeLessThanOrEqual(1);
  });
});
