/**
 * Debug-only test: prints the actual chroma vector + top candidates for a
 * C major synthesised signal so we can pinpoint why the tonal fixture
 * currently ranks F above C.
 */

import { describe, it } from "vitest";
import { analyzeReference } from "../../src/reference/analysis/analyzeReference";
import { scoreKeys } from "../../src/reference/analysis/tonal";
import { extractChroma } from "../../src/reference/dsp/chroma";
import { makeMetadata, tonalTrack } from "./_fixtures";

describe("reference/_debug", () => {
  it("dumps chroma + top keys for C major synth", () => {
    const mono = tonalTrack(0, "major", 12);
    const { chroma, frameCount, tonalEnergy } = extractChroma(mono, 22050, 2048, 512);
    // eslint-disable-next-line no-console
    console.log("chroma:", chroma.map((v) => v.toFixed(4)).join(", "));
    // eslint-disable-next-line no-console
    console.log("frameCount:", frameCount, "tonalEnergy:", tonalEnergy.toFixed(4));
    const ranked = scoreKeys(chroma).slice(0, 5);
    for (const c of ranked) {
      // eslint-disable-next-line no-console
      console.log(`  ${c.tonic} ${c.mode}  score=${c.score.toFixed(4)}  conf=${c.confidence.toFixed(4)}`);
    }

    const result = analyzeReference({ mono, metadata: makeMetadata(12) });
    // eslint-disable-next-line no-console
    console.log("analyzeReference top key:", result.result.tonal.tonic, result.result.tonal.mode, "camelot:", result.result.tonal.camelot);
  });
});
