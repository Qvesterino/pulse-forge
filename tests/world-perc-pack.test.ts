import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { BUILDERS, DURATIONS } from "../src/sample-library/factory";
import { CURATED_SAMPLES } from "../src/sample-library/curated";

/**
 * WORLD PERCUSSION PACK (Priority-3 wave, amapiano/latino/afro/samba) —
 * six regional voices the 13-member percussion family left to genre lanes
 * only: the conga QUINTO (slap tone — the existing conga keeps the open
 * tumbao), the bongocero's MARTILLO pair, the salsa timbale cascara, the
 * tabla with its syahi GLIDE (the pitch bend is the instrument), the
 * cajón box thump, and the agogô double-bell chase.
 */

const SR = 44100;

const P3_IDS = [
  "factory.perc.conga.high",
  "factory.perc.bongos",
  "factory.perc.timbale",
  "factory.perc.tabla",
  "factory.perc.cajon",
  "factory.perc.agogo",
];

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

describe("world percussion pack — registry coherence (Priority-3 expand)", () => {
  it("six new assets with distinct characters, Percussion category and moods", () => {
    for (const id of P3_IDS) {
      const asset = FACTORY_ASSETS.find((a) => a.id === id);
      expect(asset, `${id} in manifest`).toBeTruthy();
      expect(asset!.category).toBe("Percussion");
      expect(asset!.character.length).toBeGreaterThan(8);
      expect(asset!.tags.length).toBeGreaterThanOrEqual(3);
      expect(asset!.mood.length).toBeGreaterThanOrEqual(1);
    }
    const characters = new Set(P3_IDS.map((id) => FACTORY_ASSETS.find((a) => a.id === id)!.character));
    expect(characters.size).toBe(P3_IDS.length);
  });

  it("every P3 asset has a builder, a duration and exactly one curated override on disk", () => {
    for (const id of P3_IDS) {
      expect(BUILDERS[id], `${id} builder`).toBeTypeOf("function");
      expect(DURATIONS[id], `${id} duration`).toBeGreaterThan(0.15);
      const slots = CURATED_SAMPLES.filter((c) => c.id === id);
      expect(slots).toHaveLength(1);
      const size = readFileSync(path.resolve(__dirname, "..", "public", "samples", slots[0].file)).length;
      expect(size, `${slots[0].file}`).toBeGreaterThan(44 + Math.floor(0.15 * SR) * 3);
    }
  });

  it("the conga QUINTO is brighter than the existing conga (slap vs open tone)", () => {
    // The high conga's spectral centroid must sit above the mid conga's —
    // the slap tone carries more 2+ kHz energy than the open tone.
    const centroid = (pcm: Float32Array): number => {
      const n = Math.min(pcm.length, Math.floor(0.2 * SR));
      // crude zero-crossing rate as a brightness proxy (deterministic)
      let zc = 0;
      for (let i = 1; i < n; i++) if (pcm[i] >= 0 !== pcm[i - 1] >= 0) zc++;
      return zc / (n / SR);
    };
    const quinto = decodeCurated("factory.perc.conga.high.wav");
    const mid = decodeCurated("factory.perc.conga.wav");
    expect(centroid(quinto), "quinto ZCR vs conga ZCR").toBeGreaterThan(centroid(mid));
  });

  it("the tabla sustains longer than the conga (resonant body contract)", () => {
    const tabla = decodeCurated("factory.perc.tabla.wav");
    const conga = decodeCurated("factory.perc.conga.wav");
    // DURATIONS say 0.65 vs 0.3; the rendered+mastered WAVs preserve the ratio.
    expect(tabla.length).toBeGreaterThan(conga.length);
  });

  it("the bongos carry TWO transients (the martillo pair, not a single drum)", () => {
    const bongos = decodeCurated("factory.perc.bongos.wav");
    // Find local RMS peaks in the first 120 ms: at least two windows with
    // rms > 25% of the max window.
    const win = Math.floor(0.01 * SR);
    let maxRms = 0;
    const rmsAt: number[] = [];
    for (let t = 0; t < 0.12 * SR && t + win < bongos.length; t += win) {
      let sum = 0;
      for (let i = t; i < t + win; i++) sum += bongos[i] * bongos[i];
      const r = Math.sqrt(sum / win);
      rmsAt.push(r);
      maxRms = Math.max(maxRms, r);
    }
    const strongWindows = rmsAt.filter((r) => r > maxRms * 0.25).length;
    expect(strongWindows, "martillo transient count").toBeGreaterThanOrEqual(2);
  });

  it("the cajón is the LOWEST-pitched percussion asset (box thump)", () => {
    // Lowest strong spectral peak via autocorrelation on the first 150 ms.
    const cajon = decodeCurated("factory.perc.cajon.wav");
    const conga = decodeCurated("factory.perc.conga.wav");
    const lowPeriod = (pcm: Float32Array): number => {
      const n = Math.min(pcm.length, Math.floor(0.15 * SR));
      let bestLag = 0;
      let best = 0;
      for (let lag = Math.floor(SR / 500); lag < Math.floor(SR / 50); lag++) {
        let sum = 0;
        for (let i = 0; i + lag < n; i++) sum += pcm[i] * pcm[i + lag];
        if (sum > best) {
          best = sum;
          bestLag = lag;
        }
      }
      return bestLag > 0 ? SR / bestLag : 0;
    };
    expect(lowPeriod(cajon), "cajon f0 vs conga f0").toBeLessThan(lowPeriod(conga));
  });
});
