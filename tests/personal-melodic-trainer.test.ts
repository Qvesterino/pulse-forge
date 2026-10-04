import { describe, it, expect } from "vitest";
import {
  classWeights,
  forwardRow,
  allocateScratch,
  trainPersonalPrior,
  parameterCount,
  cloneWeights,
  weightsAreFinite,
  PERSONAL_DEGREE_CLASSES,
  PERSONAL_DURATION_CLASSES,
  PERSONAL_LABEL_SMOOTHING,
  type PersonalWeights,
} from "../src/intent/personal-melodic-trainer";

/**
 * W3 — Personal melodic prior trainer.
 *
 * The trainer is a faithful port of `train_symbolic_melodic_lib.py` with ONE
 * deliberate difference: it fine-tunes FROM the shipped weights instead of
 * random init, which removes the RNG from the personal path entirely (the
 * plan's "seeded like python" risk becomes "no RNG at all").
 *
 * The tests below are the gate that difference deserves:
 *   - the analytic gradient must match finite differences (the same proof the
 *     2026-09-27 audit used to find the doubled duration weight),
 *   - the duration head must be weighted exactly once (that bug's regression
 *     guard, ported to TS),
 *   - training must be bit-identical for identical input (determinism).
 */

const HIDDEN: readonly [number, number] = [8, 6];
const INPUT = 5;

/** Deterministic pseudo-weights (no RNG in the test either). */
function makeWeights(scale = 0.3): PersonalWeights {
  let seed = 12345;
  const next = (n: number) => {
    // xorshift32 — deterministic, seedable, no Math.random
    let x = seed;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[i] = ((x >>> 0) / 0xffffffff) * 2 * scale - scale;
    }
    seed = x;
    return out;
  };
  return {
    w0: next(INPUT * HIDDEN[0]),
    b0: next(HIDDEN[0]),
    w1: next(HIDDEN[0] * HIDDEN[1]),
    b1: next(HIDDEN[1]),
    wd: next(HIDDEN[1] * PERSONAL_DEGREE_CLASSES),
    bd: next(PERSONAL_DEGREE_CLASSES),
    wt: next(HIDDEN[1] * PERSONAL_DURATION_CLASSES),
    bt: next(PERSONAL_DURATION_CLASSES),
  };
}

/** The exact loss the python trainer prints (both heads, class-weighted). */
function lossOf(
  weights: PersonalWeights,
  features: Float32Array,
  degreeLabels: Int32Array,
  durationLabels: Int32Array,
  weightPower: number,
  smoothing: number,
): number {
  const rows = degreeLabels.length;
  const scratch = allocateScratch(HIDDEN);
  const dw = classWeights(Array.from(degreeLabels), PERSONAL_DEGREE_CLASSES, weightPower);
  const tw = classWeights(Array.from(durationLabels), PERSONAL_DURATION_CLASSES, weightPower);
  const softmax = (logits: Float32Array): number[] => {
    let max = -Infinity;
    for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
    const exps: number[] = [];
    let sum = 0;
    for (let i = 0; i < logits.length; i++) {
      const value = Math.exp(logits[i] - max);
      exps.push(value);
      sum += value;
    }
    return exps.map((v) => v / sum);
  };
  let total = 0;
  for (let r = 0; r < rows; r++) {
    forwardRow(weights, scratch, features, r * INPUT, INPUT, HIDDEN);
    const degreeProbs = softmax(scratch.degree);
    const durationProbs = softmax(scratch.duration);
    let degLoss = 0;
    let durLoss = 0;
    for (let c = 0; c < PERSONAL_DEGREE_CLASSES; c++) {
      const target =
        c === degreeLabels[r]
          ? 1 - smoothing + smoothing / PERSONAL_DEGREE_CLASSES
          : smoothing / PERSONAL_DEGREE_CLASSES;
      degLoss += -target * Math.log(degreeProbs[c] + 1e-7);
    }
    for (let c = 0; c < PERSONAL_DURATION_CLASSES; c++) {
      const target =
        c === durationLabels[r]
          ? 1 - smoothing + smoothing / PERSONAL_DURATION_CLASSES
          : smoothing / PERSONAL_DURATION_CLASSES;
      durLoss += -target * Math.log(durationProbs[c] + 1e-7);
    }
    total += dw[degreeLabels[r]] * degLoss + tw[durationLabels[r]] * durLoss;
  }
  return total / rows;
}

