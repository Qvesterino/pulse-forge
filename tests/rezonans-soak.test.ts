/**
 * REZONANS soak — 300 s of Fine / four-voice worklet-core audio.
 *
 * Pins the long-run properties the short goldens cannot: finite output,
 * denormal-free samples, bounded output level, stable loudness and bounded
 * retained heap while the shared analysis and all synthesis voices stay hot.
 */
import { describe, expect, it } from "vitest";
import { QUALITY_FINE, REZ_PARAM, voiceParamId } from "../src/effects/rezonans-core/contracts/parameters";
import { RezonansProcessor } from "../src/effects/rezonans-core/dsp/rezonansProcessor";

const SR = 48000;
const BLOCK = 128;
const SOAK_SECONDS = 300;
const TOTAL_BLOCKS = (SOAK_SECONDS * SR) / BLOCK;
const HEAP_LIMIT_BYTES = 6 * 1024 * 1024;

describe("REZONANS 300 s soak", () => {
  it("keeps four Fine voices finite, stable and bounded without heap growth", () => {
    const processor = new RezonansProcessor();
    processor.prepare(SR, 2, BLOCK, 120);
    processor.setParameter(REZ_PARAM.quality, QUALITY_FINE);
    processor.setParameter(REZ_PARAM.harmonyMode, 1);
    processor.setParameter(REZ_PARAM.voices, 4);
    processor.setParameter(REZ_PARAM.mix, 1);
    processor.setParameter(REZ_PARAM.bodyGate, 0);
    processor.setParameter(REZ_PARAM.clarity, 0);
    for (let voice = 0; voice < 4; voice++) {
      processor.setParameter(voiceParamId(voice, "enabled"), 1);
      processor.setParameter(voiceParamId(voice, "degree"), [3, 7, 12, 0][voice]!);
      processor.setParameter(voiceParamId(voice, "level"), 0.35);
      processor.setParameter(voiceParamId(voice, "pan"), [-0.75, -0.25, 0.25, 0.75][voice]!);
      processor.setParameter(voiceParamId(voice, "formant"), [6, -6, 3, 0][voice]!);
      processor.setParameter(voiceParamId(voice, "humanize"), 0);
    }
    processor.prepareOfflineRender();

    const source = new Float32Array(SR);
    for (let i = 0; i < source.length; i++) {
      const phase = (2 * Math.PI * 220 * i) / SR;
      source[i] = 0.24 * (Math.sin(phase) + 0.38 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase));
    }

    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    const channels = [left, right];
    let nonFinite = 0;
    let subnormal = 0;
    let peak = 0;
    let earlyEnergy = 0;
    let lateEnergy = 0;
    // Both windows start on the same 8 s cycle of the 1 s source and the
    // 1024-sample Fine analysis hop. Comparing different hop phases adds a
    // small, irrelevant overlap-add phase offset to the RMS drift metric.
    const earlyStart = 8 * SR;
    const earlyEnd = 18 * SR;
    const lateStart = 280 * SR;
    const lateEnd = 290 * SR;

    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let block = 0; block < TOTAL_BLOCKS; block++) {
      const offset = block * BLOCK;
      for (let i = 0; i < BLOCK; i++) {
        const sample = source[(offset + i) % source.length]!;
        left[i] = sample;
        right[i] = sample * 0.94;
      }
      processor.process(channels, BLOCK);

      for (let i = 0; i < BLOCK; i++) {
        const l = left[i]!;
        const r = right[i]!;
        if (!Number.isFinite(l) || !Number.isFinite(r)) nonFinite++;
        const magnitude = Math.max(Math.abs(l), Math.abs(r));
        if (magnitude > peak) peak = magnitude;
        if ((l !== 0 && Math.abs(l) < 1e-20) || (r !== 0 && Math.abs(r) < 1e-20)) subnormal++;

        const sampleIndex = offset + i;
        if (sampleIndex >= earlyStart && sampleIndex < earlyEnd) earlyEnergy += l * l + r * r;
        if (sampleIndex >= lateStart && sampleIndex < lateEnd) lateEnergy += l * l + r * r;
      }
    }

    global.gc?.();
    const heapGrowthBytes = process.memoryUsage().heapUsed - heapBefore;
    const driftDb = Math.abs(10 * Math.log10(lateEnergy / earlyEnergy));
    const meters = processor.getMeters();

    console.log(
      `[rezonans-soak] peak=${peak.toFixed(3)} drift=${driftDb.toFixed(5)}dB ` +
        `heapGrowth=${(heapGrowthBytes / (1024 * 1024)).toFixed(1)}MB ` +
        `f0=${meters.f0.toFixed(1)}Hz voiced=${(meters.voicedRatio * 100).toFixed(1)}%`,
    );
    expect(nonFinite).toBe(0);
    expect(subnormal).toBe(0);
    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThan(4);
    expect(driftDb).toBeLessThanOrEqual(0.003);
    expect(heapGrowthBytes).toBeLessThan(HEAP_LIMIT_BYTES);
    expect(meters.f0).toBeGreaterThan(0);
    expect(meters.voicedRatio).toBeGreaterThan(0.9);
  }, 180_000);
});
