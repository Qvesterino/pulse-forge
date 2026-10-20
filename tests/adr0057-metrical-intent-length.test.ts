/**
 * ADR 0057 Stage 2 — THE INTENT ENGINE speaks the document's BARS.
 *
 * The grid became metrical (ADR 0057 Stage 1/1b): the pattern editor draws
 * the document's bar. But the GENERATION path still asked "how many steps?"
 * with a hard-coded sixteen-steps-per-bar, so in a 3/4 document the engine
 * answered a request for one bar with a sixteen-step pattern — 1.33 bars,
 * drifting against the very ruler drawn above it. The default intent length
 * was sixteen steps too, so EVERY generation outside 4/4 was off the grid.
 *
 * The fix changes what the request MEANS, never what is stored: the intent
 * asks in BARS (meter-independent) and the document's meter turns bars into
 * steps. A step-framed request ("32 steps") stays a step count.
 *
 * The two properties this file locks down:
 *
 *   1. 4/4 is byte-identical to before — same length, same spec shape, same
 *      intent hash, same generated beat. The overwhelming majority of the
 *      product must not feel a thing.
 *   2. Every other meter is RIGHT — a bar is the document's bar, and a
 *      generated pattern is a whole number of those bars.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { stepsPerBar } from "../src/project-model/grid";
import { normalizeIntent } from "../src/intent/normalize";
import { parseIntentText } from "../src/intent/text-parser";
import { planGeneration } from "../src/intent/plan";
import { compileBriefContract } from "../src/intent/brief-contract";
import { createProjectBriefFromContract, projectBriefIntentPatch } from "../src/intent/project-brief";
import { intentHash } from "../src/intent/hash";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
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

describe("ADR 0057 — the intent engine asks in the document's bars", () => {
  it("the DEFAULT length is one bar of the document's meter", () => {
    expect(normalizeIntent({}, docWithMeter(FOUR_FOUR)).length).toBe(16);
    expect(normalizeIntent({}, docWithMeter(THREE_FOUR)).length).toBe(12);
    expect(normalizeIntent({}, docWithMeter(SIX_EIGHT)).length).toBe(12);
    expect(normalizeIntent({}, docWithMeter(FOUR_TWO)).length).toBe(32);
  });

  it("a bar-framed request is resolved by the meter", () => {
    const parsed = parseIntentText("8 bars of techno");
    expect(parsed.input.bars).toBe(8);
    expect(normalizeIntent(parsed.input, docWithMeter(FOUR_FOUR)).length).toBe(128);
    expect(normalizeIntent(parsed.input, docWithMeter(THREE_FOUR)).length).toBe(96);
    expect(normalizeIntent(parsed.input, docWithMeter(SIX_EIGHT)).length).toBe(96);
    expect(normalizeIntent(parsed.input, docWithMeter(FOUR_TWO)).length).toBe(256);
  });

  it("a step-framed request is rounded to a WHOLE number of the meter's bars", () => {
    // 20 steps is 1.25 bars in 4/4 and 1.67 in 3/4 — both are rounded to the
    // bar the document actually has.
    expect(normalizeIntent({ length: 20 }, docWithMeter(FOUR_FOUR)).length).toBe(16);
    expect(normalizeIntent({ length: 20 }, docWithMeter(THREE_FOUR)).length).toBe(24);
    expect(normalizeIntent({ length: 12 }, docWithMeter(THREE_FOUR)).length).toBe(12);
  });

  it("NEGATIVE CONTROL: in 4/4 the spec is byte-identical to the old one", () => {
    const doc = docWithMeter(FOUR_FOUR);
    const barFramed = normalizeIntent({ bars: 8 }, doc);
    const legacyStepFramed = normalizeIntent({ length: 128 }, doc);
    // Same length, same spec SHAPE (the bar count is not carried where the
    // steps already say it), and therefore the same hash — the same beat.
    expect(barFramed.length).toBe(128);
    expect(barFramed.bars).toBeUndefined();
    expect(Object.keys(barFramed).sort()).toEqual(Object.keys(legacyStepFramed).sort());
    expect(intentHash(barFramed)).toBe(intentHash(legacyStepFramed));
  });

  it("the plan generates a WHOLE number of the document's bars", () => {
    for (const sig of [FOUR_FOUR, THREE_FOUR, SIX_EIGHT, FOUR_TWO]) {
      const doc = docWithMeter(sig);
      const plan = planGeneration(normalizeIntent({}, doc), doc);
      const perBar = stepsPerBar(doc);
      expect(plan.options.stepCount).toBe(perBar);
      expect(plan.outputShape.stepCount).toBe(perBar);
      expect(plan.outputShape.stepCount % perBar).toBe(0);
    }
  });

  it("a generated length in 3/4 is one bar of 3/4, not sixteen steps", () => {
    const doc = docWithMeter(THREE_FOUR);
    const plan = planGeneration(normalizeIntent(parseIntentText("4 bars").input, doc), doc);
    expect(plan.outputShape.stepCount).toBe(48);
    expect(plan.outputShape.stepCount % stepsPerBar(doc)).toBe(0);
  });

  it("the brief contract states the length in the document's bars", () => {
    const doc = docWithMeter(THREE_FOUR);
    const contract = compileBriefContract(parseIntentText("4 bars of techno"), { project: doc });
    const length = contract.statements.find((statement) => statement.id === "length");
    expect(length?.label).toBe("4 takty");
    // A step-framed request in 3/4 is read in 3/4's bars, not 4/4's.
    const stepContract = compileBriefContract(parseIntentText("dark techno"), { project: doc });
    expect(stepContract.statements.find((statement) => statement.id === "length")?.label).toContain("takt");
  });

  it("the project brief saves the BAR count and replays it in another meter", () => {
    const contract = compileBriefContract(parseIntentText("8 bars of techno"), { project: docWithMeter(FOUR_FOUR) });
    const brief = createProjectBriefFromContract(
      contract,
      parseIntentText("8 bars of techno").input,
      "2026-10-20T00:00:00.000Z",
    );
    expect(brief).not.toBeNull();
    expect(brief?.facts.find((fact) => fact.field === "bars")?.value).toBe(8);
    // The saved fact is meter-independent: it replays as eight bars wherever
    // it lands — sixteen steps in 4/4, twelve in 3/4.
    const patch = projectBriefIntentPatch(brief!);
    expect(patch.input.bars).toBe(8);
    expect(normalizeIntent(patch.input, docWithMeter(THREE_FOUR)).length).toBe(96);
  });
});

// ── the MCP surface speaks the document's bars too ──

/** A minimal, honest MCP context over one document. */
function mcpCtx(doc: ProjectDocument): { ctx: McpToolContext; doc: () => ProjectDocument } {
  let current = doc;
  const labels: string[] = [];
  const ctx: McpToolContext = {
    getDoc: () => current,
    execute: (command) => {
      current = command.execute(current);
      labels.push(command.label);
    },
    undo: () => {},
    redo: () => {},
    undoStackLength: () => 0,
    historyLabels: () => labels,
    isMicRecordingActive: () => false,
    transport: {
      play: () => {},
      stop: () => {},
      pause: () => {},
      setLoop: () => {},
      setMetronome: () => {},
    },
  };
  return { ctx, doc: () => current };
}