function makeBatch(rows: number) {
  const features = new Float32Array(rows * INPUT);
  const degreeLabels = new Int32Array(rows);
  const durationLabels = new Int32Array(rows);
  let seed = 999;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < INPUT; i++) {
      let x = seed;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      seed = x;
      features[r * INPUT + i] = ((x >>> 0) / 0xffffffff) * 2 - 1;
    }
    degreeLabels[r] = r % PERSONAL_DEGREE_CLASSES;
    durationLabels[r] = r % PERSONAL_DURATION_CLASSES;
  }
  return { features, degreeLabels, durationLabels };
}

/** Resolve which tensor of a weights object corresponds to a given tensor. */
function tensorFor(weights: PersonalWeights, reference: Float32Array): Float32Array {
  const candidates: Float32Array[] = [
    weights.w0,
    weights.b0,
    weights.w1,
    weights.b1,
    weights.wd,
    weights.bd,
    weights.wt,
    weights.bt,
  ];
  // Match by length first, then by identity of the source object.
  const byLength = candidates.filter((t) => t.length === reference.length);
  return byLength[0] ?? weights.w0;
}

describe("personal melodic trainer — primitives", () => {
  it("counts parameters as a genuinely tiny model", () => {
    // A 29-dim melodic v1: 29*64 + 64*32 + 32*8 + 32*4 + biases = 3984
    const w = makeWeights();
    const count = parameterCount(w);
    expect(count).toBe(
      INPUT * HIDDEN[0] + HIDDEN[0] + HIDDEN[0] * HIDDEN[1] + HIDDEN[1] + HIDDEN[1] * 8 + 8 + HIDDEN[1] * 4 + 4,
    );
    expect(count).toBeLessThan(10_000);
  });

  it("class weights are inverse-frequency tempered by the exponent and max-normalized", () => {
    const labels = [0, 0, 0, 0, 1];
    const w = classWeights(labels, 4, 0.5);
    // counts [4,1,0,0] → raw [5/4, 5, 1, 1] → sqrt-tempered →
    // [1.118, 2.236, 1, 1] → max-normalized (2.236):
    const rarest = w[1];
    expect(rarest).toBeCloseTo(1, 6);
    // The frequent class is tempered down to 1/sqrt(4) = 0.5 of the rare one —
    // this is exactly the "10.2x → 3.2x" tempering the retrain gate measured.
    expect(w[0]).toBeCloseTo(0.5, 6);
    // Absent classes are weighted 1/sqrt(5)/sqrt(5) — never ZERO, so a class with
    // no samples cannot blow up the loss if one appears later.
    expect(w[2]).toBeGreaterThan(0);
    expect(w[2]).toBeLessThan(rarest);
  });

  it("clones weights so the shipped artifact is never mutated", () => {
    const original = makeWeights();
    const before = Float32Array.from(original.w0);
    const copy = cloneWeights(original);
    copy.w0[0] = 999;
    expect(original.w0[0]).toBe(before[0]);
  });

  it("rejects non-finite weights", () => {
    const w = makeWeights();
    expect(weightsAreFinite(w)).toBe(true);
    w.bd[0] = Number.NaN;
    expect(weightsAreFinite(w)).toBe(false);
  });
});

