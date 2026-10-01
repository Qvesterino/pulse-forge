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
import { createProjectFromTemplate } from "../src/project-model/templates";
import { PRODUCTION_CONCEPTS } from "../src/intent/production";
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
    expect(validateModelAction({ kind: "clips", ops: [{ op: "copyClip", ref: "intro", toBar: 9 }] }).valid).toBe(true);
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

describe("production concept drift guard (failure-mining 2026-10-01)", () => {
  it("every parser concept is a valid model schema concept", () => {
    // The production applier handles every PRODUCTION_CONCEPTS entry
    // (exhaustive switch); the schema enum must accept all of them or a
    // valid model action is rejected before routing. "sub" shipped only
    // in the parser — the corpus row "more sub in the mix" validated
    // false and was silently dropped.
    for (const concept of PRODUCTION_CONCEPTS) {
      const result = validateModelAction({
        kind: "production",
        targets: ["bass"],
        goals: [{ concept, amount: 0.7 }],
      });
      expect(result.valid, `concept "${concept}" must validate`).toBe(true);
    }
  });

  it("the schema still rejects concepts outside the applier surface", () => {
    expect(
      validateModelAction({
        kind: "production",
        targets: ["bass"],
        goals: [{ concept: "definitely-not-a-concept", amount: 0.7 }],
      }).valid,
    ).toBe(false);
  });

  it("the corpus production rows all validate against the schema", () => {
    // Miner follow-up: teacher rows the schema rejects are silent
    // training-target corruption — pin the whole corpus clean.
    for (const split of ["train", "val", "golden"]) {
      const lines = readFileSync(path.join(process.cwd(), "scripts", "data", "intent-sft", `${split}.jsonl`), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "");
      for (const line of lines) {
        const row = JSON.parse(line) as { instruction: string; response: unknown };
        const result = validateModelAction(row.response);
        expect(result.valid, `${split}: "${row.instruction}" → ${result.errors.join("; ")}`).toBe(true);
      }
    }
  });
});

describe("ONNX vocab ↔ schema drift guard (failure-mining wave 3)", () => {
  const MODELS_DIR = path.join(process.cwd(), "public", "models");

  it("every kind class the ONNX head can emit is a valid schema kind", () => {
    // The decoder may only produce kinds the schema validates — a class in
    // vocab but not in MODEL_ACTIONS would decode and then be rejected,
    // silently dropping the action at runtime.
    const vocab = JSON.parse(readFileSync(path.join(MODELS_DIR, "intent-model-v1.vocab.json"), "utf8")) as {
      heads: Array<{ name: string; classes: string[] }>;
    };
    const kindHead = vocab.heads.find((head) => head.name === "kind");
    expect(kindHead).toBeDefined();
    for (const className of kindHead!.classes) {
      if (className === "abstain") continue;
      expect(Object.keys(MODEL_ACTIONS), `vocab kind "${className}" must be schema-valid`).toContain(className);
    }
  });

  it("reports corpus-taught kinds the kind head cannot emit (visible, not failing)", () => {
    // Structural gap detector for the trainer: rows teaching a kind the
    // closed kind-head has no class for can only ever decode as the nearest
    // in-vocab kind (wrongKind) or abstain — no amount of training fixes a
    // missing class. Failure-mining wave 3 measured exactly this shape:
    // val "duplicate the intro" (arrange) decoded as exact/duplicateTrack
    // because the kind head lacks arrange/compound/clarify/preset classes.
    const vocab = JSON.parse(readFileSync(path.join(MODELS_DIR, "intent-model-v1.vocab.json"), "utf8")) as {
      heads: Array<{ name: string; classes: string[] }>;
    };
    const emittable = new Set(vocab.heads.find((head) => head.name === "kind")!.classes);
    const taught = new Set<string>();
    for (const split of ["train", "val", "golden"]) {
      const lines = readFileSync(path.join(process.cwd(), "scripts", "data", "intent-sft", `${split}.jsonl`), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "");
      for (const line of lines) taught.add(String((JSON.parse(line) as { response: { kind: string } }).response.kind));
    }
    const gaps = [...taught].filter((kind) => !emittable.has(kind)).sort();
    // Warn loudly every run — the trainer decides whether the gap is
    // contract (out-of-scope v1 kinds abstain by design) or debt.
    if (gaps.length > 0) {
      console.warn(
        `[intent-vocab] kind head cannot emit ${gaps.length} corpus-taught kind(s): ${gaps.join(", ")} — rows of these kinds can only abstain or decode as a wrong kind`,
      );
    }
    expect(Array.isArray(gaps)).toBe(true);
  });
});