describe("ADR 0057 — the MCP surface speaks the document's bars", () => {
  it("kyx_generate accepts a bar count in 3/4 (the old rule rejected EVERY one)", async () => {
    const { ctx, doc } = mcpCtx(docWithMeter(THREE_FOUR));
    const result = await executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "3-4", bars: 2 });
    expect(result.errorCode).toBeUndefined();
    expect(result.mutated).toBe(true);
    const pattern = doc().patterns.find((candidate) => candidate.id === doc().activePatternId);
    expect(pattern?.stepCount).toBe(24); // two bars of 3/4
  });

  it("kyx_generate names the meter's real limit instead of an empty list", async () => {
    const { ctx } = mcpCtx(docWithMeter(THREE_FOUR));
    const tooLong = await executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "3-4-long", bars: 99 });
    expect(tooLong.errorCode).toBe("INVALID_ARGUMENTS");
    expect(tooLong.text).toContain("3/4");
    expect(tooLong.text).toContain("one bar is 12 steps");
  });

  it("kyx_music.setPatternLength takes BARS and reads back both units", async () => {
    const { ctx, doc } = mcpCtx(docWithMeter(THREE_FOUR));
    const result = await executeMcpTool(ctx, "kyx_music", { op: "setPatternLength", bars: 2 });
    expect(result.errorCode).toBeUndefined();
    const pattern = doc().patterns.find((candidate) => candidate.id === doc().activePatternId);
    expect(pattern?.stepCount).toBe(24);
    expect(result.data).toMatchObject({ steps: 24, bars: 2 });
    expect(result.text).toContain("24 steps (2 bars)");
  });

  it("kyx_music.setPatternLength still takes an exact step count", async () => {
    const { ctx, doc } = mcpCtx(docWithMeter(THREE_FOUR));
    const result = await executeMcpTool(ctx, "kyx_music", { op: "setPatternLength", steps: 12 });
    expect(result.errorCode).toBeUndefined();
    const pattern = doc().patterns.find((candidate) => candidate.id === doc().activePatternId);
    expect(pattern?.stepCount).toBe(12);
    expect(result.data).toMatchObject({ steps: 12, bars: 1 });
  });

  it("kyx_music.setPatternLength refuses bars AND steps at once", async () => {
    const { ctx } = mcpCtx(docWithMeter(FOUR_FOUR));
    const result = await executeMcpTool(ctx, "kyx_music", { op: "setPatternLength", bars: 2, steps: 32 });
    expect(result.errorCode).toBe("INVALID_ARGUMENTS");
  });
});

