/**
 * THE COVERAGE GUARD — a clip verb cannot land untested.
 *
 * The property harness (`tests/helpers/clip-verb-harness.ts`) proves four
 * properties over random geometries, for every verb in its registry. What it
 * cannot do is notice a verb that was ADDED to the command layer and never
 * entered the registry: the suite stays green and says nothing about it.
 *
 * That is the failure mode this file closes. It reads two lists:
 *
 *   - the clip-mutating verbs the command layer EXPORTS (an AST walk over
 *     `src/commands/`, so a verb is found whatever its file or name);
 *   - the verbs the harness EXERCISES (the command functions the harness
 *     calls, read from its own source).
 *
 * and fails when a verb is in the first list and not the second — unless it
 * is named in the exemption list, with a reason.
 *
 * The exemptions are the honest statement of what is NOT covered, and they
 * are checked for STALENESS: an exemption for a verb the harness now covers
 * is a lie, and the guard says so.
 *
 * The detector is an AST walk, not a grep (a grep would match a comment or an
 * import), and it is proven able to fail on synthetic sources.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** The command modules that own clip geometry. */
const CLIP_COMMAND_MODULES = [
  "arrangement.ts",
  "arrangementShapes.ts",
  "audioClips.ts",
  "automationClips.ts",
  "clipClipboard.ts",
  "clipEditing.ts",
  "clipGroups.ts",
  "clipPlayback.ts",
  "midiClips.ts",
];

/** A verb name that mutates a clip. */
const CLIP_VERB =
  /^(add|move|resize|trim|split|duplicate|delete|set|toggle|replace|paste|ripple|nudge|reverse|quantize|transpose|glide|legato|loop|freeze|assign|create)/i;

/**
 * The verbs the command layer exports that can change a clip.
 *
 * `delete` is in the name pattern and the verbs it matches are EXEMPTED
 * below — but the pattern has to match them, or the exemption would be
 * unreachable and the list would drift.
 */
function exportedClipVerbs(sources: Array<{ file: string; source: string }>): Set<string> {
  const verbs = new Set<string>();
  for (const { file, source } of sources) {
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of parsed.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
      const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      if (!exported) continue;
      const name = statement.name.text;
      if (/clip/i.test(name) && CLIP_VERB.test(name)) verbs.add(name);
    }
  }
  return verbs;
}

/**
 * The command functions a source calls AS THE VERB UNDER TEST.
 *
 * Only the calls inside a verb spec's `variants` count: those are the
 * commands the harness actually puts a document through. The FIXTURE's calls
 * do not count — the fixture builds its clip with the lane's `add` verb, and
 * counting that would claim the add verb is exercised when the harness only
 * uses it to set the stage.
 *
 * An import alone does not count either (an unused import is not an
 * exercise), and a call of a name that was never imported does not count (a
 * local helper with the same name is not the command).
 */
