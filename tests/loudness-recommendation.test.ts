import { describe, it, expect } from "vitest";
import { recommendLoudnessTrim, measurePreviewLoudness } from "../src/intent/loudness";
import { testDoc } from "./fixtures/doc";
import type { SampleBank } from "../src/sample-library/factory";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * FÁZA 6 (KYX ako zvukár): measure → recommend → confirm. The
 * recommendation is pure (reproducible + explainable), and the measure-only
 * preview path never mutates the project — nothing auto-masters.
 */

const fakeBank = () => ({}) as unknown as SampleBank;

describe("recommendLoudnessTrim — structured report", () => {
  it("above target → negative trim with an honest trade-off", () => {
    const recommendation = recommendLoudnessTrim(-10.2, -14, 0);
    expect(recommendation.trimDb).toBe(-3.8);
    expect(recommendation.affected).toEqual(["master (loudnessTrimDb)"]);
    expect(recommendation.evidence).toContain("-10.2");
    expect(recommendation.withinTarget).toBe(false);
    expect(recommendation.tradeOff).toContain("headroom");
  });

  it("below target → positive trim", () => {
    const recommendation = recommendLoudnessTrim(-18.4, -14, 0);
    expect(recommendation.trimDb).toBe(4.4);
    expect(recommendation.tradeOff).toContain("headroom");
  });

  it("within ±1 LU recommends nothing", () => {
    expect(recommendLoudnessTrim(-13.4, -14, 0).trimDb).toBeNull();
    expect(recommendLoudnessTrim(-13.4, -14, 0).withinTarget).toBe(true);
    expect(recommendLoudnessTrim(-14.9, -14, 0).withinTarget).toBe(true);
  });

  it("clamps to the ±6 dB field and composes with the current trim", () => {
    // −30 LUFS is far too quiet → +16 dB needed → clamped to +6.
    expect(recommendLoudnessTrim(-30, -14, 0).trimDb).toBe(6);
    // 0 LUFS is destructive loudness with +5 trim already → −9 needed → −6.
    expect(recommendLoudnessTrim(0, -14, 5).trimDb).toBe(-6);
  });

  it("unmeasurable render → no recommendation, no fake evidence", () => {
    const recommendation = recommendLoudnessTrim(null, -14, 0);
    expect(recommendation.trimDb).toBeNull();
    expect(recommendation.withinTarget).toBe(false);
    expect(recommendation.tradeOff).toContain("kreatívny tip");
  });

  it("is deterministic (same inputs → same report)", () => {
    const a = recommendLoudnessTrim(-11, -14, 1.5);
    const b = recommendLoudnessTrim(-11, -14, 1.5);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("measurePreviewLoudness — measure only, nothing applied", () => {
  it("reports the recommendation WITHOUT mutating the doc", async () => {
    const doc = testDoc();
    const before = JSON.stringify(doc);
    const render = async () =>
      ({
        numberOfChannels: 1,
        sampleRate: 44100,
        length: 3 * 44100,
        getChannelData: () => {
          const data = new Float32Array(3 * 44100);
          data.fill(0.25);
          return data;
        },
      }) as unknown as AudioBuffer;
    const measure = await measurePreviewLoudness(doc, fakeBank(), "dark techno", { render });
    // The recommendation exists and is backed by the measurement…
    expect(measure.measured).not.toBeNull();
    expect(measure.recommendation.evidence).toContain("LUFS");
    // …and the input doc is untouched — the trim rides NO implicit path.
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("an unmeasurable render yields a null recommendation, still without mutation", async () => {
    const doc = testDoc();
    const before = JSON.stringify(doc);
    const render = async () =>
      ({
        numberOfChannels: 1,
        sampleRate: 44100,
        length: 100,
        getChannelData: () => new Float32Array(100),
      }) as unknown as AudioBuffer;
    const measure = await measurePreviewLoudness(doc as ProjectDocument, fakeBank(), "dark techno", { render });
    expect(measure.measured).toBeNull();
    expect(measure.recommendedTrim).toBeNull();
    expect(JSON.stringify(doc)).toBe(before);
  });
});
