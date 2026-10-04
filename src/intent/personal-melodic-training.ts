import {
  PERSONAL_MIN_ENTRIES,
  trainPersonalPrior,
  PERSONAL_LABEL_SMOOTHING,
  type PersonalTrainResult,
  type PersonalTrainOptions,
  type PersonalWeights,
} from "./personal-melodic-trainer";
import {
  personalWeightsToJson,
  personalWeightsFromJson,
  personalWeightsFromOnnx,
  type PersonalWeightsPayload,
} from "./personal-melodic-onnx";
import { personalInferenceFromPayload, runPersonalNext } from "./personal-melodic-inference";
import { favoritesToMelodicSamples, type FavoriteLedgerEntry } from "./favorites-core";
import type { FavoriteLedgerEntry as LedgerEntry } from "./favorites-core";
import { structuredStyleVector } from "./structured-style-vector";

/**
 * W3 "Nauč sa ma" — the personal-prior training flow.
 *
 * ledger → training set → fine-tune from the shipped weights → A/B PROOF →
 * install. Every step is pure and returns an honest status; nothing here
 * touches storage (the caller does) or the DOM.
 *
 * The A/B proof is the gate the plan asks for ("the new model would pick your
 * ★ in X of Y cases"). It is measured, never asserted: the personal model and
 * the shipped one each predict every ★ context, and we count who got the
 * user's own kept note right. A model that does not beat the shipped prior is
 * reported as such and the caller is expected NOT to install it — that rule
 * lives in `shouldInstallPersonalModel` so it cannot be skipped by a caller in
 * a hurry.
 */

export interface PersonalTrainRequest {
  /** The shipped ONNX bytes (already fetched by the caller). */
  shippedOnnx: Uint8Array;
  manifest: {
    kind: string;
    featureCount: number;
    degreeClasses: number;
    durationClasses: number;
    hidden: readonly [number, number];
    modelHash: string;
  };
  entries: readonly FavoriteLedgerEntry[];
  epochs?: number;
  batchSize?: number;
  learningRate?: number;
  /** Progress callback (epoch, total, running loss). */
  onProgress?: (epoch: number, total: number, loss: number) => void;
}

export type PersonalTrainStatus =
  /** Not enough ★ yet — the UI shows the minimum and stops. */
  | { ok: false; reason: "not-enough-favorites"; needed: number; have: number }
  /** A ledger entry has no recorded key, so pitch→degree inversion is impossible. */
  | { ok: false; reason: "no-usable-entries"; skipped: number }
  /** The shipped bytes do not match the manifest architecture. */
  | { ok: false; reason: "shipped-model-mismatch"; detail: string }
  | {
      ok: true;
      result: PersonalTrainResult;
      payload: PersonalWeightsPayload;
      /** Measured proof: personal top-1 hits across the user's ★ contexts. */
      proof: PersonalProof;
    };

export interface PersonalProof {
  /** ★ contexts where the personal model's argmax matches the kept note. */
  personalHits: number;
  /** …and where the shipped model's does (the bar to beat). */
  shippedHits: number;
  cases: number;
}

/** The install gate: enough data AND the personal model actually wins more. */
export function shouldInstallPersonalModel(proof: PersonalProof, favoritesUsed: number): { ok: boolean; why: string } {
  if (favoritesUsed < PERSONAL_MIN_ENTRIES) {
    return { ok: false, why: `need at least ${PERSONAL_MIN_ENTRIES} ★` };
  }
  if (proof.cases === 0) return { ok: false, why: "no usable ★ contexts to prove against" };
  const rate = proof.personalHits / proof.cases;
  if (rate < 0.7) {
    return { ok: false, why: `personal top-1 ${(rate * 100).toFixed(0)}% — below the 70 % bar` };
  }
  if (proof.personalHits <= proof.shippedHits) {
    return { ok: false, why: "personal model does not beat the shipped prior" };
  }
  return { ok: true, why: `personal top-1 ${(rate * 100).toFixed(0)}% on your ★` };
}