// ── the guard: the intent layer may not re-derive the bar ──

const SRC_ROOT = resolve(process.cwd(), "src");
const GUARDED_ROOTS = ["src/intent/", "src/ui/", "src/mcp/"];

/**
 * Sites that still state a 4/4 length. Each entry is a DECLARATION — it
 * states WHY the number is still 4/4 — and the ledger may only shrink.
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

/** A name that counts BARS (`bars`, `loopBars`, `span.bars`). */
function isBarCount(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === "bars" || /bars$/i.test(node.text);
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "bars" || /bars$/i.test(node.name.text);
  return false;
}

function isStepTickConstant(node: ts.Node): boolean {
  return ts.isIdentifier(node) && node.text === "STEP_TICKS";
}

function isSixteen(node: ts.Node): boolean {
  return ts.isNumericLiteral(node) && node.text === "16";
}

/**
 * The intent layer may not re-derive the bar by hand:
 *
 *   A. a COUNT of bars multiplied by sixteen steps (`bars * 16`) — the step
 *      count of a bar depends on the meter, so sixteen is only true in 4/4;
 *   B. a bar measured in ticks as `16 * STEP_TICKS` — same assumption, in
 *      ticks.
 */
export function findIntentLengthViolations(files: { file: string; source: string }[]): Violation[] {
  const violations: Violation[] = [];
  for (const { file, source } of files) {
    if (!GUARDED_ROOTS.some((root) => file.startsWith(root))) continue;
    if (LEDGER_4_4_SITES[file]) continue;
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
        const { left, right } = node;
        const line = tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if ((isBarCount(left) && isSixteen(right)) || (isSixteen(left) && isBarCount(right))) {
          violations.push({ file, line, detail: "multiplies a bar count by sixteen steps" });
        }
        if ((isSixteen(left) && isStepTickConstant(right)) || (isStepTickConstant(left) && isSixteen(right))) {
          violations.push({ file, line, detail: "measures a bar as sixteen ticks" });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return violations;
}

describe("ADR 0057 — the intent layer may not re-derive the bar", () => {
  it("no intent, UI or MCP module multiplies bars by sixteen steps", () => {
    const files = walkSourceFiles(SRC_ROOT).map((absolute) => ({
      file: relative(process.cwd(), absolute).replace(/\\/g, "/"),
      source: readFileSync(absolute, "utf8"),
    }));
    const violations = findIntentLengthViolations(files);
    expect(violations).toEqual([]);
  });

  it("the guard can FAIL — a synthetic violation is caught", () => {
    const synthetic = [
      {
        file: "src/intent/rogue.ts",
        source: "export const steps = span.bars * 16;\nexport const ticks = 16 * STEP_TICKS;\n",
      },
    ];
    const violations = findIntentLengthViolations(synthetic);
    expect(violations.length).toBe(2);
    expect(violations[0]?.detail).toContain("sixteen steps");
  });
});
