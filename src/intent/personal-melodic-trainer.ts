/**
 * W3 — PERSONAL MELODIC PRIOR: in-browser fine-tuner
 * (docs/intent-killer-feature-plan.md W3 "Nauč sa ma").
 *
 * The shipped priors are tiny MLPs (18–28 kB), so fine-tuning the user's own
 * ★-kept rolls in the browser is a few seconds of plain JS — no cloud, no
 * Python, no manual artifact swap. This module is the training half; the
 * inference half lives in `personal-melodic-prior.ts`.
 *
 * DESIGN: fine-tune FROM THE SHIPPED WEIGHTS, never from scratch. Three
 * reasons, in order of importance:
 *   1. DETERMINISM — starting from shipped weights removes the RNG entirely
 *      (the python trainer's `rng.normal` init), so the same favorites always
 *      produce bit-identical parameters. The plan's "seeded like python" risk
 *      becomes "no RNG at all", which is strictly stronger.
 *   2. NO REGRESSION BY CONSTRUCTION — a personal model is a delta on a model
 *      that already works; it cannot be worse than the shipped prior, it can
 *      only be *more* the user. Training from scratch on a handful of ★
 *      would forget the whole library.
 *   3. SPEED — no zero-init of 9 tensors over a random draw, and fewer
 *      epochs are needed because the trunk already solves the hard part.
 *
 * The math is a faithful port of `scripts/train_symbolic_melodic_lib.py`
 * (Adam, class-weighted CE on both heads, label smoothing). The one thing
 * that is NOT copied is the double-weight bug the 2026-09-27 audit found and
 * fixed: both heads are weighted exactly once, matching the loss.
 *
 * Pure module: no DOM, no storage, no worker globals. `personal-melodic-
 * trainer.ts` (worker) and the tests own those concerns.
 */

export const PERSONAL_DEGREE_CLASSES = 8;
export const PERSONAL_DURATION_CLASSES = 4;
export const PERSONAL_EP0CHS_DEFAULT = 120;
export const PERSONAL_BATCH_DEFAULT = 64;
export const PERSONAL_LR_DEFAULT = 3e-3;
export const PERSONAL_LABEL_SMOOTHING = 0.1;
/** Below this many ★ entries a personal model is not worth installing. */
export const PERSONAL_MIN_ENTRIES = 3;

/** Flat parameter set, in the ONNX initializer order used by every trainer. */
export interface PersonalWeights {
  w0: Float32Array;
  b0: Float32Array;
  w1: Float32Array;
  b1: Float32Array;
  wd: Float32Array;
  bd: Float32Array;
  wt: Float32Array;
  bt: Float32Array;
}

export function weightsAreFinite(w: PersonalWeights): boolean {
  for (const tensor of [w.w0, w.b0, w.w1, w.b1, w.wd, w.bd, w.wt, w.bt]) {
    for (let i = 0; i < tensor.length; i++) if (!Number.isFinite(tensor[i])) return false;
  }
  return true;
}

/** Total parameter count — the honesty check for a "tiny model". */
export function parameterCount(w: PersonalWeights): number {
  return w.w0.length + w.b0.length + w.w1.length + w.b1.length + w.wd.length + w.bd.length + w.wt.length + w.bt.length;
}

/** Row-major copy so the trainer never mutates the shipped artifact's buffers. */
export function cloneWeights(w: PersonalWeights): PersonalWeights {
  return {
    w0: new Float32Array(w.w0),
    b0: new Float32Array(w.b0),
    w1: new Float32Array(w.w1),
    b1: new Float32Array(w.b1),
    wd: new Float32Array(w.wd),
    bd: new Float32Array(w.bd),
    wt: new Float32Array(w.wt),
    bt: new Float32Array(w.bt),
  };
}

// ── forward ──────────────────────────────────────────────────────────────────

function reluInPlace(tensor: Float32Array): void {
  for (let i = 0; i < tensor.length; i++) if (tensor[i] < 0) tensor[i] = 0;
}

/** Forward pass into caller-provided scratch buffers (no per-step allocation). */
export interface PersonalScratch {
  h0: Float32Array;
  h1: Float32Array;
  degree: Float32Array;
  duration: Float32Array;
}

export function allocateScratch(hidden: readonly [number, number]): PersonalScratch {
  const [h0Size, h1Size] = hidden;
  return {
    h0: new Float32Array(h0Size),
    h1: new Float32Array(h1Size),
    degree: new Float32Array(PERSONAL_DEGREE_CLASSES),
    duration: new Float32Array(PERSONAL_DURATION_CLASSES),
  };
}

