/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Partitioned FFT convolution
//
// Used by the Convolution Reverb engine. Uniform-partition convolution
// (Gardner, 1994) breaks a long impulse response into partitions of
// length `hopSize = partitionSize / 2`, transforms each partition once
// into the frequency domain, and convolves them with the live input
// signal. This keeps the per-block cost bounded at O(N log N)
// regardless of IR length.
//
// Formulation (validated against direct convolution):
//   • IR partition p  →  H_p = FFT([ h[p·L .. (p+1)·L), 0[L .. 2L) ])
//   • Input block q   →  X_q = FFT([ x[q·L .. (q+1)·L), 0[L .. 2L) ])
//   • Circular conv   →  Y_t = IFFT(Σ_p H_p · X_{t−p})
//   • Output segment t = Y_t[0 .. L) + Y_{t−1}[L .. 2L)
//     (the first half of Y_t is the tail of the linear convolution
//      reaching into block t−1, and the second half of Y_{t−1} is the
//      head belonging to block t; together they equal the ideal output
//      block y_ideal[t·L .. (t+1)·L))
//   • Fixed latency of `hopSize` samples (output position q holds
//     y_ideal[q − hop]); positions below `hopSize` are silence.
//
// The implementation is allocation-free at steady state, accepts any
// block size, and runs its internal FFT schedule on hop-aligned
// boundaries.
// ═══════════════════════════════════════════════════════════

import { fft, fftPlan, isPow2, nextPow2 } from "./fft.js";

export interface PartitionedConvolverOptions {
  /** IR length in samples (any length, will be zero-padded). */
  irLength: number;
  /** Partition size in samples (power of two, default 2048). */
  partitionSize?: number;
}

export interface PartitionedConvolver {
  /** Process `blockSize` new input samples (any length ≥ 1). */
  process(input: Float32Array, blockSize: number, output: Float32Array): void;
  /** Latency in samples (always partitionSize / 2). */
  readonly latency: number;
  /** Partition size (FFT length). */
  readonly partitionSize: number;
  /** Number of partitions the IR was split into. */
  readonly numPartitions: number;
  /** Reset internal state (input blocks + output ring + accumulators). */
  reset(): void;
}

/**
 * Build a partitioned convolver from a mono impulse response.
 * The IR is split into `ceil(irLength / hopSize)` partitions of
 * `hopSize` samples, each zero-padded to `partitionSize` and FFT'd
 * once at load time.
 */
