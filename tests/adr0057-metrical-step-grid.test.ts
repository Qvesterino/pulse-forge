/**
 * ADR 0057 — the step grid follows the document's METER.
 *
 * ADR 0056 Stage 2 put the ARRANGEMENT on the document's meter and left the
 * PATTERN grid behind: a pattern is 16 sixteenth steps whatever the meter
 * declares, so in 6/8 one pattern is 1.33 bars long and its downbeat reaches
 * the bar line only every fourth bar. ADR 0056 named the fix — "a metrical
 * step grid and its own ADR" — and this is that ADR's first stage.
 *
 * THE DECISION, and the hinge it turns on: a pattern's `stepCount` stays an
 * ABSOLUTE count of sixteenth notes (a musical duration). It does NOT become a
 * metrical quantity, so no stored pattern is resized and no schema version is
 * bumped. What changes is what ONE BAR MEANS: the meter says how many of those
 * sixteenth steps make a bar — `ticksPerBar(doc) / STEP_TICKS` — and the grid,
 * the ruler and the labels all follow it.
 *
 *   | meter | bar (ticks) | steps/bar | steps/beat | beats/bar |
 *   | ----- | ----------- | --------- | ---------- | --------- |
 *   | 4/4   | 1920        | 16        | 4          | 4         |
 *   | 2/2   | 1920        | 16        | 8          | 2         |
 *   | 3/4   | 1440        | 12        | 4          | 3         |
 *   | 6/8   | 1440        | 12        | 2          | 6         |
 *   | 4/2   | 3840        | 32        | 8          | 4         |
 *   | 5/4   | 2400        | 20        | 4          | 5         |
 *   | 7/8   | 1680        | 14        | 2          | 7         |
 *   | 12/8  | 2880        | 24        | 2          | 12        |
 *
 * 4/4 is unchanged BY CONSTRUCTION — 16 steps, 4 per beat, a 1920-tick bar —
 * so the overwhelming majority of projects cannot tell the difference, and
 * the change cannot regress them.
 *
 * The grid's BEAT is the denominator's unit (a quarter in x/4, an eighth in
 * x/8), which is the same unit the metronome clicks (ADR 0056 Stage 2) and
 * the same unit `ticksPerBeatFor` measures. The ruler therefore counts the
 * beats the user actually hears, and the count RESETS at every metrical bar —
 * which is how the bar line shows itself without a single new pixel.
 *
 * The guard at the bottom pins that there is ONE owner of the steps-per-bar
 * formula, and that the visible surface no longer converts a step count to a
 * bar count by hand. It is proven able to fail: the last spec feeds it
 * synthetic violations and asserts it reports them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject, ticksPerBarFor } from "../src/project-model/schema";
import {
  barsPerPattern,
  beatNumberAtStep,
  isWholeBarPattern,
  patternLengthOptions,
  stepsPerBar,
  stepsPerBarFor,
  stepsPerBeat,
  stepsPerBeatFor,
} from "../src/project-model/grid";
import { patternPhaseOffsetAtTick } from "../src/project-model/events";
import { createPattern } from "../src/commands/patterns";
import { applyExactIntentCommand, exactReadback } from "../src/commands/intentRouting";
import { parseExactIntent } from "../src/intent/exact";
import type { ProjectDocument, TimeSignature } from "../src/project-model/types";

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const THREE_FOUR: TimeSignature = { numerator: 3, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };
const FOUR_TWO: TimeSignature = { numerator: 4, denominator: 2 };

function docWithMeter(sig: TimeSignature): ProjectDocument {
  return normalizeProject({
    ...createProjectFromTemplate("house"),
    timeSignature: sig,
    bpm: 120,
    arrangement: { clips: [] },
  });
}

describe("ADR 0057 — the grid's bar is the metrical bar", () => {
  it("the truth table: steps per bar, steps per beat, beats per bar", () => {
    const table: { sig: TimeSignature; stepsPerBar: number; stepsPerBeat: number; beats: number }[] = [
      { sig: FOUR_FOUR, stepsPerBar: 16, stepsPerBeat: 4, beats: 4 },
      { sig: { numerator: 2, denominator: 2 }, stepsPerBar: 16, stepsPerBeat: 8, beats: 2 },
      { sig: THREE_FOUR, stepsPerBar: 12, stepsPerBeat: 4, beats: 3 },
      { sig: SIX_EIGHT, stepsPerBar: 12, stepsPerBeat: 2, beats: 6 },
      { sig: FOUR_TWO, stepsPerBar: 32, stepsPerBeat: 8, beats: 4 },
      { sig: { numerator: 5, denominator: 4 }, stepsPerBar: 20, stepsPerBeat: 4, beats: 5 },
      { sig: { numerator: 7, denominator: 8 }, stepsPerBar: 14, stepsPerBeat: 2, beats: 7 },
      { sig: { numerator: 12, denominator: 8 }, stepsPerBar: 24, stepsPerBeat: 2, beats: 12 },
      { sig: { numerator: 2, denominator: 4 }, stepsPerBar: 8, stepsPerBeat: 4, beats: 2 },
    ];
    for (const row of table) {
      const name = `${row.sig.numerator}/${row.sig.denominator}`;
      expect(stepsPerBarFor(row.sig), `${name} steps per bar`).toBe(row.stepsPerBar);
      expect(stepsPerBeatFor(row.sig), `${name} steps per beat`).toBe(row.stepsPerBeat);
      expect(row.stepsPerBar / row.stepsPerBeat, `${name} beats per bar`).toBe(row.beats);
      // The grid's bar and the metrical bar are the same length by construction.
      expect(stepsPerBarFor(row.sig) * 120, `${name} bar ticks`).toBe(ticksPerBarFor(row.sig));
    }
  });

  it("NEGATIVE CONTROL: 4/4 is byte-identical to the old 16-step grid", () => {
    const doc = docWithMeter(FOUR_FOUR);
    expect(stepsPerBar(doc)).toBe(16);
    expect(stepsPerBeat(doc)).toBe(4);
    expect(ticksPerBarFor(FOUR_FOUR)).toBe(1920);
    // The ruler's beat numbers are exactly the old ones: 1,2,3,4 per bar.
    expect(Array.from({ length: 16 }, (_, i) => beatNumberAtStep(doc, i))).toEqual([
      1,
      null,
      null,
      null,
      2,
      null,
      null,
      null,
      3,
      null,
      null,
      null,
      4,
      null,
      null,
      null,
    ]);
    // And the length control offers the old numbers.
    expect(patternLengthOptions(doc).map((option) => option.steps)).toEqual([16, 32, 64, 128]);
  });

  it("the beat count RESETS at every metrical bar (3/4 has three beats, not four)", () => {
    const doc = docWithMeter(THREE_FOUR);
    expect(beatNumberAtStep(doc, 0)).toBe(1);
    expect(beatNumberAtStep(doc, 4)).toBe(2);
    expect(beatNumberAtStep(doc, 8)).toBe(3);
    expect(beatNumberAtStep(doc, 3)).toBeNull();
    // The second bar starts again at beat 1 — that reset IS the bar line.
    expect(beatNumberAtStep(doc, 12)).toBe(1);
    expect(beatNumberAtStep(doc, 16)).toBe(2);
    expect(beatNumberAtStep(doc, 20)).toBe(3);
  });

  it("6/8 marks the eighth-note pulse the metronome actually clicks", () => {
    const doc = docWithMeter(SIX_EIGHT);
    expect(stepsPerBeat(doc)).toBe(2);
    expect(Array.from({ length: 12 }, (_, i) => beatNumberAtStep(doc, i))).toEqual([
      1,
      null,
      2,
      null,
      3,
      null,
      4,
      null,
      5,
      null,
      6,
      null,
    ]);
  });

  it("a WHOLE-BAR pattern never drifts against the ruler, in any meter", () => {
    for (const sig of [THREE_FOUR, SIX_EIGHT, FOUR_TWO, { numerator: 7, denominator: 8 }]) {
      const doc = docWithMeter(sig);
      const bar = ticksPerBarFor(sig);
      const perBar = stepsPerBarFor(sig);
      // A pattern of exactly one bar: the downbeat lands on EVERY bar line.
      const pattern = { ...doc.patterns[0]!, stepCount: perBar };
      const clip = { startBar: 0, phaseOffsetTicks: 0 };
      const phases = Array.from({ length: 8 }, (_, b) => patternPhaseOffsetAtTick(clip, pattern, b * bar, bar));
      expect(phases, `${sig.numerator}/${sig.denominator} whole-bar pattern`).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    }
  });

  it("a pattern that is NOT a whole number of bars is told so, not silently rounded", () => {
    const doc = docWithMeter(SIX_EIGHT);
    expect(isWholeBarPattern(doc, 12)).toBe(true);
    expect(isWholeBarPattern(doc, 16)).toBe(false);
    expect(barsPerPattern(doc, 16)).toBeCloseTo(16 / 12, 6);
    expect(barsPerPattern(doc, 12)).toBeCloseTo(1, 6);
  });

  it("the length control offers whole bars in the document's meter", () => {
    expect(patternLengthOptions(docWithMeter(FOUR_FOUR)).map((o) => o.steps)).toEqual([16, 32, 64, 128]);
    expect(patternLengthOptions(docWithMeter(THREE_FOUR)).map((o) => o.steps)).toEqual([12, 24, 48, 96]);
    expect(patternLengthOptions(docWithMeter(SIX_EIGHT)).map((o) => o.steps)).toEqual([12, 24, 48, 96]);
    expect(patternLengthOptions(docWithMeter(FOUR_TWO)).map((o) => o.steps)).toEqual([32, 64, 128, 256]);
  });
});

describe("ADR 0057 — the intent engine speaks the document's BARS", () => {
  it("'4 bars longer' adds four METRICAL bars, not four 4/4 bars", () => {
    const doc = docWithMeter(THREE_FOUR);
    const plan = parseExactIntent("4 bars longer")!;
    const next = applyExactIntentCommand(doc, plan).execute(doc);
    const steps = next.patterns.find((p) => p.id === next.activePatternId)!.stepCount;
    // The house pattern is 16 steps; a 3/4 bar is 12, so four bars are 48.
    expect(steps).toBe(16 + 4 * 12);
  });

  it("NEGATIVE CONTROL: in 4/4 the same sentence adds four bars of 16 (unchanged)", () => {
    const doc = docWithMeter(FOUR_FOUR);
    const plan = parseExactIntent("4 bars longer")!;
    const next = applyExactIntentCommand(doc, plan).execute(doc);
    const steps = next.patterns.find((p) => p.id === next.activePatternId)!.stepCount;
    expect(steps).toBe(16 + 4 * 16);
  });

  it("'make the loop 4 bars' is an ABSOLUTE length in the document's bars", () => {
    for (const [sig, expected] of [
      [FOUR_FOUR, 64],
      [THREE_FOUR, 48],
      [SIX_EIGHT, 48],
      [FOUR_TWO, 128],
    ] as [TimeSignature, number][]) {
      const doc = docWithMeter(sig);
      const plan = parseExactIntent("make the loop 4 bars")!;
      expect(plan.ops, `${sig.numerator}/${sig.denominator} parse`).toContainEqual({
        kind: "patternLengthBars",
        bars: 4,
      });
      const next = applyExactIntentCommand(doc, plan).execute(doc);
      const steps = next.patterns.find((p) => p.id === next.activePatternId)!.stepCount;
      expect(steps, `${sig.numerator}/${sig.denominator} length`).toBe(expected);
    }
  });

  it("the relative and the absolute reading never fire together", () => {
    // "4 bars longer" is the RELATIVE op. A parser that also claimed it as an
    // absolute length would set the pattern twice, and the second one would
    // silently win.
    expect(parseExactIntent("4 bars longer")!.ops).toEqual([{ kind: "patternLengthDelta", bars: 4 }]);
    expect(parseExactIntent("4 bars long")!.ops).toEqual([{ kind: "patternLengthBars", bars: 4 }]);
  });

  it("a step count is still a step count: '32 steps loop length' means 32 steps", () => {
    expect(parseExactIntent("32 steps loop length")!.ops).toEqual([{ kind: "patternLength", steps: 32 }]);
  });

  it("the read-back speaks bars, because '48 steps' alone does not say whether the groove lands", () => {
    const doc = docWithMeter(THREE_FOUR);
    const plan = parseExactIntent("make the loop 4 bars")!;
    const after = applyExactIntentCommand(doc, plan).execute(doc);
    const readback = exactReadback(doc, after, plan);
    expect(readback).toContain("48 steps");
    expect(readback).toContain("4 bars");
  });
});

describe("ADR 0057 — a NEW pattern is one metrical bar", () => {
  it("NEGATIVE CONTROL: in 4/4 a new pattern is 16 steps, as it always was", () => {
    const doc = docWithMeter(FOUR_FOUR);
    const next = createPattern(doc, "New Pattern").execute(doc);
    const created = next.patterns[next.patterns.length - 1]!;
    expect(created.stepCount).toBe(16);
  });

  it("in 3/4 and 6/8 a new pattern is 12 steps, in 4/2 it is 32", () => {
    for (const [sig, expected] of [
      [THREE_FOUR, 12],
      [SIX_EIGHT, 12],
      [FOUR_TWO, 32],
    ] as [TimeSignature, number][]) {
      const doc = docWithMeter(sig);
      const next = createPattern(doc, "New Pattern").execute(doc);
      const created = next.patterns[next.patterns.length - 1]!;
      expect(created.stepCount, `${sig.numerator}/${sig.denominator} new pattern`).toBe(expected);
      // And it is a WHOLE number of bars, so it does not drift.
      expect(isWholeBarPattern(doc, created.stepCount)).toBe(true);
    }
  });
});

// ── the guard: one owner of the formula, no hand-rolled conversions in the UI ──

const SRC_ROOT = resolve(process.cwd(), "src");

/**
 * The steps-per-bar formula may live in exactly one module. Every other site
 * imports `stepsPerBar` / `stepsPerBeat` from it.
 */
