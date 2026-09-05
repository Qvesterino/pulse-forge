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
// Ozvena — Factory Impulse Response generator
//
// Procedurally generates the factory IRs (physically-modelled
// early reflections + multi-band late decay) at any sample rate,
// deterministically (seeded PRNG). This mirrors ir/generate-irs.mjs
// but runs at runtime so the convolution engine needs no file I/O —
// works identically in the browser, the TS oracle, and native.
// ═══════════════════════════════════════════════════════════

import type { FactoryIrId } from "../v2/convolutionTypes.js";

interface IrGenSpec {
  lengthSec: number;
  earlyTaps: number;
  earlyMaxMs: number;
  lateDecay: number;
  brightness: number;
  character: "dry" | "metallic" | "warm" | "dark";
}

const IR_SPECS: Record<FactoryIrId, IrGenSpec> = {
  "vocal-booth": { lengthSec: 1.2, earlyTaps: 6,  earlyMaxMs: 25,  lateDecay: 4.5, brightness: 0.3,  character: "dry" },
  "plate":       { lengthSec: 2.5, earlyTaps: 0,  earlyMaxMs: 0,   lateDecay: 2.0, brightness: 0.85, character: "metallic" },
  "hall":        { lengthSec: 4.0, earlyTaps: 16, earlyMaxMs: 80,  lateDecay: 1.2, brightness: 0.5,  character: "warm" },
  "cathedral":   { lengthSec: 5.0, earlyTaps: 12, earlyMaxMs: 120, lateDecay: 0.8, brightness: 0.2,  character: "dark" },
  // Roadmap O7: mono fallbacks for the wide variants (true-stereo set is
  // preferred at runtime; these keep the catalogue total).
  "plate-wide":  { lengthSec: 2.5, earlyTaps: 0,  earlyMaxMs: 0,   lateDecay: 2.0, brightness: 0.85, character: "metallic" },
  "chamber-wide":{ lengthSec: 4.0, earlyTaps: 16, earlyMaxMs: 90,  lateDecay: 1.1, brightness: 0.45, character: "warm" },
};

function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateIr(spec: IrGenSpec, sampleRate: number): Float32Array {
  const length = Math.floor(spec.lengthSec * sampleRate);
  const samples = new Float32Array(length);
  const rand = makeRng(42 + Math.round(spec.lengthSec * 100));

  if (spec.earlyTaps > 0) {
    const earlyLen = Math.floor((spec.earlyMaxMs / 1000) * sampleRate);
    for (let t = 0; t < spec.earlyTaps; t++) {
      const pos = Math.floor((t / spec.earlyTaps) * earlyLen * (0.7 + rand() * 0.3));
      const gain = (1 / Math.sqrt(t + 1)) * (0.4 + rand() * 0.3);
      const tapLen = Math.min(64, length - pos);
      for (let i = 0; i < tapLen; i++) {
        const env = Math.exp(-i / (sampleRate * 0.003));
        samples[pos + i] += (rand() * 2 - 1) * gain * env;
      }
    }
  }

  const lateStart = spec.earlyTaps > 0 ? Math.floor((spec.earlyMaxMs / 1000) * sampleRate) : 0;

  const lfDecay = spec.lateDecay * 1.3;
  const mfDecay = spec.lateDecay;
  const hfDecay = spec.lateDecay * 0.6;
  const dt = 1 / sampleRate;
  const alphaLow = dt / (1 / (2 * Math.PI * 500) + dt);
  const alphaHigh = dt / (1 / (2 * Math.PI * 4000) + dt);
  void alphaHigh;

  let lpState = 0;
  let prevNoise = 0;

  for (let i = lateStart; i < length; i++) {
    const t = (i - lateStart) / sampleRate;
    const noise = rand() * 2 - 1;

    lpState += alphaLow * (noise - lpState);
    const hpState = noise - lpState;

    const lfComponent = lpState * Math.exp(-lfDecay * t);
    const mfComponent = hpState * Math.exp(-mfDecay * t);

    let hfComponent = 0;
    if (spec.brightness > 0.1) {
      const hp2 = noise - prevNoise;
      hfComponent = hp2 * spec.brightness * Math.exp(-hfDecay * t);
    }
    prevNoise = noise;

    let lateSample = lfComponent * 0.6 + mfComponent * 0.8 + hfComponent * 0.4;

    if (spec.character === "metallic") {
      const ringFreq = 3200 + Math.sin(t * 7) * 800;
      lateSample += Math.sin(2 * Math.PI * ringFreq * t) * 0.15 * Math.exp(-spec.lateDecay * 1.5 * t);
    }

    const crossfade = lateStart > 0 ? Math.min(1, (i - lateStart) / (sampleRate * 0.02)) : 1;
    samples[i] += lateSample * crossfade;
  }

  // DC removal.
  let dcAccum = 0;
  for (let i = 0; i < length; i++) {
    dcAccum += samples[i];
    samples[i] -= dcAccum / (i + 1);
  }

  // Normalise to -1 dBFS peak.
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  const norm = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < length; i++) samples[i] *= norm;

  return samples;
}

// ── True-stereo factory IRs (v2) ───────────────────────────
//
// Generates a 4-channel interleaved TRUE-STEREO impulse response
// (LL, LR, RL, RR — Space Designer convention): the early taps carry
// directional offsets per channel, the late field is independently
// seeded noise per channel sharing one envelope, so the four channels
// are correlated enough to sound like ONE space yet decorrelated
// enough to give a wide, non-phasey tail.
//
// Deterministic per (id, sampleRate), cached.

