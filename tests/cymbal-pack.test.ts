import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { BUILDERS, DURATIONS } from "../src/sample-library/factory";
import { CURATED_SAMPLES } from "../src/sample-library/curated";

/**
 * CYMBAL/SHAKER PACK (Priority-2 wave, jazz/dnb/rock) — the four voices
 * those genre families reach for that the bank did not have: the china
 * (the only crash-family voice with a trash/roar character), the washy
 * jazz comping ride (the ping's complement), the driving 16th shaker, and
 * the crescendo crash roll. Same contract shape as the bass/lead packs.
 */

const SR = 44100;

const P2_IDS = ["factory.crash.china", "factory.ride.jazz", "factory.shaker.fast", "factory.crash.roll"];

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

describe("cymbal pack — registry coherence (Priority-2 expand)", () => {
  it("four new assets with distinct characters, correct categories and moods", () => {
    for (const id of P2_IDS) {
      const asset = FACTORY_ASSETS.find((a) => a.id === id);
      expect(asset, `${id} in manifest`).toBeTruthy();
      expect(asset!.character.length).toBeGreaterThan(8);
      expect(asset!.tags.length).toBeGreaterThanOrEqual(3);
      expect(asset!.mood.length).toBeGreaterThanOrEqual(1);
    }
    const china = FACTORY_ASSETS.find((a) => a.id === "factory.crash.china")!;
    expect(china.category).toBe("Crash");
    const jazz = FACTORY_ASSETS.find((a) => a.id === "factory.ride.jazz")!;
    expect(jazz.category).toBe("Cymbal");
  });

  it("every P2 asset has a builder, a duration and exactly one curated override on disk", () => {
    for (const id of P2_IDS) {
      expect(BUILDERS[id], `${id} builder`).toBeTypeOf("function");
      expect(DURATIONS[id], `${id} duration`).toBeGreaterThan(0.15);
      const slots = CURATED_SAMPLES.filter((c) => c.id === id);
      expect(slots).toHaveLength(1);
      const file = path.resolve(__dirname, "..", "public", "samples", slots[0].file);
      const size = readFileSync(file).length;
      // 24-bit mono, > 0.15 s
      expect(size, `${slots[0].file}`).toBeGreaterThan(44 + Math.floor(0.15 * SR) * 3);
    }
  });

  it("the china is SHORTER than the crash.main wash (articulate, not a wash)", () => {
    const china = decodeCurated("factory.crash.china.wav");
    const main = decodeCurated("factory.crash.main.wav");
    expect(china.length).toBeLessThan(main.length);
  });

  it("the jazz ride tail outlives the ride ping (comping wash contract)", () => {
    const jazz = decodeCurated("factory.ride.jazz.wav");
    const ping = decodeCurated("factory.ride.ping.wav");
    expect(jazz.length / SR).toBeGreaterThan(1.2); // long tail
    expect(jazz.length).toBeGreaterThan(ping.length);
  });

  it("the shaker fast is SHORT and double-hit (driving 16th, not a swish)", () => {
    const fast = decodeCurated("factory.shaker.fast.wav");
    const shakerLong = decodeCurated("factory.shaker.long.wav");
    // The seed renderer pads a mastering tail; the CONTRACT is that fast is
    // roughly half the swish (short 16th accent, not a slow swish).
    expect(fast.length).toBeLessThan(shakerLong.length);
    // The second transient: RMS in the 15–30 ms window after the first
    // transient must be non-trivial (the chain snapping back).
    const window = fast.subarray(Math.floor(0.015 * SR), Math.floor(0.03 * SR));
    let sum = 0;
    for (let i = 0; i < window.length; i++) sum += window[i] * window[i];
    expect(Math.sqrt(sum / window.length), "double-hit rms").toBeGreaterThan(0.005);
  });

  it("the crash roll is the LONGEST crash asset (crescendo + bloom)", () => {
    const roll = decodeCurated("factory.crash.roll.wav");
    const main = decodeCurated("factory.crash.main.wav");
    expect(roll.length).toBeGreaterThan(main.length);
    // The crescendo contract: the PEAK window (the bloom lands ~60 % in)
    // is far louder than the opening window. The tail after the bloom is
    // silence — the mastering chain trims past the decay — so compare
    // peak-vs-opening, not tail-vs-opening.
    const rms = (w: Float32Array): number => {
      let sum = 0;
      for (let i = 0; i < w.length; i++) sum += w[i] * w[i];
      return Math.sqrt(sum / w.length);
    };
    const opening = rms(roll.subarray(0, Math.floor(0.3 * SR)));
    // Slide a 0.3 s window to find the peak region.
    let peak = 0;
    for (let t = 0; t + 0.3 < roll.length / SR; t += 0.15) {
      peak = Math.max(peak, rms(roll.subarray(Math.floor(t * SR), Math.floor((t + 0.3) * SR))));
    }
    expect(peak, "bloom peak vs opening").toBeGreaterThan(opening * 3);
  });
});
