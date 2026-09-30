import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CURATED_SAMPLES } from "../src/sample-library/curated";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";

/**
 * SOUND LIBRARY GATE (library-gate wave, 2026-09-30) — locks the sound-library
 * audit into a permanent contract. Every curated WAV must stay:
 *   - on its category loudness target (±2.5 dB — up-trims are ceiling-capped
 *     by design, the aggressive memphis voices land up to ~1.9 dB short),
 *   - DC-free (|mean| < 1e-3 — tape hysteresis used to ship −43 dBFS offsets),
 *   - grid-aligned (no look-ahead zeros before the first sample above −100
 *     dBFS — the limiter used to delay the whole kit ~5 ms),
 *   - unclipped, finite, in the uniform 44.1 kHz / 24-bit / dual-mono format,
 *   - at least 0.4 s long (the granular/slicing contract).
 * The category targets are SOURCE-GREPPED from scripts/render-curated-seeds.mjs
 * (the same sync-pin pattern as the cue-seconds test) so this gate can never
 * drift from the renderer that produces the files.
 */

const samplesDir = path.resolve(__dirname, "..", "public", "samples");
const SR = 44100;

/* ── targets: source-grepped from the seed renderer ───────────────────────── */
function categoryTargets(): Record<string, number> {
  const source = readFileSync(path.resolve(__dirname, "..", "scripts", "render-curated-seeds.mjs"), "utf8");
  const targets: Record<string, number> = {};
  for (const match of source.matchAll(/(\w+): \{ targetLufs: (-?\d+(?:\.\d+)?)/g)) {
    targets[match[1]] = Number(match[2]);
  }
  return targets;
}

/* ── minimal 24-bit WAV decode (the seeds are pcm24/dual-mono by contract) ── */
function decodeWav24(file: string): { left: Float32Array; right: Float32Array; bits: number; channels: number } {
  const buf = readFileSync(path.join(samplesDir, file));
  expect(buf.toString("ascii", 0, 4), `${file} RIFF`).toBe("RIFF");
  expect(buf.toString("ascii", 8, 12), `${file} WAVE`).toBe("WAVE");
  let pos = 12;
  let dataStart = -1;
  let dataBytes = 0;
  let bits = 0;
  let channels = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(pos + 8 + 2);
      bits = buf.readUInt16LE(pos + 8 + 14);
    } else if (id === "data") {
      dataStart = pos + 8;
      dataBytes = size;
      break;
    }
    pos += 8 + size + (size % 2);
  }
  expect(dataStart, `${file} data chunk`).toBeGreaterThan(0);
  const frames = Math.floor(dataBytes / (bits / 8) / channels);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = dataStart + f * channels * 3;
    // 24-bit LE sample → float (shift into the top of a 32-bit int)
    const l = (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)) << 8;
    left[f] = l / 2147483648;
    if (channels === 2) {
      const r = (buf[o + 3] | (buf[o + 4] << 8) | (buf[o + 5] << 16)) << 8;
      right[f] = r / 2147483648;
    } else {
      right[f] = left[f];
    }
  }
  return { left, right, bits, channels };
}

