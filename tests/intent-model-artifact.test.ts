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

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

describe("intent model artifact lock", () => {
  const manifestPath = path.join(MODELS_DIR, "intent-model-v1.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReturnType<typeof JSON.parse> & {
    features: { vocabSha256: string; vocabSize: number; inputName: string; outputNames: string[] };
    report: { gatePassed: boolean };
  };

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
    const head = (name: string) => vocab.heads.find((candidate) => candidate.name === name)!;
    const one = (name: string, cls: string) => {
      const scores = new Float32Array(head(name).classes.length);
      scores[head(name).classes.indexOf(cls)] = 5;
      return scores;
    };
    expect(decodeIntentHeads({ head_kind: one("kind", "preset") }, vocab)).toBeNull();
    expect(decodeIntentHeads({ head_kind: one("kind", "compound") }, vocab)).toBeNull();
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