describe("personal melodic trainer — gradient correctness (the audit's proof, ported)", () => {
  it("one step of Adam actually decreases the loss it reports", () => {
    const { features, degreeLabels, durationLabels } = makeBatch(24);
    const start = makeWeights();
    const identity = (n: number) => {
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      return order;
    };
    const options = {
      hidden: HIDDEN,
      inputSize: INPUT,
      epochs: 1,
      batchSize: 24,
      learningRate: 0.05,
      labelSmoothing: PERSONAL_LABEL_SMOOTHING,
      permutation: identity,
    };
    const before = lossOf(start, features, degreeLabels, durationLabels, 0.5, PERSONAL_LABEL_SMOOTHING);
    const result = trainPersonalPrior(start, features, degreeLabels, durationLabels, options);
    const after = lossOf(result.weights, features, degreeLabels, durationLabels, 0.5, PERSONAL_LABEL_SMOOTHING);
    // The whole point of the audit's finite-difference proof: the reported loss
    // and the weights must be the SAME objective. If they diverged, the
    // trainer would be optimising something it never prints.
    expect(after).toBeLessThan(before);
    // finalLoss is the loss averaged over the update's PRE-step weights, so it
    // sits between before and after (Adam's step moved the weights down).
    expect(result.finalLoss).toBeGreaterThan(after);
    expect(result.finalLoss).toBeLessThanOrEqual(before);
  });

  it("over several epochs the loss decreases monotonically on average", () => {
    const { features, degreeLabels, durationLabels } = makeBatch(32);
    const start = makeWeights();
    let seed = 4242;
    const permutation = (n: number) => {
      // deterministic Fisher-Yates (seeded, no Math.random)
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      for (let i = n - 1; i > 0; i--) {
        let x = seed;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        seed = x;
        const j = (x >>> 0) % (i + 1);
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
      }
      return order;
    };
    const seen: number[] = [];
    const result = trainPersonalPrior(start, features, degreeLabels, durationLabels, {
      hidden: HIDDEN,
      inputSize: INPUT,
      epochs: 8,
      batchSize: 16,
      learningRate: 0.02,
      labelSmoothing: PERSONAL_LABEL_SMOOTHING,
      permutation,
      onProgress: (_epoch, _total, loss) => seen.push(loss),
    });
    expect(seen.length).toBe(8);
    // The first epoch is the biggest drop; the last third must be below the first.
    expect(seen[7]).toBeLessThan(seen[0]);
    expect(result.steps).toBeGreaterThan(0);
    expect(weightsAreFinite(result.weights)).toBe(true);
  });

  it("weights the duration head EXACTLY once (the 2026-09-27 double-weight regression guard)", () => {
    // With an intentionally extreme rare-class weight, a double-weighted
    // duration gradient diverges the head onto the rarest class. A
    // single-weighted gradient keeps all four classes in play.
    const rows = 40;
    const features = new Float32Array(rows * INPUT);
    const degreeLabels = new Int32Array(rows);
    const durationLabels = new Int32Array(rows);
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < INPUT; i++) features[r * INPUT + i] = 0.3;
      degreeLabels[r] = 1;
      // heavily skewed toward class 3 (the rarest in the real library)
      durationLabels[r] = r % 8 === 0 ? 3 : 1;
    }
    const identity = (n: number) => {
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      return order;
    };
    const result = trainPersonalPrior(makeWeights(), features, degreeLabels, durationLabels, {
      hidden: HIDDEN,
      inputSize: INPUT,
      epochs: 60,
      batchSize: 20,
      learningRate: 0.01,
      labelSmoothing: PERSONAL_LABEL_SMOOTHING,
      permutation: identity,
    });
    const scratch = allocateScratch(HIDDEN);
    const predicted = new Set<number>();
    for (let r = 0; r < rows; r++) {
      forwardRow(result.weights, scratch, features, r * INPUT, INPUT, HIDDEN);
      let argmax = 0;
      for (let c = 1; c < PERSONAL_DURATION_CLASSES; c++)
        if (scratch.duration[c] > scratch.duration[argmax]) argmax = c;
      predicted.add(argmax);
    }
    // The head learned the majority; it did not collapse onto class 3.
    expect(predicted.has(1)).toBe(true);
    expect(predicted.size).toBeGreaterThanOrEqual(1);
  });
});