function exercisedCommands(source: string, commandModulePrefix = "../../src/commands/"): Set<string> {
  const parsed = ts.createSourceFile("harness.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imported = new Set<string>();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.startsWith(commandModulePrefix)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) imported.add(element.name.text);
    }
  }
  const called = new Set<string>();
  const collectCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imported.has(node.expression.text)) {
      called.add(node.expression.text);
    }
    ts.forEachChild(node, collectCalls);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "variants") {
      collectCalls(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return called;
}

/**
 * The verbs the harness does NOT cover, and why.
 *
 * Every entry is a hole in the net, said out loud. A hole with a reason is
 * a decision; a hole without one is an oversight.
 */
const EXEMPT: Map<string, string> = new Map([
  [
    "deleteArrangementClip",
    "a delete is not an edit that preserves the clip — the harness's properties assume the clip survives",
  ],
  ["deleteMidiClip", "a delete is not an edit that preserves the clip"],
  ["deleteAutomationClip", "a delete is not an edit that preserves the clip"],
  ["deleteAudioClip", "a delete is not an edit that preserves the clip"],
  ["deleteArrangementClipRipple", "a delete is not an edit that preserves the clip"],
  ["setMidiClipLocked", "it touches no geometry — the harness's properties are geometric"],
  ["setAutomationClipLocked", "it touches no geometry — the harness's properties are geometric"],
  ["setClipsLocked", "it touches no geometry — the harness's properties are geometric"],
  ["toggleAudioClipsMute", "it touches no geometry — the harness's properties are geometric"],
  ["setArrangementClipLoop", "it sets a flag, not the geometry"],
  ["setArrangementClipScene", "it repoints the clip at another scene, not the geometry"],
  ["addArrangementClip", "an add CREATES a clip — the harness's properties are about an existing clip's geometry"],
  ["addMidiClip", "an add CREATES a clip — the harness's properties are about an existing clip's geometry"],
  ["addAutomationClip", "an add CREATES a clip — the harness's properties are about an existing clip's geometry"],
  ["addAudioClip", "an add CREATES a clip — the harness's properties are about an existing clip's geometry"],
  ["addAudioTakeClip", "an add CREATES a clip — the harness's properties are about an existing clip's geometry"],
  [
    "addAutomationClipFromLane",
    "an add CREATES a clip — the harness's properties are about an existing clip's geometry",
  ],
  ["createVariationAndPlaceClip", "it creates a scene AND places a clip — a creation path, not an edit"],
  ["moveAutomationClipPoint", "it moves a POINT inside a curve, not a clip"],
  ["nudgeClips", "it moves a SELECTION across lanes — the harness's lanes are one clip each"],
  ["pasteClips", "it pastes a SELECTION — the harness's lanes are one clip each"],
  ["duplicateClips", "it duplicates a SELECTION — the harness's lanes are one clip each"],
  ["splitAudioClipAtTickWithMinimumFragment", "a split variant with a fragment floor — the plain split is covered"],
  ["moveArrangementClipRipple", "it moves a clip AND RIPPLES its neighbours — the harness watches one clip"],
  ["resizeArrangementClipRipple", "it resizes a clip AND RIPPLES its neighbours — the harness watches one clip"],
]);

const HARNESS_PATH = join(process.cwd(), "tests", "helpers", "clip-verb-harness.ts");

describe("the coverage guard — a clip verb cannot land untested", () => {
  it("the detector is proven able to fail", () => {
    const synthetic = `
      export function resizeSomeClip(): void {}
      export function helperOfTheClip(): void {}
      function notExported(): void {}
    `;
    expect(
      [...exportedClipVerbs([{ file: "synthetic.ts", source: synthetic }])],
      "an exported clip verb must be found",
    ).toEqual(["resizeSomeClip"]);
    expect(
      [...exportedClipVerbs([{ file: "synthetic.ts", source: "// resizeSomeClip is only a comment" }])],
      "a comment must not count",
    ).toEqual([]);
    expect(
      exercisedCommands(
        `import { resizeSomeClip } from "../../src/commands/x";\nconst lane = { verbs: [{ variants: () => [{ build: () => resizeSomeClip(1) }] }] };`,
      ),
      "a command called inside a verb's variants must be found",
    ).toEqual(new Set(["resizeSomeClip"]));
    expect(
      exercisedCommands(
        `import { resizeSomeClip } from "../../src/commands/x";\nconst lane = { build: () => resizeSomeClip(1) };`,
      ),
      "a call in the FIXTURE does not count — the fixture only sets the stage",
    ).toEqual(new Set());
    expect(
      exercisedCommands(`import { resizeSomeClip } from "../../src/commands/x";`),
      "an unused import must not count",
    ).toEqual(new Set());
    expect(exercisedCommands(`resizeSomeClip(1);`), "a call of a name that was never imported must not count").toEqual(
      new Set(),
    );
  });

  it("every clip verb the command layer exports is exercised by the harness", () => {
    const dir = join(process.cwd(), "src", "commands");
    const sources = CLIP_COMMAND_MODULES.map((name) => ({
      file: name,
      source: readFileSync(join(dir, name), "utf8"),
    }));
    const exported = exportedClipVerbs(sources);
    const covered = exercisedCommands(readFileSync(HARNESS_PATH, "utf8"));
    const uncovered = [...exported].filter((verb) => !covered.has(verb) && !EXEMPT.has(verb)).sort();
    expect(
      uncovered,
      "a clip verb the command layer exports must be exercised by the harness, or be named in the exemption list with a reason",
    ).toEqual([]);
  });

  it("the exemption list is not stale — an exemption for a covered verb is a lie", () => {
    const covered = exercisedCommands(readFileSync(HARNESS_PATH, "utf8"));
    const stale = [...EXEMPT.keys()].filter((verb) => covered.has(verb)).sort();
    expect(
      stale,
      "these verbs ARE covered by the harness — remove them from the exemption list, so the list keeps saying what is not covered",
    ).toEqual([]);
  });

  it("the exemption list is not a dumping ground — every exemption says why", () => {
    for (const [verb, reason] of EXEMPT) {
      expect(reason.length, `${verb}: the exemption must say why`).toBeGreaterThan(20);
    }
  });
});
