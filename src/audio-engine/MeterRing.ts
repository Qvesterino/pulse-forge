/**
 * MeterRing — typed-array-backed ring buffer for the master meter pipeline.
 *
 * The DAW pushes `masterChBufL/R` (Float32Array) into the meter on every
 * snapshot tick, then extracts the trailing N seconds (momentary 0.4 s,
 * short-term 3 s) for LUFS analysis. The legacy implementation used
 * `number[]` with `push(...buf) + splice(0, n)` per overshoot — both ops
 * are O(n) AND the spread allocates a fresh array each time. At 48 kHz
 * with 2048-sample chunks pushed every ~46 ms, that allocates ~14 KiB
 * of boxed numbers per second and shifts the whole ring whenever
 * `length > maxSamples`.
 *
 * This ring pre-allocates a single Float32Array of the maximum capacity
 * (`Math.ceil(96000 * 3.2)` = 307 200 samples ≈ 1.2 MiB per channel),
 * tracks the valid range with a start index + size, and copies via
 * `Float32Array.set()` (a single memcpy) on push / lastN. The size cap
 * is enforced by overwriting the oldest samples — no splice.
 *
 * API is intentionally minimal: `push(src)`, `lastN(n)`, `length`,
 * `capacity`, `reset()`. All consumers stay on the hot path with zero
 * observable behaviour change.
 */
export class MeterRing {
  private readonly buf: Float32Array;
  /** Index of the OLDEST valid sample in `buf`. */
  private start = 0;
  /** Number of valid samples currently in the ring (≤ capacity). */
  private size = 0;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isInteger(capacity)) {
      throw new RangeError(`MeterRing capacity must be a positive integer, got ${capacity}`);
    }
    this.buf = new Float32Array(capacity);
  }

  /** Maximum samples the ring can hold. Fixed at construction. */
  get capacity(): number {
    return this.buf.length;
  }

  /** Current number of valid samples (≤ capacity). */
  get length(): number {
    return this.size;
  }

  /**
   * Append `src` samples. If the new total exceeds capacity, the oldest
   * samples are overwritten (no allocation, no shift). If `src.length`
   * is ≥ capacity, only the LAST `capacity` samples are kept.
   */
  push(src: Float32Array): void {
    const cap = this.buf.length;
    const n = src.length;
    if (n === 0) return;

    if (n >= cap) {
      // Caller's buffer is bigger than the whole ring — keep only its tail.
      this.buf.set(src.subarray(n - cap), 0);
      this.start = 0;
      this.size = cap;
      return;
    }

    const writeStart = (this.start + this.size) % cap;
    if (writeStart + n <= cap) {
      // Fits in one contiguous segment.
      this.buf.set(src, writeStart);
    } else {
      // Wraps around the end of the backing buffer.
      const firstLen = cap - writeStart;
      this.buf.set(src.subarray(0, firstLen), writeStart);
      this.buf.set(src.subarray(firstLen), 0);
    }
    // If we overflowed, drop the oldest samples by advancing `start`.
    const overflow = this.size + n - cap;
    if (overflow > 0) {
      this.start = (this.start + overflow) % cap;
      this.size = cap;
    } else {
      this.size += n;
    }
  }

  /**
   * Copy the most recent `n` valid samples into a fresh Float32Array in
   * chronological order. If `n > size`, returns the full ring. If `n <= 0`
   * or `size === 0`, returns an empty Float32Array. The caller owns the
   * returned buffer.
   */
  lastN(n: number): Float32Array {
    if (n <= 0 || this.size === 0) return new Float32Array(0);
    const take = Math.min(n, this.size);
    const cap = this.buf.length;
    const windowStart = (this.start + this.size - take) % cap;
    const out = new Float32Array(take);
    if (windowStart + take <= cap) {
      out.set(this.buf.subarray(windowStart, windowStart + take), 0);
    } else {
      const firstLen = cap - windowStart;
      out.set(this.buf.subarray(windowStart, cap), 0);
      out.set(this.buf.subarray(0, take - firstLen), firstLen);
    }
    return out;
  }

  /** Discard all samples. Does NOT release the backing buffer. */
  reset(): void {
    this.start = 0;
    this.size = 0;
  }
}
