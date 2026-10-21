import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGateFileList, parseScope, resolveScopeFiles, trackedFiles } from "../scripts/format-gate.mjs";

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
 * Three invariants, and the second and third were learned the hard way:
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
 * 3. The gate must measure only TRACKED files. Prettier walks the working
 *    tree, so another agent's scratch script in the repo root — untracked,
 *    half-written, nobody's business — could turn the gate red. The
 *    repository already applies this rule to the spec-file count
 *    ("committed files only, so parallel sessions cannot flap the gate"); the
 *    format gate now obeys the same rule.
 *
 * Every invariant is proven able to go red: narrowing the scope, naming a tree
 * that does not exist, pointing the scripts back at raw prettier, and feeding
 * the resolver a file that is not tracked all fail this spec.
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

/** Committed files under a tree — the tree as a fresh checkout sees it. */
function filesUnder(tree: string): string[] {
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
 * Git's own list of tracked files. The spec asks GIT, not the script under
 * test — otherwise a change to the script's own file list would move the
 * reference with it and the guard would be blind to exactly the thing it
 * exists to catch.
 */
function gitTrackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((line) => line.length > 0);
}

/**
 * The scope tokens that name a tree with no committed files. Prettier treats
 * such a pattern as an ERROR (exit 2), which fails the gate even when every
 * file it did find is formatted.
 */
function missingTrees(scope: string[]): string[] {
  return scope.filter((token) => !token.includes("*")).filter((tree) => filesUnder(tree).length === 0);
}

const scope = parseScope(pkg.scripts["format:scope"] ?? "");

describe("the format gate's scope", () => {
  it("is declared by the repository, in one place", () => {
    expect(pkg.scripts["format:scope"], "package.json must declare the scope").toBeTruthy();
    expect(scope.length, "the scope must not be empty").toBeGreaterThan(0);
  });

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

  it("names only trees that exist in the repository", () => {
    const missing = missingTrees(scope);
    expect(
      missing,
      `prettier exits 2 on a pattern that matches no file, so the gate fails in CI whatever the ` +
        `formatting is: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("runs the check and the write variant through the same gate", () => {
    // The gate is what makes the scope tracked-only; raw prettier would walk
    // the working tree and pick up another session's scratch files.
    expect(pkg.scripts["format:check"]).toContain("scripts/format-gate.mjs");
    expect(pkg.scripts["format"]).toContain("scripts/format-gate.mjs");
    expect(pkg.scripts["format:check"]).toContain("--check");
    expect(pkg.scripts["format"]).toContain("--write");
  });

  it("measures only TRACKED files, so another session's scratch cannot flap it", () => {
    // The gate's own list, built the way the gate builds it...
    const list = buildGateFileList(scope, trackedFiles(ROOT));
    // ...judged against git's own list, which the spec asks for directly.
    const gitList = new Set(gitTrackedFiles());

    // The gate's list must be a subset of what git knows about: a file that
    // is not tracked belongs to somebody's working directory, not to the
    // project.
    expect(list.filter((file) => !gitList.has(file))).toEqual([]);

    // And it must be a list of FILES, never a scope token: handing prettier
    // a directory makes prettier expand it on the working tree, which is how
    // an untracked scratch file got into the gate in the first place.
    for (const tree of MAINTAINED_SOURCE_TREES) {
      expect(list, `${tree}/ is a directory — prettier would expand it on the working tree`).not.toContain(tree);
    }

    // Sanity: the gate really measures the project, not an empty list.
    expect(list.length, "the gate must cover the whole maintained tree").toBeGreaterThan(1000);
  });

  it("can tell a missing tree from a present one", () => {
    // Negative control: the detector must be able to go red. Without this, a
    // broken detector that always returns [] would pass the spec above.
    expect(missingTrees(["src", "apps", "definitely-not-a-tree"])).toEqual(["apps", "definitely-not-a-tree"]);
    expect(missingTrees(["src", "docs"])).toEqual([]);
  });

  it("cannot invent a file that git does not know", () => {
    // Negative control for the tracked-only rule: the list builder narrows
    // the tracked set, so a path outside it can never appear.
    expect(buildGateFileList(["src"], ["src/app.ts"], () => true)).toEqual(["src/app.ts"]);
    expect(buildGateFileList(["src"], ["src/app.ts"], () => false)).toEqual([]);
  });

  it("resolves a root glob to root-level files only", () => {
    // `*.md` must not reach into the subtrees — the trees are named
    // separately, and the CLI's own glob does not cross a path separator.
    expect(resolveScopeFiles(["*.md"], ["README.md", "docs/AGENT-MAP.md", "src/x.md"])).toEqual(["README.md"]);
  });
});
