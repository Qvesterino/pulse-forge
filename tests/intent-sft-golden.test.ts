import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { addArrangementClip, createScene, setSceneRole } from "../src/commands/commands";
import { routeIntentText } from "../src/intent/route";
import { compactIntentResponse } from "../src/intent/dataset";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * SFT GOLDEN LOCK — the training target for the "LLM as sound engineer"
 * distillation is the deterministic intent layer. This suite pins the golden
 * subset of (instruction → canonical action) pairs: if a parser change moves
 * a golden response, the diff IS the review — the training data moved with
 * it, and the model must be re-trained on the new teacher.
 *
 * Mirrors datasetDoc() in scripts/generate-intent-dataset.mts exactly.
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

interface SftPair {
  instruction: string;
  lang: "en" | "sk";
  response: Record<string, unknown>;
}

const GOLDEN_PATH = path.join(process.cwd(), "scripts", "data", "intent-sft", "golden.jsonl");
const TRAIN_PATH = path.join(process.cwd(), "scripts", "data", "intent-sft", "train.jsonl");
const MANIFEST_PATH = path.join(process.cwd(), "scripts", "data", "intent-sft", "manifest.json");

function readJsonl(file: string): SftPair[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SftPair);
}

describe("intent SFT dataset (LLM-as-sound-engineer distillation)", () => {
  const doc = datasetDoc();
  const golden = readJsonl(GOLDEN_PATH);
  const train = readJsonl(TRAIN_PATH);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    datasetVersion: number;
    total: number;
    train: number;
    val: number;
    golden: number;
    kinds: Record<string, number>;
  };

  it("every golden pair re-routes to the EXACT same canonical action", () => {
    expect(golden.length).toBeGreaterThanOrEqual(40);
    for (const pair of golden) {
      const now = compactIntentResponse(routeIntentText(pair.instruction, doc));
      expect(JSON.stringify(now)).toBe(JSON.stringify(pair.response));
    }
  });

  it("dataset invariants: no pattern commands, deduped, deterministic, SK present", () => {
    for (const pair of [...train, ...golden]) {
      expect(pair.response.kind).not.toBe("pattern");
      expect(pair.instruction.length).toBeGreaterThan(0);
    }
    const instructions = new Set(train.map((p) => p.instruction.toLowerCase()));
    expect(instructions.size).toBe(train.length);
    // determinism: re-route everything twice, byte-identical
    for (const pair of train.slice(0, 40)) {
      const once = compactIntentResponse(routeIntentText(pair.instruction, doc));
      const twice = compactIntentResponse(routeIntentText(pair.instruction, doc));
      expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
      expect(JSON.stringify(once)).toBe(JSON.stringify(pair.response));
    }
    const skCount = [...train, ...golden].filter((p) => p.lang === "sk").length;
    expect(skCount).toBeGreaterThanOrEqual(30);
    // manifest agrees with the files
    expect(manifest.train).toBe(train.length);
    expect(manifest.golden).toBe(golden.length);
    expect(manifest.kinds["pattern"]).toBeUndefined();
  });

  it("the command set covers the DAW surface (kinds the model must learn)", () => {
    const kinds = new Set([...train, ...golden].map((p) => String(p.response.kind)));
    for (const kind of [
      "fader",
      "exact",
      "transport",
      "save",
      "export",
      "record",
      "select",
      "preset",
      "effectIntent",
      "sendIntent",
      "bypassIntent",
      "arrange",
      "clips",
      "compound",
      "production",
      "revise",
      "mix",
      "loudness",
      "tempo",
      "clarify",
    ]) {
      expect(kinds.has(kind)).toBe(true);
    }
  });
});
