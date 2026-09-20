import { describe, expect, it } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import {
  MULTIRES_CROSS_HIGH_HZ,
  MULTIRES_CROSS_LOW_HZ,
  SPECTRO_LUT_NAMES,
  SpectrogramHistory,
  composeMultiResRows,
  createSpectrogramBandMap,
  dbToLutIndex,
  dominantRowAround,
  getSpectroLut,
  buildRowFreqs,
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

  it("supports a zoomed log axis (fTop < Nyquist) with valid bin ranges", () => {
    const map = createSpectrogramBandMap(SR, FFT, 100, 20, 2000);
    expect(map.fTop).toBe(2000);
    expect(rowToFreq(map, 0)).toBeGreaterThan(1900);
    expect(rowToFreq(map, 99)).toBeLessThan(25);
    const binCount = FFT >> 1;
    for (let row = 0; row < 100; row++) {
      expect(map.binStart[row]).toBeGreaterThanOrEqual(1);
      expect(map.binEnd[row]).toBeLessThanOrEqual(binCount);
      expect(map.binEnd[row]).toBeGreaterThanOrEqual(map.binStart[row]);
      // A zoomed map must never reference bins above its top frequency.
      expect(map.binEnd[row] * (SR / FFT)).toBeLessThanOrEqual(2100);
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

describe("composeMultiResRows", () => {
  it("reads each pixel row from the band whose window suits it", () => {
    const low = new Float32Array([-60, -100, -100]);
    const mid = new Float32Array([-100, -40, -100]);
    const high = new Float32Array([-100, -100, -35]);
    const rowFreq = new Float32Array([100, 500, 5000]);
    const out = new Float32Array(3);
    composeMultiResRows(low, mid, high, rowFreq, MULTIRES_CROSS_LOW_HZ, MULTIRES_CROSS_HIGH_HZ, out);
    expect(out[0]).toBeCloseTo(-60, 5); // 100 Hz < 250 Hz → long window
    expect(out[1]).toBeCloseTo(-40, 5); // 500 Hz → mid window
    expect(out[2]).toBeCloseTo(-35, 5); // 5 kHz > 2 kHz → short window
  });

  it("row frequencies fed to compose come from the map itself", () => {
    const map = makeMap();
    const freqs = buildRowFreqs(map);
    expect(freqs[0]).toBeGreaterThan(MULTIRES_CROSS_HIGH_HZ);
    expect(freqs[ROWS - 1]).toBeLessThan(MULTIRES_CROSS_LOW_HZ);
  });
});

describe("dominantRowAround", () => {
  it("finds the strongest row within the radius and clamps at the edges", () => {
    const rows = new Float32Array([-90, -60, -30, -45, -90, -90, -90]);
    expect(dominantRowAround(rows, 2, 2)).toBe(2);
    expect(dominantRowAround(rows, 3, 2)).toBe(2); // peak within reach
    expect(dominantRowAround(rows, 6, 4)).toBe(2); // radius clamps at the array edge
    expect(dominantRowAround(rows, 0, 1)).toBe(1); // -60 beats -90 at the boundary
    const flat = new Float32Array(5).fill(-80);
    expect(dominantRowAround(flat, 2, 2)).toBe(2); // ties → cursor row
  });
});

describe("dbToLutIndex", () => {
  it("clamps silence, NaN and out-of-range dB into 0..255 against floor..ceiling", () => {
    expect(dbToLutIndex(-Infinity, -90, 0)).toBe(0);
    expect(dbToLutIndex(NaN, -90, 0)).toBe(0);
    expect(dbToLutIndex(-90, -90, 0)).toBe(0);
    expect(dbToLutIndex(-200, -90, 0)).toBe(0);
    expect(dbToLutIndex(0, -90, 0)).toBe(255);
    expect(dbToLutIndex(+10, -90, 0)).toBe(255);
    expect(dbToLutIndex(-45, -90, 0)).toBe(127);
    // Lowered ceiling spotlights quiet detail: values above the -20 ceiling
    // saturate, and the window compresses everything below it.
    expect(dbToLutIndex(-15, -90, -20)).toBe(255);
    expect(dbToLutIndex(-55, -90, -20)).toBe(127);
  });
});

describe("color LUTs", () => {
  it("runs from near-black/dark to bright and keeps ramp channels monotonic", () => {
    const magma = getSpectroLut("MAGMA");
    expect(magma.length).toBe(256 * 3);
    expect(magma[0] + magma[1] + magma[2]).toBeLessThan(10); // black floor
    expect(magma[255 * 3] + magma[255 * 3 + 1] + magma[255 * 3 + 2]).toBeGreaterThan(600); // bright top
    for (let i = 1; i < 256; i++) {
      expect(magma[i * 3]).toBeGreaterThanOrEqual(magma[(i - 1) * 3]);
      expect(magma[i * 3 + 1]).toBeGreaterThanOrEqual(magma[(i - 1) * 3 + 1]);
    }
  });

  it("offers viridis and grayscale variants with correct endpoints", () => {
    expect(Array.from(SPECTRO_LUT_NAMES)).toEqual(["MAGMA", "VIRIDIS", "GRAY"]);
    const viridis = getSpectroLut("VIRIDIS");
    expect(viridis[0]).toBe(68); // viridis start (dark purple-blue)
    expect(viridis[255 * 3]).toBe(253); // ends bright yellow
    expect(viridis[255 * 3 + 1]).toBe(231);
    const gray = getSpectroLut("GRAY");
    for (let i = 0; i < 256; i++) {
      expect(gray[i * 3]).toBe(i);
      expect(gray[i * 3 + 1]).toBe(i);
      expect(gray[i * 3 + 2]).toBe(i);
    }
    // Cached: same instance back.
    expect(getSpectroLut("MAGMA")).toBe(getSpectroLut("MAGMA"));
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

describe("spectrogram engine taps", () => {
  it("exposes no spectrogram analysers before a master graph exists", () => {
    const engine = new AudioEngine();
    expect(engine.getMasterSpectrogramAnalyser()).toBeNull();
    expect(engine.getMasterSpectrogramTaps()).toBeNull();
    // The spectrum/goniometer taps keep their own getters — the spectrogram
    // never shares their nodes.
    expect(engine.getMasterSpectrumAnalyser()).toBeNull();
    expect(engine.getMasterStereoAnalysers()).toBeNull();
  });
});