/**
 * Build the ★ training set at the SHIPPED model's feature width.
 *
 * The favorites conversion (`favoritesToMelodicSamples`) produces v1 29-dim
 * rows. A v2/v3 shipped model expects the semantic-conditioned layout, so the
 * genre one-hot block (4 dims) is swapped for a 16-dim structured style vector
 * — the same swap the offline trainer performs in `--embedding` mode, just
 * resolved locally through `style-embeddings.json` instead of MiniLM (the
 * user's own ★ does not need the 118 MB embedder to train a personal model).
 */
function trainingSetFrom(
  entries: readonly FavoriteLedgerEntry[],
  featureCount: number,
): { features: Float32Array; degree: Int32Array; duration: Int32Array; samples: number; skipped: number } {
  const usable = entries.filter((entry) => Array.isArray(entry.melodic) && entry.melodic.length > 0 && entry.key);
  const rows: number[][] = [];
  const degree: number[] = [];
  const duration: number[] = [];
  let skipped = 0;

  for (const entry of usable) {
    // Per-entry conversion so each row can carry ITS entry's conditioning.
    const samples = favoritesToMelodicSamples([entry as LedgerEntry], 1);
    if (samples.length === 0) {
      skipped += 1;
      continue;
    }
    let semantic: number[] | null = null;
    if (featureCount !== 29) {
      try {
        semantic =
          structuredStyleVector({
            genre: entry.genre,
            style: entry.style ?? (entry.grooveId.includes(".") ? entry.grooveId.split(".")[1] : null),
          }) ?? null;
      } catch {
        semantic = null;
      }
    }
    for (const sample of samples) {
      if (sample.x.length !== 29) {
        // The favorites converter is contract-pinned to v1; if that ever
        // changes, fail loudly rather than train on a misinterpreted row.
        throw new Error(`favorite row width ${sample.x.length} != expected 29 (melodic-features.v1)`);
      }
      const row = semantic ? [...semantic, ...sample.x.slice(4)] : sample.x;
      if (row.length !== featureCount) {
        throw new Error(`personal row width ${row.length} != shipped featureCount ${featureCount}`);
      }
      rows.push(row);
      degree.push(sample.degree);
      duration.push(sample.duration);
    }
  }

  const features = new Float32Array(rows.length * featureCount);
  for (let i = 0; i < rows.length; i++) features.set(rows[i], i * featureCount);
  return {
    features,
    degree: Int32Array.from(degree),
    duration: Int32Array.from(duration),
    samples: rows.length,
    skipped,
  };
}

/**
 * Deterministic batch order. Seeded Fisher-Yates from a FNV-1a hash of the
 * entry set — the same permutation for the same ledger, so two runs from the
 * same ★ produce the same personal model.
 */
