import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The format gate's SCOPE is an invariant, not a preference.
 *
 * `format:check` named two directories — `src` and `tests` — for months. Every
 * other tree (246 files under scripts/, the desktop shell, the collab server,
 * the docs, the prompt vault) drifted unchecked: 191 prettier-dirty files were
 * measured in one sweep. A gate nobody can narrow silently is the only reason
 * that number can only go down.
 *
 * The scope is a LIST of maintained trees rather than a glob over "." because
 * the repository also holds generated trees (build output, coverage, the
 * committed worklet bundles) whose bytes nobody formats by hand — and a glob
 * cannot tell them from source without an ignore list nobody would keep.
 *
 * Two invariants, and the second one was learned the hard way:
 *
 * 1. The scope must COVER every maintained tree. Narrowing it fails this spec.
 * 2. The scope must name only trees that EXIST. Prettier exits 2 on a pattern
 *    that matches no file ("No files matching the pattern were found"), so a
 *    scope naming a tree that does not exist makes the gate red in CI no
 *    matter how well every file is formatted. The scope named `apps` — a
 *    directory that exists in nobody's checkout — and the gate was therefore
 *    red in CI from the moment it was added, while passing locally because a
 *    stray working directory happened to exist. A gate that was only ever
 *    verified in a non-representative environment is not a gate.
 *
 * Both are proven able to go red: narrowing the scope in package.json fails
 * the first spec, and the second spec's detector is checked against a scope
 * that names trees which do not exist.
 */

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** The trees a human maintains by hand — every one of them must be checked. */
const MAINTAINED_SOURCE_TREES = [
  "src",
  "tests",
  "scripts",
  "desktop",
  "server",
  "native",
  "companion",
  "mobile",
  "extension",
  "remotion",
  "tools",
  "prompts",
  "docs",
];

/**
 * Trees whose bytes are generated or vendored. Formatting them is churn on
 * every rebuild, and their emitters own their byte shape.
 */
const GENERATED_TREES = ["public", "coverage", "dist", "build", "out", "release"];

/** The scope tokens of an npm script: `prettier --check src tests "*.md"`. */
function scopeTokens(script: string): string[] {
  const tokens = script
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith("--"))
    .map((token) => token.replace(/^["']|["']$/g, ""));
  // The command itself is not a path — only the patterns after it are.
  const first = tokens[0] ?? "";
  return first === "prettier" || first.endsWith("prettier.cjs") ? tokens.slice(1) : tokens;
}

/** Committed files under a tree — the tree as a fresh checkout sees it. */
function trackedFiles(tree: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "--", tree], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * The scope tokens that name a tree with no committed files. Prettier treats
 * such a pattern as an ERROR (exit 2), which fails the gate even when every
 * file it did find is formatted.
 */
function missingTrees(scope: string[]): string[] {
  return scope.filter((token) => !token.includes("*")).filter((tree) => trackedFiles(tree).length === 0);
}

const scope = scopeTokens(pkg.scripts["format:check"] ?? "");

describe("the format gate's scope", () => {
  it("covers every maintained source tree", () => {
    for (const tree of MAINTAINED_SOURCE_TREES) {
      expect(scope, `format:check must cover ${tree}/`).toContain(tree);
    }
  });

  it("covers the repository's own root documents", () => {
    expect(scope, "format:check must cover the root-level documents").toContain("*.md");
  });

  it("does not format generated or vendored trees", () => {
    for (const tree of GENERATED_TREES) {
      expect(scope, `${tree}/ is generated — formatting it is churn on every rebuild`).not.toContain(tree);
    }
  });

  it("the write variant covers the same scope as the check", () => {
    expect(scopeTokens(pkg.scripts["format"] ?? "")).toEqual(scope);
  });

  it("names only trees that exist in the repository", () => {
    const missing = missingTrees(scope);
    expect(
      missing,
      `prettier exits 2 on a pattern that matches no file, so the gate fails in CI whatever the ` +
        `formatting is: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("can tell a missing tree from a present one", () => {
    // Negative control: the detector must be able to go red. Without this, a
    // broken detector that always returns [] would pass the spec above.
    expect(missingTrees(["src", "apps", "definitely-not-a-tree"])).toEqual(["apps", "definitely-not-a-tree"]);
    expect(missingTrees(["src", "docs"])).toEqual([]);
  });
});
