import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative, sep } from "node:path";

/**
 * Architecture cycle guard (GOAL 02, re-run 4) — source-level twin of the
 * periodic `npx madge --circular src/` sweep.
 *
 * Re-run 3 recorded 5 file-level cycles as "function-level-safe, monitor";
 * by re-run 4 the count had silently drifted to 9 and the monitored
 * intent→commands folder cycle had CLOSED (pipeline → ranking-v3 → audition
 * → commands). This test pins the remaining allowlist so drift fails a test
 * instead of waiting for the next manual sweep:
 *
 *  - every multi-file strongly-connected component in the STATIC import
 *    graph must be a member of the documented allowlist below;
 *  - the pipeline↔commands cycle stays broken at runtime: ranking-v3 must
 *    keep loading the audition renderer through a DYNAMIC import (a static
 *    import would close the cycle at module-evaluation time);
 *  - three allowlisted cycles are known safe because their back edge is
 *    `import type` (erased at compile time) — pinned by regex so a value
 *    import slipped into the same line fails loudly.
 */

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkSources(full));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const match of source.matchAll(/import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/g)) {
    out.push(match[1]!);
  }
  for (const match of source.matchAll(/^\s*import\s+["'](\.[^"']+)["']/gm)) {
    out.push(match[1]!);
  }
  // `export ... from` re-exports create real module-graph edges too.
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{[^}]*\}\s+from\s+["']([^"']+)["']/g)) {
    out.push(match[1]!);
  }
  return out.filter((spec) => spec.startsWith("."));
}

function resolveImport(from: string, spec: string): string | null {
  const base = join(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts")]) {
    try {
      statSync(candidate).isFile();
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

const SRC = resolve(process.cwd(), "src");
const files = walkSources(SRC);

const graph = new Map<string, string[]>();
for (const file of files) {
  graph.set(
    file,
    importsOf(file)
      .map((spec) => resolveImport(file, spec))
      .filter((f): f is string => f !== null && f !== file),
  );
}

/** Tarjan strongly-connected components over the static graph. */
function sccs(): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;

  const strong = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      out.push(component);
    }
  };

  for (const v of files) if (!index.has(v)) strong(v);
  return out.filter((c) => c.length > 1);
}

const rel = (file: string) => relative(SRC, file).split(sep).join("/");

/** Known cycles, each with the reason it is accepted (see AGENT_WORK_LOG re-run 3/4). */
const ALLOWED_SCCS: Array<{ members: string[]; why: string }> = [
  {
    members: ["commands/commands.ts", "export/packCode.ts"],
    why: "both edges are `import type` — erased at compile time (re-run 3 GOAL 02)",
  },
  {
    members: ["project-model/schema.ts", "project-model/templates.ts", "project-model/template-pack2.ts"],
    why: "template starter docs are domain data; function-level-safe at runtime (re-run 3)",
  },
  {
    members: ["audio-engine/metering.ts", "audio-engine/kweighting.ts"],
    why: "shared BS.1770 const; function-level-safe (re-run 3)",
  },
  {
    members: ["persistence/UserSampleRepository.ts", "persistence/RecordingRecoveryRepository.ts"],
    why: "back edge is `import type`; runtime direction is one-way (re-run 4)",
  },
  {
    members: ["intent/sections.ts", "intent/song.ts"],
    why: "back edge is `import type` (SongSectionSpec); runtime direction is one-way (re-run 4)",
  },
];

describe("architecture import graph", () => {
  it("every file-level cycle is in the documented allowlist", () => {
    const found = sccs().map((component) => component.map(rel).sort());
    const allowedKeys = new Set(ALLOWED_SCCS.map((a) => [...a.members].sort().join("|")));
    const unknown = found.filter((c) => !allowedKeys.has(c.join("|")));
    expect(
      unknown,
      `New import cycles appeared (run \`npx madge --extensions ts,tsx --circular src/\` for paths). ` +
        `Break them at a leaf edge or add an explicitly documented allowlist entry. Found: ${JSON.stringify(unknown)}`,
    ).toEqual([]);
  });

  it("the intent→commands cycle stays broken: ranking-v3 loads audition dynamically", () => {
    // GOAL 02 re-run 4: pipeline → ranking-v3 → (dynamic) audition → commands
    // is runtime-safe ONLY while this edge stays dynamic. A static import
    // closes the cycle at module-evaluation time.
    const source = readFileSync(resolve(SRC, "intent/ranking-v3.ts"), "utf8");
    expect(source).toMatch(/await\s+import\("\.\/audition"\)/);
    expect(source).not.toMatch(/import\s+(type\s+)?\{[^}]*\}\s+from\s+"\.\/audition"/);
  });

  it("the three type-only back edges stay type-only", () => {
    const pins: Array<{ file: string; mustMatch: RegExp }> = [
      { file: "export/packCode.ts", mustMatch: /import\s+type\s+\{[^}]*\}\s+from\s+"\.\.\/commands\/commands"/ },
      {
        file: "persistence/RecordingRecoveryRepository.ts",
        mustMatch: /import\s+type\s+\{[^}]*\}\s+from\s+"\.\/UserSampleRepository"/,
      },
      { file: "intent/sections.ts", mustMatch: /import\s+type\s+\{[^}]*\}\s+from\s+"\.\/song"/ },
    ];
    for (const pin of pins) {
      const source = readFileSync(resolve(SRC, pin.file), "utf8");
      expect(source, `${pin.file} back edge must stay import type`).toMatch(pin.mustMatch);
    }
  });

  it("the provider dependency stays one-directional: symbolic never imports local", () => {
    // GOAL 02 re-run 4 broke local↔symbolic by extracting the shared
    // candidate gates into providers/candidate.ts. local→symbolic remains
    // sanctioned (the template provider branches to the symbolic prior);
    // the back edge is what must never return.
    const symbolic = readFileSync(resolve(SRC, "intent/providers/symbolic.ts"), "utf8");
    expect(symbolic).not.toMatch(/from\s+"\.\/local"/);
    const candidate = readFileSync(resolve(SRC, "intent/providers/candidate.ts"), "utf8");
    expect(candidate).not.toMatch(/from\s+"\.\/(local|symbolic)"/);
  });
});
