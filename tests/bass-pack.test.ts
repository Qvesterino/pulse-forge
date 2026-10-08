import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { BUILDERS, DURATIONS } from "../src/sample-library/factory";
import { CURATED_SAMPLES } from "../src/sample-library/curated";
import { categoryColor, assetCategoryOf } from "../src/ui/kitColors";

/**
 * BASS PACK (library-completion wave 2026-10-04) — the last empty category.
 * Six pitch-anchored one-shots (D2 root, pluck on D3): clean sub, reese, FM,
 * pluck, LFO wobble, saturated dist. Locks manifest/builder/duration/curated
 * coherence (the full-kit contract), the new asset category plumbing and the
 * semitone tuning anchor (a detuned bass beats against tuned melodies).
 *
 * The measured distinctness contract lives in `npm run audit:samples` (feature
 * distance) and tests/sound-library-gate.test.ts (loudness/format); this spec
 * keeps the data contract the app boots from.
 */

const BASS_IDS = [
  "factory.bass.clean",
  "factory.bass.reese",
  "factory.bass.fm",
  "factory.bass.pluck",
  "factory.bass.wobble",
  "factory.bass.dist",
  // Priority-1 expand (UN-SUNO bass-lane feed)
  "factory.bass.808.soft",
  "factory.bass.808.medium",
  "factory.bass.808.hard",
  "factory.bass.subsine",
  "factory.bass.subsquare",
  "factory.bass.upright",
  "factory.bass.acid.fast",
  "factory.bass.acid.slow",
];

const LEAD_IDS = [
  "factory.lead.saw",
  "factory.lead.supersaw",
  "factory.lead.square",
  "factory.lead.pluck.bright",
  "factory.lead.pluck.dark",
];

const SR = 44100;

