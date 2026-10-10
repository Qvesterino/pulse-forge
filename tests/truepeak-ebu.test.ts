import { describe, expect, it } from "vitest";
import { truePeakOversampled } from "../src/audio-engine/metering";

const SAMPLE_RATE = 48_000;
const FFS = 1;

type EbuCase = {
  id: number;
  cyclesPerSample: number;
  amplitude: number;
  phaseRad: number;
  expectedDbtp: number;
  fadeMs?: number;
};

const sineCases: EbuCase[] = [
  { id: 15, cyclesPerSample: 1 / 4, amplitude: 0.5, phaseRad: 0, expectedDbtp: -6, fadeMs: 10 },
  { id: 16, cyclesPerSample: 1 / 4, amplitude: 0.5, phaseRad: Math.PI / 4, expectedDbtp: -6, fadeMs: 10 },
  { id: 17, cyclesPerSample: 1 / 6, amplitude: 0.5, phaseRad: Math.PI / 3, expectedDbtp: -6, fadeMs: 10 },
  { id: 18, cyclesPerSample: 1 / 8, amplitude: 0.5, phaseRad: (3 * Math.PI) / 8, expectedDbtp: -6, fadeMs: 10 },
  { id: 19, cyclesPerSample: 1 / 4, amplitude: 1.41, phaseRad: Math.PI / 4, expectedDbtp: 3, fadeMs: 10 },
];

function makeSine(testCase: EbuCase): Float32Array {
  const length = SAMPLE_RATE;
  const samples = new Float32Array(length);
  const fadeSamples = testCase.fadeMs ? Math.round((testCase.fadeMs / 1000) * SAMPLE_RATE) : 0;
  for (let n = 0; n < length; n++) {
    let envelope = 1;
    if (fadeSamples > 0 && n < fadeSamples) {
      envelope = 0.5 - 0.5 * Math.cos((Math.PI * n) / fadeSamples);
    } else if (fadeSamples > 0 && n >= length - fadeSamples) {
      envelope = 0.5 - 0.5 * Math.cos((Math.PI * (length - 1 - n)) / fadeSamples);
    }
    samples[n] =
      testCase.amplitude * FFS * envelope * Math.sin(2 * Math.PI * testCase.cyclesPerSample * n + testCase.phaseRad);
  }
  return samples;
}

function sinc(x: number): number {
  return Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
}

function makeAntiAliasedTransient(offset: number): Float32Array {
  // Model EBU cases 20–23 from their published signal description without
  // checking in or copying the EBU's restricted audio test sequence. The
  // anti-alias filter is explicitly chosen here because the spec does not
  // mandate a particular low-pass implementation.
  const oversample = 4;
  const highRate = SAMPLE_RATE * oversample;
  const seconds = 3;
  const fadeSamples = Math.round(0.01 * highRate);
  const highLength = seconds * highRate + oversample;
  const high = new Float64Array(highLength);
  const backgroundPhase = -Math.PI / 6;
  // The background phase advances 240° across one fs/4 period. At -30° its
  // endpoint values match; this transient phase matches those values too.
  const transientPhase = Math.asin(-0.25);
  const transientStart = highRate;
  const transientEnd = transientStart + oversample * 4;

  for (let n = 0; n < highLength; n++) {
    const time = n / highRate;
    const envelope =
      n < fadeSamples
        ? 0.5 - 0.5 * Math.cos((Math.PI * n) / fadeSamples)
        : n >= highRate * seconds - fadeSamples
          ? 0.5 - 0.5 * Math.cos((Math.PI * (highRate * seconds - 1 - n)) / fadeSamples)
          : 1;
    const background = 0.5 * Math.sin(2 * Math.PI * (SAMPLE_RATE / 6) * time + backgroundPhase);
    const value =
      n >= transientStart && n < transientEnd
        ? Math.sin(2 * Math.PI * (SAMPLE_RATE / 4) * ((n - transientStart) / highRate) + transientPhase)
        : background;
    high[n] = value * envelope;
  }

  // Independent windowed-sinc low-pass at the 4× rate before decimation.
  const tapCount = 129;
  const delay = (tapCount - 1) / 2;
  const cutoffCyclesPerHighSample = 1 / (2 * oversample);
  const filter = new Float64Array(tapCount);
  let filterSum = 0;
  for (let tap = 0; tap < tapCount; tap++) {
    const distance = tap - delay;
    const window =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * tap) / (tapCount - 1)) +
      0.08 * Math.cos((4 * Math.PI * tap) / (tapCount - 1));
    filter[tap] = 2 * cutoffCyclesPerHighSample * sinc(2 * cutoffCyclesPerHighSample * distance) * window;
    filterSum += filter[tap];
  }
  for (let tap = 0; tap < tapCount; tap++) filter[tap] /= filterSum;

  const output = new Float32Array(SAMPLE_RATE * seconds);
  for (let n = 0; n < output.length; n++) {
    const center = n * oversample + offset;
    let sample = 0;
    for (let tap = 0; tap < tapCount; tap++) {
      const source = center + tap - delay;
      if (source >= 0 && source < high.length) sample += high[source] * filter[tap];
    }
    output[n] = sample;
  }
  return output;
}

function expectEbuPeak(samples: Float32Array, id: number, expectedDbtp: number): void {
  const peakDbtp = 20 * Math.log10(truePeakOversampled([samples]));
  // EBU Tech 3341 v4 accepts +0.2 / -0.4 dB around the listed level.
  expect(peakDbtp, `case ${id}: ${peakDbtp.toFixed(3)} dBTP`).toBeGreaterThanOrEqual(expectedDbtp - 0.4);
  expect(peakDbtp, `case ${id}: ${peakDbtp.toFixed(3)} dBTP`).toBeLessThanOrEqual(expectedDbtp + 0.2);
}

describe("EBU Tech 3341 true-peak cases 15–19", () => {
  for (const testCase of sineCases) {
    it(`meets published dBTP tolerance for case ${testCase.id}`, () => {
      expectEbuPeak(makeSine(testCase), testCase.id, testCase.expectedDbtp);
    });
  }
});

describe("EBU Tech 3341 true-peak cases 20–23", () => {
  for (let offset = 0; offset < 4; offset++) {
    it(`meets published dBTP tolerance for the 4×-downsample offset ${offset}`, () => {
      expectEbuPeak(makeAntiAliasedTransient(offset), 20 + offset, 0);
    });
  }
});
