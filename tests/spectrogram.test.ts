import { describe, expect, it } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import {
  SpectrogramHistory,
  buildMagmaLut,
  createSpectrogramBandMap,
  dbToLutIndex,
  reduceFrameToRows,
  rowToFreq,
  type SpectrogramBandMap,
} from "../src/audio-engine/spectrogram";

const SR = 44100;
const FFT = 4096;
const ROWS = 200;

function makeMap(): SpectrogramBandMap {
  return createSpectrogramBandMap(SR, FFT, ROWS);
}

describe("spectrogram band map", () => {
  it("maps rows monotonically from Nyquist (top) down to the 20 Hz floor", () => {
    const map = makeMap();
    expect(map.rowCount).toBe(ROWS);
    expect(rowToFreq(map, 0)).toBeGreaterThan(10000);
    expect(rowToFreq(map, ROWS - 1)).toBeLessThan(25);
    for (let row = 1; row < ROWS; row++) {
      expect(rowToFreq(map, row)).toBeLessThan(rowToFreq(map, row - 1));
    }
  });

  it("covers only valid bins, in descending frequency order, with sub-bin fallbacks", () => {
    const map = makeMap();
    const binCount = FFT >> 1;
    for (let row = 0; row < ROWS; row++) {
      const start = map.binStart[row];
      const end = map.binEnd[row];
      expect(start).toBeGreaterThanOrEqual(1); // DC bin never used
      expect(end).toBeLessThanOrEqual(binCount);
      expect(end).toBeGreaterThanOrEqual(start);
      expect(map.nearestBin[row]).toBeGreaterThanOrEqual(1);
      expect(map.nearestBin[row]).toBeLessThan(binCount);
    }
    // Top rows cover high bins, bottom rows low bins.
    expect(map.binStart[0]).toBeGreaterThan(map.binStart[ROWS - 1]);
    // The ~1 kHz row's band must contain the 1 kHz bin (93 @ 44.1k/4096).
    const bin1k = Math.round(1000 / (SR / FFT));
    const row1k = map.binStart.findIndex((start, row) => start <= bin1k && bin1k < map.binEnd[row]);
    expect(row1k).toBeGreaterThanOrEqual(0);
    const freq = rowToFreq(map, row1k);
    expect(freq).toBeGreaterThan(940);
    expect(freq).toBeLessThan(1060);
  });

  it("gives low rows a nearest bin when the band is narrower than one bin (2048 FFT)", () => {
    // 2048-point FFT @ 44.1 kHz has ~21.5 Hz bins; the 20–21.5 Hz band is sub-bin.
    const map = createSpectrogramBandMap(SR, 2048, ROWS);
    const bottom = ROWS - 1;
    expect(map.binEnd[bottom] - map.binStart[bottom]).toBeLessThanOrEqual(1);
    expect(map.nearestBin[bottom]).toBe(1);
  });
});

describe("reduceFrameToRows", () => {
  it("propagates a spectral spike into exactly the row covering that bin (max reduction)", () => {
    const map = makeMap();
    const frame = new Float32Array(FFT >> 1).fill(-100);
    const bin1k = Math.round(1000 / (SR / FFT));
    frame[bin1k] = -20;
    const out = new Float32Array(ROWS);
    reduceFrameToRows(frame, map, out);

    const row1k = map.binStart.findIndex((start, row) => start <= bin1k && bin1k < map.binEnd[row]);
    expect(out[row1k]).toBeCloseTo(-20, 5);
    const max = out.reduce((a, b) => Math.max(a, b));
    expect(max).toBeCloseTo(-20, 5);
  });

  it("falls back to the nearest bin for sub-bin rows instead of going dark", () => {
    const map = createSpectrogramBandMap(SR, 2048, ROWS);
    const frame = new Float32Array(2048 >> 1).fill(-100);
    frame[1] = -30; // energy only in the lowest usable bin
    const out = new Float32Array(ROWS);
    reduceFrameToRows(frame, map, out);
    expect(out[ROWS - 1]).toBeCloseTo(-30, 5);
  });
});

describe("dbToLutIndex", () => {
  it("clamps silence, NaN and out-of-range dB into 0..255", () => {
    expect(dbToLutIndex(-Infinity, -90, 90)).toBe(0);
    expect(dbToLutIndex(NaN, -90, 90)).toBe(0);
    expect(dbToLutIndex(-90, -90, 90)).toBe(0);
    expect(dbToLutIndex(-200, -90, 90)).toBe(0);
    expect(dbToLutIndex(0, -90, 90)).toBe(255);
    expect(dbToLutIndex(+10, -90, 90)).toBe(255);
    expect(dbToLutIndex(-45, -90, 90)).toBe(127);
  });
});

describe("magma LUT", () => {
  it("runs from near-black to bright and keeps the red channel monotonic", () => {
    const lut = buildMagmaLut();
    expect(lut.length).toBe(256 * 3);
    expect(lut[0] + lut[1] + lut[2]).toBeLessThan(10); // black floor
    expect(lut[255 * 3] + lut[255 * 3 + 1] + lut[255 * 3 + 2]).toBeGreaterThan(600); // bright top
    for (let i = 1; i < 256; i++) {
      expect(lut[i * 3]).toBeGreaterThanOrEqual(lut[(i - 1) * 3]);
      expect(lut[i * 3 + 1]).toBeGreaterThanOrEqual(lut[(i - 1) * 3 + 1]);
    }
  });
});

describe("SpectrogramHistory ring", () => {
  it("keeps the newest column at age 0 and allocates nothing beyond capacity", () => {
    const history = new SpectrogramHistory(4, 3);
    const push = (v: number) => {
      const rows = new Float32Array(4).fill(v);
      history.push(rows);
    };
    push(1);
    push(2);
    push(3);
    expect(Array.from(history.at(0))).toEqual([3, 3, 3, 3]);
    expect(Array.from(history.at(2))).toEqual([1, 1, 1, 1]);
    push(4); // wraps: age 1 is now the old newest
    expect(Array.from(history.at(0))).toEqual([4, 4, 4, 4]);
    expect(Array.from(history.at(1))).toEqual([3, 3, 3, 3]);
    expect(Array.from(history.at(2))).toEqual([2, 2, 2, 2]);
  });

  it("returns silence outside the filled window and after clear", () => {
    const history = new SpectrogramHistory(2, 4);
    expect(history.at(0)[0]).toBe(-Infinity);
    history.push(new Float32Array(2).fill(-40));
    expect(history.at(0)[0]).toBe(-40);
    expect(history.at(1)[0]).toBe(-Infinity);
    history.push(new Float32Array(2).fill(-30));
    history.clear();
    expect(history.at(0)[0]).toBe(-Infinity);
    expect(history.at(1)[0]).toBe(-Infinity);
  });
});

describe("spectrogram engine tap", () => {
  it("exposes no spectrogram analyser before a master graph exists", () => {
    const engine = new AudioEngine();
    expect(engine.getMasterSpectrogramAnalyser()).toBeNull();
    // The spectrum/goniometer taps keep their own getters — the spectrogram
    // never shares their nodes.
    expect(engine.getMasterSpectrumAnalyser()).toBeNull();
    expect(engine.getMasterStereoAnalysers()).toBeNull();
  });
});
