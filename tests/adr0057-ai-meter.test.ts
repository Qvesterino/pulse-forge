/**
 * ADR 0057 Stage 2b — THE AI LAYER speaks the document's METRE.
 *
 * The grid became metrical (ADR 0057 Stage 1/1b) and the intent engine began
 * to ask in the document's BARS (Stage 2a). The GENERATOR was still the last
 * layer that believed one bar is sixteen sixteenth-note steps: `bars =
 * Math.ceil(stepCount / 16)`, the phrase cut at `bar * 16`, the kick on
 * `step % 4 === 0`, the snare on `step % 8 === 4`, the groove reference folded
 * at `step % 16`, the melodic density per sixteen steps.
 *
 * Measured consequence (before this stage, 3/4 document, house): the pattern
 * carried the groove's first twelve steps — the 4/4 bar cut in half — so the
 * beat-4 backbeat was simply gone, the phrase cut at step 16 (a third of a bar
 * past the bar line) and the fill landed off the beat. In 6/8 the same
 * pattern claimed a shuffle it did not have.
 *
 * The two properties this file locks down:
 *
 *   1. 4/4 is byte-identical — same content hash, same anchors, same recipe.
 *      The overwhelming majority of the product must not feel a thing.
 *   2. Every other metre is RIGHT — a bar is the document's bar, the pulse is
 *      the document's pulse, and the anchors sit where that metre puts them.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { normalizeIntent } from "../src/intent/normalize";
import { generateLocalResult } from "../src/intent/pipeline";
import { canonicalizePattern, contentHash } from "../src/ai/evaluation";
import { aiMeterFor, isBackbeatAnchor, isKickAnchor, meterCarrier, referencePhase } from "../src/ai/meter";
import { buildPhrasePlan } from "../src/ai/phrase";
import { applyVerbRows } from "../src/intent/pattern-verbs";
import { planGeneration } from "../src/intent/plan";
import type { DrumPad, Pattern, ProjectDocument, TimeSignature } from "../src/project-model/types";

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const THREE_FOUR: TimeSignature = { numerator: 3, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };
const FIVE_FOUR: TimeSignature = { numerator: 5, denominator: 4 };
const SEVEN_EIGHT: TimeSignature = { numerator: 7, denominator: 8 };

function docWithMeter(sig: TimeSignature): ProjectDocument {
  return normalizeProject({
    ...createProjectFromTemplate("house"),
    timeSignature: sig,
    bpm: 120,
    arrangement: { clips: [] },
  });
}

/** Generate one pattern and report its drum rows as hit positions. */
function generateRows(sig: TimeSignature, genre: string, seed: string): { rows: string[]; hash: string } {
  const doc = docWithMeter(sig);
  const intent = normalizeIntent({ genre, seed }, doc);
  const result = generateLocalResult(doc, intent, "preview");
  const pattern = result.proposal?.pattern;
  if (!pattern) throw new Error(`no proposal for ${genre}/${seed}`);
  const rows = Object.values(pattern.rows ?? {}).map((row) =>
    row
      .map((value, step) => (value > 0 ? step : -1))
      .filter((step) => step >= 0)
      .join(","),
  );
  return { rows, hash: contentHash(canonicalizePattern(doc, pattern)) };
}

