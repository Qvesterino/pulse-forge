/**
 * ADR 0056 / ADR 0057 — the meter is never changed silently.
 *
 * ADR 0056 shipped the transfer dialog's disclosure and left a note:
 *
 *     "Other meter-setting surfaces (the `kyx_music` MCP tool, the text-intent
 *      path, `setTimeSignature`) can still change a project's meter without
 *      disclosure."
 *
 * This spec is that follow-up. Four surfaces can put a project into a metre:
 *
 *   1. the COMMAND (`setTimeSignature`) — the canonical writer;
 *   2. the INTENT path ("make it 6/8") — through the command;
 *   3. the MCP surface (`kyx_music op=setTimeSignature`) — through the command;
 *   4. the AI GENERATION path — it writes `doc.timeSignature` directly.
 *
 * Each of them now discloses, and they all say the SAME words, because the
 * words live in ONE owner (`src/project-model/meter-disclosure.ts`). A
 * disclosure that four surfaces word differently is four disclosures, and
 * three of them are wrong by accident.
 *
 * THE SILENCE RULE is the interesting part, and it is not "the bar changed":
 *
 *   - 4/4 → 4/4 is not a change at all, so NOTHING is said. That is the
 *     negative control every spec here pins.
 *   - 4/4 → 2/2 keeps the bar's 1920 ticks but moves the beat from a quarter
 *     note to a half note, so the metronome clicks twice a bar instead of
 *     four times (`ticksPerBeatFor`, `src/scheduler/Scheduler.ts`). A
 *     disclosure keyed on the BAR alone would stay silent about a change the
 *     user can HEAR. So the disclosure fires when the SIGNATURE changes, and
 *     it states the beat as well as the bar.
 *
 * The guard at the bottom makes "no surface changes the meter without
 * disclosing it" executable, and it is proven able to fail: the last spec
 * feeds it synthetic violations and asserts it reports them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { setTimeSignature } from "../src/commands/metadata";
import { applyExactIntentCommand, exactReadback } from "../src/commands/intentRouting";
import { applyGenerationResultCommand } from "../src/commands/aiPattern";
import { parseExactIntent } from "../src/intent/exact";
import { parseIntentText } from "../src/intent/text-parser";
import { generateLocalResult } from "../src/intent/pipeline";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject, ticksPerBarFor, ticksPerBeatFor } from "../src/project-model/schema";
import { stepsPerBarFor, stepsPerBeatFor } from "../src/project-model/grid";
import {
  meterBarClause,
  meterChangeClause,
  meterFacts,
  meterMeaning,
  meterSignatureChanged,
} from "../src/project-model/meter-disclosure";
import { patternGridWarning } from "../src/export/transfer-import";
import type { ProjectDocument, TimeSignature } from "../src/project-model/types";

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const TWO_TWO: TimeSignature = { numerator: 2, denominator: 2 };
const THREE_FOUR: TimeSignature = { numerator: 3, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };
const TWO_FOUR: TimeSignature = { numerator: 2, denominator: 4 };

/** The house project: a 16-step (one 4/4 bar) active pattern. */
function project(): ProjectDocument {
  return normalizeProject({
    ...createProjectFromTemplate("house"),
    bpm: 120,
    arrangement: { clips: [] },
  });
}

/** The minimal MCP surface — the real command layer, a held document. */
function mcpCtx(doc: ProjectDocument): McpToolContext {
  let current = doc;
  return {
    getDoc: () => current,
    execute: (command) => {
      current = command.execute(current);
    },
    undo: () => undefined,
    redo: () => undefined,
    undoStackLength: () => 0,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: {
      play: () => {},
      stop: () => {},
      pause: () => {},
      setLoop: () => {},
      setMetronome: () => {},
    },
  };
}