export function createPartitionedConvolver(
  ir: Float32Array,
  opts: PartitionedConvolverOptions,
): PartitionedConvolver {
  const partitionSize = opts.partitionSize ?? 2048;
  if (!isPow2(partitionSize)) {
    throw new Error(
      `createPartitionedConvolver: partitionSize must be a power of two, got ${partitionSize}`,
    );
  }
  const hopSize = partitionSize / 2;
  const numPartitions = Math.ceil(opts.irLength / hopSize);
  if (numPartitions < 1) {
    throw new Error("createPartitionedConvolver: IR length must be ≥ 1 sample");
  }

  // Pre-computed FFT of each IR partition.
  // Layout: irSpectrums[p * partitionSize * 2 + 2*k + 0] = real, + 1 = imag.
  const irSpectrums = new Float64Array(numPartitions * partitionSize * 2);
  const irRe = new Float64Array(partitionSize);
  const irIm = new Float64Array(partitionSize);
  for (let p = 0; p < numPartitions; p++) {
    irRe.fill(0);
    irIm.fill(0);
    const offset = p * hopSize;
    for (let i = 0; i < hopSize; i++) {
      const src = offset + i;
      if (src < ir.length) irRe[i] = ir[src];
    }
    fft(irRe, irIm);
    const base = p * partitionSize * 2;
    for (let k = 0; k < partitionSize; k++) {
      irSpectrums[base + 2 * k] = irRe[k];
      irSpectrums[base + 2 * k + 1] = irIm[k];
    }
  }

  // Input block spectra ring — slot (j % numPartitions) holds X_j.
  // Sized so Y_t can always reach the partitions it needs.
  const blockSpectra = new Float64Array(numPartitions * partitionSize * 2);
  const blockBuf = new Float32Array(hopSize);
  let pending = 0; // samples buffered toward the next hop block
  let blockCount = 0; // input blocks fully received so far

  // Output ring — 2·hop entries. outRing[q % partitionSize] holds the
  // ideal output sample y_ideal[q − hop].
  // Y_{t−1}[L .. 2L) is captured here for the next segment.
  const outRing = new Float32Array(partitionSize);
  const prevSecondHalf = new Float32Array(hopSize);
  let absRead = 0; // next output absolute position the host will read

  // Scratch buffers (reused, allocation-free at steady state).
  const inRe = new Float64Array(partitionSize);
  const inIm = new Float64Array(partitionSize);
  const accRe = new Float64Array(partitionSize);
  const accIm = new Float64Array(partitionSize);

  // For unit testing — pre-compute plan reference (cached globally).
  fftPlan(partitionSize);

  /**
   * Run FFT for the (pending) input block `t` and produce the output
   * segment for block `t`:
   *
   *   Y_t = IFFT(Σ_p H_p · X_{t−p})
   *   out_t[m] = Y_t[m] + Y_{t−1}[L + m]   for m ∈ [0, hopSize)
   *
   * The first half of the circular convolution Y_t is the tail of the
   * linear convolution that belongs to block t−1 (it needs input blocks
   * up to t), and Y_t[L .. 2L) is the head of the block-t contribution;
   * the previous block's tail completes the picture. This combination
   * is exactly y_ideal[t·L .. (t+1)·L) (verified numerically against
   * direct convolution).
   *
   * Deliveries: segment for absolute positions
   * [(t+1)·hop .. (t+2)·hop) → ring slots ((t+1)·hop + m) % (2·hop).
   * The reported latency is `hopSize` samples.
   */
  function runBlock(t: number): void {
    // X_t = FFT([blockBuf, zeros]).
    for (let i = 0; i < hopSize; i++) {
      inRe[i] = blockBuf[i];
      inIm[i] = 0;
    }
    for (let i = hopSize; i < partitionSize; i++) {
      inRe[i] = 0;
      inIm[i] = 0;
    }
    fft(inRe, inIm);
    const xSlot = (t % numPartitions) * partitionSize * 2;
    for (let k = 0; k < partitionSize; k++) {
      blockSpectra[xSlot + 2 * k] = inRe[k];
      blockSpectra[xSlot + 2 * k + 1] = inIm[k];
    }

    // Y_t = IFFT(Σ_p H_p · X_{t−p}).
    accRe.fill(0);
    accIm.fill(0);
    for (let p = 0; p < numPartitions; p++) {
      const j = t - p;
      if (j < 0) continue;
      const xb = (j % numPartitions) * partitionSize * 2;
      const hb = p * partitionSize * 2;
      for (let k = 0; k < partitionSize; k++) {
        const xR = blockSpectra[xb + 2 * k];
        const xI = blockSpectra[xb + 2 * k + 1];
        const hR = irSpectrums[hb + 2 * k];
        const hI = irSpectrums[hb + 2 * k + 1];
        accRe[k] += hR * xR - hI * xI;
        accIm[k] += hR * xI + hI * xR;
      }
    }

    // Inverse FFT via conjugate trick: IFFT(x) = conj(FFT(conj(x))) / N.
    for (let k = 0; k < partitionSize; k++) {
      inRe[k] = accRe[k];
      inIm[k] = -accIm[k]; // conjugate
    }
    fft(inRe, inIm);
    for (let k = 0; k < partitionSize; k++) {
      accRe[k] = inRe[k] / partitionSize;
      accIm[k] = -inIm[k] / partitionSize; // conjugate back
    }
    // accRe now holds the time-domain circular convolution Y_t. The
    // output segment is out_t[m] = Y_t[m] + prevSecondHalf[m], where
    // prevSecondHalf carries Y_{t−1}[L .. 2L) computed previously.
    const dest = ((t + 1) * hopSize) % partitionSize;
    for (let m = 0; m < hopSize; m++) {
      outRing[(dest + m) % partitionSize] = accRe[m] + prevSecondHalf[m];
      prevSecondHalf[m] = accRe[hopSize + m];
    }
  }

  return {
    latency: hopSize,
    partitionSize,
    numPartitions,

    process(input, blockSize, output) {
      if (blockSize <= 0) return;
      if (output.length < blockSize) {
        throw new Error(
          `partitionedConvolver.process: output too small (${output.length} < ${blockSize})`,
        );
      }

      // Feed and read in bounded chunks. Reading only after the whole host
      // block was fed lets a large block run enough FFT partitions to wrap
      // the ring and overwrite samples from the beginning of the block.
      let done = 0;
      while (done < blockSize) {
        const take = Math.min(hopSize - pending, blockSize - done);
        for (let i = 0; i < take; i++) blockBuf[pending + i] = input[done + i];
        pending += take;
        if (pending === hopSize) {
          runBlock(blockCount);
          blockCount++;
          pending = 0;
        }

        for (let i = 0; i < take; i++) {
          const q = absRead + i;
          output[done + i] = q >= hopSize ? outRing[q % partitionSize] : 0;
        }
        absRead += take;
        done += take;
      }
    },

    reset() {
      blockSpectra.fill(0);
      blockBuf.fill(0);
      outRing.fill(0);
      prevSecondHalf.fill(0);
      inRe.fill(0);
      inIm.fill(0);
      accRe.fill(0);
      accIm.fill(0);
      pending = 0;
      blockCount = 0;
      absRead = 0;
    },
  };
}

/**
 * Compute the partition size for a given IR length. Uses the
 * power-of-two nearest to `2 * sqrt(irLength)` (a common heuristic
 * that balances latency vs per-block cost).
 */
export function recommendPartitionSize(irLength: number): number {
  const target = Math.max(64, Math.round(2 * Math.sqrt(irLength)));
  return nextPow2(target);
}