describe("ADR 0057 Stage 2b — the AI layer's metrical facts", () => {
  it("reads the bar and the pulse from the metre", () => {
    const fourFour = aiMeterFor(FOUR_FOUR);
    expect(fourFour.stepsPerBar).toBe(16);
    expect(fourFour.stepsPerBeat).toBe(4);
    expect(fourFour.pulseSteps).toBe(4);
    expect(fourFour.compound).toBe(false);

    const threeFour = aiMeterFor(THREE_FOUR);
    expect(threeFour.stepsPerBar).toBe(12);
    expect(threeFour.stepsPerBeat).toBe(4);
    expect(threeFour.pulseSteps).toBe(4);

    const sixEight = aiMeterFor(SIX_EIGHT);
    expect(sixEight.stepsPerBar).toBe(12);
    expect(sixEight.stepsPerBeat).toBe(2);
    expect(sixEight.compound).toBe(true);
    expect(sixEight.pulseSteps).toBe(6);

    const fiveFour = aiMeterFor(FIVE_FOUR);
    expect(fiveFour.stepsPerBar).toBe(20);
    expect(fiveFour.pulseSteps).toBe(4);
  });

  it("places the kick on the pulse and the snare on the backbeat", () => {
    const fourFour = aiMeterFor(FOUR_FOUR);
    const kicks = range(fourFour.stepsPerBar).filter((step) => isKickAnchor(fourFour, step));
    const backs = range(fourFour.stepsPerBar).filter((step) => isBackbeatAnchor(fourFour, step));
    expect(kicks).toEqual([0, 4, 8, 12]);
    expect(backs).toEqual([4, 12]);

    const threeFour = aiMeterFor(THREE_FOUR);
    expect(range(12).filter((step) => isKickAnchor(threeFour, step))).toEqual([0, 4, 8]);
    expect(range(12).filter((step) => isBackbeatAnchor(threeFour, step))).toEqual([4]);

    // 6/8 is COMPOUND: the kick rides the dotted quarter (1 and 4) and the
    // backbeat is the shuffle's "2 & 5" — NOT every second pulse, which would
    // put it on the second dotted quarter and turn a shuffle into a tresillo.
    const sixEight = aiMeterFor(SIX_EIGHT);
    expect(range(12).filter((step) => isKickAnchor(sixEight, step))).toEqual([0, 6]);
    expect(range(12).filter((step) => isBackbeatAnchor(sixEight, step))).toEqual([2, 8]);

    const fiveFour = aiMeterFor(FIVE_FOUR);
    expect(range(20).filter((step) => isKickAnchor(fiveFour, step))).toEqual([0, 4, 8, 12, 16]);
    expect(range(20).filter((step) => isBackbeatAnchor(fiveFour, step))).toEqual([4, 12]);
  });

  it("treats an irregular bar as one pulse and declares the grouping as content", () => {
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    expect(sevenEight.stepsPerBar).toBe(14);
    expect(sevenEight.pulseSteps).toBe(14);
    expect(range(14).filter((step) => isKickAnchor(sevenEight, step))).toEqual([0]);
    expect(range(14).filter((step) => isBackbeatAnchor(sevenEight, step))).toEqual([]);
  });

  it("carries the metre in a contract only when it is not 4/4", () => {
    expect(meterCarrier(FOUR_FOUR)).toBeUndefined();
    expect(meterCarrier(null)).toBeUndefined();
    expect(meterCarrier(THREE_FOUR)).toEqual(THREE_FOUR);
    expect(meterCarrier(SIX_EIGHT)).toEqual(SIX_EIGHT);
  });

  it("folds the groove reference at the metrical bar, not at sixteen steps", () => {
    const threeFour = aiMeterFor(THREE_FOUR);
    // The second bar of a 3/4 pattern draws the groove's FIRST bar again.
    expect(referencePhase(threeFour, 0, 16)).toBe(0);
    expect(referencePhase(threeFour, 11, 16)).toBe(11);
    expect(referencePhase(threeFour, 12, 16)).toBe(0);
    expect(referencePhase(threeFour, 23, 16)).toBe(11);
    // 4/4 keeps the legacy fold.
    const fourFour = aiMeterFor(FOUR_FOUR);
    expect(referencePhase(fourFour, 16, 16)).toBe(0);
    expect(referencePhase(fourFour, 23, 16)).toBe(7);
  });

  it("cuts the phrase at the metrical bar line", () => {
    expect(buildPhrasePlan(24).map((bar) => [bar.startStep, bar.endStep])).toEqual([
      [0, 16],
      [16, 24],
    ]);
    expect(buildPhrasePlan(24, aiMeterFor(THREE_FOUR)).map((bar) => [bar.startStep, bar.endStep])).toEqual([
      [0, 12],
      [12, 24],
    ]);
    expect(buildPhrasePlan(48, aiMeterFor(THREE_FOUR)).map((bar) => bar.startStep)).toEqual([0, 12, 24, 36]);
  });
});

