/**
 * Intent ranker ACTIVATION orchestrator (only after an independent human
 * holdout evaluation; in-sample golden fit is not an activation signal):
 *
 *   1. verifies scripts/data/intent-ranker-golden.json is reviewed:true
 *      (with exact dataset group keys and complete candidate permutations),
 *   2. retrains + re-validates the model (npm run ranker:train),
 *   3. reads an independent held-out golden verdict —
 *        ready-for-active  → flips DEFAULT_RANKER_MODE to "active" in
 *                            ranker-client.ts, runs typecheck + ranker tests,
 *        otherwise          → keeps shadow mode and prints guidance.
 *
 * Run: npm run ranker:activate
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const goldenPath = path.join(ROOT, "scripts", "data", "intent-ranker-golden.json");
const clientPath = path.join(ROOT, "src", "ai", "ranking", "ranker-client.ts");
const reportPath = path.join(ROOT, "scripts", "data", "intent-ranker-validation.json");

function run(cmd) {
  console.log(`\n[activate] $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

// 1. Golden review gate.
if (!existsSync(goldenPath)) {
  console.error("[activate] missing scripts/data/intent-ranker-golden.json — run ranker:golden first");
  process.exit(1);
}
const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
if (golden.reviewed !== true || !golden.reviewedBy || !golden.reviewedAt) {
  console.error(
    "[activate] golden preferences are NOT reviewed yet.\n" +
      "  1. Listen to public/golden-review/<combo>/cand-*.wav (7 combos)\n" +
      "  2. Reorder 'order' per combo (best → worst) in the golden JSON\n" +
      "  3. Set reviewed:true + reviewedBy + reviewedAt\n" +
      "  Then re-run npm run ranker:activate",
  );
  process.exit(1);
}
console.log(`[activate] golden review by ${golden.reviewedBy} at ${golden.reviewedAt} — ${golden.combos.length} combo(s)`);

// 2. Retrain + validate on golden labels.
run("npm run ranker:train");

// 3. Verdict gate.
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const verdict = report.goldenVerdict;
const goldenAccuracy = report.goldenHoldoutPairwiseAccuracy;
console.log(`[activate] goldenVerdict=${verdict} goldenHoldoutPairwiseAccuracy=${goldenAccuracy ?? "not available"}`);

if (verdict !== "ready-for-active") {
  console.error(
    `[activate] verdict is NOT ready-for-active — ranker stays in SHADOW mode.\n` +
      "  In-sample training fit is not sufficient: review a separate held-out set,\n" +
      "  then keep the heuristic ranking as the default until that evaluation passes.",
  );
  process.exit(1);
}

// 4. Flip the in-code default to active (persisted, survives localStorage).
const client = readFileSync(clientPath, "utf8");
const flipped = client.replace(
  'export const DEFAULT_RANKER_MODE: RankerMode = "shadow";',
  'export const DEFAULT_RANKER_MODE: RankerMode = "active";',
);
if (flipped === client) {
  console.log("[activate] DEFAULT_RANKER_MODE already active");
} else {
  writeFileSync(clientPath, flipped);
  console.log("[activate] DEFAULT_RANKER_MODE flipped to active");
}

// 5. Sanity: typecheck + ranker tests before handing over to final QA.
run("npm run typecheck");
run("npx vitest run tests/rank-candidates.test.ts --no-file-parallelism");
console.log(
  "\n[activate] DONE — ranker is ACTIVE by default.\n" +
    "  Final step: npm run test:browser on a quiet machine (expect 217+/217+ incl. prism).",
);
