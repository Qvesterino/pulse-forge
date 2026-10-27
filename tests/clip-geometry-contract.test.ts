/**
 * THE CLIP GEOMETRY CONTRACT — one home for the clamp rule.
 *
 * `src/commands/geometry.ts` is where a clip's geometry is clamped. The rule
 * it encodes is short: **the clamp falls on the field the verb does NOT own.**
 * A placement owns the length, so the position gives way; a resize owns the
 * length, so the position stays and the length gives way.
 *
 * This file makes that rule EXECUTABLE in three layers:
 *
 *   1. the rule itself, tested at the helper level (what the shared home
 *      promises);
 *   2. a GUARD over the command layer: no module outside `geometry.ts` may
 *      clamp a clip's geometry inline — an inline clamp is a second rule, and
 *      a second rule is how the resize that teleported a clip to tick 0 and
 *      the resize that made a MIDI clip VANISH happened;
 *   3. the lanes that own clip geometry must actually CALL the shared home,
 *      so the guard cannot pass because a lane quietly stopped clamping.
 *
 * The guard is an AST walk, not a grep: a grep would also match a comment,
 * an import, or a COMPARISON (the ripple edit refuses a group move that would
 * push a clip past the ceiling — a refusal is not a clamp). The house rule is
 * that a guard must be PROVEN ABLE TO FAIL: the detector is fed synthetic
 * sources below and must report them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  clampBarLength,
  clampBarPosition,
  clampResizeLength,
  clampTickLength,
  clampTickPosition,
  clampTickSpan,
  clampValue,
  clampWholeBarLength,
} from "../src/commands/geometry";
import { MAX_ARRANGEMENT_CLIP_BARS, MAX_ARRANGEMENT_CLIP_TICKS } from "../src/project-model/schema";

/** The modules that own clip geometry, and therefore must clamp through the shared home. */
const CLIP_GEOMETRY_LANES = [
  "src/commands/arrangement.ts",
  "src/commands/arrangementShapes.ts",
  "src/commands/audioClips.ts",
  "src/commands/automationClips.ts",
  "src/commands/clipClipboard.ts",
  "src/commands/clipEditing.ts",
  "src/commands/clipPlayback.ts",
  "src/commands/midiClips.ts",
];

const CEILINGS = ["MAX_ARRANGEMENT_CLIP_BARS", "MAX_ARRANGEMENT_CLIP_TICKS"];

/**
 * The modules that may touch a clip ceiling WITHOUT routing through the
 * shared home, and why. An exemption is a hole in the guard, so each one is
 * named and said out loud:
 *
 *   - `notes.ts` — NOTE geometry, not clip geometry: a note's own bounds
 *     inside the pattern. Its rule is per-verb (a note move lets the START
 *     give way, a note resize lets the DURATION give way) and it is a
 *     different subject from the clip rule this module owns.
 *   - `timeRange.ts` — a REFUSAL, not a clamp: the print range must fit
 *     inside the clip limit, and the command says so instead of clamping.
 */
const CLIP_GEOMETRY_EXEMPT = new Map<string, string>([
  ["src/commands/notes.ts", "note geometry — a note's own bounds, not a clip's"],
  ["src/commands/timeRange.ts", "a refusal (the print range must fit the clip limit), not a clamp"],
]);

