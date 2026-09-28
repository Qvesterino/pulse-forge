import type { GrooveData } from "../types";

/**
 * Groove velocity rows use a deliberately small, lossless palette. The data
 * compactor reads this table through the TypeScript AST so source and runtime
 * encoding cannot drift independently.
 */
const GROOVE_VELOCITIES = [
  0, 0.1, 0.12, 0.14, 0.15, 0.16, 0.18, 0.2, 0.22, 0.24, 0.25, 0.26, 0.28, 0.3, 0.32, 0.33, 0.34, 0.35, 0.36, 0.38, 0.4,
  0.42, 0.44, 0.45, 0.46, 0.48, 0.5, 0.52, 0.55, 0.58, 0.6, 0.62, 0.65, 0.68, 0.7, 0.72, 0.74, 0.75, 0.76, 0.78, 0.8,
  0.82, 0.84, 0.85, 0.86, 0.88, 0.9, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98,
] as const;

const GROOVE_CODEC_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

type CompactGroove = Omit<GrooveData, "patterns"> & {
  patterns: Record<number, string | number[]>[];
};

const decodeIndex = (value: string, index: number, label: string): number => {
  const decoded = GROOVE_CODEC_ALPHABET.indexOf(value[index] ?? "");
  if (decoded < 0) throw new Error(`Invalid compact groove ${label} at offset ${index}`);
  return decoded;
};

/** Recreate a velocity row from its length + sparse position/velocity pairs. */
export function decodeGrooveRow(encoded: string): number[] {
  if (encoded.length === 0) throw new Error("Compact groove row is missing its length prefix");
  if ((encoded.length - 1) % 2 !== 0) throw new Error("Compact groove row has an incomplete hit pair");

  const length = decodeIndex(encoded, 0, "row length");
  const row = new Array<number>(length).fill(0);
  for (let offset = 1; offset < encoded.length; offset += 2) {
    const position = decodeIndex(encoded, offset, "hit position");
    const velocityIndex = decodeIndex(encoded, offset + 1, "velocity");
    const velocity = GROOVE_VELOCITIES[velocityIndex];
    if (position >= length) throw new Error(`Compact groove hit position ${position} exceeds row length ${length}`);
    if (velocity === undefined || velocity <= 0)
      throw new Error(`Invalid compact groove velocity index ${velocityIndex}`);
    row[position] = velocity;
  }
  return row;
}

/** Encode numeric rows for round-trip tests and future groove authoring tools. */
export function encodeGrooveRow(row: readonly number[]): string {
  if (row.length >= GROOVE_CODEC_ALPHABET.length) throw new Error(`Groove row is too long to encode: ${row.length}`);

  let encoded = GROOVE_CODEC_ALPHABET[row.length];
  for (let position = 0; position < row.length; position++) {
    const velocity = row[position];
    if (velocity === 0) continue;
    const velocityIndex = GROOVE_VELOCITIES.indexOf(velocity as (typeof GROOVE_VELOCITIES)[number]);
    if (velocityIndex <= 0) throw new Error(`Unsupported groove velocity ${velocity}`);
    encoded += `${GROOVE_CODEC_ALPHABET[position]}${GROOVE_CODEC_ALPHABET[velocityIndex]}`;
  }
  return encoded;
}

/** Decode compact source rows while keeping the public runtime shape unchanged. */
export function decodeGrooves(grooves: readonly CompactGroove[]): GrooveData[] {
  return grooves.map((groove) => ({
    ...groove,
    patterns: groove.patterns.map((pattern) => {
      const decoded: Record<number, number[]> = {};
      for (const [pad, row] of Object.entries(pattern)) {
        decoded[Number(pad)] = typeof row === "string" ? decodeGrooveRow(row) : row;
      }
      return decoded;
    }),
  }));
}