describe("ADR 0057 Stage 2b — 4/4 stays byte-identical", () => {
  // Measured against HEAD before this stage (the canonical content hash —
  // project UUIDs excluded, so the number is reproducible).
  const BASELINE: { genre: string; seed: string; hash: string }[] = [
    { genre: "house", seed: "baseline-house-1", hash: "17e1439d" },
    { genre: "trap", seed: "baseline-trap-1", hash: "688279c1" },
    { genre: "dnb", seed: "baseline-dnb-1", hash: "47f20c59" },
    { genre: "house", seed: "baseline-house-2", hash: "b4f0ae78" },
  ];

  for (const entry of BASELINE) {
    it(`4/4 ${entry.genre}/${entry.seed} hashes to the pre-stage content`, () => {
      expect(generateRows(FOUR_FOUR, entry.genre, entry.seed).hash).toBe(entry.hash);
    });
  }

  it("4/4 carries no metre in the generation recipe", () => {
    const doc = docWithMeter(FOUR_FOUR);
    const plan = planGeneration({ genre: "house", seed: "baseline-house-1" }, doc);
    expect(plan.options.timeSignature).toBeUndefined();
    expect(plan.recipe.timeSignature).toBeUndefined();
    expect(JSON.stringify(plan.recipe)).not.toContain("timeSignature");
  });

  it("another metre IS part of the generation identity", () => {
    const doc = docWithMeter(THREE_FOUR);
    const plan = planGeneration({ genre: "house", seed: "baseline-house-1" }, doc);
    expect(plan.options.timeSignature).toEqual(THREE_FOUR);
    expect(plan.recipe.timeSignature).toEqual(THREE_FOUR);
  });
});

describe("ADR 0057 Stage 2b — another metre is RIGHT", () => {
  it("3/4 puts the kick on the three beats and the snare on beat 2", () => {
    const { rows } = generateRows(THREE_FOUR, "house", "baseline-house-1");
    // Row 0 is the kick, row 1 the snare (the house template's pad order).
    expect(rows[0]).toBe("0,4,8");
    expect(rows[1]).toBe("4");
  });

  it("6/8 puts the kick on the dotted quarters and the snare on the shuffle's 2 & 5", () => {
    const { rows } = generateRows(SIX_EIGHT, "house", "baseline-house-1");
    expect(rows[0]).toBe("0,6");
    expect(rows[1]).toBe("2,8");
  });

  it("the generated pattern is a whole number of the document's bars", () => {
    for (const sig of [FOUR_FOUR, THREE_FOUR, SIX_EIGHT]) {
      const doc = docWithMeter(sig);
      const intent = normalizeIntent({ genre: "house", seed: "metrical-bars" }, doc);
      const result = generateLocalResult(doc, intent, "preview");
      const pattern = result.proposal?.pattern;
      expect(pattern).toBeTruthy();
      const perBar = aiMeterFor(sig).stepsPerBar;
      expect(pattern!.stepCount % perBar).toBe(0);
      expect(pattern!.phrasePlan?.length).toBe(pattern!.stepCount / perBar);
    }
  });

  it("the pattern verbs keep the DOCUMENT's downbeat, not every sixteenth step", () => {
    const pad: DrumPad = {
      id: "pad-kick",
      name: "Kick",
      assetId: null,
      gain: 1,
      pan: 0,
      pitch: 0,
      mute: false,
      solo: false,
      chokeGroup: null,
    };
    const row = Array.from({ length: 24 }, (_, step) => (step % 2 === 0 ? 0.8 : 0));
    const pattern: Pattern = { id: "p1", name: "verbs", stepCount: 24, rows: { "pad-kick": row }, notes: {} };

    // 3/4: the downbeats are 0 and 12 — the verbs must keep those two.
    const thinned = applyVerbRows(pattern, [pad], [{ kind: "thin", family: "all" }], "seed-3/4", THREE_FOUR);
    const kept = thinned.rows["pad-kick"].map((value, step) => (value > 0 ? step : -1)).filter((step) => step >= 0);
    expect(kept).toContain(0);
    expect(kept).toContain(12);
  });
});

// ── the guard: the AI layer may not re-derive the bar ──

const SRC_ROOT = resolve(process.cwd(), "src");
const GUARDED_ROOTS = ["src/ai/"];