/** True when `node` mentions one of the clip ceilings. */
function mentionsCeiling(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(child) && CEILINGS.includes(child.text)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * The inline CLAMP sites in a source: a `Math.min` / `Math.max` CALL that
 * takes a clip ceiling AS A DIRECT ARGUMENT.
 *
 * Deliberately narrow. A ceiling inside an arithmetic expression
 * (`ceiling - start`) is a derived BOUND — the lane composes its own limit
 * from the shared constant — and a comparison is a REFUSAL. Both are
 * legitimate outside the shared home; what is not legitimate is the lane
 * clamping a clip's length against the ceiling in its own words.
 */
function inlineClampSites(source: string): number[] {
  const file = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Math" &&
      (node.expression.name.text === "min" || node.expression.name.text === "max") &&
      node.arguments.some((argument) => ts.isIdentifier(argument) && CEILINGS.includes(argument.text))
    ) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

/** True when the source imports the shared home. */
function importsSharedHome(source: string): boolean {
  const file = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "./geometry"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The names of the geometry helpers a source CALLS. */
function calledGeometryHelpers(source: string): string[] {
  const file = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const called: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name.startsWith("clamp")) called.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return called;
}

describe("the clip geometry rule — the clamp falls on the field the verb does NOT own", () => {
  it("a RESIZE keeps the start and gives way on the length", () => {
    // The start the user put is the verb's other field — it must not move.
    expect(clampResizeLength(1000, 1e12, "MIDI"), "the length gives way, the start does not").toBe(
      MAX_ARRANGEMENT_CLIP_TICKS - 1000,
    );
    expect(clampResizeLength(0, 1e12, "MIDI")).toBe(MAX_ARRANGEMENT_CLIP_TICKS);
    expect(clampResizeLength(1000, 480, "MIDI"), "a legal length is untouched").toBe(480);
    expect(clampResizeLength(1000, 0, "MIDI"), "a length is at least one tick").toBe(1);
  });

  it("a RESIZE respects the lane's own extra bound (the automation phase)", () => {
    expect(clampResizeLength(1000, 1e12, "Automation", 4096), "the phase limits how far the clip may reach").toBe(4096);
    expect(clampResizeLength(1000, 1e12, "Automation", 10), "and it is the bound, not a floor of one").toBe(10);
    expect(clampResizeLength(1000, 0, "Automation", 10), "but a length is never below one tick").toBe(1);
  });

  it("a PLACEMENT keeps the length and gives way on the position", () => {
    const span = clampTickSpan(1e12, 480, "MIDI");
    expect(span.lengthTicks, "the length is what the user asked for").toBe(480);
    expect(span.startTick, "the position is pulled back inside the timeline").toBe(MAX_ARRANGEMENT_CLIP_TICKS - 480);
    expect(clampTickSpan(-500, 480, "MIDI").startTick, "and never before the timeline").toBe(0);
  });

  it("a MOVE with a fixed length gives way on the position alone", () => {
    expect(clampTickPosition(1e12, 480)).toBe(MAX_ARRANGEMENT_CLIP_TICKS - 480);
    expect(clampTickPosition(-5, 480)).toBe(0);
    expect(clampTickPosition(1000, 480)).toBe(1000);
  });

  it("a bar-addressed clip rounds to whole bars and stops at the ceiling", () => {
    expect(clampWholeBarLength(4.4)).toBe(4);
    expect(clampWholeBarLength(0)).toBe(1);
    expect(clampWholeBarLength(1e12)).toBe(MAX_ARRANGEMENT_CLIP_BARS);
    expect(clampWholeBarLength(Number.NaN), "garbage becomes one bar, never a clip the normalizer drops").toBe(1);
    expect(clampBarLength(2.5, 1), "the audio lane's floor is the caller's").toBe(2.5);
    expect(clampBarLength(1e12, 1)).toBe(MAX_ARRANGEMENT_CLIP_BARS);
    expect(clampBarPosition(-3)).toBe(0);
    expect(clampBarPosition(2.6)).toBe(3);
  });

  it("the plain value clamp stays a value clamp", () => {
    expect(clampValue(5, 0, 3)).toBe(3);
    expect(clampValue(-5, 0, 3)).toBe(0);
    expect(clampValue(2, 0, 3)).toBe(2);
    expect(clampTickLength(1e12)).toBe(MAX_ARRANGEMENT_CLIP_TICKS);
  });

  it("the shared home refuses a non-finite length, in the lane's words", () => {
    expect(() => clampResizeLength(0, Number.NaN, "MIDI")).toThrow("MIDI clip length must be finite ticks");
    expect(() => clampTickSpan(0, Number.POSITIVE_INFINITY, "Automation")).toThrow(
      "Automation clip position and length must be finite ticks",
    );
  });
});

describe("the guard: the command layer has ONE home for the clamp", () => {
  it("the detector is proven able to fail", () => {
    expect(
      inlineClampSites("const x = Math.min(MAX_ARRANGEMENT_CLIP_TICKS, 10);"),
      "an inline clamp must be found",
    ).toEqual([1]);
    expect(
      inlineClampSites("const x = Math.max(0, MAX_ARRANGEMENT_CLIP_BARS);"),
      "and one with the ceiling as the direct argument",
    ).toEqual([1]);
    expect(
      inlineClampSites("// Math.min(MAX_ARRANGEMENT_CLIP_TICKS, 10) is only a comment"),
      "a comment must not count",
    ).toEqual([]);
    expect(
      inlineClampSites("import { MAX_ARRANGEMENT_CLIP_TICKS } from './schema';"),
      "an unused import must not count",
    ).toEqual([]);
    expect(
      inlineClampSites("const past = clip.end + delta > MAX_ARRANGEMENT_CLIP_TICKS;"),
      "a COMPARISON is a refusal, not a clamp",
    ).toEqual([]);
    expect(
      inlineClampSites("const room = MAX_ARRANGEMENT_CLIP_TICKS - start;"),
      "a derived BOUND is not a clamp",
    ).toEqual([]);
    expect(
      inlineClampSites("const room = Math.max(1, MAX_ARRANGEMENT_CLIP_TICKS - start);"),
      "and a bound inside a clamp is still a bound",
    ).toEqual([]);
  });

  it("the import detector is proven able to fail", () => {
    expect(importsSharedHome(`import { clampValue } from "./geometry";`), "a real import must be found").toBe(true);
    expect(importsSharedHome(`import { clampValue } from "./other";`), "another module must not count").toBe(false);
    expect(importsSharedHome(`// import { clampValue } from "./geometry";`), "a comment must not count").toBe(false);
  });

  it("no command module clamps a clip's geometry inline", () => {
    const dir = join(process.cwd(), "src", "commands");
    const offenders: string[] = [];
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
      if (name === "geometry.ts") continue;
      const path = `src/commands/${name}`;
      if (CLIP_GEOMETRY_EXEMPT.has(path)) continue;
      const source = readFileSync(join(dir, name), "utf8");
      const sites = inlineClampSites(source);
      if (sites.length > 0) offenders.push(`${path} (lines ${sites.join(", ")})`);
    }
    expect(
      offenders,
      "a clip's geometry is clamped in ONE place — src/commands/geometry.ts. An inline clamp is a second rule, and a second rule is how a resize teleported a clip to tick 0.",
    ).toEqual([]);
  });

  it("a module that touches a clip ceiling routes through the shared home", () => {
    const dir = join(process.cwd(), "src", "commands");
    const offenders: string[] = [];
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
      if (name === "geometry.ts") continue;
      const path = `src/commands/${name}`;
      if (CLIP_GEOMETRY_EXEMPT.has(path)) continue;
      const source = readFileSync(join(dir, name), "utf8");
      if (!mentionsCeiling(ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))) {
        continue;
      }
      if (!importsSharedHome(source)) {
        offenders.push(`${path} — it names a clip ceiling but does not import ./geometry`);
      }
    }
    expect(
      offenders,
      "a module that uses the clip ceiling goes through src/commands/geometry.ts — or it is named in the exemption list, with a reason",
    ).toEqual([]);
  });

  it.each(CLIP_GEOMETRY_LANES)("%s clamps through the shared home", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(
      calledGeometryHelpers(source),
      `${file} owns clip geometry, so it must CALL the shared home — not re-derive the ceiling`,
    ).not.toEqual([]);
  });
});
