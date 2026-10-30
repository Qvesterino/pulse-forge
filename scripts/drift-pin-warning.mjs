#!/usr/bin/env node
/**
 * drift-pin-warning.mjs — the pre-commit guard for the spec-file pin.
 *
 * WHAT IT IS. The drift gate compares the "Vitest spec files" row in
 * docs/CURRENT-STATE.md with the number of spec files in the COMMITTED tree,
 * and that gate is BLOCKING in CI (the "Hygiene (format + drift)" job). That
 * keeps main green, but the break is only discovered a whole CI cycle later:
 * on 2026-10-30 the pin broke four times in one day (1335 → 1336 → 1337 →
 * 1341), each time because a parallel session committed new spec files. This
 * guard says the same thing at COMMIT time, locally, where it can still be
 * fixed in the same minute.
 *
 * WHY IT COUNTS FROM THE INDEX. The pre-commit hook was switched off on
 * 2026-09-19 because it blocked commits whenever another agent's in-flight
 * work had type errors. A guard that read the WORKING TREE would trip on
 * another session's uncommitted spec files and block their commit for a
 * reason that has nothing to do with their work. So this one reads the
 * INDEX: the tree as it will be committed, and nothing else.
 *
 * WHY IT ONLY WARNS. The owner's decision (2026-10-30): a warning, never a
 * block. A guard that blocks in a shared worktree is the exact failure the
 * hook was switched off for. This script therefore always exits 0.
 *
 * The count and the pin are parsed with the SAME rules as
 * scripts/drift-check.ts (countSpecFiles / parseCountRow), so the guard can
 * never disagree with the gate it pre-announces.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The CURRENT-STATE row this guard watches. */
export const PIN_LABEL = "Vitest spec files";

/**
 * The second-column **bold** number of the CURRENT-STATE row — the same rule
 * scripts/drift-check.ts parses it with (parseCountRow): the first bold
 * number AFTER the label.
 */
export function parsePin(markdown) {
  const lines = markdown.split("\n");
  for (const line of lines) {
    if (!line.includes(`**${PIN_LABEL}**`)) continue;
    const afterLabel = line.slice(line.indexOf(`**${PIN_LABEL}**`) + `**${PIN_LABEL}**`.length);
    const match = afterLabel.match(/\*\*(\d+)\*\*/);
    return match ? Number(match[1]) : null;
  }
  return null;
}

/**
 * Spec files in the INDEX — the tree as it will be committed. Committed-only
 * by design, for the same reason the drift gate counts that way: a directory
 * walk counted untracked WIP and made the same repo measure two different
 * numbers depending on who was working.
 */
export function countIndexedSpecFiles(root) {
  const listed = execFileSync("git", ["-C", root, "ls-files", "--cached", "tests"], { encoding: "utf8" });
  return listed
    .split("\n")
    .filter((file) => file.endsWith(".test.ts") || file.endsWith(".test.tsx"))
    .filter((file) => !file.startsWith("tests/e2e/")).length;
}

/** The pin as it will be committed — the index's copy of CURRENT-STATE.md. */
export function readIndexedPin(root) {
  try {
    // CURRENT-STATE.md is a document with a very long row; it outgrew Node's
    // default 1 MB spawn buffer once (ENOBUFS), and the guard went silent
    // exactly when it mattered. The limit is set well above the file's size.
    const markdown = execFileSync("git", ["-C", root, "show", ":docs/CURRENT-STATE.md"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return parsePin(markdown);
  } catch {
    return null;
  }
}

/** What the guard sees: the claimed pin against the counted tree. */
export function inspectDriftPin(root) {
  const claimed = readIndexedPin(root);
  const measured = countIndexedSpecFiles(root);
  return { claimed, measured, matches: claimed !== null && claimed === measured };
}

/** The message the hook prints. It says what to do, and it says it is not a block. */
export function warningText({ claimed, measured }) {
  return [
    "",
    "[pre-commit] WARNING: the spec-file pin does not match the tree you are about to commit.",
    `             docs/CURRENT-STATE.md claims ${claimed} spec files; this commit carries ${measured}.`,
    "             The CI job 'Hygiene (format + drift)' will go red on this commit. To fix it here:",
    "               npm run status:report   # regenerates docs/status.json + docs/STATUS.md",
    `               then set the '${PIN_LABEL}' row in docs/CURRENT-STATE.md to ${measured}`,
    "             This is a warning only — the commit is not blocked.",
    "",
  ].join("\n");
}

function main() {
  const root = process.argv[2] ?? process.cwd();
  let result;
  try {
    result = inspectDriftPin(root);
  } catch {
    // A guard that cannot measure says nothing and blocks nothing.
    return 0;
  }
  if (result.claimed !== null && !result.matches) {
    console.warn(warningText(result));
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(main());
}