/** Run one row through the trunk + both heads into `scratch`. */
export function forwardRow(
  weights: PersonalWeights,
  scratch: PersonalScratch,
  row: Float32Array,
  rowOffset: number,
  inputSize: number,
  hidden: readonly [number, number],
): void {
  const [h0Size, h1Size] = hidden;
  for (let i = 0; i < h0Size; i++) scratch.h0[i] = weights.b0[i];
  for (let k = 0; k < inputSize; k++) {
    const value = row[rowOffset + k];
    if (value === 0) continue;
    const wOffset = k * h0Size;
    for (let i = 0; i < h0Size; i++) scratch.h0[i] += value * weights.w0[wOffset + i];
  }
  reluInPlace(scratch.h0);

  for (let i = 0; i < h1Size; i++) scratch.h1[i] = weights.b1[i];
  for (let k = 0; k < h0Size; k++) {
    const value = scratch.h0[k];
    if (value === 0) continue;
    const wOffset = k * h1Size;
    for (let i = 0; i < h1Size; i++) scratch.h1[i] += value * weights.w1[wOffset + i];
  }
  reluInPlace(scratch.h1);

  for (let i = 0; i < PERSONAL_DEGREE_CLASSES; i++) scratch.degree[i] = weights.bd[i];
  for (let i = 0; i < PERSONAL_DURATION_CLASSES; i++) scratch.duration[i] = weights.bt[i];
  for (let k = 0; k < h1Size; k++) {
    const value = scratch.h1[k];
    if (value === 0) continue;
    const wdOffset = k * PERSONAL_DEGREE_CLASSES;
    const wtOffset = k * PERSONAL_DURATION_CLASSES;
    for (let i = 0; i < PERSONAL_DEGREE_CLASSES; i++) scratch.degree[i] += value * weights.wd[wdOffset + i];
    for (let i = 0; i < PERSONAL_DURATION_CLASSES; i++) scratch.duration[i] += value * weights.wt[wtOffset + i];
  }
}

/** Softmax in place (numerically stabilized, mirrors the python helper). */
function softmaxInPlace(logits: Float32Array): void {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    const value = Math.exp(logits[i] - max);
    logits[i] = value;
    sum += value;
  }
  for (let i = 0; i < logits.length; i++) logits[i] /= sum;
}

// ── class weights ────────────────────────────────────────────────────────────

/**
 * Inverse-frequency class weights with a tempering exponent (port of
 * `class_weights` in train_symbolic_melodic_lib.py). power 0.5 keeps a rare
 * class visible without letting it dominate — the value the retrain gate
 * measured.
 */
export function classWeights(labels: readonly number[], classCount: number, power = 0.5): Float32Array {
  const counts = new Array<number>(classCount).fill(0);
  let total = 0;
  for (const label of labels) {
    if (label >= 0 && label < classCount) {
      counts[label]++;
      total++;
    }
  }
  const weights = new Array<number>(classCount).fill(1);
  for (let c = 0; c < classCount; c++) {
    const raw = counts[c] > 0 ? total / counts[c] : 1;
    weights[c] = Math.pow(raw, power);
  }
  let max = 0;
  for (const w of weights) if (w > max) max = w;
  for (let c = 0; c < classCount; c++) weights[c] /= max;
  return Float32Array.from(weights);
}

// ── training ─────────────────────────────────────────────────────────────────

export interface PersonalTrainOptions {
  hidden: readonly [number, number];
  inputSize: number;
  epochs?: number;
  batchSize?: number;
  learningRate?: number;
  weightPower?: number;
  labelSmoothing?: number;
  /**
   * Deterministic batch order. Injected so the tests can pin an order and the
   * worker can use a seeded generator — the trainer itself never calls
   * Math.random (see the determinism note in the file header).
   */
  permutation: (count: number) => Uint32Array;
  onProgress?: (epoch: number, total: number, loss: number) => void;
}

export interface PersonalTrainResult {
  weights: PersonalWeights;
  /** Mean loss over all trained steps (both heads, class-weighted). */
  finalLoss: number;
  epochs: number;
  steps: number;
}

/**
 * Fine-tune `start` on (features, degreeLabel, durationLabel) triples.
 * Mutates a CLONE — the shipped weights are never touched.
 */
