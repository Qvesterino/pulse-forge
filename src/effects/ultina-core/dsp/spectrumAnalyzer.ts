/* eslint-disable */
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ultina — Spectrum Analyzer
//
// Lightweight FFT-based spectrum analyzer for the editor UI.
// Uses a 256-point radix-2 Cooley-Tukey FFT with Hann window.
// Outputs 64 log-spaced bins covering 20 Hz – 20 kHz in dBFS.
//
// Runs on the audio thread but only when the editor requests
// meter data (throttled by the meter polling rate).
// ═══════════════════════════════════════════════════════════

/** Number of FFT points (must be power of 2). */
export const FFT_SIZE = 256;

/** Number of output display bins. */
export const SPECTRUM_BINS = 64;

/** Minimum frequency for display (Hz). */
const MIN_DISPLAY_FREQ = 20;

/** Maximum frequency for display (Hz). */
const MAX_DISPLAY_FREQ = 20000;

/** dB floor for display. */
const DB_FLOOR = -100;

/**
 * Spectrum analyzer with pre-allocated buffers.
 * Call `process()` with a mono signal (already summed L+R),
 * then `getBins()` to retrieve the 64-bin dB array.
 */
export class SpectrumAnalyzer {
  /** Real part of FFT input/output (reused to avoid allocation). */
  private real: Float64Array = new Float64Array(FFT_SIZE);
  /** Imaginary part of FFT input/output. */
  private imag: Float64Array = new Float64Array(FFT_SIZE);
  /** Hann window coefficients (precomputed). */
  private window: Float64Array = new Float64Array(FFT_SIZE);
  /** Output bins in dB. */
  private binsDb: Float32Array = new Float32Array(SPECTRUM_BINS);
  /** Bit-reversal lookup table. */
  private bitReverseTable: Int32Array;
  /** Precomputed log-frequency bin boundaries (linear FFT bin indices). */
  private binEdges: Float64Array = new Float64Array(SPECTRUM_BINS + 1);
  /** Sample rate (set in prepare). */
  private sampleRate: number = 44100;
  /** Whether the window has been initialized. */
  private initialized: boolean = false;

  /**
   * Create a new spectrum analyzer.
   * The Hann window and bit-reversal table are precomputed once.
   */
  constructor() {
    this.bitReverseTable = this.buildBitReverseTable();
    this.computeWindow();
    this.computeBinEdges();
    this.initialized = true;
  }

  /**
   * Prepare the analyzer for a given sample rate.
   * Bin edges depend on sample rate so they must be recomputed.
   */
  prepare(sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.computeBinEdges();
  }

  /**
   * Process a block of mono samples and update internal spectrum.
   * If frameCount < FFT_SIZE, earlier slots are zero-filled.
   */
  process(mono: Float32Array, frameCount: number): void {
    if (!this.initialized) {
      this.computeWindow();
      this.computeBinEdges();
      this.initialized = true;
    }

    const n = FFT_SIZE;
    const samplesToCopy = Math.min(frameCount, n);

    // Apply Hann window and copy into real[], zero imag[]
    for (let i = 0; i < n; i++) {
      if (i < samplesToCopy) {
        this.real[i] = mono[i] * this.window[i];
      } else {
        this.real[i] = 0;
      }
      this.imag[i] = 0;
    }

    // In-place radix-2 FFT
    this.fftInPlace(this.real, this.imag);

    // Compute magnitude spectrum for first N/2 bins
    const halfN = n >> 1;
    const mag = this.real; // reuse as magnitude buffer (we don't need real after this)
    for (let i = 0; i < halfN; i++) {
      const re = this.real[i];
      const im = this.imag[i];
      mag[i] = Math.sqrt(re * re + im * im);
    }

    // Map to 64 log-spaced bins
    const nyquist = this.sampleRate * 0.5;
    const normFloor = 1e-10;
    const dbRange = -DB_FLOOR; // 100 dB

    for (let b = 0; b < SPECTRUM_BINS; b++) {
      const startIdx = Math.floor(this.binEdges[b]);
      const endIdx = Math.ceil(this.binEdges[b + 1]);
      const lo = Math.max(1, startIdx); // skip DC bin
      const hi = Math.min(halfN - 1, endIdx);

      if (lo > hi) {
        this.binsDb[b] = DB_FLOOR;
        continue;
      }

      // Find peak magnitude in this bin range
      let peakMag = 0;
      for (let i = lo; i <= hi; i++) {
        if (mag[i] > peakMag) peakMag = mag[i];
      }

      // Normalize by FFT size, convert to dB
      const normalized = peakMag / (n * 0.5); // scale by N/2 for Hann
      const clamped = Math.max(normFloor, normalized);
      let db = 20 * Math.log10(clamped);
      if (db < DB_FLOOR) db = DB_FLOOR;

      this.binsDb[b] = db;
    }

    // Prevent unused-variable warning
    void nyquist;
    void dbRange;
  }