describe("ADR 0056 — the COMMAND discloses the meter change", () => {
  it("the command's detail says what the new metre MEASURES and what happens to the pattern", () => {
    const detail = setTimeSignature(project(), 6, 8).detail;
    expect(detail).toBeTruthy();
    // The bar, the step grid's bar, the beat and its count — all measured.
    expect(detail).toContain("bar = 1440 ticks / 12 steps (6 beats of 240 ticks)");
    // The material: a 16-step pattern in a 12-step bar is 1.33 bars — it drifts.
    expect(detail).toContain("your 16-step pattern is 1.33 bars and drifts against the ruler");
    // …and the user is told HOW to make it land.
    expect(detail).toContain("snap it to a whole bar (12 steps) to land on the downbeat");
  });

  it("a pattern that IS a whole number of bars is told it lands on the downbeat", () => {
    // 2/4 is an 8-step bar, so a 16-step pattern is exactly TWO bars.
    const detail = setTimeSignature(project(), 2, 4).detail;
    expect(detail).toContain("your 16-step pattern is 2 bars and lands on the downbeat");
    expect(detail).not.toContain("drifts");
  });

  it("NEGATIVE CONTROL: 4/4 → 4/4 discloses NOTHING — no change, no sentence", () => {
    expect(setTimeSignature(project(), 4, 4).detail).toBeUndefined();
  });
});

describe("ADR 0056 — the INTENT path discloses the meter change", () => {
  it("the read-back carries the shared clause", () => {
    const doc = project();
    const plan = parseExactIntent("time signature 6/8");
    expect(plan).not.toBeNull();
    const after = applyExactIntentCommand(doc, plan!).execute(doc);
    const readback = exactReadback(doc, after, plan!);
    expect(readback).toContain("time signature 4/4→6/8");
    expect(readback).toContain(meterChangeClause(doc, SIX_EIGHT)!);
  });

  it("NEGATIVE CONTROL: 4/4 → 4/4 says nothing about a meter", () => {
    const doc = project();
    const plan = parseExactIntent("time signature 4/4");
    expect(plan).not.toBeNull();
    const after = applyExactIntentCommand(doc, plan!).execute(doc);
    expect(exactReadback(doc, after, plan!)).not.toContain("time signature");
  });
});

describe("ADR 0056 — the MCP surface discloses the meter change", () => {
  it("the response carries the shared clause", async () => {
    const doc = project();
    const result = await executeMcpTool(mcpCtx(doc), "kyx_music", {
      op: "setTimeSignature",
      numerator: 6,
      denominator: 8,
    });
    expect(result.text).toContain("time signature is now 6/8");
    expect(result.text).toContain(meterChangeClause(doc, SIX_EIGHT)!);
  });

  it("NEGATIVE CONTROL: the same meter is 'already_set' and discloses nothing", async () => {
    const result = await executeMcpTool(mcpCtx(project()), "kyx_music", {
      op: "setTimeSignature",
      numerator: 4,
      denominator: 4,
    });
    expect(result.data).toMatchObject({ status: "already_set", undoSteps: 0 });
    expect(result.text).not.toContain("bar =");
  });
});

describe("ADR 0056 — the AI GENERATION path discloses the meter change", () => {
  it("the generation that moves the project into a new metre says what that metre measures", () => {
    const doc = project();
    const parsed = parseIntentText("make me a dark house beat in 6/8");
    const result = generateLocalResult(doc, parsed.input, "preview");
    const command = applyGenerationResultCommand(doc, result);
    expect(command.detail).toContain("bar = 1440 ticks / 12 steps (6 beats of 240 ticks)");
    // Only the BAR is stated here: the generated pattern is built IN the
    // requested metre, so a clause about the OLD pattern's length would
    // describe material that no longer exists.
    expect(command.detail).not.toContain("drifts");
    expect(command.execute(doc).timeSignature).toEqual({ numerator: 6, denominator: 8 });
  });

  it("NEGATIVE CONTROL: a generation that does not change the metre discloses nothing", () => {
    const doc = project();
    const parsed = parseIntentText("make me a dark house beat");
    const result = generateLocalResult(doc, parsed.input, "preview");
    expect(applyGenerationResultCommand(doc, result).detail).toBeUndefined();
  });
});