const IR4_SPECS: Record<FactoryIrId, { lengthSec: number; spreadMs: number; seed: number; decay: number; bright: number }> = {
  "vocal-booth": { lengthSec: 1.2, spreadMs: 18,  seed: 101, decay: 3.4, bright: 0.45 },
  "plate":       { lengthSec: 1.8, spreadMs: 4,   seed: 202, decay: 2.2, bright: 0.85 },
  "hall":        { lengthSec: 2.5, spreadMs: 38,  seed: 303, decay: 1.4, bright: 0.55 },
  "cathedral":   { lengthSec: 3.0, spreadMs: 55,  seed: 404, decay: 1.1, bright: 0.35 },
  // Roadmap O7: wide true-stereo variants (4ch decorrelated by design).
  "plate-wide":  { lengthSec: 1.8, spreadMs: 22,  seed: 205, decay: 2.2, bright: 0.85 },
  "chamber-wide":{ lengthSec: 3.0, spreadMs: 46,  seed: 407, decay: 1.3, bright: 0.5 },
};

const cache4 = new Map<string, Float32Array>();
// Roadmap O7: bounded caches — several IRs × several sample rates must not
// accumulate without limit in long sessions.
const IR_CACHE_MAX = 24;

/**
 * Generate (or fetch from cache) a 4-channel interleaved TRUE-STEREO
 * factory IR at the given sample rate. Returns null for unknown ids.
 * Channel layout: LL, LR, RL, RR (frames × 4 samples).
 */
export function generateFactoryIr4(id: string, sampleRate: number): Float32Array | null {
  const spec = IR4_SPECS[id as FactoryIrId];
  if (!spec) return null;
  const key = `4:${id}:${sampleRate}`;
  const hit = cache4.get(key);
  if (hit) return hit;

  const frames = Math.floor(spec.lengthSec * sampleRate);
  const out = new Float32Array(frames * 4);
  const chs: Float32Array[] = [
    out.subarray(0, frames),
    out.subarray(frames, frames * 2),
    out.subarray(frames * 2, frames * 3),
    out.subarray(frames * 3, frames * 4),
  ] as unknown as Float32Array[];

  // Directional early taps: left-biased for L-in responses, right for R.
  const spread = Math.floor((spec.spreadMs / 1000) * sampleRate);
  const taps = 7;
  const mkRng = makeRng(spec.seed);
  const early: Array<{ pos: number; gain: number; pan: number }> = [];
  for (let t = 0; t < taps; t++) {
    const pos = Math.floor((t / taps) * spread * (0.6 + mkRng() * 0.4)) + Math.floor(sampleRate * 0.002);
    const gain = (1 / Math.sqrt(t + 1)) * (0.5 + mkRng() * 0.4);
    const pan = (t % 2 === 0 ? 1 : -1) * (0.35 + mkRng() * 0.4);
    early.push({ pos, gain, pan });
  }

  // Late field: per-channel independently seeded noise with a shared
  // exponential envelope + one-pole HF damping per channel.
  const rngs = [makeRng(spec.seed + 11), makeRng(spec.seed + 22), makeRng(spec.seed + 33), makeRng(spec.seed + 44)];
  const lp = [0, 0, 0, 0];
  const alpha = 1 - Math.exp((-2 * Math.PI * (1200 + spec.bright * 6000)) / sampleRate);
  const offsets = [0, 3, 5, 8]; // subtle per-channel onset offsets

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-spec.decay * t);
    // Buildup: late field fades in over the first ~20 ms.
    const build = Math.min(1, i / (0.02 * sampleRate));
    for (let c = 0; c < 4; c++) {
      let v = 0;
      if (i >= offsets[c]) {
        const n = rngs[c]() * 2 - 1;
        lp[c] += alpha * (n - lp[c]);
        v = (rngs[c]() * 0.5 + lp[c] * 0.5) * env * build;
      }
      chs[c][i] = v;
    }
  }

  // Early taps: same tap, per-channel weighting by direction.
  for (const tap of early) {
    const gl = tap.gain * Math.max(0, 1 - tap.pan);
    const gr = tap.gain * Math.max(0, 1 + tap.pan);
    // L-in responses: tap gain → LL (left mic), LR (right mic).
    if (tap.pos < frames) chs[0][tap.pos] += gl;
    if (tap.pos < frames) chs[1][tap.pos] += gr;
    // R-in responses: mirrored.
    if (tap.pos < frames) chs[2][tap.pos] += gr;
    if (tap.pos < frames) chs[3][tap.pos] += gl;
  }

  // Normalise the whole 4-channel set to -1 dBFS (shared peak).
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  if (peak > 1e-9) {
    const g = 0.89 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }

  cache4.set(key, out);
  if (cache4.size > IR_CACHE_MAX) { const oldest = cache4.keys().next().value; if (oldest !== undefined) cache4.delete(oldest); }
  return out;
}

// Cache generated IRs per (id, sampleRate) so repeated selection is free.
const cache = new Map<string, Float32Array>();

/**
 * Generate (or fetch from cache) a mono factory IR at the given sample
 * rate. Returns null for an unknown IR id.
 */
export function generateFactoryIr(id: string, sampleRate: number): Float32Array | null {
  const spec = IR_SPECS[id as FactoryIrId];
  if (!spec) return null;
  const key = `${id}:${sampleRate}`;
  let ir = cache.get(key);
  if (!ir) {
    ir = generateIr(spec, sampleRate);
    cache.set(key, ir);
    if (cache.size > IR_CACHE_MAX) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest); }
  }
  return ir;
}
