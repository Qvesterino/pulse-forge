/**
 * commands.ts identifier hygiene — source-grep regression guard.
 *
 * AGENTS.md §3 establishes a strict separation between model and engine,
 * and AGENTS.md §5 (state-management discipline) routes every mutation
 * through commands. With 212 exported functions in `src/commands/commands.ts`,
 * the consistency of the verb-prefix vocabulary is part of the project's
 * discoverability — a regression that introduces ad-hoc names like
 * `doStuff()` or `f()` would erode the household convention silently.
 *
 * Strategy:
 *  1. Ratio assertion — at least 60% of commands use a conventional verb
 *     prefix (`set` / `add` / `update` / `insert` / `remove` / `delete`
 *     / `toggle` / `create` / `move` / `duplicate` / `rename` /
 *     `reorder` / `clear` / `apply`). Anything outside that envelope is
 *     a verb-prefix migration that should be deliberate (whitelist), not
 *     accidental.
 *  2. `set*` is the dominant setter prefix — pin its share so the
 *     setter vocabulary does not fragment as new code lands.
 *  3. Anchor list — pin a small set of high-traffic non-conventional
 *     commands so a future rename or accidental delete is loud.
 *
 * Speed: a single read of src/commands/commands.ts per assertion pair,
 * regex over `^export function \w+`. Total runtime stays sub-50 ms.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONVENTIONAL_PREFIXES = [
  "set",
  "add",
  "update",
  "insert",
  "remove",
  "delete",
  "toggle",
  "create",
  "move",
  "duplicate",
  "rename",
  "reorder",
  "clear",
  "apply",
] as const;

function loadCommandExportNames(): string[] {
  const src = readFileSync(resolve(process.cwd(), "src/commands/commands.ts"), "utf8");
  return Array.from(src.matchAll(/^export\s+function\s+(\w+)/gm), (m) => m[1]);
}

describe("commands.ts identifier hygiene — conventional verb-prefix coverage", () => {
  it("at least 60% of commands use a conventional verb prefix (household vocabulary)", () => {
    // Current state: 67%. A regression that adds 30+ ad-hoc-verb commands
    // would drop below the threshold and fail here before code review
    // even sees them.
    const names = loadCommandExportNames();
    const conventional = names.filter((n) => CONVENTIONAL_PREFIXES.some((p) => n.startsWith(p))).length;
    const ratio = conventional / names.length;
    expect(
      ratio,
      `convention coverage ${(ratio * 100).toFixed(1)}% (${conventional}/${names.length}); expected >= 60%`,
    ).toBeGreaterThanOrEqual(0.6);
  });

  it("set* remains the dominant setter prefix (commands.ts is setter-heavy by design)", () => {
    // Current state: 67/212 ≈ 32%. Fragmentation would show up as a
    // drop — e.g. a future refactor that spreads setters across `update*`
    // and `configure*` would drag the shared vocabulary apart.
    const names = loadCommandExportNames();
    const set = names.filter((n) => n.startsWith("set")).length;
    const ratio = set / names.length;
    expect(
      ratio,
      `set* share ${(ratio * 100).toFixed(1)}% (${set}/${names.length}); expected >= 25%`,
    ).toBeGreaterThanOrEqual(0.25);
  });

  it("non-conventional commands stay below half of the export surface", () => {
    // 33% currently. Pin a ceiling so a future contributor who adds 20
    // commands named `doFoo()` triggers the regression guard without
    // having to update this test by feel.
    const names = loadCommandExportNames();
    const nonConventional = names.filter((n) => !CONVENTIONAL_PREFIXES.some((p) => n.startsWith(p))).length;
    const ratio = nonConventional / names.length;
    expect(ratio).toBeLessThan(0.4);
  });
});

describe("commands.ts identifier hygiene — anchor commands", () => {
  // A small, deliberate whitelist of high-traffic commands whose rename
  // or accidental delete would silently break the UI / AUTO-CHOP /
  // groove-extract / pack-install flows. Each anchor must remain
  // exported under the exact name below.
  const ANCHORS = [
    "snapshot",
    "sliceToPads",
    "captureKitFromTrack",
    "applyKitToDrumTrack",
    "installPackSketch",
    "stealGrooveIntoPattern",
  ] as const;

  it("every high-traffic anchor remains exported (rename deletes are loud)", () => {
    const names = new Set(loadCommandExportNames());
    const missing: string[] = [];
    for (const a of ANCHORS) {
      if (!names.has(a)) missing.push(a);
    }
    expect(missing, `missing anchor commands — rename deleted the API: ${missing.join(", ")}`).toEqual([]);
  });
});
