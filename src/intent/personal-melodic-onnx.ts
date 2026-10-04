/**
 * W3 — Read the shipped ONNX initializers so the personal trainer can
 * FINE-TUNE FROM THE SHIPPED WEIGHTS (docs/intent-killer-feature-plan.md W3).
 *
 * Why fine-tune and not train from scratch:
 *   1. DETERMINISM — no random init means no RNG in the personal path at all
 *      (stronger than the plan's "seeded like python" requirement),
 *   2. NO REGRESSION BY CONSTRUCTION — a personal model is a delta on a model
 *      that already works; a few ★ rolls can never make it worse overall,
 *   3. SPEED — no zero-init of nine tensors, and fewer epochs are needed
 *      because the trunk already solves the hard part.
 *
 * The exporter writes the trunk and heads as separate `Gemm` initializers
 * (see `train-symbolic-melodic.py`'s ONNX export block), so the trained
 * tensors arrive TRANSPOSED relative to the trainer's in-memory layout
 * (transB=1 means the ONNX Gemm consumes [out, in]). This reader
 * de-transposes them so the in-memory matmul stays cache-friendly row-major
 * [in, out] — the same orientation the python trainer uses.
 *
 * Pure module: no DOM, no storage, no worker globals. It deliberately does
 * NOT use a protobuf dependency — the initializer section is read with a
 * small hand-rolled walker over the ONNX wire format (the file is generated
 * by this repo's own trainer, so the shape of the input is known).
 */
import type { PersonalWeights } from "./personal-melodic-trainer";

// ── minimal ONNX protobuf walker ─────────────────────────────────────────────

interface Field {
  fieldNumber: number;
  wireType: number;
  /** For wire type 2: the payload slice; for varint/fixed: the decoded number. */
  value: Uint8Array | number;
}