describe("ADR 0056 — all four surfaces say the SAME words", () => {
  it("the command, the intent read-back and the MCP response quote one clause", async () => {
    const doc = project();
    const clause = meterChangeClause(doc, SIX_EIGHT)!;

    const command = setTimeSignature(doc, 6, 8).detail ?? "";
    expect(command).toContain(clause);

    const plan = parseExactIntent("time signature 6/8")!;
    const after = applyExactIntentCommand(doc, plan).execute(doc);
    expect(exactReadback(doc, after, plan)).toContain(clause);

    const result = await executeMcpTool(mcpCtx(doc), "kyx_music", {
      op: "setTimeSignature",
      numerator: 6,
      denominator: 8,
    });
    expect(result.text).toContain(clause);
  });

  it("the transfer dialog quotes the owner's sentence verbatim", () => {
    // The dialog that OFFERS a metre and the surfaces that CHANGE a metre
    // must not describe the same metre in two different ways.
    expect(patternGridWarning(SIX_EIGHT)).toContain(meterMeaning(SIX_EIGHT));
    expect(meterMeaning(SIX_EIGHT)).toContain("1440 ticks");
    expect(meterMeaning(SIX_EIGHT)).toContain("12 sixteenth steps");
  });

  it("NEGATIVE CONTROL: the transfer dialog still says nothing in 4/4", () => {
    expect(patternGridWarning(FOUR_FOUR)).toBeNull();
  });
});

describe("ADR 0057 — the disclosure tells the truth about the metre", () => {
  it("4/4 → 2/2 discloses the BEAT, because the click changes even though the bar does not", () => {
    const doc = project();
    const clause = meterChangeClause(doc, TWO_TWO)!;
    expect(clause).toBeTruthy();
    // The bar keeps its 1920 ticks and 16 steps…
    expect(clause).toContain("bar = 1920 ticks / 16 steps");
    // …but the beat is now a half note, twice a bar — the metronome hears it.
    expect(clause).toContain("(2 beats of 960 ticks)");
    // The material is unharmed, and the clause says so.
    expect(clause).toContain("your 16-step pattern is 1 bar and lands on the downbeat");
  });

  it("the numbers in the clause are the MEASURED ones, for every metre", () => {
    const table: TimeSignature[] = [
      FOUR_FOUR,
      TWO_TWO,
      THREE_FOUR,
      SIX_EIGHT,
      TWO_FOUR,
      { numerator: 4, denominator: 2 },
      { numerator: 12, denominator: 8 },
      { numerator: 7, denominator: 8 },
    ];
    for (const sig of table) {
      const facts = meterFacts(sig);
      expect(facts.ticks, `${sig.numerator}/${sig.denominator} bar ticks`).toBe(ticksPerBarFor(sig));
      expect(facts.steps, `${sig.numerator}/${sig.denominator} bar steps`).toBe(stepsPerBarFor(sig));
      expect(facts.beatTicks, `${sig.numerator}/${sig.denominator} beat ticks`).toBe(ticksPerBeatFor(sig));
      expect(facts.beatSteps, `${sig.numerator}/${sig.denominator} beat steps`).toBe(stepsPerBeatFor(sig));
      expect(facts.beats, `${sig.numerator}/${sig.denominator} beats`).toBe(sig.numerator);
      // The clause must STATE those measured numbers, not a remembered one.
      expect(meterBarClause(sig)).toBe(
        `bar = ${facts.ticks} ticks / ${facts.steps} steps (${facts.beats} beats of ${facts.beatTicks} ticks)`,
      );
    }
  });

  it("the silence rule is the SIGNATURE, not the bar", () => {
    expect(meterSignatureChanged(FOUR_FOUR, FOUR_FOUR)).toBe(false);
    expect(meterSignatureChanged(FOUR_FOUR, TWO_TWO)).toBe(true);
    expect(meterChangeClause(project(), FOUR_FOUR)).toBeNull();
    expect(meterChangeClause(project(), TWO_TWO)).not.toBeNull();
  });

  it("a project with no active pattern still discloses the metre", () => {
    const doc = { ...project(), patterns: [], activePatternId: "none" };
    const clause = meterChangeClause(doc, SIX_EIGHT)!;
    expect(clause).toBe("bar = 1440 ticks / 12 steps (6 beats of 240 ticks)");
  });
});