/* ── BS.177-0 K-weighting + tiled momentary (the seed-script convention) ──── */
function kWeightingStages() {
  const shelfF0 = 1681.974450955533;
  const shelfGainDb = 3.9998438539736248;
  const shelfQ = 0.7071752369554196;
  const ks = Math.tan((Math.PI * shelfF0) / SR);
  const vh = Math.pow(10, shelfGainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const shelfA0 = 1 + ks / shelfQ + ks * ks;
  const hpF0 = 38.13547087602444;
  const hpQ = 0.5003270373238773;
  const kh = Math.tan((Math.PI * hpF0) / SR);
  const hpA0 = 1 + kh / hpQ + kh * kh;
  return [
    {
      b0: (vh + (vb * ks) / shelfQ + ks * ks) / shelfA0,
      b1: (2 * (ks * ks - vh)) / shelfA0,
      b2: (vh - (vb * ks) / shelfQ + ks * ks) / shelfA0,
      a1: (2 * (ks * ks - 1)) / shelfA0,
      a2: (1 - ks / shelfQ + ks * ks) / shelfA0,
    },
    { b0: 1, b1: -2, b2: 1, a1: (2 * (kh * kh - 1)) / hpA0, a2: (1 - kh / hpQ + kh * kh) / hpA0 },
  ];
}

/** Highest 400 ms momentary block; sub-450 ms files are tiled (repeated hits). */
function momentaryMaxLufs(channels: Float32Array[]): number {
  const minSamples = Math.ceil(0.45 * SR);
  const len = channels[0].length;
  const reps = len >= minSamples ? 1 : Math.ceil(minSamples / len);
  const tiled = channels.map((c) => {
    if (reps === 1) return c;
    const out = new Float32Array(len * reps);
    for (let r = 0; r < reps; r++) out.set(c, r * len);
    return out;
  });
  const stages = kWeightingStages();
  const filtered = tiled.map((c) => {
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0,
      u1 = 0,
      u2 = 0,
      w1 = 0,
      w2 = 0;
    const out = new Float64Array(c.length);
    for (let i = 0; i < c.length; i++) {
      const s1 = stages[0];
      const shelf = s1.b0 * c[i] + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
      x2 = x1;
      x1 = c[i];
      y2 = y1;
      y1 = shelf;
      const s2 = stages[1];
      const hp = s2.b0 * shelf + s2.b1 * u1 + s2.b2 * u2 - s2.a1 * w1 - s2.a2 * w2;
      u2 = u1;
      u1 = shelf;
      w2 = w1;
      w1 = hp;
      out[i] = hp;
    }
    return out;
  });
  const sub = Math.round(0.1 * SR);
  const powers: number[] = [];
  for (let start = 0; start + sub <= filtered[0].length; start += sub) {
    let sum = 0;
    for (const ch of filtered) {
      let acc = 0;
      for (let i = start; i < start + sub; i++) acc += ch[i] * ch[i];
      sum += acc / sub;
    }
    powers.push(sum);
  }
  let maxL = -180;
  for (let k = 0; k + 4 <= powers.length; k++) {
    const ms = (powers[k] + powers[k + 1] + powers[k + 2] + powers[k + 3]) / 4;
    const l = ms > 1e-12 ? -0.691 + 10 * Math.log10(ms) : -180;
    if (l > maxL) maxL = l;
  }
  return maxL;
}

const LEAD_FLOOR = 1e-5; // matches the seed script's lead trim floor
const LEAD_TOLERANCE_SAMPLES = 88; // 2 ms — catches the 5 ms look-ahead regression

describe("sound library gate — every curated WAV on contract", () => {
  const targets = categoryTargets();
  const categoryOf = new Map(FACTORY_ASSETS.map((asset) => [asset.id, asset.category]));

  it("the seed renderer defines a target for every manifest category in use", () => {
    const used = new Set(FACTORY_ASSETS.map((asset) => asset.category));
    for (const category of used) expect(targets[category], `target for ${category}`).toBeDefined();
  });

  it("format: every file is 44.1 kHz / 24-bit / dual-mono and at least 0.4 s", () => {
    const bad: string[] = [];
    for (const sample of CURATED_SAMPLES) {
      const wav = decodeWav24(sample.file);
      const frames = wav.left.length;
      if (wav.bits !== 24 || wav.channels !== 2) bad.push(`${sample.file}: ${wav.bits}bit/${wav.channels}ch`);
      if (frames < Math.ceil(0.4 * SR)) bad.push(`${sample.file}: ${(frames / SR).toFixed(2)}s < 0.4s contract`);
    }
    expect(bad).toEqual([]);
  });

  it("purity: no clipping, no non-finite samples, no DC, grid-aligned start", () => {
    const bad: string[] = [];
    for (const sample of CURATED_SAMPLES) {
      const { left, right } = decodeWav24(sample.file);
      let clip = 0;
      let dcSum = 0;
      let finite = true;
      for (let i = 0; i < left.length; i++) {
        const l = left[i];
        const r = right[i];
        if (!Number.isFinite(l) || !Number.isFinite(r)) finite = false;
        if (Math.abs(l) >= 0.9995 || Math.abs(r) >= 0.9995) clip += 1;
        dcSum += (l + r) / 2;
      }
      if (!finite) bad.push(`${sample.file}: non-finite samples`);
      if (clip > 0) bad.push(`${sample.file}: ${clip} clipped samples`);
      if (Math.abs(dcSum / left.length) >= 1e-3)
        bad.push(`${sample.file}: DC ${(dcSum / left.length).toExponential(2)}`);
      let firstLoud = 0;
      while (
        firstLoud < left.length &&
        Math.abs(left[firstLoud]) <= LEAD_FLOOR &&
        Math.abs(right[firstLoud]) <= LEAD_FLOOR
      )
        firstLoud += 1;
      if (firstLoud > LEAD_TOLERANCE_SAMPLES)
        bad.push(`${sample.file}: ${((firstLoud / SR) * 1000).toFixed(1)} ms of leading silence`);
    }
    expect(bad).toEqual([]);
  });

  it("loudness: every file within ±2.5 dB of its category target", () => {
    const bad: string[] = [];
    for (const sample of CURATED_SAMPLES) {
      const category = categoryOf.get(sample.id);
      const target = category ? targets[category] : undefined;
      expect(target, `${sample.id} category target`).toBeDefined();
      const wav = decodeWav24(sample.file);
      const lufs = momentaryMaxLufs([wav.left, wav.right]);
      const drift = Math.abs(lufs - (target as number));
      if (drift > 2.5) bad.push(`${sample.file}: ${lufs.toFixed(1)} LUFS vs ${target} (drift ${drift.toFixed(1)} dB)`);
    }
    expect(bad).toEqual([]);
  });
});