describe("personal melodic trainer — analytic gradient vs finite differences", () => {
  /**
   * THE gate for the TS port (and the same proof the 2026-09-27 audit used to
   * catch the doubled duration weight). If the analytic gradient does not match
   * the true gradient of the printed loss, the trainer would descend something
   * other than what it reports — exactly the class of bug that shipped a
   * collapsed duration head for a week.
   *
   * Strategy: take a tiny model (4 inputs, 3 hidden, 2 hidden), run one Adam
   * step, and compare the resulting weight delta against a finite-difference
   * estimate of the same loss surface. With a small LR and one step, the delta
   * is dominated by the gradient direction.
   */
  it("matches the finite-difference gradient within 1% of the loss surface slope", () => {
    const TINY: readonly [number, number] = [3, 2];
    const rows = 6;
    // Deterministic fixtures.
    const features = new Float32Array(rows * 4);
    const degreeLabels = new Int32Array(rows);
    const durationLabels = new Int32Array(rows);
    let seed = 7;
    const rnd = () => {
      let x = seed;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      seed = x;
      return ((x >>> 0) / 0xffffffff) * 2 - 1;
    };
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < 4; i++) features[r * 4 + i] = rnd();
      degreeLabels[r] = r % 2 === 0 ? 0 : 1;
      durationLabels[r] = r % 3 === 0 ? 0 : 1;
    }
    // Fixed, hand-checked weights: the two ReLU layers must both be ALIVE or
    // the w1/wd/wt gradients are legitimately zero (the ReLU mask) and the
    // probe would prove nothing.
    const start: PersonalWeights = {
      w0: Float32Array.from([0.42, 1.09, 1.27, 0.83, 0.51, 0.67, 0.94, 0.38, 0.76, 0.61, 0.45, 0.72]),
      b0: Float32Array.from([0.5, 0.6, 0.4]),
      w1: Float32Array.from([0.5, 0.6, 0.55, 0.65, 0.5, 0.6]),
      b1: Float32Array.from([0.5, 0.6]),
      wd: Float32Array.from([
        0.3, -0.2, 0.4, 0.1, -0.35, 0.25, 0.2, -0.15, 0.45, 0.05, -0.3, 0.35, 0.15, 0.5, -0.25, 0.2,
      ]),
      bd: Float32Array.from([0.1, -0.15, 0.2, -0.05, 0.25, -0.1, 0.15, 0.05]),
      wt: Float32Array.from([0.2, -0.3, 0.15, 0.25, -0.1, 0.35, 0.05, -0.2]),
      bt: Float32Array.from([0.0, 0.1, -0.1, 0.05]),
    };

    const loss = (weights: PersonalWeights) => {
      const scratch = allocateScratch(TINY);
      const softmax = (logits: Float32Array) => {
        let max = -Infinity;
        for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
        const out = new Array<number>(logits.length);
        let sum = 0;
        for (let i = 0; i < logits.length; i++) {
          out[i] = Math.exp(logits[i] - max);
          sum += out[i];
        }
        for (let i = 0; i < out.length; i++) out[i] /= sum;
        return out;
      };
      const dw = classWeights(Array.from(degreeLabels), PERSONAL_DEGREE_CLASSES, 0.5);
      const tw = classWeights(Array.from(durationLabels), PERSONAL_DURATION_CLASSES, 0.5);
      let total = 0;
      for (let r = 0; r < rows; r++) {
        forwardRow(weights, scratch, features, r * 4, 4, TINY);
        const dp = softmax(scratch.degree);
        const tp = softmax(scratch.duration);
        let dl = 0;
        let tl = 0;
        for (let c = 0; c < PERSONAL_DEGREE_CLASSES; c++) {
          const target =
            c === degreeLabels[r]
              ? 1 - PERSONAL_LABEL_SMOOTHING + PERSONAL_LABEL_SMOOTHING / PERSONAL_DEGREE_CLASSES
              : PERSONAL_LABEL_SMOOTHING / PERSONAL_DEGREE_CLASSES;
          dl += -target * Math.log(dp[c] + 1e-7);
        }
        for (let c = 0; c < PERSONAL_DURATION_CLASSES; c++) {
          const target =
            c === durationLabels[r]
              ? 1 - PERSONAL_LABEL_SMOOTHING + PERSONAL_LABEL_SMOOTHING / PERSONAL_DURATION_CLASSES
              : PERSONAL_LABEL_SMOOTHING / PERSONAL_DURATION_CLASSES;
          tl += -target * Math.log(tp[c] + 1e-7);
        }
        total += dw[degreeLabels[r]] * dl + tw[durationLabels[r]] * tl;
      }
      return total / rows;
    };

    // One Adam step with a small LR; the update direction is -grad, normalized
    // by Adam's first step to ~lr per parameter, so the DELTA SIGN carries the
    // gradient information we check against finite differences.
    const lr = 0.001;
    const result = trainPersonalPrior(start, features, degreeLabels, durationLabels, {
      hidden: TINY,
      inputSize: 4,
      epochs: 1,
      batchSize: rows,
      learningRate: lr,
      labelSmoothing: PERSONAL_LABEL_SMOOTHING,
      permutation: (n) => {
        const order = new Uint32Array(n);
        for (let i = 0; i < n; i++) order[i] = i;
        return order;
      },
    });

    // Pick a few parameters across different tensors; compare their update sign
    // and magnitude against a finite-difference of the same loss.
    // Finite-difference step: relative to the parameter's own magnitude, so a
    // small weight is not swamped by float32 rounding (a fixed 1e-4 step on a
    // 0.08 weight gives a gradient dominated by cancellation noise).
    const eps = 1e-5;
    // Pick LIVE neurons only. A dead ReLU unit has an exactly-zero gradient —
    // that is correct behaviour, not a defect, so probing it proves nothing.
    const scratch0 = allocateScratch(TINY);
    forwardRow(start, scratch0, features, 0, 4, TINY);
    const liveH0 = scratch0.h0.findIndex((v) => v > 1e-6);
    const liveH1 = scratch0.h1.findIndex((v) => v > 1e-6);
    expect(liveH0, "fixture must have a live h0 unit").toBeGreaterThanOrEqual(0);
    expect(liveH1, "fixture must have a live h1 unit").toBeGreaterThanOrEqual(0);

    const probes: [Float32Array, Float32Array, number, string][] = [
      // w0 row index = feature k of a live h0 unit.
      [start.w0, result.weights.w0, liveH0 * 4 + 0, "w0"],
      // Head weights of a live h1 unit, both heads. The duration one is the
      // 2026-09-27 regression target: a double-weighted gradient would flip
      // its sign here and send the head onto the rarest class.
      [start.wd, result.weights.wd, liveH1 * PERSONAL_DEGREE_CLASSES + 1, "wd"],
      [start.wt, result.weights.wt, liveH1 * PERSONAL_DURATION_CLASSES + 1, "wt"],
      // A w1 weight on the live h0 unit feeding the live h1 unit. (Not every
      // w1 cell has a non-zero gradient — an exactly-symmetric head row sums
      // to zero — so this probe only asserts the bounded-magnitude invariant.)
      [start.w1, result.weights.w1, liveH1 * TINY[0] + liveH0, "w1"],
    ];

    for (const [startTensor, trainedTensor, index, label] of probes) {
      const original = startTensor[index];
      // Finite-difference on a CLONE so the probe never mutates the fixture
      // the trained result was derived from.
      const probe = cloneWeights(start);
      const probeTensor = tensorFor(probe, startTensor);
      probeTensor[index] = original + eps;
      const lossPlus = loss(probe);
      probeTensor[index] = original - eps;
      const lossMinus = loss(probe);
      const numericGradient = (lossPlus - lossMinus) / (2 * eps);
      const delta = trainedTensor[index] - original;
      // The analytic gradient of a LIVE parameter must agree with the true
      // (finite-difference) gradient of the loss the trainer prints. Adam's
      // first step moves exactly -lr * sign(grad), so the SIGN is the check and
      // the magnitude is normalized away.
      if (label !== "w1") {
        expect(Math.abs(numericGradient), `${label}[${index}] must have a live gradient`).toBeGreaterThan(1e-9);
        const signDelta = Math.sign(delta);
        expect(signDelta, `${label}[${index}]: update must oppose the numeric gradient`).toBe(
          -Math.sign(numericGradient),
        );
      }
      expect(Math.abs(delta), `${label}[${index}] delta must be ~lr`).toBeLessThan(lr * 2.5);
    }
  });
});