  /**
   * Get the current spectrum bins (64 values in dBFS).
   * Returns a reference to the internal array — do not modify.
   */
  getBins(): Float32Array {
    return this.binsDb;
  }

  /** Reset the analyzer state. */
  reset(): void {
    this.real.fill(0);
    this.imag.fill(0);
    this.binsDb.fill(DB_FLOOR);
  }

  // ── Internal helpers ───────────────────────────────────────

  /** Compute Hann window coefficients. */
  private computeWindow(): void {
    const n = FFT_SIZE;
    for (let i = 0; i < n; i++) {
      this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    }
  }

  /**
   * Compute log-spaced bin edges in terms of linear FFT bin indices.
   * Each edge maps a frequency to its corresponding FFT bin.
   */
  private computeBinEdges(): void {
    const binFreqStep = this.sampleRate / FFT_SIZE;
    const logMin = Math.log10(MIN_DISPLAY_FREQ);
    const logMax = Math.log10(Math.min(MAX_DISPLAY_FREQ, this.sampleRate * 0.49));
    const logRange = logMax - logMin;

    for (let i = 0; i <= SPECTRUM_BINS; i++) {
      const t = i / SPECTRUM_BINS;
      const freq = Math.pow(10, logMin + t * logRange);
      this.binEdges[i] = freq / binFreqStep;
    }
  }

  /**
   * Build the bit-reversal permutation table for FFT_SIZE.
   */
  private buildBitReverseTable(): Int32Array {
    const n = FFT_SIZE;
    const bits = Math.log2(n);
    const table = new Int32Array(n);

    for (let i = 0; i < n; i++) {
      let rev = 0;
      let val = i;
      for (let j = 0; j < bits; j++) {
        rev = (rev << 1) | (val & 1);
        val >>= 1;
      }
      table[i] = rev;
    }

    return table;
  }

  /**
   * In-place radix-2 Cooley-Tukey FFT.
   * Uses the precomputed bit-reversal table.
   */
  private fftInPlace(re: Float64Array, im: Float64Array): void {
    const n = FFT_SIZE;
    const table = this.bitReverseTable;

    // Bit-reversal permutation
    for (let i = 0; i < n; i++) {
      const j = table[i];
      if (j > i) {
        const tmpRe = re[i];
        re[i] = re[j];
        re[j] = tmpRe;

        const tmpIm = im[i];
        im[i] = im[j];
        im[j] = tmpIm;
      }
    }

    // Butterfly operations
    for (let size = 2; size <= n; size <<= 1) {
      const halfSize = size >> 1;
      const angleStep = (-2 * Math.PI) / size;

      for (let i = 0; i < n; i += size) {
        for (let j = i; j < i + halfSize; j++) {
          const k = j + halfSize;
          const angle = angleStep * (j - i);
          const cosA = Math.cos(angle);
          const sinA = Math.sin(angle);

          const tre = re[k] * cosA - im[k] * sinA;
          const tim = re[k] * sinA + im[k] * cosA;

          re[k] = re[j] - tre;
          im[k] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }
}
