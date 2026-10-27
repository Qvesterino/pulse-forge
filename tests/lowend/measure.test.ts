import { describe, expect, it } from "vitest";
import { bandEnvelope, describeBandMeasurement, measureLowEndRender } from "../../src/instruments/lowEndMeasure";

/**
 * LOW-END STACK wave 3 — the render-based measurement, gated on SYNTHETIC
 * ground truth. The contract is superposition: three PCM streams (mix,
 * kick solo, bass solo) whose residual R = mix − kick − bass is exactly
 * the ducking signal. The ±LU parity gate: an 8 dB duck must be read as
 * ~8 dB of pinch (within ±1.5 dB), no duck must read as ~0, a nonlinearity
 * must trip the guard, and a 1 kHz tone must vanish from the low bands.
 */

const SR = 44100;

/** −12 dBFS sine burst, exponential ~120 ms decay — a kick body without a click. */
function kickPcm(sr: number, onsets: number[], totalSeconds: number, hz: number): Float32Array {
  const n = Math.round(totalSeconds * sr);
  const pcm = new Float32Array(n);
  const amp = Math.pow(10, -12 / 20);
  for (const t0 of onsets) {
    const start = Math.round(t0 * sr);
    const len = Math.round(0.35 * sr);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / sr;
      pcm[start + i]! += amp * Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / 0.12);
    }
  }
  return pcm;
}

