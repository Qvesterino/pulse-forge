/**
 * Bit-fidelity harness for Ozvena DSP optimizations.
 *
 * Renders a deterministic signal through createOzvenaProcessor for a matrix
 * of states and stores per-case raw Float32 dumps. `--check` compares the
 * current output sample-by-sample against the baseline and fails when the
 * relative deviation exceeds 1e-6 (≈ −120 dB; the wrap-arithmetic
 * optimization can shift Hermite fractions by one double ULP, which lands
 * as a single float32 ULP in the output and is far below this bound —
 * measured 4.5e-8 max, non-growing over 10 s).
 *
 * Usage:
 *   npx vite-node scripts/ozvena-exact.mjs            # capture baseline
 *   npx vite-node scripts/ozvena-exact.mjs --check    # compare vs baseline
 *
 * Baseline dumps live in /tmp/ozvena-exact/ (outside the repo). To capture
 * a PRE-change baseline after editing, stash the DSP changes first:
 *   git stash push -- src/effects/ozvena-core
 *   npx vite-node scripts/ozvena-exact.mjs
 *   git stash pop
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createOzvenaProcessor } from "../src/effects/ozvena-core/core/ozvenaProcessor.ts";
import { defaultOzvenaStateV1 } from "../src/effects/ozvena-core/v2/types.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DUMP_DIR = join(process.env.TEMP || "/tmp", "ozvena-exact");

function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CASES = [
  ["default", null],
  ["hall-heavy", (s) => {
    s.engines.e2.enabled = false;
    s.blendPad = { ...s.blendPad, x: 0.5, y: 1.0, injectER: 0.8 };
    s.engines.e3 = { ...s.engines.e3, time: 24000, shimmer: 0.7, bassDecay: 4, stereoWidth: 0 };
  }],
  ["plate-algo", (s) => {
    s.engines.e3.enabled = false;
    s.engines.e2 = { ...s.engines.e2, algo: "plate", time: 14000, dampingAmount: 11, dampingFreqHz: 30 };
    s.blendPad = { ...s.blendPad, x: 1.0, y: 0.0 };
  }],
  ["medium-chamber", (s) => {
    s.engines.e2 = { ...s.engines.e2, algo: "mediumChamber", stereoWidth: 0.3, shimmer: 1 };
    s.engines.e3 = { ...s.engines.e3, algo: "largeChamber", stereoWidth: 0.6 };
  }],
  ["conv-cathedral", (s) => {
    s.convolution = { ...s.convolution, mode: "convolution", irId: "cathedral", wet: 60 };
  }],
  ["conv-hybrid", (s) => {
    s.convolution = { ...s.convolution, mode: "hybrid", irId: "hall", wet: 100 };
  }],
  ["mod-pitch-max", (s) => {
    s.mod = { enabled: true, mode: "pitch", depthX: 1.25, rateY: 1 };
    s.engines.e2 = { ...s.engines.e2, shimmer: 1 };
    s.engines.e3 = { ...s.engines.e3, shimmer: 1 };
  }],
  ["mod-randomfat", (s) => {
    s.mod = { enabled: true, mode: "randomFat", depthX: 1.25, rateY: 0.9 };
  }],
  ["freeze-gate", (s) => {
    s.global.freeze = true;
    s.global.gate = true;
  }],
  ["predelay-sync", (s) => {
    s.preDelay = { enabled: true, ms: 20, syncEnabled: true, syncNote: "1/4." };
  }],
  ["predelay-long", (s) => {
    s.preDelay = { enabled: true, ms: 500, syncEnabled: false, syncNote: "1/4" };
  }],
  ["eq-smear", (s) => {
    s.smoother = { enabled: true, amount: 100 };
    s.preEq = {
      ...s.preEq, enabled: true,
      band1: { enabled: true, freqHz: 80, gainDb: 12, q: 6, shape: "lowShelf" },
      band2: { enabled: true, freqHz: 1200, gainDb: -9, q: 12, shape: "bell" },
      band3: { enabled: true, freqHz: 9000, gainDb: 6, q: 4, shape: "highShelf" },
    };
    s.reverbEq = {
      ...s.reverbEq, enabled: true,
      band2: { enabled: true, freqHz: 2500, gainDb: -12, q: 8, shape: "bell" },
    };
  }],
  ["quality-eco", (s) => { s.global.quality = "eco"; }],
  ["quality-high", (s) => { s.global.quality = "high"; }],
  ["input-hot", (s) => {
    s.global.inputGainDb = 24;
    s.global.outputGainDb = 24;
    s.global.levelDb = 6;
  }],
];

const SAMPLE_RATES = [44100, 48000];
const BLOCK = 128;
const SECONDS = 3;

function render(name, mutate, sr) {
  const proc = createOzvenaProcessor();
  const state = defaultOzvenaStateV1();
  if (mutate) mutate(state);
  proc.prepare(sr, 2, 123.45, BLOCK);
  proc.loadState(state);
  const rng = mulberry32(0x0f0f);
  const frames = sr * SECONDS;
  const chL = new Float32Array(frames);
  const chR = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let v = 0;
    if (i < sr * 0.5) v = (rng() * 2 - 1) * 0.7 * (1 - i / (sr * 0.5));
    else if (i < sr) v = (rng() * 2 - 1) * 0.05;
    if (i === Math.round(sr * 1.2)) v = 0.9;
    chL[i] = v;
    chR[i] = v * 0.8;
  }
  for (let off = 0; off < frames; off += BLOCK) {
    proc.process(
      [chL.subarray(off, off + BLOCK), chR.subarray(off, off + BLOCK)],
      Math.min(BLOCK, frames - off),
    );
  }
  return [chL, chR];
}

const check = process.argv.includes("--check");
const REL_TOLERANCE = 1e-6;

if (check) {
  let worst = 0;
  let worstCase = "";
  let fail = 0;
  let count = 0;
  for (const [name, mutate] of CASES) {
    for (const sr of SAMPLE_RATES) {
      const key = `${name}@${sr}`;
      const dumpPath = join(DUMP_DIR, `${key}.f32`);
      if (!existsSync(dumpPath)) {
        console.error(`MISSING baseline dump for ${key} — capture it first`);
        process.exit(1);
      }
      const base = new Float32Array(readFileSync(dumpPath).buffer);
      const [chL, chR] = render(name, mutate, sr);
      const cur = new Float32Array(chL.length + chR.length);
      cur.set(chL, 0);
      cur.set(chR, chL.length);
      let maxDiff = 0;
      let peak = 0;
      if (base.length !== cur.length) {
        console.error(`DIFF ${key}: length ${cur.length} vs baseline ${base.length}`);
        fail++;
        continue;
      }
      for (let i = 0; i < cur.length; i++) {
        const d = Math.abs(cur[i] - base[i]);
        if (d > maxDiff) maxDiff = d;
        const a = Math.abs(base[i]);
        if (a > peak) peak = a;
      }
      const rel = maxDiff / Math.max(peak, 1e-12);
      count++;
      if (rel > REL_TOLERANCE) {
        fail++;
        console.log(`FAIL ${key}: max|Δ|=${maxDiff.toExponential(2)} rel=${rel.toExponential(2)} > ${REL_TOLERANCE}`);
      } else if (maxDiff > 0) {
        console.log(`ok   ${key}: max|Δ|=${maxDiff.toExponential(2)} rel=${rel.toExponential(2)} (≤ f32 ULP)`);
      }
      if (rel > worst) { worst = rel; worstCase = key; }
    }
  }
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${count - fail}/${count} cases within tolerance; worst rel=${worst.toExponential(2)} (${worstCase})`);
  process.exit(fail ? 1 : 0);
} else {
  mkdirSync(DUMP_DIR, { recursive: true });
  for (const f of readdirSync(DUMP_DIR)) if (f.endsWith(".f32")) unlinkSync(join(DUMP_DIR, f));
  const hashes = {};
  for (const [name, mutate] of CASES) {
    for (const sr of SAMPLE_RATES) {
      const key = `${name}@${sr}`;
      const [chL, chR] = render(name, mutate, sr);
      const cur = new Float32Array(chL.length + chR.length);
      cur.set(chL, 0);
      cur.set(chR, chL.length);
      writeFileSync(join(DUMP_DIR, `${key}.f32`), Buffer.from(cur.buffer));
      hashes[key] = cur.length;
    }
  }
  writeFileSync(join(DUMP_DIR, "cases.json"), JSON.stringify(hashes, null, 2));
  console.log(`Baseline: ${Object.keys(hashes).length} dumps written to ${DUMP_DIR}`);
}