function readVarint(data: Uint8Array, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = pos;
  while (cursor < data.length) {
    const byte = data[cursor++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
    if (shift > 63) throw new Error("ONNX varint overflow");
  }
  throw new Error("ONNX truncated varint");
}

function walkFields(data: Uint8Array, start = 0, end = data.length): Field[] {
  const fields: Field[] = [];
  let pos = start;
  while (pos < end) {
    const tag = readVarint(data, pos);
    pos = tag.next;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x7;
    if (wireType === 0) {
      const v = readVarint(data, pos);
      fields.push({ fieldNumber, wireType, value: v.value });
      pos = v.next;
    } else if (wireType === 1) {
      fields.push({ fieldNumber, wireType, value: 0 });
      pos += 8;
    } else if (wireType === 2) {
      const length = readVarint(data, pos);
      pos = length.next;
      fields.push({ fieldNumber, wireType, value: data.subarray(pos, pos + length.value) });
      pos += length.value;
    } else if (wireType === 5) {
      fields.push({ fieldNumber, wireType, value: 0 });
      pos += 4;
    } else {
      throw new Error(`unsupported ONNX wire type ${wireType}`);
    }
  }
  return fields;
}

/** TensorProto.Dims (field 1, repeated int64) — dimensions of one initializer. */
function tensorDims(fields: Field[]): number[] {
  return fields.filter((f) => f.fieldNumber === 1).map((f) => Number(f.value));
}

/** TensorProto.DataLocation / raw_data (field 9) — little-endian float32 bytes. */
function tensorFloats(fields: Field[]): Float32Array {
  const raw = fields.find((f) => f.fieldNumber === 9);
  if (!raw || !(raw.value instanceof Uint8Array)) {
    throw new Error("initializer has no raw_data (float_data initializers are not supported)");
  }
  const bytes = raw.value;
  const out = new Float32Array(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export interface OnnxTensor {
  name: string;
  dims: number[];
  data: Float32Array;
}

/** Parse every TensorProto initializer out of a ModelProto. */
export function parseOnnxInitializers(bytes: Uint8Array): OnnxTensor[] {
  const model = walkFields(bytes);
  // GraphProto (field 7) → Initializer (field 5, repeated).
  const graph = model.find((f) => f.fieldNumber === 7);
  if (!graph || !(graph.value instanceof Uint8Array)) throw new Error("ONNX model has no graph");
  const graphFields = walkFields(graph.value);
  const tensors: OnnxTensor[] = [];
  for (const field of graphFields) {
    if (field.fieldNumber !== 5 || !(field.value instanceof Uint8Array)) continue;
    const tensorProto = walkFields(field.value);
    const nameField = tensorProto.find((f) => f.fieldNumber === 8);
    const name = nameField && nameField.value instanceof Uint8Array ? new TextDecoder().decode(nameField.value) : "";
    tensors.push({ name, dims: tensorDims(tensorProto), data: tensorFloats(tensorProto) });
  }
  return tensors;
}

/** Transpose a row-major [in, out] matrix into [out, in] (ONNX transB=1 form). */
function transposeRowMajor(matrix: Float32Array, rows: number, cols: number): Float32Array {
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out[c * rows + r] = matrix[r * cols + c];
  }
  return out;
}

/**
 * Load the shipped melodic prior's weights from its ONNX bytes.
 *
 * The exporter names each initializer (W0, B0, W1, B1, WD, BD, WT, BT) and
 * writes the weight tensors transposed (transB=1), i.e. ONNX W0 is [hidden0,
 * featureCount] while the trainer's in-memory w0 is [featureCount, hidden0].
 * This function de-transposes so the trainer can use the tensors directly.
 */
export function personalWeightsFromOnnx(
  bytes: Uint8Array,
  hidden: readonly [number, number],
  degreeClasses: number,
  durationClasses: number,
): PersonalWeights {
  const tensors = parseOnnxInitializers(bytes);
  const byName = new Map(tensors.map((t) => [t.name, t]));
  const need = (name: string): OnnxTensor => {
    const tensor = byName.get(name);
    if (!tensor) throw new Error(`shipped ONNX is missing initializer ${name}`);
    return tensor;
  };
  const [h0, h1] = hidden;
  return {
    w0: transposeRowMajor(need("W0").data, h0, need("W0").dims[1]),
    b0: need("B0").data.slice(),
    w1: transposeRowMajor(need("W1").data, h1, need("W1").dims[1]),
    b1: need("B1").data.slice(),
    wd: transposeRowMajor(need("WD").data, degreeClasses, h1),
    bd: need("BD").data.slice(),
    wt: transposeRowMajor(need("WT").data, durationClasses, h1),
    bt: need("BT").data.slice(),
  };
}

/** Serialize personal weights to a compact JSON payload (for IndexedDB). */
export function personalWeightsToJson(weights: PersonalWeights, meta: Record<string, unknown>): string {
  const encode = (tensor: Float32Array) => Array.from(tensor, (v) => Math.fround(v));
  return JSON.stringify({
    version: 1,
    ...meta,
    w0: encode(weights.w0),
    b0: encode(weights.b0),
    w1: encode(weights.w1),
    b1: encode(weights.b1),
    wd: encode(weights.wd),
    bd: encode(weights.bd),
    wt: encode(weights.wt),
    bt: encode(weights.bt),
  });
}

export interface PersonalWeightsPayload {
  version: 1;
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
  [key: string]: unknown;
}

/** Parse + validate a stored payload; returns null on any shape mismatch. */
export function personalWeightsFromJson(raw: unknown): PersonalWeightsPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = raw as Partial<PersonalWeightsPayload>;
  if (payload.version !== 1) return null;
  const arrays = [payload.w0, payload.b0, payload.w1, payload.b1, payload.wd, payload.bd, payload.wt, payload.bt];
  if (!Array.isArray(payload.hidden) || payload.hidden.length !== 2) return null;
  if (typeof payload.featureCount !== "number" || typeof payload.degreeClasses !== "number") return null;
  if (typeof payload.durationClasses !== "number") return null;
  for (const array of arrays) {
    if (!Array.isArray(array) || array.length === 0) return null;
    for (const value of array) if (typeof value !== "number" || !Number.isFinite(value)) return null;
  }
  const [h0, h1] = payload.hidden;
  if (payload.w0.length !== h0 * payload.featureCount) return null;
  if (payload.b0.length !== h0) return null;
  if (payload.w1.length !== h1 * h0) return null;
  if (payload.b1.length !== h1) return null;
  if (payload.wd.length !== h1 * payload.degreeClasses) return null;
  if (payload.bd.length !== payload.degreeClasses) return null;
  if (payload.wt.length !== h1 * payload.durationClasses) return null;
  if (payload.bt.length !== payload.durationClasses) return null;
  return payload as PersonalWeightsPayload;
}

/** Convert a validated payload back to the trainer's tensor layout. */
export function personalWeightsFromPayload(payload: PersonalWeightsPayload): PersonalWeights {
  return {
    w0: Float32Array.from(payload.w0),
    b0: Float32Array.from(payload.b0),
    w1: Float32Array.from(payload.w1),
    b1: Float32Array.from(payload.b1),
    wd: Float32Array.from(payload.wd),
    bd: Float32Array.from(payload.bd),
    wt: Float32Array.from(payload.wt),
    bt: Float32Array.from(payload.bt),
  };
}