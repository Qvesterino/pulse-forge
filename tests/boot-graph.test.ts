import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

/**
 * BOOT-GRAPH GATE (architecture hardening A3) — source-level assertion that
 * heavy on-demand domains stay OUT of the eager boot closure.
 *
 * The eager graph is the static import closure of src/main.tsx: everything
 * in it is downloaded and parsed on every studio boot. Domains that only
 * serve an explicit, later action (song-form planning, the Audio Canvas
 * handoff render, the QMR panel, opt-in codecs/runtimes) must be reached
 * exclusively through dynamic import() — exactly the regression class we
 * fixed when the MCP layer dragged the song planner (192 KB) and the
 * handoff sender into boot.
 *
 * Mirrors the landing-budget walker pattern (tests/landing-budget.test.ts).
 * `import type` lines are skipped (erased at compile time); dynamic
 * import() never matches the static-import regexes, which is the point.
 */

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  // the song-form planner (kyx_song/kyx_arrange load it on demand; the
  // arrangement/intent panels pull it through their own lazy chunks)
  { pattern: /src[\\/]intent[\\/]song\.ts$/, why: "song-form planner (on-demand)" },
  // the Audio Canvas handoff sender drags the render/stems/wav cluster
  { pattern: /src[\\/]interop[\\/]qvesterHandoff\.ts$/, why: "Audio Canvas handoff sender (on-demand)" },
  // the heavy QMR panel — only the deferred mini chip may sit in boot
  { pattern: /qmr-hud[\\/]src[\\/]qmr-panel-mount\.tsx$/, why: "QMR full panel (chip-click on-demand)" },
  // opt-in payloads with their own bundle buckets
  { pattern: /src[\\/]export[\\/]mp3\.ts$/, why: "MP3 codec (opt-in bucket)" },
  { pattern: /audiotool-nexus/, why: "Audiotool Nexus SDK (opt-in bucket)" },
  { pattern: /transformers\.web|onnxruntime/, why: "AI/onnx runtimes (opt-in bucket)" },
];

// main.tsx is a thin route router (landing/browser/studio are lazy chunks);
// the STUDIO boot graph starts at App.tsx — that is the 768 KB App-*.js
// chunk plus its static imports that every project-open session pays for.
const ENTRIES = [resolve(process.cwd(), "src/main.tsx"), resolve(process.cwd(), "src/ui/App.tsx")];

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

function resolveImport(from: string, spec: string): string | null {
  const base = join(dirname(from), spec);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

describe("boot-graph gate", () => {
  it("the eager closure of src/main.tsx never statically imports heavy on-demand domains", () => {
    const violations: string[] = [];
    const queue = [...ENTRIES];
    const seen = new Set<string>(queue);
    let closureSize = 0;
    while (queue.length > 0) {
      const file = queue.shift()!;
      closureSize += 1;
      for (const spec of importsOf(file)) {
        const resolved = resolveImport(file, spec);
        if (!resolved) continue;
        for (const { pattern, why } of FORBIDDEN) {
          if (pattern.test(resolved)) {
            violations.push(`${file} → ${spec} → ${why}`);
          }
        }
        if (!seen.has(resolved)) {
          seen.add(resolved);
          queue.push(resolved);
        }
      }
    }
    // the walk must actually traverse the app (guard against a broken entry)
    expect(closureSize).toBeGreaterThan(150);
    expect(violations).toEqual([]);
  });

  it("the forbidden list itself stays resolvable (guards against moving files silently)", () => {
    // every forbidden pattern must still point at a real file — if a module
    // moves, this test tells you to update the pattern instead of the rule
    // rotting into a no-op.
    const mustExist: Array<[RegExp, string]> = [
      [/src[\\/]intent[\\/]song\.ts$/, "src/intent/song.ts"],
      [/src[\\/]interop[\\/]qvesterHandoff\.ts$/, "src/interop/qvesterHandoff.ts"],
    ];
    for (const [pattern, path] of mustExist) {
      const abs = resolve(process.cwd(), path);
      expect(() => readFileSync(abs)).not.toThrow();
      expect(pattern.test(abs) || pattern.test(path)).toBe(true);
    }
  });
});
