/**
 * Minimal deterministic radix-2 in-place FFT.
 *
 * Ported from audiokey-analyzer `src/dsp/fft.ts`. Encapsulated so the rest of
 * the reference analyzer never touches an FFT implementation directly — a
 * future windowed-sinc resampler or FFT swap stays behind this module.
 * No third-party dependency (bundle budgets).
 */
export class ReferenceFft {
  readonly size: number;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly reverseTable: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error("FFT size must be a power of two");
    }
    this.size = size;
    this.cosTable = new Float64Array(size / 2);
    this.sinTable = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.reverseTable = new Uint32Array(size);
    let bits = 0;
    while (1 << bits < size) bits++;
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.reverseTable[i] = r;
    }
  }

  /** In-place complex FFT. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reverseTable[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const tIdx = k * step;
          const c = this.cosTable[tIdx];
          const s = this.sinTable[tIdx];
          const a = i + k;
          const b = a + half;
          const tre = re[b] * c - im[b] * s;
          const tim = re[b] * s + im[b] * c;
          re[b] = re[a] - tre;
          im[b] = im[a] - tim;
          re[a] += tre;
          im[a] += tim;
        }
      }
    }
  }

  /**
   * Magnitude spectrum of a real signal frame (length = size).
   * Returns size/2 bins into `out`.
   */
  magnitudeSpectrum(frame: Float32Array | Float64Array, out: Float64Array): void {
    const n = this.size;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = frame[i];
    this.transform(re, im);
    for (let i = 0; i < n / 2; i++) {
      out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    }
  }
}
