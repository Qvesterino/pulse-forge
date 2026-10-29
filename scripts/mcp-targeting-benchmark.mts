import { formatReport, runTargetingScenarios } from "../src/mcp/targeting-benchmark";
import { TARGETING_SCENARIOS } from "../tests/mcp-targeting-scenarios";

/**
 * E9 runner — the full targeting benchmark as a finite CLI pass:
 *
 *     npx vite-node scripts/mcp-targeting-benchmark.mts
 *
 * Runs every seeded scenario against a fresh headless host, prints the
 * receipt table and exits 1 when any scenario fails. The vitest pin
 * (tests/mcp-targeting-benchmark.test.ts) runs the SAME catalog and adds the
 * determinism gate; this script exists for the "one question, one run"
 * workflow where an agent (or a human) wants the current numbers without
 * booting the whole suite. Baseline rule from the audit: never fabricate a
 * score — the printed table IS the score, and the same seeds must reproduce
 * it byte-for-byte.
 */

const report = await runTargetingScenarios(TARGETING_SCENARIOS);
console.log(formatReport(report));
process.exit(report.failed > 0 ? 1 : 0);
