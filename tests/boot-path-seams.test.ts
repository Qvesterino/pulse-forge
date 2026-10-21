/**
 * BOOT-PATH SEAM GUARD — the studio boot path must stay under its budget.
 *
 * WHAT THIS IS. `scripts/check-bundle-size.mjs` measures the studio boot path
 * (the App chunk plus its transitive static imports) and fails the build when
 * it crosses 2200 KB. That check runs in the build job — but it costs a full
 * production build (~2.5 minutes) to answer. This test answers the same
 * question at the SOURCE level in about a second: it walks the static import
 * graph from `src/ui/App.tsx` and asserts that the heavy modules stay OUT of
 * it.
 *
 * WHY IT EXISTS. The boot path grew from 2122 KB (2026-10-12) to 2354 KB
 * (2026-10-21) because static imports were added to modules that live on the
 * boot path. Nothing about those imports looked wrong; each one was a
 * one-line convenience. The budget caught it three days late, in a build
 * nobody was watching. This guard catches it in the test job, at the commit
 * that caused it.
 *
 * HOW TO REPAIR A FAILURE. Do NOT delete an assertion to make this green.
 * Every module listed below is reachable in the product — the question is
 * only WHEN it loads. Make the import dynamic at the moment of use
 * (`await import(...)` inside the function that needs it), or move the
 * shared helper into a leaf module that the boot path does not import.
 *
 * The list is the set of modules whose weight was measured and removed from
 * the boot path. A new member is welcome: add it with the measurement that
 * justified removing it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
/** The studio shell — the chunk the budget script calls the boot entry. */
const ENTRY = join(SRC, "ui", "App.tsx");

/**
 * Modules that must NOT be statically reachable from the studio entry.
 *
 * Each one was measured out of the boot path:
 *   ai/generator, preference-ledger  — the AI engine (grooves, generator,
 *     markov, drums): ~200 KB built, reached through a single import of an
 *     event-name constant.
 *   intentRouting, mix-idea          — the intent routing table (91.8 KB
 *     built) and the FX add assistant.
 *   renderManifest, zip              — the render manifest (11.1 KB) and the
 *     zip writer (1.7 KB).
 *   trustReport, sessionStory        — the download builders behind the
 *     activity center, which is mounted on every boot.
 *   freezeSignature                  — the freeze-signature reader, which
 *     carries the render manifest.
 *   midiFile, midiProject, hum-to-notes — the MIDI format writers.
 *   pipeline, song, aiPattern        — the intent engine's hot paths.
 */
const MUST_STAY_OUT = [
  "src/ai/generator.ts",
  "src/intent/preference-ledger.ts",
  "src/commands/intentRouting.ts",
  "src/mcp/mix-idea.ts",
  "src/export/renderManifest.ts",
  "src/export/zip.ts",
  "src/services/trustReport.ts",
  "src/services/sessionStory.ts",
  "src/rendering/freezeSignature.ts",
  "src/midi/midiFile.ts",
  "src/midi/midiProject.ts",
  "src/intent/pipeline.ts",
  "src/intent/song.ts",
  "src/commands/aiPattern.ts",
];

/**
 * The boot closure must not grow without a conscious decision. The closure
 * measured 454 modules after the wave-6 diet (487 before it). This ceiling is
 * deliberately generous: it is not a budget, it is a canary for a whole
 * subsystem arriving on the boot path at once.
 */
const MAX_CLOSURE_MODULES = 560;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const files = walk(SRC);
const known = new Set(files.map((file) => file.replace(/\\/g, "/")));

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    const key = candidate.replace(/\\/g, "/");
    if (known.has(key)) return key;
  }
  return null;
}

/**
 * A STATIC edge is `import ... from "x"` or `export ... from "x"`.
 *
 * NOT static, and therefore not a boot-path edge:
 *   `import type ... from "x"`  — erased at build time
 *   `import("x")`               — the lazy seam this whole guard exists for
 *
 * The clause part may not contain "(", which is what keeps `import("x")` from
 * being read as a static import.
 */
const IMPORT_RE = /(?:^|[\n;}])\s*(?:import|export)\s+(?:type\s+)?(?:[^'";(]*?\s+from\s+)?["']([^"']+)["']/g;

function staticImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const clause = match[0];
    if (/\b(?:import|export)\s+type\b/.test(clause)) continue;
    if (/\bimport\s*\(/.test(clause)) continue;
    const target = resolveSpecifier(file, match[1]);
    if (target) out.push(target);
  }
  return out;
}

/** The static closure of the studio entry. */
function bootClosure(): Set<string> {
  const seen = new Set<string>([ENTRY.replace(/\\/g, "/")]);
  const queue = [ENTRY.replace(/\\/g, "/")];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const dep of staticImports(file)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return seen;
}

const closure = bootClosure();

describe("studio boot path seams", () => {
  it("walks a real closure from the studio entry", () => {
    expect(closure.size).toBeGreaterThan(200);
    expect(known.has(ENTRY.replace(/\\/g, "/"))).toBe(true);
  });

  it("keeps the heavy modules out of the boot path", () => {
    const leaked = MUST_STAY_OUT.filter((relativePath) => closure.has(join(ROOT, relativePath).replace(/\\/g, "/")));
    expect(
      leaked,
      leaked.length === 0
        ? ""
        : [
            "These modules reached the studio boot path through a static import.",
            "That is what the 2200 KB boot-path budget measures — the parse/eval",
            "a waiting user pays at studio boot.",
            "",
            "Fix it by loading the module at the moment of use",
            "(`await import(...)` inside the function that needs it), or by moving",
            "the shared helper into a leaf module the boot path does not import.",
            "Do NOT delete the assertion to make this green.",
            "",
            ...leaked.map((path) => `  - ${path}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("does not let the boot closure grow without a decision", () => {
    expect(
      closure.size,
      `The studio boot closure is ${closure.size} modules (ceiling ${MAX_CLOSURE_MODULES}). ` +
        `A subsystem arriving on the boot path at once is the failure mode this catches — ` +
        `measure the boot path before raising this number.`,
    ).toBeLessThanOrEqual(MAX_CLOSURE_MODULES);
  });
});
