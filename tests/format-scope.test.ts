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
 * The guard is proven able to go red: narrowing the scope in package.json
 * fails this spec.
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
  "apps",
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
  return script
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith("--"))
    .map((token) => token.replace(/^["']|["']$/g, ""));
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
});