export function trainPersonalPrior(
  start: PersonalWeights,
  features: Float32Array,
  degreeLabels: Int32Array,
  durationLabels: Int32Array,
  options: PersonalTrainOptions,
): PersonalTrainResult {
  const weights = cloneWeights(start);
  const rows = degreeLabels.length;
  if (rows === 0) return { weights, finalLoss: 0, epochs: 0, steps: 0 };

  const { hidden, inputSize } = options;
  const epochs = options.epochs ?? PERSONAL_EP0CHS_DEFAULT;
  const batchSize = Math.max(1, options.batchSize ?? PERSONAL_BATCH_DEFAULT);
  const learningRate = options.learningRate ?? PERSONAL_LR_DEFAULT;
  const weightPower = options.weightPower ?? 0.5;
  const smoothing = options.labelSmoothing ?? PERSONAL_LABEL_SMOOTHING;
  const [h0Size, h1Size] = hidden;

  const degreeWeights = classWeights(Array.from(degreeLabels), PERSONAL_DEGREE_CLASSES, weightPower);
  const durationWeights = classWeights(Array.from(durationLabels), PERSONAL_DURATION_CLASSES, weightPower);

  // Adam state, one per parameter tensor (same layout as the python trainer).
  const tensors: Float32Array[] = [weights.w0, weights.b0, weights.w1, weights.b1, weights.wd, weights.bd, weights.wt, weights.bt];
  const firstMoments = tensors.map((t) => new Float32Array(t.length));
  const secondMoments = tensors.map((t) => new Float32Array(t.length));
  const gradients = tensors.map((t) => new Float32Array(t.length));

  const scratch = allocateScratch(hidden);
  const degreeProbs = new Float32Array(PERSONAL_DEGREE_CLASSES);
  const durationProbs = new Float32Array(PERSONAL_DURATION_CLASSES);
  const degreeDelta = new Float32Array(PERSONAL_DEGREE_CLASSES);
  const durationDelta = new Float32Array(PERSONAL_DURATION_CLASSES);
  const delta1 = new Float32Array(h1Size);
  const delta0 = new Float32Array(h0Size);

  let stepCount = 0;
  let lossSum = 0;
  let lossSteps = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const order = options.permutation(rows);
    for (let start = 0; start < order.length; start += batchSize) {
      const batch = order.subarray(start, Math.min(start + batchSize, order.length));
      const n = batch.length;
      for (const g of gradients) g.fill(0);
      let batchLoss = 0;

      for (let i = 0; i < n; i++) {
        const rowIndex = batch[i];
        const featureOffset = rowIndex * inputSize;
        forwardRow(weights, scratch, features, featureOffset, inputSize, hidden);
        for (let c = 0; c < PERSONAL_DEGREE_CLASSES; c++) degreeProbs[c] = scratch.degree[c];
        for (let c = 0; c < PERSONAL_DURATION_CLASSES; c++) durationProbs[c] = scratch.duration[c];
        softmaxInPlace(degreeProbs);
        softmaxInPlace(durationProbs);

        const degreeLabel = degreeLabels[rowIndex];
        const durationLabel = durationLabels[rowIndex];
        const wd = degreeWeights[degreeLabel];
        const wt = durationWeights[durationLabel];
        const eps = 1e-7;

        // Loss (class-weighted, label-smoothed) — the quantity the gradients
        // must actually descend.
        let degreeLoss = 0;
        for (let c = 0; c < PERSONAL_DEGREE_CLASSES; c++) {
          const target = c === degreeLabel ? 1 - smoothing + smoothing / PERSONAL_DEGREE_CLASSES : smoothing / PERSONAL_DEGREE_CLASSES;
          degreeLoss += -target * Math.log(degreeProbs[c] + eps);
        }
        let durationLoss = 0;
        for (let c = 0; c < PERSONAL_DURATION_CLASSES; c++) {
          const target =
            c === durationLabel ? 1 - smoothing + smoothing / PERSONAL_DURATION_CLASSES : smoothing / PERSONAL_DURATION_CLASSES;
          durationLoss += -target * Math.log(durationProbs[c] + eps);
        }
        batchLoss += (wd * degreeLoss + wt * durationLoss) / n;

        // Backward: BOTH heads weighted EXACTLY ONCE (the 2026-09-27 fix that
        // stopped the duration head collapsing onto the rarest class).
        const degreeScale = wd / n;
        const durationScale = wt / n;
        for (let c = 0; c < PERSONAL_DEGREE_CLASSES; c++) {
          const target = c === degreeLabel ? 1 - smoothing + smoothing / PERSONAL_DEGREE_CLASSES : smoothing / PERSONAL_DEGREE_CLASSES;
          degreeDelta[c] = (degreeProbs[c] - target) * degreeScale;
        }
        for (let c = 0; c < PERSONAL_DURATION_CLASSES; c++) {
          const target = c === durationLabel ? 1 - smoothing + smoothing / PERSONAL_DURATION_CLASSES : smoothing / PERSONAL_DURATION_CLASSES;
          durationDelta[c] = (durationProbs[c] - target) * durationScale;
        }

        // Head parameter gradients: dL/dW_d += h1 ⊗ d_degree.
        for (let k = 0; k < h1Size; k++) {
          const h1Value = scratch.h1[k];
          if (h1Value === 0) continue;
          const wdOffset = k * PERSONAL_DEGREE_CLASSES;
          const wtOffset = k * PERSONAL_DURATION_CLASSES;
          for (let c = 0; c < PERSONAL_DEGREE_CLASSES; c++) gradients[4][wdOffset + c] += h1Value * degreeDelta[c];
          for (let c = 0; c < PERSONAL_DURATION_CLASSES; c++) gradients[6][wtOffset + c] += h1Value * durationDelta[c];
        }
        for (let c = 0; c < PERSONAL_DEGREE_CLASSES; c++) gradients[5][c] += degreeDelta[c];
        for (let c = 0; c < PERSONAL_DURATION_CLASSES; c++) gradients[7][c] += durationDelta[c];

        // Trunk gradient into h1: (d_degree · wd + d_duration · wt) masked by h1 > 0.
        for (let c = 0; c < h1Size; c++) delta1[c] = 0;
        for (let k = 0; k < h1Size; k++) {
          let acc = 0;
          const wdOffset = k * PERSONAL_DEGREE_CLASSES;
          const wtOffset = k * PERSONAL_DURATION_CLASSES;
          for (let c = 0; c < PERSONAL_DEGREE_CLASSES; c++) acc += degreeDelta[c] * weights.wd[wdOffset + c];
          for (let c = 0; c < PERSONAL_DURATION_CLASSES; c++) acc += durationDelta[c] * weights.wt[wtOffset + c];
          delta1[k] = scratch.h1[k] > 0 ? acc : 0;
        }

        // Into h0: (delta1 · w1) masked by h0 > 0.
        for (let c = 0; c < h0Size; c++) delta0[c] = 0;
        for (let k = 0; k < h0Size; k++) {
          if (scratch.h0[k] === 0) continue;
          const w1Offset = k * h1Size;
          for (let c = 0; c < h1Size; c++) delta0[c] += delta1[c] * weights.w1[w1Offset + c];
        }
        for (let k = 0; k < h0Size; k++) {
          if (scratch.h0[k] === 0) continue;
          const w0Offset = k * inputSize;
          for (let i = 0; i < inputSize; i++) {
            const xValue = features[featureOffset + i];
            if (xValue === 0) continue;
            gradients[0][w0Offset + i] += xValue * delta0[k];
          }
          gradients[1][k] += delta0[k];
        }
      }

      lossSum += batchLoss;
      lossSteps++;

      stepCount++;
      const beta1 = 0.9;
      const beta2 = 0.999;
      const adamEps = 1e-8;
      const biasCorrection1 = 1 - Math.pow(beta1, stepCount);
      const biasCorrection2 = 1 - Math.pow(beta2, stepCount);
      for (let t = 0; t < tensors.length; t++) {
        const param = tensors[t];
        const grad = gradients[t];
        const m = firstMoments[t];
        const v = secondMoments[t];
        for (let i = 0; i < param.length; i++) {
          const g = grad[i];
          m[i] = beta1 * m[i] + (1 - beta1) * g;
          v[i] = beta2 * v[i] + (1 - beta2) * g * g;
          const mHat = m[i] / biasCorrection1;
          const vHat = v[i] / biasCorrection2;
          param[i] -= learningRate * mHat / (Math.sqrt(vHat) + adamEps);
        }
      }
    }
    options.onProgress?.(epoch + 1, epochs, lossSum / Math.max(1, lossSteps));
  }

  if (!weightsAreFinite(weights)) {
    throw new Error("personal training diverged (non-finite weights) — kept the shipped prior");
  }
  return { weights, finalLoss: lossSum / Math.max(1, lossSteps), epochs, steps: stepCount };
}
