import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Validate reviewed ranker preferences against the exact dataset group they
 * describe. A candidate order is not transferable to other seeds: candidates
 * at the same index contain different musical material in different groups.
 */
export function validateGoldenPreferences(golden, groups) {
  if (!golden || typeof golden !== "object" || golden.reviewed !== true) {
    return { errors: [], matchedGroups: 0, matchedCandidates: 0 };
  }

  const errors = [];
  if (typeof golden.reviewedBy !== "string" || !golden.reviewedBy.trim()) {
    errors.push("reviewed golden preferences need a non-empty reviewedBy field");
  }
  if (typeof golden.reviewedAt !== "string" || !Number.isFinite(Date.parse(golden.reviewedAt))) {
    errors.push("reviewed golden preferences need a valid reviewedAt date");
  }
  if (!Array.isArray(golden.combos) || golden.combos.length === 0) {
    errors.push("reviewed golden preferences need at least one combo");
    return { errors, matchedGroups: 0, matchedCandidates: 0 };
  }

  const seenCombos = new Set();
  const seenGroupKeys = new Set();
  const groupByKey = new Map(groups.map((group) => [group.groupKey, group]));
  let matchedGroups = 0;
  let matchedCandidates = 0;

  for (const combo of golden.combos) {
    if (!combo || typeof combo !== "object") {
      errors.push("golden combo entry must be an object");
      continue;
    }
    const label = typeof combo.combo === "string" && combo.combo.trim() ? combo.combo : "<unnamed>";
    if (seenCombos.has(label)) errors.push(`${label}: duplicate combo entry`);
    seenCombos.add(label);

    if (typeof combo.groupKey !== "string" || !combo.groupKey) {
      errors.push(`${label}: missing exact groupKey; prefix-based preference reuse is unsafe`);
      continue;
    }
    if (seenGroupKeys.has(combo.groupKey)) errors.push(`${label}: duplicate groupKey ${combo.groupKey}`);
    seenGroupKeys.add(combo.groupKey);
    const group = groupByKey.get(combo.groupKey);
    if (!group) {
      errors.push(`${label}: groupKey does not exist in the current dataset: ${combo.groupKey}`);
      continue;
    }
    matchedGroups++;

    const expected = group.candidates?.map((candidate) => candidate.index);
    const order = combo.order;
    if (
      !Array.isArray(expected) ||
      expected.length < 2 ||
      expected.some((index) => !Number.isInteger(index) || index < 0) ||
      new Set(expected).size !== expected.length
    ) {
      errors.push(`${label}: dataset group has invalid candidate indices`);
      continue;
    }
    if (
      !Array.isArray(order) ||
      order.some((index) => !Number.isInteger(index) || index < 0) ||
      new Set(order).size !== order.length ||
      order.length !== expected.length ||
      expected.some((index) => !order.includes(index))
    ) {
      errors.push(`${label}: order must contain every candidate index exactly once (${expected.join(", ")})`);
      continue;
    }
    matchedCandidates += expected.length;
  }

  if (matchedGroups === 0) errors.push("reviewed golden preferences match no dataset groups");
  if (matchedCandidates === 0) errors.push("reviewed golden preferences label no valid candidates");
  return { errors, matchedGroups, matchedCandidates };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const root = path.resolve(path.dirname(thisFile), "..");
  const golden = JSON.parse(readFileSync(path.join(root, "scripts/data/intent-ranker-golden.json"), "utf8"));
  const dataset = JSON.parse(readFileSync(path.join(root, "scripts/data/intent-ranker-dataset.json"), "utf8"));
  if (golden.reviewed !== true) {
    console.log("[golden-validation] no reviewed preferences; heuristic labels remain in use");
  } else {
    const result = validateGoldenPreferences(golden, dataset.groups);
    if (result.errors.length > 0) {
      console.error("[golden-validation] FAIL");
      for (const error of result.errors) console.error(`- ${error}`);
      process.exitCode = 1;
    } else {
      console.log(
        `[golden-validation] PASS — ${result.matchedGroups} exact group(s), ${result.matchedCandidates} candidates`,
      );
    }
  }
}
