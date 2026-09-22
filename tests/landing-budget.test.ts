import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

/**
 * Fáza C — landing import-graph budget (source-level twin of the
 * check-bundle-size landing-route gate).
 *
 * The landing conversion path may use: the offline renderer/embed player,
 * the intent keyword parser + deterministic provider, and the command that
 * applies a forged pattern. It must NEVER statically pull in: the studio
 * services (IndexedDB/scheduler boot), the studio UI, the collab stack, the
 * semantic model runtime, the audio workers, or the onnxruntime — those
 * belong to the studio route or the optional lazy chunk.
 *
 * Walks static relative imports transitively from the two landing entries;
 * `import type` lines are skipped (erased at compile time).
 */

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  // src/services.ts is the studio boot (IndexedDB, scheduler, MIDI); the tiny
  // src/services/funnel.ts module is landing machinery and explicitly allowed.
  { pattern: /src[\\/]services\.ts$/, why: "studio services boot" },
  { pattern: /src[\\/]ui[\\/]/, why: "studio UI" },
  { pattern: /src[\\/]collab[\\/]/, why: "collab stack" },
  { pattern: /src[\\/]ai[\\/]semantic[\\/]/, why: "semantic model client" },
  { pattern: /src[\\/]store[\\/]/, why: "studio stores" },
  { pattern: /[\\/]onnxruntime[\\/]|onnxruntime-web/, why: "onnx runtime" },
];

const ENTRIES = [
  resolve(process.cwd(), "src/landing/LandingPage.tsx"),
  resolve(process.cwd(), "src/embed/EmbedApp.tsx"),
];

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

function walkGraph(entries: string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [...entries];
  const seen = new Set(entries);
  while (queue.length > 0) {
    const file = queue.shift()!;
    const violations: string[] = [];
    for (const spec of importsOf(file)) {
      const resolved = resolveImport(file, spec);
      if (!resolved) continue;
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(resolved)) violations.push(`${spec} → ${why}`);
      }
      if (!seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
    graph.set(file, violations);
  }
  return graph;
}

describe("landing route — static import budget (Fáza C)", () => {
  const graph = walkGraph(ENTRIES);

  it("walked a non-trivial graph (the entries are really connected)", () => {
    expect(graph.size).toBeGreaterThan(20);
  });

  it("no forbidden module statically reaches the landing route", () => {
    const violations = [...graph.entries()].flatMap(([file, hits]) =>
      hits.map((hit) => `${file.replace(process.cwd(), "")}: ${hit}`),
    );
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("the render path stays DYNAMIC (no renderer/AudioEngine in the static graph)", () => {
    // 2026-09-22: EmbedApp/loudness/audition switched to `await import()`
    // for the offline renderer — statically it dragged AudioEngine, the
    // worklet loader, persistence and the curated library into the landing
    // closure (bundle landing route 729 > 600 KB). The renderer may only
    // enter via dynamic import (loaded on demand, after first paint).
    const files = [...graph.keys()];
    expect(files.some((file) => file.endsWith("renderer.ts"))).toBe(false);
    expect(files.some((file) => file.endsWith("AudioEngine.ts"))).toBe(false);
    // Guard against the walker silently matching nothing: the known-good
    // static edge commands.ts (intent apply — the sanctioned heaviest
    // landing module) must still be in the walked graph.
    expect(files.some((file) => file.endsWith("commands.ts"))).toBe(true);
  });
});
