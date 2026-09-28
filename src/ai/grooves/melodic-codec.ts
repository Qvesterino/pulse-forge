import type { MelodicNote } from "../types";

const MELODIC_CODEC_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
const MELODIC_DEGREES = [-1, 0, 2, 3, 4, 5, 6] as const;
const MELODIC_DURATIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 16] as const;
const MELODIC_VELOCITIES = [
  0, 0.3, 0.32, 0.35, 0.36, 0.38, 0.39, 0.4, 0.42, 0.44, 0.45, 0.46, 0.47, 0.48, 0.5, 0.52, 0.53, 0.54, 0.55, 0.6, 0.65,
  0.66, 0.68, 0.7, 0.72, 0.74, 0.75, 0.76, 0.78, 0.8, 0.82, 0.85, 0.88, 0.9, 0.92, 0.94, 0.95,
] as const;

const CODE_COUNT = MELODIC_DEGREES.length * MELODIC_DURATIONS.length * MELODIC_VELOCITIES.length;

const alphabetIndex = (value: string, offset: number): number => {
  const index = MELODIC_CODEC_ALPHABET.indexOf(value[offset] ?? "");
  if (index < 0) throw new Error(`Invalid compact melodic note at offset ${offset}`);
  return index;
};

export function decodeMelodicSequences(encodedSequences: readonly string[]): MelodicNote[][] {
  return encodedSequences.map((encoded) => {
    if (encoded.length % 2 !== 0) throw new Error("Compact melodic sequence has an incomplete note code");
    const notes: MelodicNote[] = [];
    for (let offset = 0; offset < encoded.length; offset += 2) {
      const code = alphabetIndex(encoded, offset) * MELODIC_CODEC_ALPHABET.length + alphabetIndex(encoded, offset + 1);
      if (code >= CODE_COUNT) throw new Error(`Compact melodic note code ${code} is out of range`);

      const velocityIndex = code % MELODIC_VELOCITIES.length;
      const durationAndDegree = Math.floor(code / MELODIC_VELOCITIES.length);
      const durationIndex = durationAndDegree % MELODIC_DURATIONS.length;
      const degreeIndex = Math.floor(durationAndDegree / MELODIC_DURATIONS.length);
      const degree = MELODIC_DEGREES[degreeIndex];
      const duration = MELODIC_DURATIONS[durationIndex];
      const velocity = MELODIC_VELOCITIES[velocityIndex];
      if (degree === undefined || duration === undefined || velocity === undefined) {
        throw new Error(`Compact melodic note code ${code} is incomplete`);
      }
      notes.push({ degree, duration, velocity });
    }
    return notes;
  });
}

export function encodeMelodicSequences(sequences: readonly (readonly MelodicNote[])[]): string[] {
  return sequences.map((sequence) => {
    let encoded = "";
    for (const note of sequence) {
      const degreeIndex = MELODIC_DEGREES.indexOf(note.degree as (typeof MELODIC_DEGREES)[number]);
      const durationIndex = MELODIC_DURATIONS.indexOf(note.duration as (typeof MELODIC_DURATIONS)[number]);
      const velocityIndex = MELODIC_VELOCITIES.indexOf(note.velocity as (typeof MELODIC_VELOCITIES)[number]);
      if (degreeIndex < 0 || durationIndex < 0 || velocityIndex < 0) {
        throw new Error(`Unsupported melodic note ${note.degree}/${note.duration}/${note.velocity}`);
      }
      const code = (degreeIndex * MELODIC_DURATIONS.length + durationIndex) * MELODIC_VELOCITIES.length + velocityIndex;
      encoded +=
        MELODIC_CODEC_ALPHABET[Math.floor(code / MELODIC_CODEC_ALPHABET.length)] +
        MELODIC_CODEC_ALPHABET[code % MELODIC_CODEC_ALPHABET.length];
    }
    return encoded;
  });
}
