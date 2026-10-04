import {
  PERSONAL_DEGREE_CLASSES,
  PERSONAL_DURATION_CLASSES,
  forwardRow,
  allocateScratch,
  type PersonalWeights,
} from "./personal-melodic-trainer";

/**
 * W3 — PERSONAL INFERENCE OVERLAY.
 *
 * The personal prior runs the SAME graph as the shipped ONNX (trunk + two
 * softmax heads) but in plain JS, so no second session, no second artifact
 * fetch and no ORT dependency on the personal path — a 29→64→32 MLP over a
 * single note context is microseconds of arithmetic.
 *
 * WHY AN OVERLAY AND NOT A SECOND ONNX: exporting ONNX in the browser is not
 * viable (protobuf + shape inference is a build-time job), and a personal model
 * is 4 396 floats — a JSON payload the user owns, not a shipped binary. The
 * overlay also keeps the honesty property that matters: the personal path can
 * only ever be consulted for the artifact it was trained from.
 *
 * The contract mirrors `runMelodicNext` exactly — degree and duration
 * distributions rounded to 4 decimals — so the provider cannot tell which
 * model answered, and the fallback path is a no-op rather than a second code
 * branch.
 */

export interface PersonalInferenceModel {
  weights: PersonalWeights;
  featureCount: number;
  degreeClasses: number;
  durationClasses: number;
  hidden: readonly [number, number];
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function softmaxRow(values: number[]): number[] {
  const max = Math.max(...values);
  const exp = values.map((value) => Math.exp(Math.max(-30, Math.min(30, value - max))));
  const sum = exp.reduce((total, value) => total + value, 0);
  return exp.map((value) => round4(value / sum));
}

/**
 * Run the personal model over ONE feature row. Returns ready-to-use
 * distributions, or null when the row width does not match the model — the
 * caller then falls back to the shipped prior (never throws).
 */
export function runPersonalNext(
  model: PersonalInferenceModel,
  features: Float32Array,
  rowCount: number,
): { degree: number[][]; duration: number[][] } | null {
  if (!(features instanceof Float32Array)) return null;
  if (features.length !== rowCount * model.featureCount) return null;
  if (model.degreeClasses !== PERSONAL_DEGREE_CLASSES) return null;
  if (model.durationClasses !== PERSONAL_DURATION_CLASSES) return null;
  const scratch = allocateScratch(model.hidden);
  const degree: number[][] = [];
  const duration: number[][] = [];
  try {
    for (let row = 0; row < rowCount; row++) {
      forwardRow(model.weights, scratch, features, row * model.featureCount, model.featureCount, model.hidden);
      degree.push(softmaxRow(Array.from(scratch.degree)));
      duration.push(softmaxRow(Array.from(scratch.duration)));
    }
  } catch {
    return null;
  }
  for (const distribution of [...degree, ...duration]) {
    for (const value of distribution) if (!Number.isFinite(value)) return null;
  }
  return { degree, duration };
}

/** Build the inference model from a validated stored payload. */
export function personalInferenceFromPayload(payload: {
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
}): PersonalInferenceModel {
  return {
    weights: {
      w0: Float32Array.from(payload.w0),
      b0: Float32Array.from(payload.b0),
      w1: Float32Array.from(payload.w1),
      b1: Float32Array.from(payload.b1),
      wd: Float32Array.from(payload.wd),
      bd: Float32Array.from(payload.bd),
      wt: Float32Array.from(payload.wt),
      bt: Float32Array.from(payload.bt),
    },
    featureCount: payload.featureCount,
    degreeClasses: payload.degreeClasses,
    durationClasses: payload.durationClasses,
    hidden: payload.hidden,
  };
}
