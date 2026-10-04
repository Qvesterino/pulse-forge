import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ANALYSIS_BANDS, analyzeTransientProfile } from "../src/analysis/transientProfile";

/**
 * TRANSIENT PROFILE — the per-band leading-window attack term.
 *
 * The sound-library audit's redundancy vector was blind to strike/transient
 * changes by construction: a whole-file Welch band share averages a
 * sub-millisecond contact into a rounding error. This module (and the audit
 * script that consumes it) measures the axis the fixes actually changed — the
 * head energy of each band relative to its own loud span.
 *
 * Locked here:
 *   1. contract: bands cover the audit's 7, values are finite, silence → null
 *      (never a fabricated 0-strike reading);
 *   2. determinism: same input → identical profile;
 *   3. the REAL historical proof: on the 2026-10 mallet pre/post pairs the
 *      per-band max separates the voices while the broadband term does not;
 *   4. the synthetic proof: a strike added to one band raises that band's head
 *      ratio far above the broadband reading — the property the old metric
 *      lacked.
 */

const SAMPLES = path.resolve(__dirname, "..", "public", "samples");

function decodeCuratedWav(file: string): Float32Array {
  const buf = readFileSync(file);
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

describe("transient profile — contract", () => {
  it("band set matches the audit's whole-file bands exactly", () => {
    expect(ANALYSIS_BANDS.map(([name]) => name)).toEqual(["sub", "low", "lowmid", "mid", "himid", "high", "air"]);
    for (const [, lo, hi] of ANALYSIS_BANDS) {
      expect(lo).toBeGreaterThan(0);
      expect(hi).toBeGreaterThan(lo);
    }
  });

  it("a silent buffer reports null, not a zero-strike reading", () => {
    const silent = new Float32Array(44100);
    expect(analyzeTransientProfile(silent)).toBeNull();
  });

  it("a steady tone has every participating band's head ratio near 0 dB", () => {
    const steady = new Float32Array(22050);
    for (let i = 0; i < steady.length; i++) steady[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100);
    const profile = analyzeTransientProfile(steady)!;
    expect(profile).not.toBeNull();
    // No attack: head and body carry the same power in every PARTICIPATING
    // band. A band the tone does not occupy (sub for a 440 Hz sine) is
    // excluded by the participation floor instead of reporting filter ringing.
    expect(profile.participating).toContain("mid");
    expect(profile.participating).not.toContain("sub");
    for (const name of profile.participating) {
      expect(Math.abs(profile.bands[name]), name).toBeLessThan(1.5);
    }
    expect(Math.abs(profile.broadbandDb)).toBeLessThan(1.5);
  });

  it("is deterministic — same input, identical profile", () => {
    const buf = new Float32Array(44100);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * 180 * i) / 44100) * (1 - i / buf.length);
    const a = analyzeTransientProfile(buf);
    const b = analyzeTransientProfile(buf);
    expect(b).toEqual(a);
  });
});

describe("transient profile — sees what broadband cannot", () => {
  it("a one-band strike makes that band win the max", () => {
    // A 100 ms 220 Hz body fading in over 20 ms (so the head window sits
    // inside the quiet ramp and the body reads ~0 dB of its own), plus a
    // 1 ms 4 kHz click at t=6 ms. Broadband power is dominated by the body,
    // so the click barely moves it; himid is where the click lives.
    const SR = 44100;
    const make = (withClick: boolean) => {
      const len = Math.round(0.1 * SR);
      const sig = new Float32Array(len);
      const ramp = Math.round(0.02 * SR);
      for (let i = 0; i < len; i++) {
        const env = i < ramp ? i / ramp : 1;
        sig[i] = 0.5 * env * Math.sin((2 * Math.PI * 220 * i) / SR);
      }
      if (withClick) {
        const at = Math.round(0.006 * SR);
        for (let i = 0; i < Math.round(0.001 * SR); i++) {
          sig[at + i] += 0.6 * Math.sin((2 * Math.PI * 4000 * i) / SR);
        }
      }
      return sig;
    };
    const bodyProfile = analyzeTransientProfile(make(false), { windowMs: 8 })!;
    const clickProfile = analyzeTransientProfile(make(true), { windowMs: 8 })!;
    // Without the click the body's home band (mid) wins; with it, the click's
    // band (himid) takes the max — the term names WHERE the transient is.
    expect(bodyProfile.maxBand).toBe("mid");
    expect(clickProfile.maxBand).toBe("himid");
    // The click's own band moves far more than the broadband reading (which
    // is diluted by the body) — the property the old metric lacked.
    expect(clickProfile.bands.himid - bodyProfile.bands.himid).toBeGreaterThan(
      clickProfile.broadbandDb - bodyProfile.broadbandDb + 5,
    );
    expect(clickProfile.bands.himid).toBeGreaterThan(clickProfile.bands.sub);
  });

  it("the real 2026-10 mallet pairs separate per-band where broadband is flat", () => {
    // The historical fix lives in tmp-old-*.wav vs the shipped seed. When the
    // scratch pair is absent (fresh checkout) the test skips honestly rather
    // than inventing evidence.
    const pairs: Array<[string, string]> = [
      ["tmp-old-vibes.wav", "factory.mallet.vibes.wav"],
      ["tmp-old-marimba.wav", "factory.mallet.marimba.wav"],
      ["tmp-old-kalimba.wav", "factory.mallet.kalimba.wav"],
    ];
    const root = path.resolve(__dirname, "..");
    let checked = 0;
    for (const [oldFile, newFile] of pairs) {
      const oldPath = path.join(root, oldFile);
      if (!existsSync(oldPath)) continue;
      const oldProfile = analyzeTransientProfile(decodeCuratedWav(oldPath))!;
      const newProfile = analyzeTransientProfile(decodeCuratedWav(path.join(SAMPLES, newFile)))!;
      expect(oldProfile, oldFile).not.toBeNull();
      expect(newProfile, newFile).not.toBeNull();
      // Broadband: the fix is invisible (|Δ| under half a dB).
      expect(Math.abs(newProfile.broadbandDb - oldProfile.broadbandDb), `${newFile} broadband`).toBeLessThan(0.5);
      // Per-band: the strike's own band moved multiple dB.
      expect(Math.abs(newProfile.maxDb - oldProfile.maxDb), `${newFile} per-band`).toBeGreaterThan(1.0);
      checked += 1;
    }
    if (checked === 0) console.warn("[transient-profile] scratch pairs absent — historical A/B skipped");
  });
});
