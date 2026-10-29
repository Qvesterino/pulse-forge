import { describe, expect, it } from "vitest";
import {
  PARITY_FX_EXCLUSIONS,
  PARITY_INSTRUMENT_EXCLUSIONS,
  PARITY_ALIGN_TOLERANCE,
  PARITY_NULL_FLOOR_DB,
  PARITY_MIN_SPECTRAL_COSINE_KEYS,
  comparePhaseInsensitiveParity,
  noteExpressionParityAgrees,
  noteExpressionParityMatrix,
  phaseInsensitiveParityAgrees,
  parityFxCorpus,
  parityInstrumentCorpus,
  parityObligationCheck,
  parityObligations,
  realtimeBranchOwnsTheNull,
} from "../src/testing/live-offline-parity";
import { EFFECT_ORDER } from "../src/effects/registry";
import {
  noteExpressionTargetsForInstrument,
  supportsHeldVoiceSlideNote,
} from "../src/instruments/noteExpressionCapabilities";
import { INSTRUMENT_ORDER } from "../src/instruments/registry";

function tone(frequency: number, phase = 0, amplitude = 0.3, sampleRate = 44100): Float32Array {
  const samples = new Float32Array(sampleRate);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + phase);
  }
  return samples;
}

function detunedPair(phaseA: number, phaseB: number, sampleRate = 44100): Float32Array {
  const samples = new Float32Array(sampleRate);
  const baseFrequency = 329.63;
  const detunedFrequency = baseFrequency * Math.pow(2, 8 / 1200);
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    samples[i] =
      0.5 * Math.sin(2 * Math.PI * baseFrequency * time + phaseA) +
      0.45 * Math.sin(2 * Math.PI * detunedFrequency * time + phaseB);
  }
  return samples;
}

/**
 * Live↔offline parity obligation (release-gate hardening).
 *
 * The real-audio null test runs in the browser gate; this suite is the part
 * that can run on every commit. It enforces the OBLIGATION: a registry
 * member cannot be added (or silently removed from the corpus) without an
 * explicit parity decision. Without this, "invariant #3" is a comment again.
 */
