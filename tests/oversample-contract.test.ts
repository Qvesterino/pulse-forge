import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Oversampling contract: every WaveShaper on an AUDIO path runs 4×, so
 * saturation harmonics never fold back as inharmonic grit. "none" survives
 * only where oversampling would be wrong:
 *
 *  - modmatrix CV shapers (control voltage into AudioParams, not audio),
 *  - pump key rectifier/clamp (control-rate envelope follower),
 *  - bitcrusher fallback (oversampling would smear the quantization steps
 *    the effect exists to produce).
 *
 * Source-grep style (house precedent: audio-engine-lifecycle.test.ts) —
 * asserting on the constructed graph would need a real BaseAudioContext.
 */

const FILES = [
  "src/effects/registry.ts",
  "src/instruments/registry.ts",
  "src/instruments/modmatrix.ts",
  "src/audio-engine/AudioEngine.ts",
];

function readSources(): Map<string, string> {
  return new Map(FILES.map((f) => [f, readFileSync(resolve(process.cwd(), f), "utf8")]));
}

describe("oversampling contract", () => {
  it('no audio-path shaper is left at "2x"', () => {
    for (const [file, source] of readSources()) {
      expect(source, `${file} still has a 2x shaper`).not.toContain('oversample = "2x"');
    }
  });

  it('"none" appears only at the three allowlisted control/crush sites', () => {
    const sources = readSources();
    const occurrences: { file: string; line: number; text: string }[] = [];
    for (const [file, source] of sources) {
      const lines = source.split("\n");
      lines.forEach((text, i) => {
        if (text.includes('oversample = "none"')) occurrences.push({ file, line: i + 1, text: text.trim() });
      });
    }
    // Pinned allowlist: modmatrix CV shapers ×2, pump key rectifier + clamp
    // ×2, bitcrusher fallback ×1. A new "none" (or a count drift) fails here
    // and must justify itself first.
    const expected = new Map([
      ["src/instruments/modmatrix.ts", 2],
      ["src/effects/registry.ts", 3],
      ["src/audio-engine/AudioEngine.ts", 0],
      ["src/instruments/registry.ts", 0],
    ]);
    for (const [file, count] of expected) {
      const actual = occurrences.filter((o) => o.file === file).length;
      expect(actual, `${file}: expected ${count} allowlisted "none", found ${actual}`).toBe(count);
    }
    expect(occurrences.length).toBe(5);
  });
});
