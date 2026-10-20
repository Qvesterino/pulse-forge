// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Dirent } from "node:fs";

/**
 * THE RUN MUST MEASURE KYX.
 *
 * Vitest's default include is a double-star glob over the WHOLE project root
 * (every `*.test.ts` / `*.spec.ts` and their cjs/mjs variants), so any tree
 * that is not `tests/` can inject spec files into the run — a co-tenant
 * workspace, a backup directory, or a JUNCTION into node_modules. Measured
 * 2026-10-20: a junction named `tmp-nm-junction` pointed at `node_modules`;
 * the full run collected 1388 spec files, 250 of them zod's own suite, and 58
 * of the 73 red files were zod's tests.
 *
 * A red count that is mostly somebody else's suite is a measurement nobody can
 * trust. So the exclude list in vitest.config.ts has to cover every foreign
 * tree that exists in the project root, and this test fails the moment a new
 * one appears.
 */

const ROOT = process.cwd();

/** The trees a KYX spec may live in. Everything else in the root is foreign. */
const OWN_ROOTS = new Set(["tests", "src", "node_modules", ".git"]);

const SPEC_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Minimal glob → RegExp for the shapes the exclude list uses: `**`, `*`, `?`, `{a,b}`. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1; // `**/` swallows the separator
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      const options = pattern.slice(i + 1, end).split(",");
      out += `(?:${options.map((option) => option.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    } else if ("+^$.()|[]\\".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

export interface RootEntry {
  name: string;
  /** A junction/symlink points OUTSIDE the tree — its contents are not ours. */
  isJunction: boolean;
  /** Spec files found inside. Empty for a junction: its target is not ours. */
  specFiles: string[];
}

/**
 * The foreign roots the run would collect from. An entry is foreign when the
 * exclude list does not cover it AND it either is a junction (by construction
 * a foreign source) or holds a spec file.
 */
export function foreignRoots(entries: RootEntry[], patterns: RegExp[]): RootEntry[] {
  return entries.filter((entry) => {
    if (patterns.some((pattern) => pattern.test(`${entry.name}/probe.test.ts`))) return false;
    if (entry.isJunction) return true;
    return entry.specFiles.length > 0;
  });
}

/** Bounded walk for spec files. It never follows a nested junction. */
function scanForSpecs(dir: string, depth = 0, budget = { left: 3000 }): string[] {
  if (depth > 4 || budget.left <= 0) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    budget.left -= 1;
    if (budget.left <= 0) break;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      found.push(...scanForSpecs(full, depth + 1, budget));
    } else if (SPEC_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function listRootEntries(): RootEntry[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !OWN_ROOTS.has(entry.name))
    .map((entry) => {
      const isJunction = entry.isSymbolicLink();
      return {
        name: entry.name,
        isJunction,
        specFiles: isJunction ? [] : scanForSpecs(join(ROOT, entry.name)),
      };
    });
}

/**
 * The exclude list, read from the config SOURCE. Importing vitest.config.ts
 * would pull @vitejs/plugin-react (and esbuild) into a jsdom realm, where
 * `new TextEncoder().encode("") instanceof Uint8Array` is false and the
 * whole file dies before a single assertion runs. The config is text; read it
 * as text.
 */
function readExcludePatterns(): string[] {
  const source = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  const block = source.slice(source.indexOf("exclude: ["));
  const end = block.indexOf("],");
  if (block.indexOf("exclude: [") < 0 || end < 0) throw new Error("vitest.config.ts has no exclude list to read");
  return [...block.slice(0, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

const EXCLUDE_PATTERNS = readExcludePatterns().map((pattern) => globToRegExp(pattern));

describe("the vitest run collects KYX's own specs only", () => {
  it("covers every foreign tree in the project root with the exclude list", () => {
    const foreign = foreignRoots(listRootEntries(), EXCLUDE_PATTERNS);
    const report = foreign
      .map((entry) =>
        entry.isJunction
          ? `  ${entry.name} — a junction tree; vitest traverses INTO it, so it must be excluded`
          : `  ${entry.name} — ${entry.specFiles.length} spec file(s), e.g. ${entry.specFiles[0]}`,
      )
      .join("\n");
    expect(
      foreign.map((entry) => entry.name),
      `these project-root trees would inject FOREIGN spec files into the run:\n${report}\n` +
        "Add them to the `exclude` list in vitest.config.ts (with a comment saying why).",
    ).toEqual([]);
  });

  it("recognises the trees that already had to be excluded", () => {
    // The co-tenant trees measured on 2026-10-20, plus KYX's own scratch
    // directory. If this list is empty the exclude list is too narrow — and
    // the guard above would be blind.
    const known = [".kilo", ".sft", ".zcode", ".sound-audit", "tmp-nm-junction", "output", "scratch"];
    const uncovered = known.filter(
      (name) => !EXCLUDE_PATTERNS.some((pattern) => pattern.test(`${name}/probe.test.ts`)),
    );
    expect(uncovered, "these known foreign trees lost their exclusion").toEqual([]);
  });
});

describe("foreignRoots (the guard, proven able to fail)", () => {
  it("flags a junction that is not excluded", () => {
    const flagged = foreignRoots(
      [{ name: "tmp-new-junction", isJunction: true, specFiles: [] }],
      [globToRegExp("**/node_modules/**")],
    );
    expect(flagged.map((entry) => entry.name)).toEqual(["tmp-new-junction"]);
  });

  it("flags a plain tree that holds a spec file", () => {
    const flagged = foreignRoots(
      [{ name: "scratch", isJunction: false, specFiles: ["scratch/probe.test.ts"] }],
      [globToRegExp("**/node_modules/**")],
    );
    expect(flagged.map((entry) => entry.name)).toEqual(["scratch"]);
  });

  it("accepts an excluded tree", () => {
    const flagged = foreignRoots(
      [{ name: "tmp-nm-junction", isJunction: true, specFiles: [] }],
      [globToRegExp("**/tmp-*/**")],
    );
    expect(flagged).toEqual([]);
  });
});

describe("globToRegExp (the matcher, proven able to fail)", () => {
  it("matches the exclude shapes the config actually uses", () => {
    expect(globToRegExp("**/node_modules/**").test("node_modules/zod/x.test.ts")).toBe(true);
    expect(globToRegExp("**/tmp-*/**").test("tmp-nm-junction/zod/x.test.ts")).toBe(true);
    expect(globToRegExp("**/.{idea,git,cache,output,temp}/**").test(".output/x.test.ts")).toBe(true);
    expect(globToRegExp("tests/e2e/**").test("tests/e2e/01.spec.ts")).toBe(true);
  });

  it("does NOT match a tree it was not written for", () => {
    expect(globToRegExp("**/node_modules/**").test("tmp-nm-junction/zod/x.test.ts")).toBe(false);
    expect(globToRegExp("**/dist/**").test("dist-contest/x.test.ts")).toBe(false);
  });
});