function seededPermutation(seedText: string): (count: number) => Uint32Array {
  return (count: number) => {
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    let seed = 0x811c9dc5;
    for (let i = 0; i < seedText.length; i++) {
      seed ^= seedText.charCodeAt(i);
      seed = Math.imul(seed, 0x01000193) >>> 0;
    }
    for (let i = count - 1; i > 0; i--) {
      // xorshift32 — deterministic, no Math.random anywhere on this path.
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      const j = seed % (i + 1);
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    return order;
  };
}

function seedTextFor(request: PersonalTrainRequest, entries: readonly FavoriteLedgerEntry[]): string {
  return `${request.manifest.modelHash}|${request.manifest.kind}|${entries.map((e) => e.seed).join(",")}`;
}

/** Top-1 agreement of a model against every ★ row's true label. */
function countHits(
  weights: PersonalWeights,
  featureCount: number,
  manifest: PersonalTrainRequest["manifest"],
  features: Float32Array,
  degree: Int32Array,
  duration: Int32Array,
): { degreeHits: number; durationHits: number } {
  const model = personalInferenceFromPayload(personalWeightsFromOnnxLike(weights, manifest, featureCount));
  const result = runPersonalNext(model, features, degree.length);
  if (!result) return { degreeHits: 0, durationHits: 0 };
  let degreeHits = 0;
  let durationHits = 0;
  for (let row = 0; row < degree.length; row++) {
    let best = 0;
    for (let c = 1; c < result.degree[row].length; c++) {
      if (result.degree[row][c] > result.degree[row][best]) best = c;
    }
    if (best === degree[row]) degreeHits++;
    let bestDuration = 0;
    for (let c = 1; c < result.duration[row].length; c++) {
      if (result.duration[row][c] > result.duration[row][bestDuration]) bestDuration = c;
    }
    if (bestDuration === duration[row]) durationHits++;
  }
  return { degreeHits, durationHits };
}

/** Wrap raw tensors in the payload shape the inference layer consumes. */
function personalWeightsFromOnnxLike(
  weights: PersonalWeights,
  manifest: PersonalTrainRequest["manifest"],
  featureCount: number,
): {
  hidden: [number, number];
  featureCount: number;
  degreeClasses: number;
  durationClasses: number;
  w0: number[];
  b0: number[];
  w1: number[];
  b1: number[];
  wd: number[];
  bd: number[];
  wt: number[];
  bt: number[];
} {
  const encode = (t: Float32Array) => Array.from(t, (v) => Math.fround(v));
  return {
    hidden: [manifest.hidden[0], manifest.hidden[1]],
    featureCount,
    degreeClasses: manifest.degreeClasses,
    durationClasses: manifest.durationClasses,
    w0: encode(weights.w0),
    b0: encode(weights.b0),
    w1: encode(weights.w1),
    b1: encode(weights.b1),
    wd: encode(weights.wd),
    bd: encode(weights.bd),
    wt: encode(weights.wt),
    bt: encode(weights.bt),
  };
}

/** Full flow: ledger → trained payload + A/B proof. Never throws. */
export function trainPersonalModel(request: PersonalTrainRequest): PersonalTrainStatus {
  try {
    const entries = request.entries;
    if (entries.length < PERSONAL_MIN_ENTRIES) {
      return {
        ok: false,
        reason: "not-enough-favorites",
        needed: PERSONAL_MIN_ENTRIES,
        have: entries.length,
      };
    }

    // The shipped weights are the STARTING POINT (see personal-melodic-trainer).
    let shipped: PersonalWeights;
    try {
      shipped = personalWeightsFromOnnx(
        request.shippedOnnx,
        request.manifest.hidden,
        request.manifest.degreeClasses,
        request.manifest.durationClasses,
      );
    } catch (error) {
      return {
        ok: false,
        reason: "shipped-model-mismatch",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const set = trainingSetFrom(entries, request.manifest.featureCount);
    if (set.samples === 0) {
      return { ok: false, reason: "no-usable-entries", skipped: set.skipped };
    }

    const options: PersonalTrainOptions = {
      hidden: request.manifest.hidden,
      inputSize: request.manifest.featureCount,
      epochs: request.epochs,
      batchSize: request.batchSize,
      learningRate: request.learningRate,
      labelSmoothing: PERSONAL_LABEL_SMOOTHING,
      permutation: seededPermutation(seedTextFor(request, entries)),
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    };
    const result = trainPersonalPrior(shipped, set.features, set.degree, set.duration, options);

    const payloadJson = personalWeightsToJson(result.weights, {
      hidden: [request.manifest.hidden[0], request.manifest.hidden[1]],
      featureCount: request.manifest.featureCount,
      degreeClasses: request.manifest.degreeClasses,
      durationClasses: request.manifest.durationClasses,
      baseKind: request.manifest.kind,
      baseModelHash: request.manifest.modelHash,
    });
    const payload = personalWeightsFromJson(JSON.parse(payloadJson));
    if (!payload) {
      return { ok: false, reason: "shipped-model-mismatch", detail: "trained payload failed validation" };
    }

    // The proof: personal vs shipped on the user's own ★ rows.
    const personalHits = countHits(
      result.weights,
      request.manifest.featureCount,
      request.manifest,
      set.features,
      set.degree,
      set.duration,
    );
    const shippedHits = countHits(
      shipped,
      request.manifest.featureCount,
      request.manifest,
      set.features,
      set.degree,
      set.duration,
    );
    const proof: PersonalProof = {
      personalHits: personalHits.degreeHits,
      shippedHits: shippedHits.degreeHits,
      cases: set.samples,
    };

    return { ok: true, result, payload, proof };
  } catch (error) {
    return {
      ok: false,
      reason: "shipped-model-mismatch",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