// ── the guard ────────────────────────────────────────────────────────────────

interface MeterSite {
  file: string;
  line: number;
  detail: string;
}

/**
 * The sites that can put a project into a metre.
 *
 * Two syntactic shapes:
 *
 *   - a call to `setTimeSignature(` — the command that changes the metre;
 *   - an object literal that BUILDS a metre (`numerator` + `denominator`) —
 *     the moment a metre value is chosen rather than copied.
 *
 * The model layer (`src/project-model/`) is excluded: it is where the metre
 * LIVES, not a surface that changes one.
 */
export function findMeterSites(files: { file: string; source: string }[]): MeterSite[] {
  const sites: MeterSite[] = [];
  for (const { file, source } of files) {
    if (file.startsWith("src/project-model/")) continue;
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "setTimeSignature"
      ) {
        sites.push({
          file,
          line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          detail: "calls the setTimeSignature command",
        });
      }
      if (ts.isObjectLiteralExpression(node)) {
        const names = node.properties
          .map((property) => {
            // `{ numerator, denominator }` is a SHORTHAND property — its name
            // still counts as a metre key.
            if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
            if (ts.isPropertyAssignment(property)) {
              return ts.isIdentifier(property.name) ? property.name.text : property.name.getText();
            }
            return "";
          })
          .filter((name) => name !== "");
        if (names.includes("numerator") && names.includes("denominator")) {
          sites.push({
            file,
            line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            detail: "builds a metre",
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return sites;
}

/**
 * The surfaces that change a project's metre — each one MUST disclose.
 *
 * A surface discloses when it asks the one owner for the words, or when it
 * writes through the command that asks the owner.
 */
const METER_SURFACES: Record<string, string> = {
  "src/commands/metadata.ts": "the command that owns the change",
  "src/commands/intentRouting.ts": "the intent path — it writes through the command",
  "src/mcp/tools.ts": "the MCP surface — it writes through the command",
};

/**
 * The sites that BUILD a metre value without changing a project's metre, with
 * the reason. A new entry here is a judgement call that has to be written
 * down; the ledger may only SHRINK (every entry must still be needed).
 */
const METER_NON_SURFACES: Record<string, string> = {
  "src/ui/TransferImportDialog.tsx":
    "the dialog's metre CHOICE — the imported project is built in src/export/transfer-import.ts, which discloses",
  "src/intent/text-parser.ts": "the REQUEST's metre — the project is changed later, by a surface that discloses",
  "src/intent/meter-phrase.ts": "parses the metre PHRASE out of the request",
  "src/intent/exact.ts":
    "builds the intent's timeSignature OP — the project is changed by the intent path, which discloses",
  "src/intent/normalize.ts": "normalises the REQUEST's metre",
  "src/ai/meter.ts": "the AI layer's metre truth — a helper over a TimeSignature, not over a project",
  "src/ai/grooves/irregular.ts":
    "the grooves' OWN metre — a groove declares the metre it was WRITTEN in; no project is changed here",
  "src/assist/pipeline.ts": "normalises a TimeSignature value for the assist layer",
  "src/collab/YDocAdapter.ts": "mirrors the shared document's metre — it does not choose one",
  "src/integrations/audiotool-nexus/tempo.ts": "the Audiotool SDK's export config — it does not change the project",
  "src/browser-checks-transfer.ts": "a browser-check fixture",
  "src/transport/Transport.ts": "the transport's DEFAULT bar ticks — a fallback, not a project change",
};

/** The phrases that make up the disclosure — they belong to the one owner. */
const OWNER_PHRASES = ["step grid's bar", "drifts against the ruler", " beats of "];

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function sourceFiles(): { file: string; source: string }[] {
  return walkSourceFiles("src").map((absolute) => ({
    file: relative(process.cwd(), absolute).replace(/\\/g, "/"),
    source: readFileSync(absolute, "utf8"),
  }));
}

describe("ADR 0056 — no surface changes the metre without disclosing it", () => {
  it("every site that builds a metre or calls the command is ledgered", () => {
    const sites = findMeterSites(sourceFiles());
    const found = [...new Set(sites.map((site) => site.file))].sort();
    const ledgered = [...Object.keys(METER_SURFACES), ...Object.keys(METER_NON_SURFACES)].sort();
    expect(
      found.filter((file) => !ledgered.includes(file)),
      "a new metre site appeared — it must disclose, or be ledgered with a reason",
    ).toEqual([]);
    expect(found.length, "the scan must actually find the ledgered sites").toBeGreaterThan(0);
  });

  it("every metre SURFACE asks the one owner for the words", () => {
    const files = sourceFiles();
    for (const [file, why] of Object.entries(METER_SURFACES)) {
      const source = files.find((entry) => entry.file === file)?.source;
      expect(source, `${file} (${why}) must exist`).toBeTruthy();
      const discloses = source!.includes("meter-disclosure") || source!.includes("setTimeSignature(");
      expect(discloses, `${file} (${why}) changes the metre without disclosing it`).toBe(true);
    }
  });

  it("the ledger may only SHRINK — every entry is still needed", () => {
    const found = new Set(findMeterSites(sourceFiles()).map((site) => site.file));
    for (const file of [...Object.keys(METER_SURFACES), ...Object.keys(METER_NON_SURFACES)]) {
      expect(found.has(file), `${file} is ledgered but no longer a metre site — remove the entry`).toBe(true);
    }
  });

  it("the disclosure's words live in ONE owner", () => {
    const allowed = new Set(["src/project-model/meter-disclosure.ts"]);
    const offenders: string[] = [];
    for (const { file, source } of sourceFiles()) {
      if (allowed.has(file)) continue;
      for (const phrase of OWNER_PHRASES) {
        if (source.includes(phrase)) offenders.push(`${file} — "${phrase}"`);
      }
    }
    expect(offenders, "the metrical disclosure words must not be re-typed in another surface").toEqual([]);
  });
});

describe("ADR 0056 — the guard, proven able to fail", () => {
  it("reports a surface that builds a metre without disclosing it", () => {
    const sites = findMeterSites([
      { file: "src/ui/Whatever.tsx", source: "const sig = { numerator: 6, denominator: 8 };" },
    ]);
    expect(sites.map((site) => site.detail)).toEqual(["builds a metre"]);
    expect(sites.map((site) => site.file)).toEqual(["src/ui/Whatever.tsx"]);
  });

  it("reports a surface that calls the meter command", () => {
    const sites = findMeterSites([
      { file: "src/mcp/tools.ts", source: "setTimeSignature(before, numerator, denominator);" },
    ]);
    expect(sites.map((site) => site.detail)).toEqual(["calls the setTimeSignature command"]);
  });

  it("does NOT report the model layer, and does NOT report a copied metre", () => {
    const sites = findMeterSites([
      { file: "src/project-model/templates.ts", source: "timeSignature: { numerator: 4, denominator: 4 }," },
      { file: "src/export/scorepack.ts", source: "timeSignature: doc.timeSignature," },
    ]);
    expect(sites).toEqual([]);
  });

  it("the phrase guard reports a re-typed disclosure sentence", () => {
    const source = "const text = `the step grid's bar is ${n} sixteenth steps`;";
    const offenders = OWNER_PHRASES.filter((phrase) => source.includes(phrase));
    expect(offenders).toEqual(["step grid's bar"]);
  });
});