describe("live↔offline parity obligation", () => {
  it("every effect is null-tested or explicitly excluded with a reason", () => {
    const { uncoveredFx } = parityObligations();
    expect(
      uncoveredFx,
      `these effects need a parity decision (add to the corpus or PARITY_FX_EXCLUSIONS with a reason): ${uncoveredFx.join(", ")}`,
    ).toEqual([]);
  });

  it("every instrument is null-tested or explicitly excluded with a reason", () => {
    const { uncoveredInstruments } = parityObligations();
    expect(
      uncoveredInstruments,
      `these instruments need a parity decision: ${uncoveredInstruments.join(", ")}`,
    ).toEqual([]);
  });

  it("maps every declared Piano Roll target and slide-note capability to a live/offline parity case", () => {
    const matrix = noteExpressionParityMatrix();
    const obligationIds = matrix.map(({ kind, family, targetKeys }) => `${kind}:${family}:${targetKeys.join(",")}`);
    expect(new Set(obligationIds).size).toBe(obligationIds.length);

    for (const kind of INSTRUMENT_ORDER) {
      const declared = noteExpressionTargetsForInstrument(kind);
      const rows = matrix.filter((row) => row.kind === kind);
      const noteOn = rows.filter((row) => row.family === "note-on");
      expect(noteOn.map((row) => row.targetKeys)).toEqual([
        ["velocity"],
        ["pitchOffsetSemitones"],
        ...declared.filter((target) => target === "pan" || target === "releaseVelocity").map((target) => [target]),
      ]);

      const directFilter = rows.filter((row) => row.family === "direct-filter");
      expect(directFilter.map((row) => row.targetKeys)).toEqual(
        declared
          .filter((target) => target === "filterCutoffHz" || target === "filterResonance")
          .map((target) => [target]),
      );

      const modulation = rows.filter((row) => row.family === "modulation");
      expect(modulation.map((row) => row.targetKeys)).toEqual(
        declared.filter((target) => target === "modX" || target === "modY").map((target) => [target]),
      );

      const heldSlide = rows.filter((row) => row.family === "held-slide");
      expect(heldSlide.map((row) => row.targetKeys)).toEqual(supportsHeldVoiceSlideNote(kind) ? [["slideNote"]] : []);
    }
  });

  it("the corpus is registry-derived and non-empty", () => {
    const fx = parityFxCorpus();
    const instruments = parityInstrumentCorpus();
    expect(fx.length).toBeGreaterThan(0);
    expect(instruments.length).toBeGreaterThan(0);
    // Corpus ∪ exclusions === the full registry (no drift by construction).
    expect(new Set([...fx, ...PARITY_FX_EXCLUSIONS.keys()])).toEqual(new Set(EFFECT_ORDER));
    expect(new Set([...instruments, ...PARITY_INSTRUMENT_EXCLUSIONS.keys()])).toEqual(new Set(INSTRUMENT_ORDER));
  });

  it("every exclusion carries a non-empty, specific reason", () => {
    for (const [key, reason] of [...PARITY_FX_EXCLUSIONS, ...PARITY_INSTRUMENT_EXCLUSIONS]) {
      expect(reason.length, `${key} exclusion needs a reason`).toBeGreaterThan(8);
      // A reason must not be a placeholder — the whole point is a real decision.
      expect(reason.toLowerCase(), `${key} reason looks like a placeholder`).not.toMatch(/^(todo|tbd|n\/a|skip)$/);
    }
  });

  it("the browser check reports the same obligation outcome", () => {
    const result = parityObligationCheck();
    expect(result.ok, result.message).toBe(true);
    expect(result.message).toContain("fx=");
    expect(result.message).toContain("instruments=");
  });

  it("documents its own thresholds (alignment and null floor)", () => {
    expect(PARITY_NULL_FLOOR_DB).toBeLessThan(0);
    expect(PARITY_ALIGN_TOLERANCE).toBeGreaterThan(0);
  });

  it("accepts a phase-shifted oscillator spectrum without masking changed pitch or level", () => {
    const reference = tone(220);
    const phaseShifted = comparePhaseInsensitiveParity(reference, tone(220, 1.25), 0, 44100);
    expect(phaseShifted.windows).toBeGreaterThanOrEqual(8);
    expect(phaseShifted.spectralCosine).toBeGreaterThanOrEqual(0.98);
    expect(phaseShifted.rmsRatio).toBeGreaterThanOrEqual(0.9);
    expect(phaseShifted.rmsRatio).toBeLessThanOrEqual(1.1);

    const changedPitch = comparePhaseInsensitiveParity(reference, tone(440, 0.5), 0, 44100);
    expect(changedPitch.spectralCosine).toBeLessThan(0.98);

    const changedLevel = comparePhaseInsensitiveParity(reference, tone(220, 0.5, 0.6), 0, 44100);
    expect(changedLevel.spectralCosine).toBeGreaterThanOrEqual(0.98);
    expect(changedLevel.rmsRatio).toBeGreaterThan(1.1);
    expect(phaseInsensitiveParityAgrees(phaseShifted, phaseShifted, phaseShifted, -76)).toBe(true);
    expect(phaseInsensitiveParityAgrees(changedPitch, phaseShifted, phaseShifted, -76)).toBe(false);
    expect(phaseInsensitiveParityAgrees(phaseShifted, phaseShifted, phaseShifted, -30)).toBe(false);
    expect(phaseInsensitiveParityAgrees(phaseShifted, phaseShifted, { ...phaseShifted, rmsRatio: 0.89 }, -76)).toBe(
      false,
    );
    expect(phaseInsensitiveParityAgrees(phaseShifted, phaseShifted, null, -76)).toBe(false);
  });

  it("keeps the spectral comparison stable for a detuned analog oscillator pair", () => {
    const reference = detunedPair(0, 0);
    const phaseShiftedPair = detunedPair(1.4, -2.1);
    const comparison = comparePhaseInsensitiveParity(reference, phaseShiftedPair, 0, 44100);
    expect(comparison.windows).toBeGreaterThanOrEqual(8);
    expect(comparison.spectralCosine).toBeGreaterThanOrEqual(0.98);
    expect(comparison.rmsRatio).toBeGreaterThan(1.1);
    expect(phaseInsensitiveParityAgrees(comparison, comparison, comparison, -76)).toBe(false);
  });

  it("keeps the Keys spectral tolerance local without loosening other instruments", () => {
    const keysSpectrum = { spectralCosine: 0.975, rmsRatio: 1, windows: 12 };
    expect(phaseInsensitiveParityAgrees(keysSpectrum, keysSpectrum, keysSpectrum, -76)).toBe(false);
    expect(
      phaseInsensitiveParityAgrees(keysSpectrum, keysSpectrum, keysSpectrum, -76, PARITY_MIN_SPECTRAL_COSINE_KEYS),
    ).toBe(true);
  });

  it("rejects a silent or divergent second live capture even when the first live null passes", () => {
    const agreeingMeasurement = {
      alignOffset: 0,
      liveNullDb: -76,
      liveRepeatNullDb: -74,
      liveRepeatAlignOffset: 0,
      phaseInsensitive: null,
      phaseInsensitiveControl: null,
      phaseInsensitiveRepeat: null,
      controlNullDb: -78,
    };
    expect(noteExpressionParityAgrees(agreeingMeasurement)).toBe(true);
    const phaseShifted = comparePhaseInsensitiveParity(tone(220), tone(220, 1.25), 0, 44100);
    expect(
      noteExpressionParityAgrees({
        ...agreeingMeasurement,
        liveNullDb: -1,
        liveRepeatNullDb: -1,
        phaseInsensitive: phaseShifted,
        phaseInsensitiveControl: phaseShifted,
        phaseInsensitiveRepeat: phaseShifted,
        controlNullDb: -76,
      }),
    ).toBe(true);
    expect(
      noteExpressionParityAgrees({
        ...agreeingMeasurement,
        liveRepeatNullDb: 0,
        phaseInsensitive: toneSpectrum(220),
        phaseInsensitiveControl: toneSpectrum(220),
        phaseInsensitiveRepeat: { spectralCosine: 0, rmsRatio: 0, windows: 0 },
      }),
    ).toBe(false);
  });
});

