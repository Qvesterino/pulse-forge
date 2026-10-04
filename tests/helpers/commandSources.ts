// Loader for the source-grep guards over the command engine.
//
// `src/commands/commands.ts` is the barrel: it keeps the whole public surface on
// one path (the ~199 modules that import it are untouched) but delegates the
// bodies to domain modules through `export * from "./x"`. A guard that greps the
// barrel for `^export function <name>` therefore no longer finds the commands
// whose bodies moved — `snapshot` (core), `freezeTrack` (freeze), the instrument
// setters, and every domain module added after.
//
// readCommandLines() follows the barrel's own re-export list — both
// `export * from "./x"` (domain modules) and `export { … } from "./x"`
// (./core, which re-exports named members) — and concatenates those sources
// into ONE array, so every caller keeps indexing a single line list and
// `scanBody` / `readSignature` still resolve against the declaration they were
// written for. This widens the search scope only; it does not relax any
// assertion.
//
// Order is barrel-first, then each re-exported module in source order, so an
// index found in the barrel still points at barrel code.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const BARREL = resolve(process.cwd(), "src/commands/commands.ts");

/** The barrel plus every module it re-exports, in the order readCommandLines() concatenates them. */
function readCommandSegments(): { file: string; lines: string[] }[] {
  const seen = new Set<string>();
  const out: { file: string; lines: string[] }[] = [];

  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    out.push({ file, lines: src.split(/\r?\n/) });
    for (const m of src.matchAll(/^export\s+(?:\*|\{[^}]*\})\s+from\s+"\.\/([\w.-]+)"/gm)) {
      const next = resolve(dirname(file), `${m[1]}.ts`);
      if (existsSync(next)) visit(next);
    }
  };

  visit(BARREL);
  return out;
}

/** Every source line of the barrel plus every module it re-exports. */
export function readCommandLines(): string[] {
  return readCommandSegments().flatMap((s) => s.lines);
}

/**
 * The owning file of every line readCommandLines() returns — a parallel array.
 *
 * A guard that concatenates several files cannot tell a module header from a
 * function's own JSDoc, because both are just a `/** ... *\/` block sitting
 * above an `export function`. This gives callers the boundary they need to
 * tell the two apart.
 */
export function readCommandLineOwners(): string[] {
  return readCommandSegments().flatMap((s) => s.lines.map(() => s.file));
}

/** Names of every `export function` across the barrel and its domain modules. */
export function readCommandExportNames(): string[] {
  const src = readCommandLines().join("\n");
  return Array.from(src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm), (m) => m[1]);
}
