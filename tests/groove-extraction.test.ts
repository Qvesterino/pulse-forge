import { describe, it, expect } from "vitest";
import { extractGrooveGrid, grooveRowsForPads } from "../src/intent/groove-extraction";

const SAMPLE_RATE = 16000;

/** Reference groove at `bpm`: low kicks on beats, high noisy hats on off-beats. */
function referenceGroove(bpm: number, seconds = 8): Float32Array {
  const pcm = new Float32Array(Math.round(SAMPLE_RATE * seconds));
  const beat = 60 / bpm;
  const addHit = (startSec: number, kind: "low" | "high") => {
    const start = Math.round(startSec * SAMPLE_RATE);
    const length = Math.round(0.06 * SAMPLE_RATE);
    for (let index = 0; index < length && start + index < pcm.length; index++) {
      if (kind === "low") {
        pcm[start + index] += 0.9 * Math.exp(-index / 300) * Math.sin((2 * Math.PI * 85 * index) / SAMPLE_RATE);
      } else {
        // pseudo-random hat burst — bright, zero-crossing heavy
        const state = (index * 2654435761) % 4294967296;
        pcm[start + index] += 0.5 * (((state >>> 7) % 2000) / 1000 - 1);
      }
    }
  };
  for (let beatIndex = 0; beatIndex * beat < seconds; beatIndex++) {
    addHit(beatIndex * beat, "low"); // kick on the beat → steps 0, 4, 8, 12
    addHit(beatIndex * beat + beat / 2, "high"); // hat on the off-beat → steps 2, 6, 10, 14
  }
  return pcm;
}

describe("groove extraction", () => {
  it("recovers kick steps, hat steps and bands from a synthetic groove", () => {
    const result = extractGrooveGrid(referenceGroove(120), SAMPLE_RATE, { bpm: 120 });
    expect(result).not.toBeNull();
    expect(result?.bpm).toBe(120);
    expect(result?.hits.length).toBeGreaterThanOrEqual(6);

    const lowSteps = result!.hits.filter((hit) => hit.band === "low").map((hit) => hit.step);
    const highSteps = result!.hits.filter((hit) => hit.band === "high").map((hit) => hit.step);
    // kicks quantize onto the downbeats, hats onto the off-beat 8ths
    for (const step of [0, 4, 8, 12]) expect(lowSteps).toContain(step);
    for (const step of [2, 6, 10, 14]) expect(highSteps).toContain(step);
    // velocities keep musical order (nothing at zero, nothing above 1)
    for (const hit of result!.hits) {
      expect(hit.velocity).toBeGreaterThanOrEqual(0.35);
      expect(hit.velocity).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic for the same input", () => {
    const pcm = referenceGroove(120);
    const a = extractGrooveGrid(pcm, SAMPLE_RATE, { bpm: 120 });
    const b = extractGrooveGrid(pcm, SAMPLE_RATE, { bpm: 120 });
    expect(a?.hits).toEqual(b?.hits);
  });

  it("refuses silence and refuses without a tempo", () => {
    expect(extractGrooveGrid(new Float32Array(SAMPLE_RATE * 8), SAMPLE_RATE)).toBeNull();
    const sparse = new Float32Array(SAMPLE_RATE * 2); // 2 s, no onsets, no tempo
    expect(extractGrooveGrid(sparse, SAMPLE_RATE)).toBeNull();
  });

  it("maps band hits onto pads via their roles", () => {
    const result = extractGrooveGrid(referenceGroove(120), SAMPLE_RATE, { bpm: 120 })!;
    const pads = [
      { id: "pad-kick", role: "kick" },
      { id: "pad-snare", role: "snare" },
      { id: "pad-hat", role: "closedHat" },
    ];
    const rows = grooveRowsForPads(result.hits, pads, 16);
    expect(Object.keys(rows)).toHaveLength(3);
    const kickRow = rows["pad-kick"];
    expect(kickRow).toHaveLength(16);
    for (const step of [0, 4, 8, 12]) expect(kickRow[step]).toBeGreaterThan(0);
    const hatRow = rows["pad-hat"];
    for (const step of [2, 6, 10, 14]) expect(hatRow[step]).toBeGreaterThan(0);
    // snare band (mid) got no hits in this synthetic groove
    expect(rows["pad-snare"].every((value) => value === 0)).toBe(true);
  });
});
