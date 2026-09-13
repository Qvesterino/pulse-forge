import { describe, expect, it } from "vitest";
import {
  measurePreviewAudio,
  passesPreviewAudio,
  previewCleanupDelayMs,
  previewNoteDuration,
} from "../src/presets/audioQuality";

describe("factory preview audio quality metrics", () => {
  it("accepts finite audible headroom-controlled audio", () => {
    const metrics = measurePreviewAudio([new Float32Array([0, 0.2, -0.4, 0.1])]);
    expect(metrics.finite).toBe(true);
    expect(metrics.peak).toBeCloseTo(0.4);
    expect(passesPreviewAudio(metrics)).toBe(true);
  });

  it("rejects silence, non-finite samples and full-scale clipping", () => {
    expect(passesPreviewAudio(measurePreviewAudio([new Float32Array(8)]))).toBe(false);
    expect(measurePreviewAudio([new Float32Array([0.2, Number.NaN, 0.1])]).finite).toBe(false);
    expect(passesPreviewAudio(measurePreviewAudio([new Float32Array([1, 0.2, -1])]))).toBe(false);
  });

  it("gives slow attacks enough preview time and cleanup tail", () => {
    expect(previewNoteDuration({ attack: 1.2 })).toBeCloseTo(1.55);
    expect(previewNoteDuration({ attack: 0.01 })).toBe(0.65);
    expect(previewCleanupDelayMs({ release: 2.2 }, 1.55)).toBe(3_300);
  });
});
