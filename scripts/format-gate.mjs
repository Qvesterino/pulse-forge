#!/usr/bin/env node
/**
 * format-gate.mjs — run prettier over the repository's TRACKED sources only.
 *
 * Why not `prettier --check <dirs>` directly: prettier walks the working
 * tree, so the gate also inspected files that are NOT part of the project —
 * another agent's scratch script sitting in the repo root, a probe nobody
 * committed, a half-written file. The gate then went red for reasons that
 * have nothing to do with the project, and a red gate that flaps on someone
 * else's in-flight work is a gate people learn to ignore.
 *
 * The repository already applies this principle elsewhere: the spec-file
 * count in docs/CURRENT-STATE.md is measured with `git ls-files` "committed
 * files only, so parallel sessions cannot flap the gate". The format gate
 * now obeys the same rule.
 *
 * How it works:
 *   1. the SCOPE lives in package.json ("format:scope") — one owner, and
 *      tests/format-scope.test.ts pins it;
 *   2. `git ls-files` gives the tracked paths — the tree as a fresh checkout
 *      sees it, with nothing that only exists in one working directory;
 *   3. the scope is resolved against those paths: a tree token matches
 *      everything under it, a root glob matches root-level files only
 *      (`*` does not cross `/`, and a leading dot is not matched, exactly
 *      as fast-glob resolves the CLI's own patterns);
 *   4. paths that do not exist on disk are dropped — in a shared worktree a
 *      file can be deleted in the working tree before the deletion is
 *      staged, and prettier answers a missing path with exit 2 ("No files
 *      matching the pattern were found"), which would fail the gate;
 *   5. prettier still applies .prettierignore and .gitignore itself: an
 *      ignored file passed explicitly is skipped silently, so the generated
 *      artifacts stay out of the gate without this script re-implementing
 *      ignore rules;
 *   6. the files are handed to prettier in batches, because a Windows
 *      command line cannot carry thousands of paths at once.
 *
 * Usage:
 *   node scripts/format-gate.mjs --check   (default) — report what is unformatted
 *   node scripts/format-gate.mjs --write               — format it
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PRETTIER_BIN = path.join(REPO_ROOT, "node_modules", "prettier", "bin", "prettier.cjs");

/**
 * How many characters one prettier invocation may carry. Windows caps the
 * command line at 32 767 characters, and every path is quoted in it, so the
 * budget is what actually decides the batch size - a fixed file count either
 * overflows the line or spawns far more processes than needed.
 */
const COMMAND_LINE_BUDGET = 20_000;

/** Parse the scope string: `src tests "*.md"` → ["src", "tests", "*.md"]. */
export function parseScope(scope) {
  return scope
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => token.replace(/^["']|["']$/g, ""));
}

/**
 * A root-level glob to a regular expression. `*` matches within one path
 * segment, and a leading dot is not matched (fast-glob's default, which is
 * what the prettier CLI uses for its own patterns).
 */
function globToRegExp(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "\u0000")
    .replace(/\?/g, "\u0001")
    .split("\u0000")
    .join("[^/]*")
    .split("\u0001")
    .join("[^/]");
  return new RegExp(`^${body}$`);
}

/**
 * The tracked files the scope names.
 *
 * A tree token ("src") matches every tracked file under it. A glob token
 * ("*.md") matches root-level files only, and skips dot-files.
 */
export function resolveScopeFiles(scope, trackedPaths) {
  const selected = new Set();
  for (const token of scope) {
    if (token.includes("*") || token.includes("?")) {
      const re = globToRegExp(token);
      for (const file of trackedPaths) {
        if (file.includes("/")) continue; // root-level patterns only
        if (file.startsWith(".")) continue; // fast-glob's default: no dot-files
        if (re.test(file)) selected.add(file);
      }
      continue;
    }
    const prefix = `${token.replace(/\/+$/, "")}/`;
    for (const file of trackedPaths) {
      if (file === token || file.startsWith(prefix)) selected.add(file);
    }
  }
  return [...selected].sort();
}

/** The tracked paths of the repository, as git sees them. */
export function trackedFiles(cwd = REPO_ROOT) {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .toString("utf8")
    .split("\u0000")
    .filter((line) => line.length > 0);
}

/**
 * The files the gate hands to prettier: the tracked paths the scope names,
 * minus the ones that are not on disk.
 *
 * The tracked set is the input, never a directory walk — that is the whole
 * point of this script. A scope token is a DIRECTORY ("scripts"), and
 * handing a directory to prettier makes prettier expand it on the working
 * tree, where another agent's untracked scratch file is waiting.
 */
export function buildGateFileList(scope, trackedPaths, exists = defaultExists) {
  return resolveScopeFiles(scope, trackedPaths).filter((file) => exists(file));
}

function defaultExists(file) {
  return existsSync(path.join(REPO_ROOT, file));
}

function runPrettier(mode, files) {
  // `--ignore-unknown` restores what a directory expansion did on its own:
  // prettier only picked up the files it can parse (no .snap, no .py, no
  // .wav). With explicit paths it would instead answer "No parser could be
  // inferred" and exit 2, so a tracked snapshot file would fail the gate.
  const result = spawnSync("node", [PRETTIER_BIN, mode, "--ignore-unknown", ...files], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: false,
  });
  return { status: result.status };
}

/** Split the file list into command lines that fit the budget. */
export function batchFiles(files, budget = COMMAND_LINE_BUDGET) {
  const batches = [];
  let current = [];
  let length = 0;
  for (const file of files) {
    const cost = file.length + 3; // quotes and the separating space
    if (current.length > 0 && length + cost > budget) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function main(argv) {
  const write = argv.includes("--write");
  const mode = write ? "--write" : "--check";

  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const scope = parseScope(pkg.scripts["format:scope"] ?? "");
  if (scope.length === 0) {
    console.error('format-gate — package.json has no "format:scope" to work from.');
    return 2;
  }

  let tracked;
  try {
    tracked = trackedFiles();
  } catch (error) {
    console.error("format-gate — `git ls-files` failed, so the tracked set is unknown.");
    console.error("             This gate measures the repository, so it needs a git checkout.");
    console.error(String(error));
    return 2;
  }

  // ONE owner of the file list: the tracked set, narrowed by the scope, minus
  // the paths that are gone from the working tree. A path can be deleted in
  // the working tree before the deletion is staged, and prettier answers a
  // missing path with exit 2, which would fail the gate.
  const present = buildGateFileList(scope, tracked);
  const skipped = resolveScopeFiles(scope, tracked).length - present.length;
  console.log(
    `format-gate — ${present.length} tracked files in scope (${skipped} deleted in the working tree, skipped)`,
  );

  let failed = false;
  const batches = batchFiles(present);
  for (const batch of batches) {
    const { status } = runPrettier(mode, batch);
    if (status !== 0) {
      failed = true;
      if (status === 2) {
        console.error(
          "format-gate — prettier exited 2 (a path matched no file). The tracked set and the working tree disagree.",
        );
      }
    }
  }

  if (failed) {
    console.error(`format-gate — ${mode} FAILED`);
    return 1;
  }
  console.log(`format-gate — ${mode} OK over ${present.length} tracked files`);
  return 0;
}

// CLI guard: vitest sets VITEST=true, and a test importing this module must
// not launch prettier. Same discriminator the drift-check script uses.
if (!process.env.VITEST) {
  process.exitCode = main(process.argv);
}
