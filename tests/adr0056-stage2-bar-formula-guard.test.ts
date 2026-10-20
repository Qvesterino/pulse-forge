/**
 * ADR 0056 — Stage 2 GUARD: the bar length has ONE formula.
 *
 * Stage 2 of ADR 0056 makes `ticksPerBar(doc)` the only way a bar index is
 * converted to ticks. The companion spec (`tests/adr0056-stage2-bar-unit.test.ts`)
 * pins the AUDIBLE path — where a clip sits, how long the render is, where the
 * metronome's downbeat falls. This spec pins the other half: that no module
 * computes a bar length FOR ITSELF.
 *
 * That half cannot be policed by grepping for a constant's NAME. The seven
 * conversions that were wrong when this spec was written were all invisible to
 * `grep BAR_TICKS`:
 *
 *   src/collab/bandmate.ts:29       const BAR_TICKS = PPQ * 4;   <- shadow copy
 *   src/transport/Transport.ts:10   const BAR_TICKS_ = PPQ * 4;  <- shadow copy
 *   src/project-model/chords.ts:63   chord.startBar * 1920;       <- hardcoded
 *   src/project-model/intensity.ts:54 clip.startBar * 1920;       <- hardcoded
 *   src/ui/IntentPanel.tsx:2628      Math.round(ticks / 1920)     <- hardcoded
 *   src/ui/IntentPanel.tsx:5766      (... : 1920) / 1920          <- hardcoded
 *   src/ui/ModPanel.tsx:1381        2 * 1920                      <- hardcoded
 *   src/intent/studio-words.ts:144   const bar = 4 * PPQ;          <- shadow copy
 *   src/midi/MidiClock.ts:5          const PPQ = 480;              <- shadow copy
 *
 * Three of them carried a different NAME; four carried no name at all; and
 * the last one wrote the formula BACKWARDS (`4 * PPQ`), which a
 * `grep "PPQ \* 4"` misses completely. A name sweep passes all nine. So this
 * guard looks for the FORMULA — the expression `PPQ * 4` in EITHER order, and
 * the numeric literal `1920` — and it looks for them in the AST, not in the
 * raw text.
 *
 * WHY THE AST AND NOT A REGEX OVER THE SOURCE TEXT: the first version of this
 * guard stripped comments and string literals by hand. That cannot be done
 * correctly — `src/intent/route.ts` has `'` inside a regex literal,
 * `src/agents/AgentsPage.tsx` has an apostrophe in JSX text ("AI can't break
 * your track"), and `src/export/shareCode.ts` has `//` inside a string. A
 * hand-rolled stripper swallows real code after the first false quote, which
 * turns the guard into a guard that cannot fail. `ts.createSourceFile` gives
 * the real syntax tree, so prose, comments, regexes and JSX text are excluded
 * by construction and the only thing left to find is actual code.
 *
 * THE GUARD IS PROVEN ABLE TO FAIL: the first two specs feed it synthetic
 * violations and assert it reports them. A guard that has never been seen
 * red is not a guard.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { chordAtTick } from "../src/project-model/chords";
import { intensitySignalAt } from "../src/project-model/intensity";
import { ticksPerBar, ticksPerBarFor } from "../src/project-model/schema";
import { BAR_TICKS } from "../src/project-model/types";
import { Transport } from "../src/transport/Transport";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument, Scene, TimeSignature } from "../src/project-model/types";

const SRC_ROOT = resolve(process.cwd(), "src");

/**
 * Files allowed to contain the raw literal `1920`, each with the reason the
 * number is NOT a bar length. Adding an entry here is a DECLARATION — it
 * states why the literal is something else — not a silence.
 */
const ALLOWED_RAW_1920: Record<string, string> = {
  "src/project-model/templates.ts":
    "factory template note offsets — 4/4 templates by definition (ADR 0056 keeps a 4/4 default for these)",
  "src/export/video.ts": "video frame height in pixels, not a bar length",
};

/** The bar-length formula may live in exactly one module. */
const ALLOWED_FORMULA_FILES = new Set(["src/project-model/types.ts"]);

/** The PPQ constant may be copied into exactly one module. */
const ALLOWED_PPQ_FILES = new Set(["src/project-model/types.ts"]);

type ViolationKind = "formula" | "literal" | "ppq-copy";

interface Violation {
  file: string;
  line: number;
  column: number;
  kind: ViolationKind;
  text: string;
}