const ALLOWED_FORMULA_FILES = new Set(["src/project-model/grid.ts"]);

/**
 * The VISIBLE surface may not convert a step count to a bar count by hand.
 * Each entry is a DECLARATION — it states why the number is still 4/4 — and
 * the ledger may only shrink (ADR 0057 Stage 2 owns the rest).
 */
const LEDGER_4_4_SITES: Record<string, string> = {
  "src/ui/AssistPanel.tsx":
    "the assist preview draws a fixed 16-cell 4/4 preview — the generator's output shape (ADR 0057 Stage 2)",
  "src/ui/GenerateDialog.tsx":
    "the generate preview draws a fixed 16-cell 4/4 preview — the generator's output shape (ADR 0057 Stage 2)",
  "src/ui/DiceTray.tsx":
    "the dice preview draws a fixed 16-cell 4/4 preview — the generator's output shape (ADR 0057 Stage 2)",
  "src/ui/ModPanel.tsx":
    "the automation lane draws a beat grid every 4 steps — Stage 2 moves it onto the metrical beat",
  "src/ui/BriefContractSummary.tsx":
    "the brief's length readout is stated in 4/4 bars — the brief contract's own unit (ADR 0057 Stage 2)",
  "src/ui/HumToMelody.tsx":
    "the pitch contour draws its bar lines at the pattern-grid bar — Stage 2 moves them onto the metrical bar",
};