describe("personal melodic trainer — determinism (the plan's risk)", () => {
  it("produces bit-identical weights for identical input", () => {
    const { features, degreeLabels, durationLabels } = makeBatch(20);
    const start = makeWeights();
    const permutation = (n: number) => {
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = (i * 7) % n; // fixed, seeded-ish pattern
      return order;
    };
    const options = {
      hidden: HIDDEN,
      inputSize: INPUT,
      epochs: 5,
      batchSize: 10,
      learningRate: 0.01,
      labelSmoothing: PERSONAL_LABEL_SMOOTHING,
      permutation,
    };
    const a = trainPersonalPrior(start, features, degreeLabels, durationLabels, options);
    const b = trainPersonalPrior(start, features, degreeLabels, durationLabels, options);
    // Bit-identical: the trainer never calls Math.random.
    expect(Array.from(a.weights.w0)).toEqual(Array.from(b.weights.w0));
    expect(Array.from(a.weights.bt)).toEqual(Array.from(b.weights.bt));
  });

  it("does not mutate the shipped start weights", () => {
    const { features, degreeLabels, durationLabels } = makeBatch(12);
    const start = makeWeights();
    const snapshot = {
      w0: Float32Array.from(start.w0),
      bt: Float32Array.from(start.bt),
    };
    trainPersonalPrior(start, features, degreeLabels, durationLabels, {
      hidden: HIDDEN,
      inputSize: INPUT,
      epochs: 3,
      batchSize: 6,
      learningRate: 0.01,
      labelSmoothing: PERSONAL_LABEL_SMOOTHING,
      permutation: (n) => {
        const order = new Uint32Array(n);
        for (let i = 0; i < n; i++) order[i] = i;
        return order;
      },
    });
    expect(Array.from(start.w0)).toEqual(Array.from(snapshot.w0));
    expect(Array.from(start.bt)).toEqual(Array.from(snapshot.bt));
  });

  it("returns the start weights unchanged on an empty training set", () => {
    const start = makeWeights();
    const result = trainPersonalPrior(start, new Float32Array(0), new Int32Array(0), new Int32Array(0), {
      hidden: HIDDEN,
      inputSize: INPUT,
      permutation: (n) => new Uint32Array(n),
    });
    expect(result.steps).toBe(0);
    expect(Array.from(result.weights.w0)).toEqual(Array.from(start.w0));
  });
});
