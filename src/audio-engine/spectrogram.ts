/**
 * Spectrogram analysis primitives: pure math that turns AnalyserNode
 * frequency frames into ready-to-paint spectrogram columns.
 *
 * Kept separate from the renderer (src/ui/Spectrogram.tsx) so the mapping is
 * unit-testable without a DOM and so future consumers (track spectrograms,
 * pre/post-FX comparison, masking overlays) can reuse the exact pipeline:
 *
 *   Audio Signal → Analysis Tap (engine-owned AnalyserNode)
 *   → FFT frames (getFloatFrequencyData, dBFS)
 *   → log-frequency band reduction (reduceFrameToRows)
 *   → dB ring history (SpectrogramHistory)
 *   → renderer paints columns + overlays
 *
 * Nothing here touches the DOM, the audio graph, or wall-clock time.
 *
 * Row convention: row 0 is the TOP of the drawing (Nyquist), row
 * rowCount-1 is the bottom (minFreq) — the same order canvas pixel rows
 * are written, so renderers never flip indices.
 */

export const SPECTRO_MIN_FREQ = 20;

export interface SpectrogramBandMap {
  readonly rowCount: number;
  /** First FFT bin covered by each row (inclusive). Bin 0 (DC) is never used. */
  readonly binStart: Int32Array;
  /** First FFT bin NOT covered by each row (exclusive). */
  readonly binEnd: Int32Array;
  /** Nearest bin for rows narrower than one bin spacing (sub-bass on small FFTs). */
  readonly nearestBin: Int32Array;
  readonly sampleRate: number;
  readonly fftSize: number;
  readonly minFreq: number;
  readonly nyquist: number;
}

/**
 * Log-frequency map from canvas rows to FFT bins. Rows are equal-height
 * bands between minFreq and Nyquist on a log axis, so each octave gets the
 * same pixel height and kick/sub behavior stays readable.
 */
export function createSpectrogramBandMap(
  sampleRate: number,
  fftSize: number,
  rowCount: number,
  minFreq = SPECTRO_MIN_FREQ,
): SpectrogramBandMap {
  const binCount = fftSize >> 1;
  const nyquist = sampleRate / 2;
  const binStart = new Int32Array(rowCount);
  const binEnd = new Int32Array(rowCount);
  const nearestBin = new Int32Array(rowCount);
  const binHz = sampleRate / fftSize;
  const logRatio = Math.log(nyquist / minFreq);

  for (let row = 0; row < rowCount; row++) {
    // Row edges in log space: row 0 spans [edge(top0), edge(top1)) near Nyquist.
    const fHi = minFreq * Math.exp(logRatio * (1 - row / rowCount));
    const fLo = minFreq * Math.exp(logRatio * (1 - (row + 1) / rowCount));
    const start = Math.max(1, Math.ceil(fLo / binHz));
    const end = Math.min(binCount, Math.ceil(fHi / binHz));
    binStart[row] = start;
    binEnd[row] = Math.max(start, end);
    const center = (fLo + fHi) / 2;
    nearestBin[row] = Math.min(binCount - 1, Math.max(1, Math.round(center / binHz)));
  }

  return { rowCount, binStart, binEnd, nearestBin, sampleRate, fftSize, minFreq, nyquist };
}

/** Center frequency of a row on the map's log axis (for cursor readouts). */
export function rowToFreq(map: SpectrogramBandMap, row: number): number {
  const { rowCount, minFreq, nyquist } = map;
  const clamped = Math.min(rowCount - 1, Math.max(0, row));
  const t = (rowCount - clamped - 0.5) / rowCount;
  return minFreq * Math.exp(Math.log(nyquist / minFreq) * t);
}

/**
 * Reduce one FFT frame to per-row dB values. Bands wider than a bin take
 * the max (peak-preserving — the X-ray look), sub-bin bands read their
 * nearest bin so low rows never go dark on small FFT sizes.
 */
export function reduceFrameToRows(freqData: Float32Array, map: SpectrogramBandMap, out: Float32Array): void {
  const { rowCount, binStart, binEnd, nearestBin } = map;
  for (let row = 0; row < rowCount; row++) {
    const start = binStart[row];
    const end = binEnd[row];
    if (end <= start) {
      out[row] = freqData[nearestBin[row]];
      continue;
    }
    let max = -Infinity;
    for (let bin = start; bin < end; bin++) {
      if (freqData[bin] > max) max = freqData[bin];
    }
    out[row] = max;
  }
}

/** dBFS → color-map index. Silence (-Infinity/NaN) and anything below the floor map to 0. */
export function dbToLutIndex(db: number, floorDb: number, rangeDb: number): number {
  if (!Number.isFinite(db)) return 0;
  const norm = (db - floorDb) / rangeDb;
  if (norm <= 0) return 0;
  if (norm >= 1) return 255;
  return (norm * 255) | 0;
}

/** magma anchors (t, r, g, b) — perceptually uniform, black background. */
const MAGMA_STOPS: Array<[number, number, number, number]> = [
  [0.0, 0, 0, 4],
  [0.1, 24, 15, 61],
  [0.2, 68, 15, 118],
  [0.3, 114, 31, 129],
  [0.4, 158, 47, 127],
  [0.5, 205, 64, 113],
  [0.6, 241, 96, 93],
  [0.7, 253, 150, 104],
  [0.8, 254, 202, 141],
  [0.9, 254, 240, 178],
  [1.0, 254, 253, 191],
];

/** 256-entry RGB color LUT (768 bytes), precomputed once per page. */
export function buildMagmaLut(): Uint8Array<ArrayBuffer> {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s = 0;
    while (s < MAGMA_STOPS.length - 2 && t > MAGMA_STOPS[s + 1][0]) s++;
    const [t0, r0, g0, b0] = MAGMA_STOPS[s];
    const [t1, r1, g1, b1] = MAGMA_STOPS[s + 1];
    const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    lut[i * 3] = Math.round(r0 + (r1 - r0) * f);
    lut[i * 3 + 1] = Math.round(g0 + (g1 - g0) * f);
    lut[i * 3 + 2] = Math.round(b0 + (b1 - b0) * f);
  }
  return lut;
}

/**
 * Ring of the most recent dB columns (one Float32Array of `rowCount` per
 * pushed frame). Fixed allocation after construction — the render loop
 * never allocates. `at()` returns the live internal buffer for age < filled
 * (treat as read-only) and a shared silence column otherwise.
 */
export class SpectrogramHistory {
  private readonly columns: Float32Array<ArrayBuffer>[];
  private readonly silent: Float32Array<ArrayBuffer>;
  private writeIndex = 0;
  private filled = 0;

  constructor(
    readonly rowCount: number,
    readonly capacity: number,
  ) {
    this.columns = [];
    for (let i = 0; i < capacity; i++) this.columns.push(new Float32Array(rowCount));
    this.silent = new Float32Array(rowCount).fill(-Infinity);
  }

  /** Store one frame (copied) as the newest column. */
  push(rows: Float32Array): void {
    this.columns[this.writeIndex].set(rows);
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /** Column `age` frames back (0 = newest). Silence outside the filled window. */
  at(age: number): Float32Array<ArrayBuffer> {
    if (age < 0 || age >= this.filled) return this.silent;
    return this.columns[(this.writeIndex - 1 - age + this.capacity * 2) % this.capacity];
  }

  /** All columns → silence (stop/seek/resize: old content must not read as current). */
  clear(): void {
    this.writeIndex = 0;
    this.filled = 0;
  }
}