interface Violation {
  file: string;
  line: number;
  detail: string;
}

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function isStepsPerBarCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
  return name === "ticksPerBar" || name === "ticksPerBarFor" || name === "ticksPerBeat" || name === "ticksPerBeatFor";
}

function isStepCountRef(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "stepCount";
  if (ts.isIdentifier(node)) return node.text === "stepCount" || node.text === "editorStepCount";
  return false;
}

/** The literal 16 or a named 4/4-bar constant, used as the OTHER side of a conversion. */
function isFourFourBarConstant(node: ts.Node): boolean {
  if (ts.isNumericLiteral(node)) return node.text === "16";
  if (ts.isIdentifier(node))
    return node.text === "STEPS_PER_PATTERN" || node.text === "PATTERN_TICKS" || node.text === "BAR_TICKS";
  return false;
}

/**
 * Two rules, both on the AST (never on the raw text — see the Stage-2 guard
 * for why a hand-rolled comment/string stripper cannot be done correctly).
 *
 *  A. The steps-per-bar FORMULA (`ticksPerBar(...) / STEP_TICKS`) may only be
 *     written in `src/project-model/grid.ts`.
 *  B. A user-facing UI or MCP file may not convert a step count to a bar count by hand.
 */
export function findGridViolations(files: { file: string; source: string }[]): Violation[] {
  const violations: Violation[] = [];
  for (const { file, source } of files) {
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.SlashToken) {
        const right = node.right;
        if (ts.isIdentifier(right) && right.text === "STEP_TICKS" && isStepsPerBarCall(node.left)) {
          if (!ALLOWED_FORMULA_FILES.has(file)) {
            violations.push({
              file,
              line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              detail: "computes steps per bar for itself",
            });
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.SlashToken &&
        (file.startsWith("src/ui/") || file.startsWith("src/mcp/"))
      ) {
        const left = node.left;
        const right = node.right;
        const pairs =
          (isStepCountRef(left) && isFourFourBarConstant(right)) ||
          (isStepCountRef(right) && isFourFourBarConstant(left));
        if (pairs && !LEDGER_4_4_SITES[file]) {
          violations.push({
            file,
            line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            detail: "converts a step count to bars by hand",
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return violations;
}

describe("ADR 0057 — the grid truth has one owner", () => {
  it("no module computes the steps-per-bar formula for itself", () => {
    const files = walkSourceFiles(SRC_ROOT).map((absolute) => ({
      file: relative(process.cwd(), absolute).replace(/\\/g, "/"),
      source: readFileSync(absolute, "utf8"),
    }));
    const violations = findGridViolations(files).filter((v) => v.detail === "computes steps per bar for itself");
    expect(
      violations.map((v) => `${v.file}:${v.line} — ${v.detail}`),
      "the steps-per-bar formula must live in src/project-model/grid.ts only",
    ).toEqual([]);
  });

  it("visible UI and MCP surfaces do not convert a step count to a bar count by hand", () => {
    const files = walkSourceFiles(SRC_ROOT)
      .map((absolute) => ({
        file: relative(process.cwd(), absolute).replace(/\\/g, "/"),
        source: readFileSync(absolute, "utf8"),
      }))
      .filter((entry) => entry.file.startsWith("src/ui/") || entry.file.startsWith("src/mcp/"));
    const violations = findGridViolations(files).filter((v) => v.detail === "converts a step count to bars by hand");
    expect(
      violations.map((v) => `${v.file}:${v.line} — ${v.detail}`),
      "a UI or MCP site converts a step count to bars by hand; use barsPerPattern(doc, …) or stepsPerBar(doc)",
    ).toEqual([]);
  });
});

describe("ADR 0057 — the guard, proven able to fail", () => {
  it("reports a module that computes the steps-per-bar formula for itself", () => {
    const violations = findGridViolations([
      { file: "src/ui/Whatever.tsx", source: "const n = ticksPerBar(doc) / STEP_TICKS;" },
    ]);
    expect(violations.map((v) => v.detail)).toEqual(["computes steps per bar for itself"]);
  });

  it("reports a UI or MCP site that converts a step count to bars by hand", () => {
    const violations = findGridViolations([
      { file: "src/ui/Whatever.tsx", source: "const bars = pattern.stepCount / 16;" },
      { file: "src/ui/Another.tsx", source: "const bars = Math.ceil(editorStepCount / 16);" },
      { file: "src/mcp/tools.ts", source: "const bars = pattern.stepCount / 16;" },
    ]);
    expect(violations.map((v) => v.file)).toEqual(["src/ui/Whatever.tsx", "src/ui/Another.tsx", "src/mcp/tools.ts"]);
  });

  it("does NOT report the same code in the owner module or in a ledgered site", () => {
    const violations = findGridViolations([
      { file: "src/project-model/grid.ts", source: "const n = ticksPerBar(doc) / STEP_TICKS;" },
      { file: "src/ui/DiceTray.tsx", source: "const bars = pattern.stepCount / 16;" },
    ]);
    expect(violations).toEqual([]);
  });

  it("does NOT flag an unrelated division", () => {
    const violations = findGridViolations([
      { file: "src/ui/Whatever.tsx", source: "const n = Math.floor(tick / STEP_TICKS);" },
    ]);
    expect(violations).toEqual([]);
  });
});
