// ═══════════════════════════════════════════════════════════
// FXEQ — Golden snapshot helpers
//
// Deterministic signal generation + output fingerprinting for golden
// snapshot comparison. Fingerprints are compact JSON (64-sample
// envelope + peak + RMS + SHA-256 hash) committed to tests/golden/.
//
// Regenerate fixtures: set env UPDATE_GOLDEN=1 and run the golden tests.
// ═══════════════════════════════════════════════════════════

import { createFxEqProcessor } from "../../src/effects/fxeq-core/core/fxEqProcessor.js";
import { V1_TOPOLOGY_LABEL } from "../../src/effects/fxeq-core/core/presets.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const GOLDEN_SR = 44100;

// ── Deterministic test signals ───────────────────────────────

/** Single-sample impulse at t=0. */
export function impulseSignal(frames: number, channels = 1): Float32Array[] {
  return Array.from({ length: channels }, () => {
    const ch = new Float32Array(frames);
    ch[64] = 1.0; // small offset to avoid edge artifacts
    return ch;
  });
}

/**
 * Logarithmic sine sweep from f0 to f1 over `frames` samples.
 * Uses a deterministic phase formula so output is bit-identical across runs.
 */
export function logSweepSignal(
  frames: number,
  f0 = 20,
  f1 = 20000,
  channels = 1,
): Float32Array[] {
  const ratio = f1 / f0;
  const T = frames / GOLDEN_SR;
  const phaseConst = (T * f0 * Math.log(ratio)) / Math.log(ratio); // = T * f0 for normalization
  void phaseConst; // keep formula readable

  return Array.from({ length: channels }, (_, ci) => {
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const t = i / GOLDEN_SR;
      // Instantaneous frequency grows exponentially.
      const phase = (2 * Math.PI * f0 * T * (Math.pow(ratio, t / T) - 1)) / Math.log(ratio);
      // Add tiny stereo offset for channel > 0 to differentiate.
      const offset = ci > 0 ? 0.0001 : 0;
      ch[i] = Math.sin(phase + offset) * 0.5;
    }
    return ch;
  });
}

/**
 * Multi-tone signal: sum of N sine waves at given frequencies.
 * Deterministic, same phase every run.
 */
export function multiToneSignal(
  frames: number,
  freqs: number[] = [80, 300, 1000, 3000, 8000, 14000],
  channels = 1,
): Float32Array[] {
  return Array.from({ length: channels }, () => {
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let v = 0;
      for (const f of freqs) {
        v += Math.sin((2 * Math.PI * f * i) / GOLDEN_SR);
      }
      ch[i] = (v / freqs.length) * 0.4;
    }
    return ch;
  });
}

// ── Fingerprinting ───────────────────────────────────────────

export interface GoldenFingerprint {
  /** Schema version for forward compatibility. */
  version: 1;
  /** Topology label identifying the DSP architecture that produced this fixture. */
  topology: string;
  frames: number;
  channels: number;
  peak: number;
  rms: number;
  /** 64-sample downsampled envelope (max-abs per bucket) of channel 0. */
  envelope: number[];
  /** SHA-256 hex of the raw Float32 output bytes (all channels concatenated). */
  hash: string;
}

const ENVELOPE_BUCKETS = 64;

/** Compute a compact, deterministic fingerprint from processed output. */
export function fingerprint(output: Float32Array[]): GoldenFingerprint {
  const frames = output[0]?.length ?? 0;
  const channels = output.length;

  let peak = 0;
  let sumSq = 0;
  const ch0 = output[0];

  // Flatten all channel bytes for hashing.
  const allBytes: number[] = [];

  for (const ch of output) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
      sumSq += ch[i] * ch[i];
    }
    // Collect bytes for hash (Float32 → 4 bytes little-endian).
    const buf = Buffer.from(ch.buffer, ch.byteOffset, ch.byteLength);
    for (let b = 0; b < buf.length; b++) allBytes.push(buf[b]);
  }

  const rms = Math.sqrt(sumSq / (frames * channels || 1));

  // Envelope: max-abs per bucket of channel 0.
  const envelope: number[] = [];
  const bucketSize = Math.max(1, Math.floor(frames / ENVELOPE_BUCKETS));
  for (let b = 0; b < ENVELOPE_BUCKETS; b++) {
    let bucketMax = 0;
    const start = b * bucketSize;
    const end = Math.min(start + bucketSize, frames);
    for (let i = start; i < end; i++) {
      const a = Math.abs(ch0[i]);
      if (a > bucketMax) bucketMax = a;
    }
    envelope.push(parseFloat(bucketMax.toFixed(6)));
  }

  const hash = crypto.createHash("sha256").update(Buffer.from(allBytes)).digest("hex");

  return {
    version: 1,
    topology: V1_TOPOLOGY_LABEL,
    frames,
    channels,
    peak: parseFloat(peak.toFixed(6)),
    rms: parseFloat(rms.toFixed(6)),
    envelope,
    hash,
  };
}