/**
 * Find the three shapes of "this module computed a bar length for itself":
 *
 *   formula  — a multiplication `PPQ * 4` (or `4 * PPQ`). This is the
 *              bar-length formula itself; the ADR allows exactly one copy of
 *              it, in the module that owns the constant.
 *   literal  — the numeric literal 1920 used as code. 1920 IS the 4/4 bar
 *              length in ticks, so a bare 1920 in arithmetic is a bar unit
 *              written out longhand.
 *   ppq-copy — a local `const PPQ = ...`. Copying the tick constant is the
 *              same smell one level down: the copy is free to drift away from
 *              the project's PPQ.
 *
 * The AST is what makes this exact: a `1920` inside a comment, a string, a
 * regular expression or JSX text is not a NumericLiteral node and is never
 * reported.
 */
function detectBarUnitViolations(label: string, source: string): Violation[] {
  const scriptKind = label.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, scriptKind);
  const out: Violation[] = [];
  const at = (node: ts.Node): { line: number; column: number } => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: pos.line + 1, column: pos.character + 1 };
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
      const left = node.left;
      const right = node.right;
      const isFormula =
        (ts.isIdentifier(left) && left.text === "PPQ" && ts.isNumericLiteral(right) && right.text === "4") ||
        (ts.isIdentifier(right) && right.text === "PPQ" && ts.isNumericLiteral(left) && left.text === "4");
      if (isFormula) {
        out.push({ file: label, ...at(node), kind: "formula", text: "PPQ * 4" });
      }
    }
    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text.replace(/_/g, ""));
      if (value === 1920) {
        out.push({ file: label, ...at(node), kind: "literal", text: node.text });
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "PPQ") {
      out.push({ file: label, ...at(node), kind: "ppq-copy", text: "const PPQ = ..." });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every TypeScript source file under `src/`, as repo-relative labels. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        out.push(relative(process.cwd(), full).replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

const SRC_FILES = sourceFiles(SRC_ROOT);

function violationsInSrc(): Violation[] {
  const out: Violation[] = [];
  for (const label of SRC_FILES) {
    out.push(...detectBarUnitViolations(label, readFileSync(resolve(process.cwd(), label), "utf8")));
  }
  return out;
}

function describeViolations(violations: Violation[]): string {
  return violations.map((v) => `  ${v.file}:${v.line}:${v.column}  ${v.kind} — ${v.text}`).join("\n");
}

describe("ADR 0056 Stage 2 — the bar length has one formula (guard self-proof)", () => {
  it("GUARD PROOF: a shadow copy of the bar formula is detected", () => {
    const found = detectBarUnitViolations("src/collab/bandmate.ts", "const BAR_TICKS = PPQ * 4;\n");
    expect(found.map((v) => v.kind)).toEqual(["formula"]);
    expect(found[0]!.line).toBe(1);
  });

  it("GUARD PROOF: the same copy under a DIFFERENT name is still detected", () => {
    // The name is irrelevant — that is the whole point of the formula guard.
    const found = detectBarUnitViolations("src/whatever.ts", "const FOOBAR = PPQ * 4;\n");
    expect(found.map((v) => v.kind)).toEqual(["formula"]);
  });

  it("GUARD PROOF: the formula written BACKWARDS is still detected", () => {
    // `grep "PPQ \* 4"` misses this. The intent route had exactly this shape.
    const found = detectBarUnitViolations("src/intent/studio-words.ts", "const bar = 4 * PPQ;\n");
    expect(found.map((v) => v.kind)).toEqual(["formula"]);
  });

  it("GUARD PROOF: a local copy of the PPQ constant is detected", () => {
    const found = detectBarUnitViolations("src/midi/MidiClock.ts", "const PPQ = 480;\n");
    expect(found.map((v) => v.kind)).toEqual(["ppq-copy"]);
  });

  it("GUARD PROOF: a hardcoded 1920 bar length is detected", () => {
    const found = detectBarUnitViolations(
      "src/project-model/chords.ts",
      "export function chordAtTick(c: { startBar: number }[], tick: number) {\n  return c[0]!.startBar * 1920 + tick;\n}\n",
    );
    expect(found.map((v) => v.kind)).toEqual(["literal"]);
    expect(found[0]!.line).toBe(2);
  });

  it("GUARD PROOF: prose, comments, regexes and JSX text are NOT violations", () => {
    const found = detectBarUnitViolations(
      "src/prose.tsx",
      [
        "// 1920 ticks per bar, and PPQ * 4 is the formula",
        "/* 1920 in a block comment */",
        'const note = "1920 ticks per bar";',
        "const re = /['\"]/g;",
        "const el = <span>1920 ticks and PPQ * 4 in JSX text</span>;",
        "const real = startBar * 1920;",
      ].join("\n"),
    );
    // Only the real arithmetic is reported.
    expect(found.map((v) => v.kind)).toEqual(["literal"]);
    expect(found[0]!.line).toBe(6);
  });
});

describe("ADR 0056 Stage 2 — the repository obeys the guard", () => {
  it("the bar-length formula exists in exactly ONE module", () => {
    const formulas = violationsInSrc().filter((v) => v.kind === "formula");
    const outside = formulas.filter((v) => !ALLOWED_FORMULA_FILES.has(v.file));
    expect(outside, `the bar-length formula must not be copied anywhere:\n${describeViolations(outside)}`).toEqual([]);
    // The one allowed copy is still there — the guard must not pass by the
    // formula having disappeared.
    expect(formulas.length).toBeGreaterThan(0);
    expect(formulas.every((v) => ALLOWED_FORMULA_FILES.has(v.file))).toBe(true);
  });

  it("no module hardcodes the 4/4 bar length as a literal", () => {
    const literals = violationsInSrc().filter((v) => v.kind === "literal");
    const outside = literals.filter((v) => !ALLOWED_RAW_1920[v.file]);
    expect(outside, `a raw 1920 is a bar length written out longhand:\n${describeViolations(outside)}`).toEqual([]);
  });

  it("no module copies the PPQ constant", () => {
    const copies = violationsInSrc().filter((v) => v.kind === "ppq-copy");
    const outside = copies.filter((v) => !ALLOWED_PPQ_FILES.has(v.file));
    expect(outside, `PPQ is copied instead of imported:\n${describeViolations(outside)}`).toEqual([]);
  });

  it("the canonical constant still exists and IS the 4/4 bar", () => {
    // If the constant is renamed (BAR_TICKS -> DEFAULT_BAR_TICKS) this spec
    // follows it: it asks the module, not the name.
    const source = readFileSync(resolve(process.cwd(), "src/project-model/types.ts"), "utf8");
    expect(source).toMatch(/export const \w*BAR_TICKS\s*=/);
    expect(ticksPerBarFor({ numerator: 4, denominator: 4 })).toBe(BAR_TICKS);
  });

  it("the scanner actually reaches the source tree (a guard that scans nothing passes)", () => {
    expect(SRC_FILES.length).toBeGreaterThan(100);
    expect(SRC_FILES.some((f) => f === "src/project-model/types.ts")).toBe(true);
    expect(SRC_FILES.some((f) => f.endsWith(".tsx"))).toBe(true);
  });
});

// ─── The converted sites: the document's meter, not a hardcoded 1920 ───────────

function docWith(sig: TimeSignature): ProjectDocument {
  return { ...createProjectFromTemplate("house"), timeSignature: sig };
}

const CHORDS = [{ id: "c1", startBar: 1, lengthBars: 1, root: 0, quality: "maj" as const }];

/** The pre-fix behaviour, written out: the bar unit was the literal 1920. */
function chordAtTickWithHardcodedUnit(
  chords: readonly { id: string; startBar: number; lengthBars: number; root: number; quality: "maj" }[],
  tick: number,
): { root: number; quality: "maj" } | null {
  for (const chord of chords) {
    const start = chord.startBar * 1920;
    if (tick >= start && tick < start + chord.lengthBars * 1920) {
      return { root: chord.root, quality: chord.quality };
    }
  }
  return null;
}

describe("ADR 0056 Stage 2 — the converted sites follow the document's meter", () => {
  it("a chord on the musical downbeat of bar 2 is found in 3/4", () => {
    const doc = docWith({ numerator: 3, denominator: 4 });
    const unit = ticksPerBar(doc);
    expect(unit).toBe(1440);
    // The chord sits on bar 1 of the arrangement; in 3/4 that bar starts at
    // tick 1440. The old 4/4 unit put it at 1920 — two beats late.
    expect(chordAtTick(CHORDS, unit, unit)).not.toBeNull();
    expect(chordAtTick(CHORDS, unit, BAR_TICKS)).toBeNull();
  });

  it("4/4 behaviour is UNCHANGED — the converted call equals the old hardcoded one", () => {
    const doc = docWith({ numerator: 4, denominator: 4 });
    expect(ticksPerBar(doc)).toBe(BAR_TICKS);
    for (const tick of [0, 1919, 1920, 2879, 2880, 3839, 3840]) {
      expect(chordAtTick(CHORDS, tick, ticksPerBar(doc))).toEqual(chordAtTickWithHardcodedUnit(CHORDS, tick));
    }
  });

  it("the scene intensity resolves at the musical downbeat in 3/4", () => {
    const scene: Scene = {
      id: "s1",
      name: "Scene A",
      patternId: "p1",
      intensity: 0.7,
      intensityCurve: [
        { offset: 0, value: 0.1 },
        { offset: 960, value: 1 },
      ],
    };
    const doc = {
      scenes: [scene],
      timeSignature: { numerator: 3, denominator: 4 } as TimeSignature,
      arrangement: {
        clips: [{ id: "k1", sceneId: "s1", startBar: 1, lengthBars: 1, sceneOffsetTicks: 0 }],
      },
    };
    // Inside the clip the intensity curve decides (0.1 at the clip's start).
    expect(intensitySignalAt(doc, "p1", 1440)).toBe(0.1);
    // The old 4/4 unit put the clip at 1920, so tick 1440 was outside it and
    // the static intensity (0.7) answered instead.
    expect(intensitySignalAt({ ...doc, timeSignature: { numerator: 4, denominator: 4 } }, "p1", 1440)).toBe(0.7);
  });

  it("the transport counts 4/4 bars by default and follows the document when told", () => {
    const transport = new Transport({ now: () => 0 });
    transport.setCountIn(1);
    expect(transport.leadInTicks()).toBe(BAR_TICKS);
    transport.setBarTicks(ticksPerBarFor({ numerator: 3, denominator: 4 }));
    expect(transport.leadInTicks()).toBe(1440);
  });
});

// ─── How far an EXISTING non-4/4 document's content moves ───────────────────

/**
 * Stage 2 changes what a stored bar index MEANS. The stored number does not
 * move — `startBar: 2` is still 2 — but the tick it resolves to changes from
 * `2 * 1920` to `2 * ticksPerBar(sig)`. For every document that was saved
 * with a non-4/4 meter, that is a real shift of the audio, and it is the
 * defect being corrected (the clip now lands on the downbeat the metronome
 * clicks). It is pinned here so the magnitude is a measured number and not a
 * surprise:
 *
 *   meter   bar length   shift per stored bar   a clip at bar 2 moves
 *   4/4         1920              0                     —
 *   3/4         1440            -480              -960 ticks (2 beats)
 *   6/8         1440            -480              -960 ticks (2 beats)
 *   2/4          960           -960             -1920 ticks (4 beats)
 *   4/2         3840           +1920             +3840 ticks (8 beats)
 *   12/8        2880            +960             +1920 ticks (4 beats)
 *   32/4       15360           +13440           +26880 ticks (56 beats)
 */
describe("ADR 0056 Stage 2 — the measured shift of an existing non-4/4 document", () => {
  const shiftPerBar = (sig: TimeSignature): number => ticksPerBarFor(sig) - BAR_TICKS;

  it("MEASURED: 4/4, 2/2 and 8/8 do not move at all", () => {
    for (const sig of [
      { numerator: 4, denominator: 4 },
      { numerator: 2, denominator: 2 },
      { numerator: 8, denominator: 8 },
    ] as TimeSignature[]) {
      expect(shiftPerBar(sig)).toBe(0);
    }
  });

  it("MEASURED: 3/4 and 6/8 move a clip at bar 2 by 960 ticks — two beats — earlier", () => {
    for (const sig of [
      { numerator: 3, denominator: 4 },
      { numerator: 6, denominator: 8 },
    ] as TimeSignature[]) {
      expect(shiftPerBar(sig)).toBe(-480);
      expect(2 * shiftPerBar(sig)).toBe(-960);
    }
  });

  it("MEASURED: a 4/2 bar is TWICE as long as a 4/4 bar — a clip at bar 2 moves eight beats later", () => {
    const sig: TimeSignature = { numerator: 4, denominator: 2 };
    expect(ticksPerBarFor(sig)).toBe(3840);
    expect(shiftPerBar(sig)).toBe(1920);
    expect(2 * shiftPerBar(sig)).toBe(3840);
  });

  it("MEASURED: 32/4 moves a clip at bar 2 by 26880 ticks — 14 bars — because one bar IS seven 4/4 bars", () => {
    const sig: TimeSignature = { numerator: 32, denominator: 4 };
    expect(ticksPerBarFor(sig)).toBe(15360);
    expect(2 * shiftPerBar(sig)).toBe(26880);
  });
});
