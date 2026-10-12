/**
 * Audits the shipped action-model contract across TypeScript schema, Python
 * trainer, decoder, ONNX vocabulary, and the exact dataset snapshot used by
 * the artifact. This is a diagnostic report; it never changes the active
 * model, manifest, or dataset.
 *
 * Run: npx vite-node scripts/audit-intent-model-contract.mts [--out <path>]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ACTIONS } from "../src/intent/model-schema";
import type { IntentModelVocab } from "../src/intent/model-decoder";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_DIR = path.join(ROOT, "public", "models");
const DATA_DIR = path.join(ROOT, "scripts", "data", "intent-sft");
const TRAINER_PATH = path.join(ROOT, "scripts", "train-intent-model.py");
const DECODER_PATH = path.join(ROOT, "src", "intent", "model-decoder.ts");
const SCHEMA_PATH = path.join(ROOT, "src", "intent", "model-schema.ts");
const MODEL_PATH = path.join(MODEL_DIR, "intent-model-v1.onnx");
const VOCAB_PATH = path.join(MODEL_DIR, "intent-model-v1.vocab.json");
const MODEL_MANIFEST_PATH = path.join(MODEL_DIR, "intent-model-v1.manifest.json");
const DATA_MANIFEST_PATH = path.join(DATA_DIR, "manifest.json");

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const readJson = <T,>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

interface HeadSpec {
  name: string;
  kind: string;
  classes: string[];
}

interface ModelManifest {
  intentModelVersion?: string;
  model?: { url?: string; bytes?: number; sha256?: string };
  features?: { vocabSha256?: string; heads?: HeadSpec[] };
  report?: {
    gatePassed?: boolean;
    trainRows?: number;
    valRows?: number;
    goldenRows?: number;
    trainingInputs?: {
      datasetVersion?: number;
      datasetManifestSha256?: string;
      trainSha256?: string;
      valSha256?: string;
      goldenSha256?: string;
      trainerSha256?: string;
    };
  };
}

interface DatasetManifest {
  datasetVersion?: number;
  total?: number;
  train?: number;
  val?: number;
  golden?: number;
}

const trainerSource = readFileSync(TRAINER_PATH, "utf8");
const decoderSource = readFileSync(DECODER_PATH, "utf8");
const schemaSource = readFileSync(SCHEMA_PATH, "utf8");
const trainerKindsBlock = trainerSource.match(/\bKINDS\s*=\s*\[([\s\S]*?)\]/u)?.[1];
if (!trainerKindsBlock) throw new Error("Could not locate the trainer KINDS list");
const trainerKinds = new Set(Array.from(trainerKindsBlock.matchAll(/"([^"]+)"/gu), (match) => match[1]));

function decoderCaseKinds(source: string): Set<string> {
  const entry = source.indexOf("export function decodeIntentHeads");
  const switchStart = source.indexOf("switch (kind) {", entry);
  if (entry < 0 || switchStart < 0) throw new Error("Could not locate decodeIntentHeads kind switch");
  const openBrace = source.indexOf("{", switchStart);
  let depth = 0;
  let closeBrace = -1;
  for (let index = openBrace; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        closeBrace = index;
        break;
      }
    }
  }
  if (closeBrace < 0) throw new Error("Could not find the end of decodeIntentHeads kind switch");
  const body = source.slice(openBrace + 1, closeBrace);
  return new Set(Array.from(body.matchAll(/\bcase\s+"([^"]+)"\s*:/gu), (match) => match[1]));
}

const decoderKinds = decoderCaseKinds(decoderSource);
const vocab = readJson<IntentModelVocab>(VOCAB_PATH);
const kindHead = vocab.heads.find((head) => head.name === "kind");
if (!kindHead) throw new Error("ONNX vocabulary has no kind head");
const artifactKinds = new Set(kindHead.classes.filter((kind) => kind !== "abstain"));
const artifactHeadNames = new Set(vocab.heads.map((head) => head.name));

// Decoder outputs consumed for each kind. This map deliberately lives in the
// audit so it can compare required outputs with the artifact before anyone
// assumes that a schema kind is actually model-supported.
const decoderHeadsByKind: Record<string, string[]> = {
  fader: ["direction", "targets", "pads", "amount", "percent"],
  exact: [
    "exactOp",
    "targets_one",
    "boolValue",
    "panValue",
    "bpm",
    "key",
    "deltaDb",
    "semitones",
    "steps",
    "trackKind",
    "instrument",
    "trackName",
  ],
  transport: ["transportAction"],
  save: [],
  export: ["exportFormat"],
  record: ["boolValue"],
  select: ["selectTarget"],
  preset: ["presetId", "presetName", "targets_one"],
  effectIntent: ["effectType", "direction", "targets", "amount", "percent"],
  sendIntent: ["effectType", "direction", "targets_one", "percent"],
  bypassIntent: ["effectType", "targets_one", "boolValue"],
  mix: ["mixReverb", "mixTone", "mixPunch", "mixPump"],
  loudness: ["direction", "targetDb"],
  tempo: ["direction", "bpm"],
  production: ["prodConcept", "prodAmount", "targets"],
  revise: ["reviseAttribute", "direction", "targetRole"],
  arrange: ["arrangeOp", "arrangeRole", "arrangeBars"],
  clips: ["clipOp", "clipToBar", "clipBars"],
  compound: [
    "part1Direction",
    "part1Target",
    "part1Percent",
    "part1Amount",
    "part1Pads",
    "part2Direction",
    "part2Target",
    "part2Percent",
    "part2Amount",
    "part2Pads",
  ],
  clarify: [],
  presetUnknown: [],
  stepEdit: [],
  soundSwap: [],
};

const manifest = readJson<ModelManifest>(MODEL_MANIFEST_PATH);
const datasetManifest = readJson<DatasetManifest>(DATA_MANIFEST_PATH);
const splitFiles = ["train.jsonl", "val.jsonl", "golden.jsonl"] as const;
const splitBytes = Object.fromEntries(
  splitFiles.map((name) => [name, readFileSync(path.join(DATA_DIR, name))]),
) as Record<(typeof splitFiles)[number], Buffer>;
const splitRows = Object.fromEntries(
  splitFiles.map((name) => [
    name,
    splitBytes[name]
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length,
  ]),
) as Record<(typeof splitFiles)[number], number>;
const modelBytes = readFileSync(MODEL_PATH);
const vocabBytes = readFileSync(VOCAB_PATH);
const trainingInputs = manifest.report?.trainingInputs;
const currentHashes = {
  datasetManifestSha256: sha256(readFileSync(DATA_MANIFEST_PATH)),
  trainSha256: sha256(splitBytes["train.jsonl"]),
  valSha256: sha256(splitBytes["val.jsonl"]),
  goldenSha256: sha256(splitBytes["golden.jsonl"]),
};
const hashMatches = Object.fromEntries(
  Object.entries(currentHashes).map(([key, value]) => [
    key,
    trainingInputs?.[key as keyof typeof currentHashes] === value,
  ]),
);
const reportRows = {
  train: manifest.report?.trainRows === splitRows["train.jsonl"],
  val: manifest.report?.valRows === splitRows["val.jsonl"],
  golden: manifest.report?.goldenRows === splitRows["golden.jsonl"],
};

const kinds = Object.keys(MODEL_ACTIONS)
  .sort()
  .map((kind) => {
    const requiredHeads = decoderHeadsByKind[kind] ?? [];
    const missingHeads = requiredHeads.filter((head) => !artifactHeadNames.has(head));
    const inTrainer = trainerKinds.has(kind);
    const inArtifact = artifactKinds.has(kind);
    const inDecoder = decoderKinds.has(kind);
    const mode =
      !inTrainer || !inArtifact || !inDecoder
        ? "not-end-to-end"
        : missingHeads.length > 0
          ? "kind-only-or-incomplete"
          : requiredHeads.length === 0
            ? "kind-only"
            : "heads-present";
    return {
      kind,
      schemaSlots: MODEL_ACTIONS[kind].slots.map((slot) => ({
        name: slot.name,
        type: slot.type,
        required: slot.required !== false,
      })),
      trainerKind: inTrainer,
      artifactKind: inArtifact,
      decoderCase: inDecoder,
      requiredHeads,
      missingArtifactHeads: missingHeads,
      mode,
    };
  });

const modelHash = sha256(modelBytes);
const vocabHash = sha256(vocabBytes);
const report = {
  schemaVersion: 1,
  kind: "intent-model-contract-audit",
  generatedAt: new Date().toISOString(),
  purpose: "Diagnostic only. Does not promote, replace, or modify the active model.",
  activeModel: {
    version: manifest.intentModelVersion ?? null,
    bytes: modelBytes.byteLength,
    sha256: modelHash,
    manifestModelHashMatches: manifest.model?.sha256 === modelHash,
    manifestVocabHashMatches: manifest.features?.vocabSha256 === vocabHash,
    gatePassed: manifest.report?.gatePassed ?? false,
    vocabSize: vocab.tokens.length,
    headCount: vocab.heads.length,
    heads: vocab.heads.map((head) => head.name),
  },
  dataset: {
    version: datasetManifest.datasetVersion ?? null,
    manifestCounts: {
      train: datasetManifest.train ?? null,
      val: datasetManifest.val ?? null,
      golden: datasetManifest.golden ?? null,
      total: datasetManifest.total ?? null,
    },
    fileCounts: splitRows,
    currentHashes,
    artifactTrainingHashes: trainingInputs ?? null,
    trainingHashMatches: hashMatches,
    trainingRowCountsMatch: reportRows,
    snapshotMatchesArtifact: Object.values(hashMatches).every(Boolean) && Object.values(reportRows).every(Boolean),
  },
  sourceHashes: {
    schema: sha256(schemaSource),
    decoder: sha256(decoderSource),
    trainer: sha256(trainerSource),
  },
  kinds,
  summary: {
    schemaKinds: kinds.length,
    trainerKinds: trainerKinds.size,
    artifactKinds: artifactKinds.size,
    decoderKinds: decoderKinds.size,
    missingFromTrainer: kinds.filter((entry) => !entry.trainerKind).map((entry) => entry.kind),
    missingFromArtifact: kinds.filter((entry) => !entry.artifactKind).map((entry) => entry.kind),
    missingDecoderCases: kinds.filter((entry) => !entry.decoderCase).map((entry) => entry.kind),
    incompleteHeads: kinds.filter((entry) => entry.missingArtifactHeads.length > 0).map((entry) => entry.kind),
  },
};

const outIndex = process.argv.indexOf("--out");
if (outIndex >= 0) {
  const out = path.resolve(process.argv[outIndex + 1] ?? "");
  if (!process.argv[outIndex + 1]) throw new Error("--out requires a file path");
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`intent model contract audit written: ${path.relative(ROOT, out)}`);
} else {
  console.log(JSON.stringify(report, null, 2));
}
