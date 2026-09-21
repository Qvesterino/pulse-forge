import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";

/**
 * Cross-platform campaign GOAL 02 — domain-purity pins (source-level walker,
 * twin of landing-budget.test.ts).
 *
 * The extracted pure modules must stay executable in bare Node: no React, no
 * audio runtime, no worklet loaders, no storage in their transitive static
 * import graph. The project model and the share-code encoders must consume
 * ONLY the pure halves. `import type` lines are skipped (erased at compile
 * time) — same rules as the landing budget walker.
 */

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const match of source.matchAll(/import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/g)) {
    out.push(match[1]!);
  }
  for (const match of source.matchAll(/^\s*import\s+["'](\.[^"']+)["']/gm)) {
    out.push(match[1]!);
  }
  // re-export chains count too: `export { x } from "./y"` drags y at runtime.
  for (const match of source.matchAll(/^export\s+\{[^}]*\}\s+from\s+["']([^"']+)["']/gm)) {
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

/** BFS over static relative imports; returns repo-relative paths. */
function transitiveClosure(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  for (let i = 0; i < queue.length; i++) {
    for (const spec of importsOf(queue[i]!)) {
      const resolved = resolveImport(queue[i]!, spec);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return [...seen].map((p) => relative(process.cwd(), p).replace(/\\/g, "/"));
}

function expectNoMatches(files: string[], forbidden: Array<{ pattern: RegExp; why: string }>): void {
  for (const file of files) {
    for (const rule of forbidden) {
      expect(file, `${file} must not be reachable: ${rule.why}`).not.toMatch(rule.pattern);
    }
  }
}

const NO_REACT = [{ pattern: /node_modules\/react|src\/ui\//, why: "React/UI" }];
const NO_AUDIO_RUNTIME = [
  { pattern: /src\/audio-worklets\//, why: "worklet loaders/nodes" },
  { pattern: /src\/audio-engine\//, why: "audio engine" },
  { pattern: /src\/audio-workers\//, why: "audio workers" },
];
// Real global accesses only — `window.length` on a local analysis buffer or
// the word "localStorage" inside a doc comment must not false-positive.
const BROWSER_GLOBAL_ACCESS = [
  /\bdocument\s*\.\s*(createElement|getElementById|querySelector\w*|body|documentElement|addEventListener|removeEventListener|title|head|visibilityState)\b/,
  /\bwindow\s*\.\s*(setTimeout|setInterval|addEventListener|removeEventListener|requestAnimationFrame|alert|confirm|prompt|open|location|navigator|devicePixelRatio|innerWidth|innerHeight|AudioContext|webkitAudioContext)\b/,
  /\blocalStorage\s*\.\s*(getItem|setItem|removeItem|clear|key)\b/,
  /\bsessionStorage\s*\.\s*(getItem|setItem|removeItem)\b/,
  /\bnavigator\s*\.\s*(mediaDevices|clipboard|requestMIDIAccess|userAgent|storage|vibrate)\b/,
];

function expectNoBrowserSource(source: string, label: string): void {
  for (const pattern of BROWSER_GLOBAL_ACCESS) {
    expect(source, `${label} must not touch browser globals`).not.toMatch(pattern);
  }
}

describe("domain purity (GOAL 02)", () => {
  it("instruments/definitions is Node-pure (no React, no audio runtime, no browser globals)", () => {
    const entry = resolve(process.cwd(), "src/instruments/definitions.ts");
    const closure = transitiveClosure(entry);
    expectNoMatches(closure, [...NO_REACT, ...NO_AUDIO_RUNTIME]);
    expectNoBrowserSource(readFileSync(entry, "utf8"), "instruments/definitions.ts");
  });

  it("instruments envelope/modmatrix/wavetables deps stay browser-free (definitions' only siblings)", () => {
    for (const dep of [
      "src/instruments/envelope.ts",
      "src/instruments/modmatrix.ts",
      "src/instruments/wavetables.ts",
    ]) {
      expectNoBrowserSource(readFileSync(resolve(process.cwd(), dep), "utf8"), dep);
    }
  });

  it("project model consumes INSTRUMENT_META, never the runtime registry", () => {
    for (const rel of [
      "src/project-model/schema.ts",
      "src/project-model/targets.ts",
      "src/commands/commands.ts",
      "src/instruments/randomize.ts",
      "src/presets/similar.ts",
    ]) {
      const closure = transitiveClosure(resolve(process.cwd(), rel));
      const hits = closure.filter((f) => f === "src/instruments/registry.ts");
      expect(hits, `${rel} must not pull the instrument runtime registry`).toEqual([]);
    }
  });

  it("share-code encoders are React-free", () => {
    for (const rel of ["src/export/packCode.ts", "src/export/themeCode.ts", "src/export/bindsCode.ts"]) {
      const closure = transitiveClosure(resolve(process.cwd(), rel));
      expectNoMatches(closure, NO_REACT);
    }
  });

  it("intent favorites-core carries no storage/browser code", () => {
    const entry = resolve(process.cwd(), "src/intent/favorites-core.ts");
    const closure = transitiveClosure(entry);
    expectNoMatches(closure, [...NO_REACT, ...NO_AUDIO_RUNTIME]);
    expectNoBrowserSource(readFileSync(entry, "utf8"), "intent/favorites-core.ts");
  });
});
