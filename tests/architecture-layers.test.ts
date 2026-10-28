import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative, dirname, isAbsolute } from "node:path";

/**
 * ARCHITECTURE LAYER GATE — the long-term erosion defence.
 *
 * Each rule says: modules in the FORBIDDEN layer must never statically
 * import from the PROTECTED layer. Violations are caught at test time
 * (before they reach a commit), not in a manual audit two years later.
 *
 * To add a rule: push a new entry into the RULES array. To allow a
 * legitimate exception, add a carve-out with a `why` comment.
 *
 * BFS walker pattern (mirrors boot-graph.test.ts and landing-budget.test.ts).
 */

interface LayerRule {
  /** Human-readable name for the failure message. */
  name: string;
  /** Glob-like prefixes of files that must not violate. */
  fromDir: string;
  /** Directory prefixes that are forbidden as import targets. */
  forbiddenDir: string;
  /** Human reason for the failure message. */
  why: string;
}

const RULES: LayerRule[] = [
  {
    name: "audio-engine is self-contained",
    fromDir: "src/audio-engine",
    forbiddenDir: "src/mcp",
    why: "the audio engine must not know about the MCP protocol layer",
  },
  {
    name: "audio-engine is self-contained (intent)",
    fromDir: "src/audio-engine",
    forbiddenDir: "src/intent",
    why: "the audio engine must not know about intent generation",
  },
  {
    name: "audio-engine is self-contained (commands)",
    fromDir: "src/audio-engine",
    forbiddenDir: "src/commands",
    why: "the audio engine must not know about the command layer",
  },
  {
    name: "audio-engine is self-contained (persistence)",
    fromDir: "src/audio-engine",
    forbiddenDir: "src/persistence",
    why: "the audio engine must not know about storage",
  },
  {
    name: "audio-engine is self-contained (ui)",
    fromDir: "src/audio-engine",
    forbiddenDir: "src/ui",
    why: "the audio engine must not know about UI components",
  },
  {
    name: "persistence is storage-only (audio-engine)",
    fromDir: "src/persistence",
    forbiddenDir: "src/audio-engine",
    why: "persistence stores bytes, it must not know about the audio engine",
  },
  {
    name: "persistence is storage-only (commands)",
    fromDir: "src/persistence",
    forbiddenDir: "src/commands",
    why: "persistence stores documents, it must not know about command execution",
  },
  {
    name: "persistence is storage-only (mcp)",
    fromDir: "src/persistence",
    forbiddenDir: "src/mcp",
    why: "persistence must not know about the MCP protocol layer",
  },
  {
    name: "persistence is storage-only (ui)",
    fromDir: "src/persistence",
    forbiddenDir: "src/ui",
    why: "persistence must not know about UI components",
  },
  {
    name: "MCP protocol is UI-agnostic",
    fromDir: "src/mcp",
    forbiddenDir: "src/ui",
    why: "the MCP protocol layer must not import UI components",
  },
];

/** Collect all .ts/.tsx files under a directory (recursive). */
function filesIn(dir: string): string[] {
  const out: string[] = [];
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        queue.push(full);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Extract static relative import specifiers from a source file. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const match of source.matchAll(/import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/g)) {
    out.push(match[1]!);
  }
  for (const match of source.matchAll(/^\s*import\s+["'](\.[^"']+)["']/gm)) {
    out.push(match[1]!);
  }
  return out.filter((spec) => spec.startsWith("."));
}

/** Resolve a relative import to an absolute path (or null if not found). */
function resolveImport(from: string, spec: string): string | null {
  const base = join(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      statSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Check if an absolute path lives under the given directory prefix.
 *
 * The comparison MUST be separator-agnostic. The previous version appended a
 * hardcoded "/" to the prefix — on Windows (where paths use "\") it matched
 * NOTHING, so the whole gate went green without ever running a rule. For a
 * gate that is the worst possible failure: it reported "no violations" while
 * never looking, and the violations it hid were red on CI (measured
 * 2026-10-28: three real layer violations, invisible on the dev machine).
 * `path.relative` answers containment the same way on every platform.
 */
function underDir(absPath: string, dirPrefix: string): boolean {
  const rel = relative(resolve(process.cwd(), dirPrefix), absPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

describe("architecture layer gate", () => {
  for (const rule of RULES) {
    it(`${rule.name}: ${rule.fromDir} must not import from ${rule.forbiddenDir}`, () => {
      const fromDirAbs = resolve(process.cwd(), rule.fromDir);
      let fileCount = 0;
      const violations: string[] = [];

      for (const file of filesIn(fromDirAbs)) {
        fileCount += 1;
        for (const spec of importsOf(file)) {
          const resolved = resolveImport(file, spec);
          if (resolved == null) continue;
          if (underDir(resolved, rule.forbiddenDir)) {
            violations.push(
              `${relative(process.cwd(), file)} imports ${relative(process.cwd(), resolved)} — ${rule.why}`,
            );
          }
        }
      }

      // guard against an empty directory (pattern rot detection)
      expect(fileCount).toBeGreaterThan(0);
      if (violations.length > 0) {
        throw new Error(
          `Layer violation (${rule.name}):\n${violations.map((v) => `  ${v}`).join("\n")}\n\n` +
            `If this import is legitimate, add a carve-out to the RULES array with a why comment.`,
        );
      }
    });
  }

  it("the containment check actually recognises a path inside its layer", () => {
    // The gate's own blind spot: a separator-hardcoded prefix matches
    // NOTHING on Windows, so every rule reports "clean" without looking.
    // This pins the check itself — a known in-repo path must be recognised.
    expect(underDir(resolve(process.cwd(), "src/ui/App.tsx"), "src/ui")).toBe(true);
    expect(underDir(resolve(process.cwd(), "src/mcp/tools.ts"), "src/ui")).toBe(false);
  });
});