function toneSpectrum(frequency: number) {
  const samples = tone(frequency);
  return comparePhaseInsensitiveParity(samples, samples, 0, 44100);
}

/**
 * Who owns a case's null - the engine or the measurement.
 *
 * The rule decides whether a red case is a real live↔offline divergence or a
 * machine that measured twice and got two different answers. It used to see
 * only half of the flakiness, so the SAME case was green on one run and red
 * on the next (measured 2026-10-29: live↔offline at -323.6 dB on one run and
 * -31.7 dB on the next, same machine, same code).
 */
describe("the realtime branch owns the null when it does not reproduce itself", () => {
  it("leaves a case alone when both captures and the offline reference agree", () => {
    expect(
      realtimeBranchOwnsTheNull({
        liveNullDb: -323.6,
        live2NullDb: -323.6,
        liveRepeatNullDb: -323.6,
        controlNullDb: -323.6,
      }),
    ).toBe(false);
  });

  it("excuses a case whose second capture is the odd one out", () => {
    // The shape that flipped the verdict between runs: capture #1 matches the
    // offline reference, capture #2 does not, and the two captures disagree
    // with each other. The engine produced two different answers, so neither
    // difference is attributable to the processing path.
    expect(
      realtimeBranchOwnsTheNull({
        liveNullDb: -323.6,
        live2NullDb: -31.7,
        liveRepeatNullDb: -31.7,
        controlNullDb: -323.6,
      }),
    ).toBe(true);
  });

  it("keeps a reproducible divergence red", () => {
    // Both captures differ from the offline reference AND agree with each
    // other: the realtime branch is reproducible and it really renders
    // differently live than offline. This is the shape the CI runner's
    // instrument cases have, and they have to stay red.
    expect(
      realtimeBranchOwnsTheNull({
        liveNullDb: -28.9,
        live2NullDb: -28.9,
        liveRepeatNullDb: -304.9,
        controlNullDb: -304.9,
      }),
    ).toBe(false);
  });

  it("never excuses while the OFFLINE branch does not reproduce itself", () => {
    // The offline control has to sit BELOW the acceptance floor. A control at
    // -89.5 dB (measured on the 808 case) is still clean by that standard -
    // the two offline renders do not have to be bit-identical, they have to
    // agree to the floor. A control ABOVE the floor is a render that does not
    // reproduce itself, and then no difference can be attributed to anything.
    expect(
      realtimeBranchOwnsTheNull({
        liveNullDb: -31.7,
        live2NullDb: -31.7,
        liveRepeatNullDb: -31.7,
        controlNullDb: -12,
      }),
    ).toBe(false);
  });

  it("keeps the verdict conservative when a capture is missing", () => {
    expect(
      realtimeBranchOwnsTheNull({
        liveNullDb: -31.7,
        live2NullDb: Number.NaN,
        liveRepeatNullDb: -31.7,
        controlNullDb: -323.6,
      }),
    ).toBe(false);
  });
});