// ── Comparison ───────────────────────────────────────────────

export interface CompareResult {
  passed: boolean;
  maxEnvelopeDiff: number;
  peakDiff: number;
  rmsDiff: number;
  hashMatch: boolean;
  /** True when actual and golden topology labels differ (informational, not a failure). */
  topologyMismatch: boolean;
}

/**
 * Compare a freshly computed fingerprint against a golden reference.
 * Passes when envelope samples agree within `tolerance` and peak/RMS
 * are within `levelTolerance`. A topology mismatch produces a warning
 * but does not fail the comparison.
 */
export function compareFingerprints(
  actual: GoldenFingerprint,
  golden: GoldenFingerprint,
  tolerance = 1e-3,
  levelTolerance = 1e-3,
): CompareResult {
  const topologyMismatch =
    !!golden.topology && !!actual.topology && golden.topology !== actual.topology;

  if (topologyMismatch) {
    console.warn(
      `[golden] Topology mismatch: fixture="${golden.topology}" actual="${actual.topology}". ` +
        `Comparison proceeds but results may differ by design.`,
    );
  }

  if (actual.envelope.length !== golden.envelope.length) {
    return { passed: false, maxEnvelopeDiff: Infinity, peakDiff: Infinity, rmsDiff: Infinity, hashMatch: false, topologyMismatch };
  }

  let maxEnvelopeDiff = 0;
  for (let i = 0; i < actual.envelope.length; i++) {
    maxEnvelopeDiff = Math.max(maxEnvelopeDiff, Math.abs(actual.envelope[i] - golden.envelope[i]));
  }

  const peakDiff = Math.abs(actual.peak - golden.peak);
  const rmsDiff = Math.abs(actual.rms - golden.rms);
  const hashMatch = actual.hash === golden.hash;

  const passed =
    maxEnvelopeDiff <= tolerance &&
    peakDiff <= levelTolerance &&
    rmsDiff <= levelTolerance;

  return { passed, maxEnvelopeDiff, peakDiff, rmsDiff, hashMatch, topologyMismatch };
}

// ── Render + fixture I/O ─────────────────────────────────────

export interface GoldenCase {
  name: string;
  signal: () => Float32Array[];
  params: Record<string, number>;
  /** Process in blocks of this size (tests block-boundary stability). */
  blockSize: number;
}

/** Render a golden case through a fresh processor and return the output. */
export function renderCase(tc: GoldenCase): Float32Array[] {
  const proc = createFxEqProcessor();
  proc.prepare(GOLDEN_SR, 1, tc.blockSize);
  proc.loadParameters(tc.params);

  const input = tc.signal();
  const frames = input[0].length;
  const output: Float32Array[] = [new Float32Array(frames)];

  let offset = 0;
  while (offset < frames) {
    const block = Math.min(tc.blockSize, frames - offset);
    const inBlock: Float32Array[] = [input[0].subarray(offset, offset + block)];
    // The processor processes in-place; clone the block.
    const blockCopy: Float32Array[] = [new Float32Array(block)];
    blockCopy[0].set(inBlock[0]);
    proc.process(blockCopy, block);
    output[0].set(blockCopy[0], offset);
    offset += block;
  }

  return output;
}

const FIXTURES_DIR = import.meta.dirname;

/** Load a golden fixture from disk (returns null if not found). */
export function loadFixture(name: string): GoldenFingerprint | null {
  const fp = path.join(FIXTURES_DIR, `${name}.json`);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf8")) as GoldenFingerprint;
}

/** Save a golden fixture to disk. */
export function saveFixture(name: string, fp: GoldenFingerprint): void {
  const filePath = path.join(FIXTURES_DIR, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(fp, null, 2) + "\n", "utf8");
}

/** Whether the test harness should update fixtures instead of comparing. */
export function shouldUpdateGolden(): boolean {
  return process.env.UPDATE_GOLDEN === "1";
}