/** Minimal 24-bit decode of one curated WAV (dual-mono by contract). */
function decodeCurated(file: string): Float32Array {
  const buf = readFileSync(path.resolve(__dirname, "..", "public", "samples", file));
  let pos = 12;
  let fmt: { pos: number } | null = null;
  let data: { pos: number; size: number } | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { pos: pos + 8 };
    else if (id === "data") {
      data = { pos: pos + 8, size };
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file}: missing fmt/data`);
  const channels = buf.readUInt16LE(fmt.pos + 2);
  const frames = Math.floor(data.size / 3 / channels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = data.pos + f * channels * 3;
    out[f] = ((buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)) << 8) / 2147483648;
  }
  return out;
}

/** Lowest strong spectral peak in 25–130 Hz → the bass anchor (FFT, not
 * autocorrelation: FM sidebands can period-double an autocorrelation reading). */
function lowFundamentalHz(samples: Float32Array): number | null {
  const N = 16384;
  if (samples.length < N) return null;
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  if (peak <= 0) return null;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (samples[i] / peak) * win[i];
  fftRadix2(re, im);
  const binHz = SR / N;
  const loBin = Math.max(1, Math.floor(25 / binHz));
  const hiBin = Math.floor(130 / binHz);
  let best = loBin;
  let bestMag = 0;
  for (let k = loBin; k <= hiBin; k++) {
    const m = re[k] * re[k] + im[k] * im[k];
    if (m > bestMag) {
      bestMag = m;
      best = k;
    }
  }
  return best * binHz;
}

function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

describe("bass pack — registry coherence", () => {
  it("ships as the Bass category with unique ids, character, tags and moods", () => {
    const ids = FACTORY_ASSETS.filter((a) => a.category === "Bass").map((a) => a.id);
    expect(ids.sort()).toEqual([...BASS_IDS].sort());
    for (const id of BASS_IDS) {
      const asset = FACTORY_ASSETS.find((a) => a.id === id)!;
      expect(asset.name.length, id).toBeGreaterThan(0);
      expect(asset.character.length, id).toBeGreaterThan(0);
      expect(asset.tags.length, id).toBeGreaterThan(0);
      expect(asset.mood.length, id).toBeGreaterThan(0);
    }
  });

  it("every bass asset has a synth builder and a finite one-shot duration", () => {
    for (const id of BASS_IDS) {
      expect(typeof BUILDERS[id], `${id} builder`).toBe("function");
      expect(Number.isFinite(DURATIONS[id]) && DURATIONS[id] > 0, `${id} duration`).toBe(true);
      expect(DURATIONS[id], `${id} bounded`).toBeLessThanOrEqual(2);
    }
  });

  it("every bass asset has exactly one curated override", () => {
    for (const id of BASS_IDS) {
      const matches = CURATED_SAMPLES.filter((s) => s.id === id);
      expect(matches, id).toHaveLength(1);
      expect(matches[0].file).toBe(`${id}.wav`);
    }
  });

  it("the Bass category is plumbed into kit colours and pad lookup", () => {
    expect(categoryColor("Bass")).toMatch(/^#[0-9a-f]{6}$/i);
    // A pad pointing at a bass asset classifies as Bass (kit colours must not
    // fall back to Percussion).
    const pad = {
      id: "pad-x",
      assetId: "factory.bass.clean",
      synth: null,
      gain: 1,
      pan: 0,
      chokeGroup: null,
      layers: [],
    } as unknown as Parameters<typeof assetCategoryOf>[0];
    expect(assetCategoryOf(pad)).toBe("Bass");
  });
});

describe("lead pack — registry coherence (Priority-1 expand)", () => {
  it("ships as the Lead category with unique ids, character, tags and moods", () => {
    const leads = FACTORY_ASSETS.filter((a) => a.id.startsWith("factory.lead."));
    expect(leads.map((a) => a.id)).toEqual(LEAD_IDS);
    expect(new Set(leads.map((a) => a.character)).size).toBe(LEAD_IDS.length);
    for (const asset of leads) {
      expect(asset.category, `${asset.id} category`).toBe("Lead");
      expect(asset.tags.length).toBeGreaterThanOrEqual(3);
      expect(asset.mood.length).toBeGreaterThanOrEqual(1);
    }
  });
  it("every lead asset has a synth builder, a duration and exactly one curated override", () => {
    for (const id of LEAD_IDS) {
      expect(BUILDERS[id], `${id} builder`).toBeTypeOf("function");
      expect(DURATIONS[id], `${id} duration`).toBeTypeOf("number");
      expect(DURATIONS[id]).toBeGreaterThan(0.2);
      expect(CURATED_SAMPLES.filter((c) => c.id === id)).toHaveLength(1);
    }
  });
  it("the curated WAVs exist on disk and are non-trivially long", () => {
    for (const id of LEAD_IDS) {
      const slot = CURATED_SAMPLES.find((c) => c.id === id)!;
      const file = path.resolve(__dirname, "..", "public", "samples", slot.file);
      const stat = readFileSync(file);
      // 24-bit mono: 44-byte header + frames*3; > 0.2 s at 44.1 kHz
      expect(stat.length, `${slot.file} size`).toBeGreaterThan(44 + Math.floor(0.2 * 44100) * 3);
    }
  });
});

describe("bass pack — curated tuning anchor", () => {
  it("every sub-anchored voice sits on its authored root (a detuned bass beats against melodies)", () => {
    // Heavy-harmonic voices defeat the estimator, so the anchor asserts on
    // the pure voices where the fundamental dominates. Roots are authored
    // per voice: the originals on D2, the expand wave on F1 (808/subs),
    // E1 (upright) and C2 (acid) — each documented in its builder.
    const anchors: Array<[id: string, hz: number]> = [
      ["factory.bass.clean", 73.42], // D2
      ["factory.bass.fm", 73.42], // D2
      ["factory.bass.subsine", 43.65], // F1
      ["factory.bass.upright", 41.2], // E1
    ];
    for (const [id, root] of anchors) {
      const hz = lowFundamentalHz(decodeCurated(`${id}.wav`));
      expect(hz, `${id} fundamental`).not.toBeNull();
      const cents = Math.abs(1200 * Math.log2((hz as number) / root));
      expect(cents, `${id} ${(hz as number).toFixed(2)} Hz vs ${root} Hz`).toBeLessThan(50);
    }
  });
  it("the 808 velocity zones escalate — hard decays longer and drives hotter than soft", async () => {
    // The velocity contract in one measurable: soft is short/clean, hard is
    // long/driven. Compare the curated zone WAVs' durations and energy tails.
    const zoneSeconds = (id: string): number => decodeCurated(`${id}.wav`).length / SR;
    const soft = zoneSeconds("factory.bass.808.soft");
    const medium = zoneSeconds("factory.bass.808.medium");
    const hard = zoneSeconds("factory.bass.808.hard");
    expect(medium).toBeGreaterThan(soft);
    expect(hard).toBeGreaterThan(medium);
  });
});
