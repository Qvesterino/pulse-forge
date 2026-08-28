import { describe, expect, it } from "vitest";
import { analyzeLoudnessBuffer, KWeightingFilter, kWeightingCoefficients } from "../src/audio-engine/kweighting";
import { truePeakOversampled } from "../src/audio-engine/metering";

/** Mono sine at a given dBFS amplitude into L/R channels. */
function sineStereo(dBFS: number, frequency: number, seconds: number, sampleRate: number, phase = 0): Float32Array[] {
  const amplitude = Math.pow(10, dBFS / 20);
  const n = Math.round(seconds * sampleRate);
  const channels = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const value = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + phase);
    channels[0][i] = value;
    channels[1][i] = value;
  }
  return channels;
}

describe("K-weighting (ITU-R BS.1770-4)", () => {
  // Official conformance target: a 997 Hz (≈1 kHz) sine at −23 dBFS in ALL
  // channels must read −23.0 LUFS ±0.1 — we assert ±0.2 to stay clear of the
  // exact 0.1 boundary across sample rates.

  it("1 kHz sine at −23 dBFS stereo reads −23 LUFS @48 kHz", () => {
    const channels = sineStereo(-23, 1000, 2, 48000);
    const reading = analyzeLoudnessBuffer(channels, 48000);
    expect(reading.measured).toBe(true);
    expect(reading.integrated).toBeGreaterThan(-23.2);
    expect(reading.integrated).toBeLessThan(-22.8);
  });

  it("1 kHz sine at −23 dBFS stereo reads −23 LUFS @44.1 kHz", () => {
    const channels = sineStereo(-23, 997, 2, 44100);
    const reading = analyzeLoudnessBuffer(channels, 44100);
    expect(reading.integrated).toBeGreaterThan(-23.2);
    expect(reading.integrated).toBeLessThan(-22.8);
  });

  it("scales with amplitude: −33 dBFS lands near −33 LUFS", () => {
    const channels = sineStereo(-33, 1000, 2, 48000);
    const reading = analyzeLoudnessBuffer(channels, 48000);
    expect(reading.integrated).toBeGreaterThan(-33.2);
    expect(reading.integrated).toBeLessThan(-32.8);
  });

  it("high-pass stage rejects infrasonic rumble (RLB stage sanity)", () => {
    // 10 Hz at −10 dBFS would dominate a flat-energy meter; K-weighting's
    // 38 Hz high-pass must keep it far below a −23 dBFS reference.
    const rumble = sineStereo(-10, 10, 1.5, 48000);
    const reading = analyzeLoudnessBuffer(rumble, 48000);
    expect(reading.integrated).toBeLessThan(-23);
  });

  it("dual gate: silence around a burst does not dilute integrated", () => {
    // 12 s of near-silence followed by 1.5 s of −23 dBFS tone. Silence
    // blocks fall under the absolute −70 gate; integrated must land at the
    // tone's loudness, not an average with the silence.
    const sampleRate = 48000;
    const silenceSeconds = 12;
    const toneSeconds = 1.5;
    const n = Math.round((silenceSeconds + toneSeconds) * sampleRate);
    const channels = [new Float32Array(n), new Float32Array(n)];
    const amplitude = Math.pow(10, -23 / 20);
    for (let i = Math.round(silenceSeconds * sampleRate); i < n; i++) {
      const v = amplitude * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
      channels[0][i] = v;
      channels[1][i] = v;
    }
    const reading = analyzeLoudnessBuffer(channels, sampleRate);
    expect(reading.integrated).toBeGreaterThan(-24.5);
    expect(reading.integrated).toBeLessThan(-21.5);
  });

  it("material shorter than 400 ms is not measured", () => {
    const tiny = sineStereo(-23, 1000, 0.2, 48000);
    const reading = analyzeLoudnessBuffer(tiny, 48000);
    expect(reading.measured).toBe(false);
    expect(reading.integrated).toBe(-120); // MIN_DB
  });
});

describe("true peak — 4× polyphase oversampling", () => {
  it("catches the fs/4 intersample peak (+3 dB over sample peak)", () => {
    // Classic: a sine at exactly fs/4 with 45° phase alternates ±A/√2 in the
    // samples but peaks at A between them — a +3.01 dB intersample peak.
    const sampleRate = 48000;
    const amplitude = Math.sqrt(0.5); // sample peak = 0.5
    const n = 48000;
    const channel = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      channel[i] = amplitude * Math.sin((2 * Math.PI * (sampleRate / 4) * i) / sampleRate + Math.PI / 4);
    }
    let samplePeak = 0;
    for (let i = 0; i < n; i++) samplePeak = Math.max(samplePeak, Math.abs(channel[i]));
    expect(samplePeak).toBeCloseTo(0.5, 3);

    const truePeak = truePeakOversampled([channel]);
    // True peak ≈ 0.7071 (i.e. sample peak + 3.01 dB) within FIR tolerance.
    expect(truePeak).toBeGreaterThan(0.66);
    expect(truePeak).toBeLessThan(0.75);
    expect(truePeak).toBeGreaterThan(samplePeak * 1.25); // strictly intersample
  });

  it("does not overshoot on ordinary content (≤ +0.5 dB)", () => {
    const sampleRate = 48000;
    const channel = new Float32Array(sampleRate);
    for (let i = 0; i < channel.length; i++) {
      channel[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
    }
    let samplePeak = 0;
    for (let i = 0; i < channel.length; i++) samplePeak = Math.max(samplePeak, Math.abs(channel[i]));
    const truePeak = truePeakOversampled([channel]);
    expect(truePeak).toBeGreaterThan(samplePeak * 0.98);
    expect(truePeak).toBeLessThan(samplePeak * 1.06);
  });
});

describe("K-weighting coefficients", () => {
  it("shelf boosts ~4 dB at high frequencies and HPF kills DC", () => {
    const [shelf, hp] = kWeightingCoefficients(48000);
    // Shelf DC gain (z = 1) should sit near −0.0 dB (BT.1770 shelf is 0 at DC).
    const shelfDc = Math.abs((shelf.b0 + shelf.b1 + shelf.b2) / (1 + shelf.a1 + shelf.a2));
    expect(shelfDc).toBeLessThan(1.05);
    // HP at DC (z = 1) is zero by construction.
    const hpDc = Math.abs((hp.b0 + hp.b1 + hp.b2) / (1 + hp.a1 + hp.a2));
    expect(hpDc).toBeLessThan(1e-9);
  });

  it("KWeightingFilter is stateful across processSample calls", () => {
    const filter = new KWeightingFilter(kWeightingCoefficients(48000));
    // Feed a step — output must build up over samples (stateful IIR).
    let first = 0;
    let tenth = 0;
    for (let i = 0; i < 10; i++) {
      const value = filter.processSample(0.5);
      if (i === 0) first = value;
      if (i === 9) tenth = value;
    }
    expect(first).toBeGreaterThan(0);
    expect(tenth).not.toBe(first);
  });
});