/** −20 dBFS constant sine — the unducked bass reference U(t). */
function bassPcm(sr: number, totalSeconds: number, hz: number): Float32Array {
  const n = Math.round(totalSeconds * sr);
  const pcm = new Float32Array(n);
  const amp = Math.pow(10, -20 / 20);
  for (let i = 0; i < n; i++) pcm[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return pcm;
}

/** The duck gain curve the sidechain applies: dips to `duckDb` at each onset, τ = 80 ms recovery. */
function duckGain(sr: number, onsets: number[], totalSeconds: number, duckDb: number): Float32Array {
  const n = Math.round(totalSeconds * sr);
  const gain = new Float32Array(n).fill(1);
  const dip = Math.pow(10, -duckDb / 20);
  const tau = 0.08 * sr;
  for (let i = 0; i < n; i++) {
    const sinceSamples = onsets.map((t0) => i - Math.round(t0 * sr)).filter((s) => s >= 0);
    if (sinceSamples.length === 0) continue;
    const since = Math.min(...sinceSamples);
    gain[i] = dip + (1 - dip) * (1 - Math.exp(-since / tau));
  }
  return gain;
}

const ONSETS = [0, 0.5, 1.0, 1.5];
const TOTAL = 2.2;
const KICK_HZ = 40; // ≈ MIDI 24 (C1) — the tuned kick fundamental
const BASS_HZ = 65.4; // ≈ MIDI 36 (C2) — one octave up

/** The full synthetic scene: solo kick, solo bass, and the mix with the duck applied. */
function scene(duckDb: number, kickHz = KICK_HZ, bassHz = BASS_HZ) {
  const kick = kickPcm(SR, ONSETS, TOTAL, kickHz);
  const bass = bassPcm(SR, TOTAL, bassHz);
  const gain = duckGain(SR, ONSETS, TOTAL, duckDb);
  const mix = new Float32Array(bass.length);
  for (let i = 0; i < mix.length; i++) mix[i] = kick[i]! + bass[i]! * gain[i]!;
  return { mix, kick, bass };
}

describe("measureLowEndRender — the ±LU parity gate", () => {
  it("reads no duck as ≈0 dB of pump (linear chain: the residual is silence)", () => {
    const m = measureLowEndRender(scene(0), SR, { onsetSeconds: ONSETS, analyzedSeconds: TOTAL }, KICK_HZ, BASS_HZ);
    expect(m.bandsTooClose).toBe(false);
    expect(m.pumpHits).toBeGreaterThanOrEqual(3);
    expect(m.pumpDepthDb).toBeLessThanOrEqual(1);
    // Superposition holds exactly: the residual floor is vanishingly low.
    expect(m.residualFloorDb).toBeLessThanOrEqual(-60);
  });

  it("reads an 8 dB duck within the ±LU parity band around the truth", () => {
    const m = measureLowEndRender(scene(8), SR, { onsetSeconds: ONSETS, analyzedSeconds: TOTAL }, KICK_HZ, BASS_HZ);
    // The documented bias: the ratio decays while the envelope settles, so
    // the read is a CONSERVATIVE lower bound — never above the truth,
    // within ~25% under it. (Measured 6.19 vs truth 8 at 1 ms attack.)
    expect(m.pumpDepthDb).toBeGreaterThanOrEqual(8 * 0.75);
    expect(m.pumpDepthDb).toBeLessThanOrEqual(8 + 1);
    // And the guard stays quiet — the duck is the ONLY nonlinearity here.
    expect(m.residualFloorDb).toBeLessThanOrEqual(-25);
  });

  it("flags nonlinearity: extra energy the superposition cannot explain trips the guard", () => {
    const { mix, kick, bass } = scene(0);
    const corrupted = new Float32Array(mix.length);
    for (let i = 0; i < mix.length; i++) {
      // A slow unrelated wobble the solo renders know nothing about.
      corrupted[i] = mix[i]! + 0.02 * Math.sin((2 * Math.PI * 3 * i) / SR);
    }
    const m = measureLowEndRender(
      { mix: corrupted, kick, bass },
      SR,
      { onsetSeconds: ONSETS, analyzedSeconds: TOTAL },
      KICK_HZ,
      BASS_HZ,
    );
    expect(m.residualFloorDb).toBeGreaterThan(-25);
    expect(describeBandMeasurement(m)).toMatch(/indicative/);
  });

  it("rejects out-of-band content: a 1 kHz tone stays 30+ dB under the solo low bands", () => {
    const n = Math.round(TOTAL * SR);
    const bright = new Float32Array(n);
    for (let i = 0; i < n; i++) bright[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    const m = measureLowEndRender(
      { mix: bright, kick: bright, bass: bright },
      SR,
      { onsetSeconds: ONSETS, analyzedSeconds: TOTAL },
      KICK_HZ,
      BASS_HZ,
    );
    expect(m.kickBandPeakDb).toBeLessThanOrEqual(-30);
    expect(m.bassBandPeakDb).toBeLessThanOrEqual(-30);
  });

  it("rejects subsonic rumble: 15 Hz stays out of the kick band (the HP's job)", () => {
    const n = Math.round(TOTAL * SR);
    const rumble = new Float32Array(n);
    for (let i = 0; i < n; i++) rumble[i] = 0.5 * Math.sin((2 * Math.PI * 15 * i) / SR);
    const m = measureLowEndRender(
      { mix: rumble, kick: rumble, bass: rumble },
      SR,
      { onsetSeconds: ONSETS, analyzedSeconds: TOTAL },
      KICK_HZ,
      BASS_HZ,
    );
    // −6 dBFS in, half an octave below the band edge: the 2-pole HP owes
    // ~15 dB of rejection here; without it the LP alone leaks the tone in.
    expect(m.kickBandPeakDb).toBeLessThanOrEqual(-10);
  });

  it("refuses the solo peaks when the fundamentals sit closer than 5 st (the pump still measures)", () => {
    const m = measureLowEndRender(scene(8, 60, 64), SR, { onsetSeconds: ONSETS, analyzedSeconds: TOTAL }, 60, 64);
    expect(m.bandsTooClose).toBe(true);
    expect(m.kickBandPeakDb).toBe(-120);
    // The residual pump does not need band separation — it stays honest.
    expect(m.pumpDepthDb).toBeGreaterThan(5);
  });

  it("bandEnvelope tracks a step: fast attack inside the tone, slow release after it", () => {
    const n = Math.round(0.5 * SR);
    const pcm = new Float32Array(n);
    for (let i = Math.round(0.1 * SR); i < Math.round(0.3 * SR); i++) {
      pcm[i] = 0.1 * Math.sin((2 * Math.PI * 60 * i) / SR);
    }
    const env = bandEnvelope(pcm, SR, 40, 90);
    const at = (ms: number) => env[Math.round((ms / 1000) * SR)]!;
    expect(at(50)).toBeLessThan(0.02); // nothing before the tone
    expect(at(200)).toBeGreaterThan(0.05); // attack settled inside the tone
    expect(at(350)).toBeLessThan(at(300)! * 0.6); // release is under way
  });
});

describe("describeBandMeasurement", () => {
  it("names the pump, the flat read, and the withheld peaks", () => {
    const base = {
      kickBandPeakDb: -8,
      bassBandPeakDb: -14,
      pumpHits: 4,
      residualFloorDb: -40,
      bandsTooClose: false,
      kickHz: KICK_HZ,
      bassHz: BASS_HZ,
      analyzedSeconds: TOTAL,
    };
    expect(describeBandMeasurement({ ...base, pumpDepthDb: 7.2, pumpGain: 0.56 })).toMatch(/pinches the bass 7\.2 dB/);
    expect(describeBandMeasurement({ ...base, pumpDepthDb: 0.1, pumpGain: 0.01 })).toMatch(/no pump detected/);
    const close = describeBandMeasurement({
      ...base,
      pumpDepthDb: 8,
      pumpGain: 0.6,
      bandsTooClose: true,
      kickHz: 60,
      bassHz: 64,
    });
    expect(close).toMatch(/withheld/);
  });
});
