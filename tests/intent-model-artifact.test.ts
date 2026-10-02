import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { toGbnfGrammar } from "../src/intent/model-schema";
import { isIntentModelManifest, manifestGatePassed } from "../src/intent/model-loader-types";
import {
  buildIntentBow,
  expandIntentFeatures,
  canonicalModelJson,
  decodeIntentHeads,
  tokenizeIntentInstruction,
  type IntentModelVocab,
} from "../src/intent/model-decoder";

/**
 * LOCAL INTENT MODEL — ARTIFACT LOCK (AGENTS.md "Adding a new AI model",
 * step 2 + 5). The committed artifact triple (onnx + vocab + manifest) must
 * stay coherent WITH THIS BUILD:
 *
 *   - the manifest's grammarSha256 must equal sha256 of the LIVE
 *     toGbnfGrammar() — any action-vocabulary change fails this test and
 *     forces the documented retrain (npm run intent-model:all);
 *   - model + vocab hashes/bytes must match the manifest pins;
 *   - the release-gate verdict must be an explicit boolean — the loader
 *     refuses to register the model unless validate-intent-model.mts
 *     patched gatePassed=true (an artifact that exists is not an artifact
 *     that may act).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_DIR = path.join(ROOT, "public", "models");
const SFT_DATA_DIR = path.join(ROOT, "scripts", "data", "intent-sft");
const VALIDATION_REPORT_PATH = path.join(ROOT, "scripts", "data", "intent-model-validation-report.json");

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

interface ValidationReport {
  schemaVersion: number;
  kind: string;
  taskBoundary: string;
  model: {
    modelSha256: string;
    vocabularySha256: string;
    grammarSha256: string;
    trainingReport: {
      trainRows: number | null;
      valRows: number | null;
      goldenRows: number | null;
      trainingDataContentHashPinned: boolean;
      trainingInputs: unknown;
    };
  };
  evaluationDataset: {
    manifestSha256: string;
    splits: Record<string, { rows: number; sha256: string }>;
    exactInstructionOverlap: {
      trainVal: number;
      trainGolden: number;
      valGolden: number;
      goldenIsIndependentHoldout: boolean;
      candidateFamilyDisjointnessVerified: boolean;
    };
    trainingReportRowCountsMatch: boolean;
  };
  evaluator: { validatorSha256: string; decoderSha256: string; schemaSourceSha256: string };
  metrics: {
    val: { rows: number; attempted: number; exact: number; wrongKind: number; abstain: number };
    goldenRegressionSuite: { rows: number; attempted: number; exact: number; wrongKind: number; abstain: number };
  };
  gate: { passed: boolean; releaseGateEligible: boolean };
  claims: { actionIntentOnly: boolean; independentGeneralizationEvidence: boolean; musicalQualityEvidence: boolean };
}

function instructionKeys(file: string): Set<string> {
  return new Set(
    readFileSync(path.join(SFT_DATA_DIR, file), "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const row = JSON.parse(line) as { instruction: string };
        return row.instruction.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
      }),
  );
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let overlap = 0;
  for (const key of a) if (b.has(key)) overlap += 1;
  return overlap;
}

describe("intent model artifact lock", () => {
  const manifestPath = path.join(MODELS_DIR, "intent-model-v1.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReturnType<typeof JSON.parse> & {
    features: { vocabSha256: string; vocabSize: number; inputName: string; outputNames: string[] };
    report: { gatePassed: boolean; validationReportPath: string; validationReportSha256: string };
  };
  const validationReportBytes = readFileSync(VALIDATION_REPORT_PATH);
  const validationReport = JSON.parse(validationReportBytes.toString("utf8")) as ValidationReport;

  it("the manifest is schema-valid and pins THIS build's grammar (the drift guard)", () => {
    expect(isIntentModelManifest(manifest)).toBe(true);
    expect(manifest.grammarSha256.toLowerCase()).toBe(sha256(toGbnfGrammar()));
  });

  it("model + vocab artifacts match the manifest pins", () => {
    const modelBytes = readFileSync(path.join(MODELS_DIR, "intent-model-v1.onnx"));
    expect(modelBytes.byteLength).toBe(manifest.model.bytes);
    expect(sha256(modelBytes)).toBe(manifest.model.sha256.toLowerCase());

    const vocabBytes = readFileSync(path.join(MODELS_DIR, "intent-model-v1.vocab.json"));
    expect(sha256(vocabBytes)).toBe(manifest.features.vocabSha256.toLowerCase());
    const vocab = JSON.parse(vocabBytes.toString("utf8")) as IntentModelVocab;
    expect(vocab.tokens.length).toBe(manifest.features.vocabSize);
    expect(vocab.heads.map((head) => `head_${head.name}`)).toEqual(manifest.features.outputNames);
    // the native ONNX backend resolves the vocab through the manifest pin
    expect(manifest.features.url).toBe("/models/intent-model-v1.vocab.json");
  });

  it("the release-gate verdict is explicit (loader refuses models without it)", () => {
    expect(typeof manifest.report.gatePassed).toBe("boolean");
    expect(manifestGatePassed(manifest)).toBe(manifest.report.gatePassed === true);
  });

  it("pins validation metrics to the exact model, dataset splits, decoder, and evaluator", () => {
    expect(validationReport.schemaVersion).toBe(1);
    expect(validationReport.kind).toBe("intent-action-model-validation");
    expect(validationReport.taskBoundary).toContain("not a creative-brief or musical-quality evaluation");
    expect(validationReport.model.modelSha256).toBe(manifest.model.sha256);
    expect(validationReport.model.vocabularySha256).toBe(manifest.features.vocabSha256);
    expect(validationReport.model.grammarSha256).toBe(manifest.grammarSha256);
    expect(validationReport.evaluator.validatorSha256).toBe(
      sha256(readFileSync(path.join(ROOT, "scripts", "validate-intent-model.mts"))),
    );
    expect(validationReport.evaluator.decoderSha256).toBe(
      sha256(readFileSync(path.join(ROOT, "src", "intent", "model-decoder.ts"))),
    );
    expect(validationReport.evaluator.schemaSourceSha256).toBe(
      sha256(readFileSync(path.join(ROOT, "src", "intent", "model-schema.ts"))),
    );
    expect(validationReport.evaluationDataset.manifestSha256).toBe(
      sha256(readFileSync(path.join(SFT_DATA_DIR, "manifest.json"))),
    );
    for (const split of ["train", "val", "golden"]) {
      expect(validationReport.evaluationDataset.splits[split].sha256).toBe(
        sha256(readFileSync(path.join(SFT_DATA_DIR, split + ".jsonl"))),
      );
    }
    expect(validationReport.model.trainingReport.trainRows).toBe(manifest.report.trainRows);
    expect(validationReport.model.trainingReport.valRows).toBe(manifest.report.valRows);
    expect(validationReport.model.trainingReport.goldenRows).toBe(manifest.report.goldenRows);
    expect(validationReport.model.trainingReport.trainingDataContentHashPinned).toBe(
      manifest.report.trainingDataContentHashPinned === true,
    );
    expect(validationReport.model.trainingReport.trainingInputs).toEqual(manifest.report.trainingInputs ?? null);
    expect(validationReport.evaluationDataset.trainingReportRowCountsMatch).toBe(
      manifest.report.trainRows === validationReport.evaluationDataset.splits.train.rows &&
        manifest.report.valRows === validationReport.evaluationDataset.splits.val.rows &&
        manifest.report.goldenRows === validationReport.evaluationDataset.splits.golden.rows,
    );
    expect(manifest.report.validationReportPath).toBe("scripts/data/intent-model-validation-report.json");
    expect(manifest.report.validationReportSha256).toBe(sha256(validationReportBytes));
    expect(manifest.report.gatePassed).toBe(validationReport.gate.passed && validationReport.gate.releaseGateEligible);
  });

  it("labels overlapping golden prompts as regression coverage, never generalization evidence", () => {
    const train = instructionKeys("train.jsonl");
    const val = instructionKeys("val.jsonl");
    const golden = instructionKeys("golden.jsonl");
    expect(validationReport.evaluationDataset.exactInstructionOverlap.trainVal).toBe(overlapCount(train, val));
    expect(validationReport.evaluationDataset.exactInstructionOverlap.trainGolden).toBe(overlapCount(train, golden));
    expect(validationReport.evaluationDataset.exactInstructionOverlap.valGolden).toBe(overlapCount(val, golden));
    expect(validationReport.evaluationDataset.exactInstructionOverlap.goldenIsIndependentHoldout).toBe(false);
    expect(validationReport.evaluationDataset.exactInstructionOverlap.candidateFamilyDisjointnessVerified).toBe(false);
    expect(validationReport.claims.actionIntentOnly).toBe(true);
    expect(validationReport.claims.independentGeneralizationEvidence).toBe(false);
    expect(validationReport.claims.musicalQualityEvidence).toBe(false);
  });

  it("the ONNX graph input/output names match the manifest", async () => {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.wasmPaths = pathToFileURL(path.join(ROOT, "node_modules", "onnxruntime-web", "dist", path.sep)).href;
    ort.env.wasm.numThreads = 1;
    const modelBytes = readFileSync(path.join(MODELS_DIR, "intent-model-v1.onnx"));
    const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
      executionProviders: ["wasm"],
    });
    expect(session.inputNames[0]).toBe(manifest.features.inputName);
    for (const name of manifest.features.outputNames) {
      expect(session.outputNames).toContain(name);
    }
  });
});

describe("intent model decoder contract", () => {
  const vocab = JSON.parse(
    readFileSync(path.join(MODELS_DIR, "intent-model-v1.vocab.json"), "utf8"),
  ) as IntentModelVocab;

  it("tokenizer + BoW are deterministic and vocab-shaped", () => {
    expect(tokenizeIntentInstruction("Zníž BASU o 25 %")).toEqual(["zniz", "basu", "o", "25", "%"]);
    const bow = buildIntentBow("mute the drums", vocab.tokens);
    expect(bow.length).toBe(vocab.tokens.length);
    const again = buildIntentBow("mute the drums", vocab.tokens);
    expect(Array.from(bow)).toEqual(Array.from(again));
  });

  it("decodes head outputs into the compact action form (fader)", () => {
    const head = (name: string) => vocab.heads.find((candidate) => candidate.name === name)!;
    const one = (name: string, cls: string) => {
      const scores = new Float32Array(head(name).classes.length);
      scores[head(name).classes.indexOf(cls)] = 5;
      return scores;
    };
    const targets = new Float32Array(head("targets").classes.length).fill(-5);
    targets[head("targets").classes.indexOf("drums")] = 5; // saturated: positive active, negatives far below
    const outputs: Record<string, Float32Array> = {
      head_kind: one("kind", "fader"),
      head_direction: one("direction", "down"),
      head_targets: targets,
      head_pads: new Float32Array(head("pads").classes.length).fill(-5),
      head_amount: one("amount", "normal"),
      head_percent: one("percent", "__absent__"),
    };
    const decoded = decodeIntentHeads(outputs, vocab);
    expect(canonicalModelJson(decoded)).toBe(
      canonicalModelJson({
        kind: "fader",
        intent: { targets: ["drums"], pads: [], direction: "down", amount: "normal" },
      }),
    );
  });

  it("a flat kind distribution abstains (margin rule) — never a guess", () => {
    const head = (name: string) => vocab.heads.find((candidate) => candidate.name === name)!;
    const flat = new Float32Array(head("kind").classes.length).fill(-600);
    flat[head("kind").classes.indexOf("fader")] = -599.4; // top margin 0.6 < 1.0
    const outputs: Record<string, Float32Array> = { head_kind: flat };
    expect(decodeIntentHeads(outputs, vocab)).toBeNull();
  });

  it("out-of-scope kinds decode to an explicit abstain", () => {
    // Failure-mining wave 3: preset/compound/arrange/clips/clarify became
    // IN-SCOPE (the trainer's KINDS now mirrors MODEL_ACTIONS), so the
    // out-of-scope set is the schema kinds the corpus does not teach.
    const head = (name: string) => vocab.heads.find((candidate) => candidate.name === name)!;
    const one = (name: string, cls: string) => {
      const scores = new Float32Array(head(name).classes.length);
      scores[head(name).classes.indexOf(cls)] = 5;
      return scores;
    };
    expect(decodeIntentHeads({ head_kind: one("kind", "stepEdit") }, vocab)).toBeNull();
    expect(decodeIntentHeads({ head_kind: one("kind", "soundSwap") }, vocab)).toBeNull();
  });
});

describe("arrange decode contract (sequence-student phase 1)", () => {
  const vocab = JSON.parse(
    readFileSync(path.join(MODELS_DIR, "intent-model-v1.vocab.json"), "utf8"),
  ) as IntentModelVocab;
  // Rolling-artifact guard (same philosophy as the decoder's head guards):
  // the part/clip-head artifact set is not the shipped one — the sparse-head
  // wave destabilized the shared trunk (measured: val head mean 0.9893 →
  // 0.9303) and was reverted pending corpus growth. These tests activate
  // only when an artifact actually trains those heads.
  const hasPartHeads = true; // sparse-head corpus wave returned the part/clip heads
  const head = (name: string) => vocab.heads.find((candidate) => candidate.name === name)!;
  const one = (name: string, cls: string) => {
    const scores = new Float32Array(head(name).classes.length);
    scores[head(name).classes.indexOf(cls)] = 5;
    return scores;
  };
  const absent = (name: string) => one(name, "__absent__");
  // The decoder reads the shared multi-label bags before the kind switch.
  const emptySigmoid = (name: string) => new Float32Array(head(name).classes.length).fill(-5);

  it("decodes a single-op arrange resize from the arrange heads", () => {
    const outputs: Record<string, Float32Array> = {
      head_kind: one("kind", "arrange"),
      head_targets: emptySigmoid("targets"),
      head_pads: emptySigmoid("pads"),
      head_arrangeOp: one("arrangeOp", "resize"),
      head_arrangeRole: one("arrangeRole", "intro"),
      head_arrangeBars: one("arrangeBars", "2"),
    };
    expect(canonicalModelJson(decodeIntentHeads(outputs, vocab))).toBe(
      canonicalModelJson({ kind: "arrange", ops: [{ op: "resize", role: "intro", bars: 2 }] }),
    );
  });

  it("autoArrange needs no role/bars; resize without bars abstains", () => {
    const auto: Record<string, Float32Array> = {
      head_kind: one("kind", "arrange"),
      head_targets: emptySigmoid("targets"),
      head_pads: emptySigmoid("pads"),
      head_arrangeOp: one("arrangeOp", "autoArrange"),
      head_arrangeRole: absent("arrangeRole"),
      head_arrangeBars: absent("arrangeBars"),
    };
    expect(canonicalModelJson(decodeIntentHeads(auto, vocab))).toBe(
      canonicalModelJson({ kind: "arrange", ops: [{ op: "autoArrange" }] }),
    );
    const noBars: Record<string, Float32Array> = {
      head_kind: one("kind", "arrange"),
      head_targets: emptySigmoid("targets"),
      head_pads: emptySigmoid("pads"),
      head_arrangeOp: one("arrangeOp", "resize"),
      head_arrangeRole: one("arrangeRole", "drop"),
      head_arrangeBars: absent("arrangeBars"),
    };
    expect(decodeIntentHeads(noBars, vocab)).toBeNull();
  });

  it("the op-form strip ignores engine-resolved fields in the truth comparison", () => {
    // The engine fills sceneId/name/beforeSceneId when ROUTING; the model
    // can only ever know the model-form op. canonicalModelJson strips those
    // keys on op-form objects so decode-vs-truth rewards the contract.
    const decoded = { kind: "arrange", ops: [{ op: "duplicate", role: "intro" }] };
    const routed = {
      kind: "arrange",
      ops: [{ op: "duplicate", role: "intro", sceneId: "scene-x", name: "Intro" }],
    };
    expect(canonicalModelJson(decoded)).toBe(canonicalModelJson(routed));
    // …but a flat renameTrack payload keeps its name slot.
    const rename = { kind: "exact", ops: [{ kind: "renameTrack", target: "bass", name: "sub" }] };
    expect(canonicalModelJson(rename)).toContain('"name":"sub"');
  });

  it.skipIf(!hasPartHeads)("decodes a two-fader compound from the part heads (sequence-student phase 2)", () => {
    const outputs: Record<string, Float32Array> = {
      head_kind: one("kind", "compound"),
      head_targets: emptySigmoid("targets"),
      head_pads: emptySigmoid("pads"),
      head_part1Direction: one("part1Direction", "set"),
      head_part1Target: one("part1Target", "bass"),
      head_part1Percent: one("part1Percent", "50"),
      head_part1Amount: absent("part1Amount"),
      head_part1Pads: emptySigmoid("part1Pads"),
      head_part2Direction: one("part2Direction", "up"),
      head_part2Target: one("part2Target", "lead"),
      head_part2Percent: absent("part2Percent"),
      head_part2Amount: one("part2Amount", "normal"),
      head_part2Pads: emptySigmoid("part2Pads"),
    };
    expect(canonicalModelJson(decodeIntentHeads(outputs, vocab))).toBe(
      canonicalModelJson({
        kind: "compound",
        parts: [
          { kind: "fader", intent: { direction: "set", pads: [], percent: 50, targets: ["bass"] } },
          { kind: "fader", intent: { amount: "normal", direction: "up", pads: [], targets: ["lead"] } },
        ],
      }),
    );
  });

  it.skipIf(!hasPartHeads)(
    "a compound with a missing/invalid part hands off as a bare kind — never a partial apply",
    () => {
      const base: Record<string, Float32Array> = {
        head_kind: one("kind", "compound"),
        head_targets: emptySigmoid("targets"),
        head_pads: emptySigmoid("pads"),
        head_part1Direction: one("part1Direction", "up"),
        head_part1Target: one("part1Target", "lead"),
        head_part1Percent: absent("part1Percent"),
        head_part1Amount: one("part1Amount", "normal"),
        head_part1Pads: emptySigmoid("part1Pads"),
      };
      // part2 direction absent → the second part cannot be built → bare-kind
      // handoff (the resolver refuses the empty route; never a partial apply).
      expect(
        canonicalModelJson(
          decodeIntentHeads(
            {
              ...base,
              head_part2Direction: absent("part2Direction"),
              head_part2Target: one("part2Target", "bass"),
              head_part2Percent: absent("part2Percent"),
              head_part2Amount: absent("part2Amount"),
              head_part2Pads: emptySigmoid("part2Pads"),
            },
            vocab,
          ),
        ),
      ).toBe(canonicalModelJson({ kind: "compound" }));
      // both amount and percent absent on part1 → a guess → bare-kind handoff.
      expect(
        canonicalModelJson(
          decodeIntentHeads(
            {
              ...base,
              head_part1Percent: absent("part1Percent"),
              head_part1Amount: absent("part1Amount"),
              head_part2Direction: one("part2Direction", "up"),
              head_part2Target: one("part2Target", "bass"),
              head_part2Percent: absent("part2Percent"),
              head_part2Amount: absent("part2Amount"),
              head_part2Pads: emptySigmoid("part2Pads"),
            },
            vocab,
          ),
        ),
      ).toBe(canonicalModelJson({ kind: "compound" }));
    },
  );

  it.skipIf(!hasPartHeads)("decodes single-op clips (clipId is engine-resolved and stripped)", () => {
    const clips: Record<string, Float32Array> = {
      head_kind: one("kind", "clips"),
      head_targets: emptySigmoid("targets"),
      head_pads: emptySigmoid("pads"),
      head_clipOp: one("clipOp", "copyClip"),
      head_clipToBar: one("clipToBar", "9"),
      head_clipBars: absent("clipBars"),
    };
    expect(canonicalModelJson(decodeIntentHeads(clips, vocab))).toBe(
      canonicalModelJson({ kind: "clips", ops: [{ op: "copyClip", toBar: 9 }] }),
    );
    // …and it compares equal to the ENGINE-FORM truth (clipId stripped).
    expect(canonicalModelJson({ kind: "clips", ops: [{ op: "copyClip", clipId: "clip-x", toBar: 9 }] })).toBe(
      canonicalModelJson({ kind: "clips", ops: [{ op: "copyClip", toBar: 9 }] }),
    );
  });

  it("an older vocab without arrange heads abstains instead of throwing", () => {
    const stripped = {
      ...vocab,
      heads: vocab.heads.filter((candidate) => !candidate.name.startsWith("arrange")),
    };
    const outputs: Record<string, Float32Array> = {
      head_kind: one("kind", "arrange"),
      head_targets: emptySigmoid("targets"),
      head_pads: emptySigmoid("pads"),
    };
    expect(decodeIntentHeads(outputs, stripped as typeof vocab)).toBeNull();
  });
});

describe("expandIntentFeatures (intent-features.v2)", () => {
  it("unigrams + bigrams + char 3-grams over the padded word", () => {
    const features = expandIntentFeatures(["turn", "down"]);
    expect(features).toContain("turn");
    expect(features).toContain("down");
    expect(features).toContain("turn_down");
    expect(features).toContain("^tu");
    expect(features).toContain("wn$");
    expect(features).toContain("^tur");
    expect(features).toContain("own$");
  });

  it("char grams carry the fuzzy read: a typo keeps most of its signature", () => {
    const clean = new Set(expandIntentFeatures(tokenizeIntentInstruction("turn down the drums")));
    const typo = expandIntentFeatures(tokenizeIntentInstruction("turn downn the drums"));
    const shared = typo.filter((f) => clean.has(f)).length;
    expect(shared / typo.length).toBeGreaterThan(0.6);
  });

  it("buildIntentBow stays binary over the expanded feature vocab", () => {
    const tokens = expandIntentFeatures(tokenizeIntentInstruction("turn down the drums")).slice(0, 50);
    const bow = buildIntentBow("turn DOWN the drums", tokens);
    expect(bow.length).toBe(tokens.length);
    for (const v of bow) expect(v === 0 || v === 1).toBe(true);
  });
});
