import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MODEL_ACTIONS,
  VOCAB,
  toGbnfGrammar,
  validateModelAction,
  validateModelOutputForDoc,
} from "../src/intent/model-schema";
import { routeIntentText } from "../src/intent/route";
import { compactIntentResponse } from "../src/intent/dataset";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { addArrangementClip, createScene, setSceneRole } from "../src/commands/commands";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * LOCAL INTENT MODEL schema tests — the contract that makes a 1.2B-class
 * model viable: every action the deterministic engine can produce validates
 * against the model-facing schema (the model's output space ⊇ the teacher's),
 * the GBNF grammar exists for every enum, and hand-written MODEL-form
 * examples validate and carry the fields the engine adapts.
 */
function datasetDoc(): ProjectDocument {
  useDeterministicIds();
  resetDeterministicIds();
  let doc = createProjectFromTemplate("house");
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] }, markers: [] };
  doc = createScene(doc, "Intro").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "intro").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 0, 4).execute(doc);
  doc = createScene(doc, "Drop").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "drop").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 4, 4).execute(doc);
  return doc;
}

function readDataset(file: string): Array<{ instruction: string; response: Record<string, unknown> }> {
  return readFileSync(path.join(process.cwd(), "scripts", "data", "intent-sft", file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { instruction: string; response: Record<string, unknown> });
}

describe("local intent model schema", () => {
  const doc = datasetDoc();
  const pairs = [...readDataset("train.jsonl"), ...readDataset("val.jsonl"), ...readDataset("golden.jsonl")];

  it("every dataset action (all kinds) validates against the model schema", () => {
    expect(pairs.length).toBeGreaterThanOrEqual(190);
    const failures: string[] = [];
    for (const pair of pairs) {
      const result = validateModelAction(pair.response);
      if (!result.valid) failures.push(`${pair.instruction}: ${result.errors.join("; ")}`);
    }
    expect(failures).toEqual([]);
  });

  it("engine-filled fields are allowed extras, never errors", () => {
    const withExtras = {
      kind: "fader",
      intent: { targets: ["bass"], direction: "down", amount: "normal", matchedBy: "x" },
      detected: ["zníž basu"],
    };
    const result = validateModelAction(withExtras);
    expect(result.valid).toBe(true);
    expect(result.extras.length).toBeGreaterThan(0);
  });

  it("invalid model output is caught precisely", () => {
    expect(validateModelAction({ kind: "warp9" }).valid).toBe(false);
    expect(validateModelAction({ kind: "fader", direction: "sideways" }).valid).toBe(false);
    const result = validateModelAction({ kind: "fader", targets: ["bass"], direction: "set", percent: 250 });
    expect(result.valid).toBe(false);
    expect(result.errors.join("; ")).toContain("out of range");
    expect(validateModelAction(null).valid).toBe(false);
    expect(validateModelOutputForDoc({ kind: "save" }, doc).valid).toBe(true);
  });

  it("hand-written MODEL-form examples validate (what we ask the model for)", () => {
    // minimal fader — pads/amount optional, engine fills defaults
    expect(validateModelAction({ kind: "fader", targets: ["bass"], direction: "down" }).valid).toBe(true);
    // preset by NAME (engine resolves the id)
    expect(validateModelAction({ kind: "preset", name: "Warm Sub", target: "bass" }).valid).toBe(true);
    // clips by REF (engine resolves the id)
    expect(
      validateModelAction({ kind: "clips", ops: [{ op: "copyClip", ref: "intro", toBar: 9 }] }).valid,
    ).toBe(true);
    // send with explicit level
    expect(
      validateModelAction({ kind: "sendIntent", effectType: "delay", target: "bass", direction: "set", percent: 40 })
        .valid,
    ).toBe(true);
    // production with goals — amount on the ENGINE's 0..1 scale
    expect(
      validateModelAction({
        kind: "production",
        targets: ["drums"],
        goals: [{ concept: "darker", amount: 0.7 }],
      }).valid,
    ).toBe(true);
  });

  it("the GBNF grammar covers every kind and every enum value", () => {
    const grammar = toGbnfGrammar();
    expect(grammar).toMatch(/^root ::= /);
    for (const kind of VOCAB.kind) {
      expect(grammar).toContain(`${kind} ::=`);
    }
    // spot-check enum values from different vocabularies
    expect(grammar).toContain('"bass"');
    expect(grammar).toContain('"metronomeOn"');
    expect(grammar).toContain('"punchier"');
    expect(grammar).toContain('"copyClip"');
    expect(grammar).toContain('"duplicateTrack"');
    // every MODEL_ACTIONS slot rule exists
    for (const [kind, spec] of Object.entries(MODEL_ACTIONS)) {
      for (const slot of spec.slots) {
        expect(grammar).toContain(`${kind}-${slot.name} ::=`);
      }
    }
  });
});