/**
 * Sites that still state a 4/4 length. Each entry is a DECLARATION — it
 * states WHY the number is still 4/4 — and the ledger may only shrink.
 *
 * The six pinned-ONNX entries are GONE (ADR 0057 Stage 2e): those contracts
 * no longer fold the bar at sixteen — they read the metre's own bar, and the
 * model's canonical frame is a named constant in one owner
 * (`src/ai/symbolic/step-position.ts`).
 *
 * The Markov entry is gone too, and that one is a lesson: the model's
 * sixteen-position state space is a NAMED constant (`STEPS_PER_BAR = 16`), so
 * the AST guard never saw it — and an entry the guard cannot see is an entry
 * that HIDES a file from the scan for a reason that no longer exists. The
 * model's 4/4 frame is recorded in ADR 0057 instead, and the file is scanned
 * like any other.
 *
 * What remains is the two things that really are 4/4 material AND still state
 * it as a literal: the corpus the models were trained on, and the pinned v2
 * chord-duration contract. A spec below makes "the ledger may only shrink"
 * executable — an entry whose file no longer trips the guard fails the gate.
 */
const LEDGER_4_4_SITES: Record<string, string> = {
  "src/ai/midi-corpus-ingest.ts":
    "the corpus ingest frame is the model's sixteen-step training frame, not the pattern grid",
  "src/ai/features/pattern-features-v2.ts":
    "the pinned v2 feature contract measures a chord duration against a 4/4 bar — a versioned metrical contract is a separate step",
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

function isSixteen(node: ts.Node): boolean {
  return ts.isNumericLiteral(node) && node.text === "16";
}

/**
 * The AI layer may not measure a bar by hand.
 *
 * A numeric SIXTEEN in a multiplicative expression (`x * 16`, `x / 16`,
 * `x % 16`) is the shape of the old assumption: a bar is sixteen steps, a
 * step's position inside a bar is `step % 16`, a bar's start is `bar * 16`.
 * The metre now lives in `src/ai/meter.ts` — one owner — and every layer
 * below it asks the metre instead of re-deriving the bar.
 */
export function findAiBarViolations(files: { file: string; source: string }[], ignoreLedger = false): Violation[] {
  const violations: Violation[] = [];
  for (const { file, source } of files) {
    if (!GUARDED_ROOTS.some((root) => file.startsWith(root))) continue;
    if (!ignoreLedger && LEDGER_4_4_SITES[file]) continue;
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        const multiplicative =
          operator === ts.SyntaxKind.AsteriskToken ||
          operator === ts.SyntaxKind.SlashToken ||
          operator === ts.SyntaxKind.PercentToken;
        if (multiplicative && (isSixteen(node.left) || isSixteen(node.right))) {
          violations.push({
            file,
            line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            detail: "measures a bar as sixteen steps",
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return violations;
}

describe("ADR 0057 Stage 2b — the AI layer may not re-derive the bar", () => {
  it("no AI module measures a bar as sixteen steps", () => {
    const files = walkSourceFiles(SRC_ROOT).map((absolute) => ({
      file: relative(process.cwd(), absolute).replace(/\\/g, "/"),
      source: readFileSync(absolute, "utf8"),
    }));
    expect(findAiBarViolations(files)).toEqual([]);
  });

  it("the guard can FAIL — a synthetic violation is caught", () => {
    const synthetic = [
      {
        file: "src/ai/rogue.ts",
        source: "export const bars = Math.ceil(stepCount / 16);\nexport const at = step % 16;\n",
      },
    ];
    const violations = findAiBarViolations(synthetic);
    expect(violations.length).toBe(2);
    expect(violations[0]?.detail).toContain("sixteen steps");
  });

  it("every ledger entry is STILL NEEDED — a stale declaration fails the gate", () => {
    // "The ledger may only shrink" is a rule of the repo, and a rule nobody
    // executes is a rule nobody keeps. An entry whose file no longer trips
    // the guard is a stale declaration: it hides a file from the scan for a
    // reason that no longer exists, and it is how a ledger grows.
    for (const file of Object.keys(LEDGER_4_4_SITES)) {
      const absolute = resolve(process.cwd(), file);
      expect(existsSync(absolute)).toBe(true);
      const violations = findAiBarViolations([{ file, source: readFileSync(absolute, "utf8") }], true);
      expect(
        violations.length,
        `${file} is in the ledger but no longer trips the guard — remove the entry`,
      ).toBeGreaterThan(0);
    }
  });
});

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}
