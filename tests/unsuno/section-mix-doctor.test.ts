import { describe, expect, it } from "vitest";
import { analyzeSectionMix } from "../../src/analysis/sectionMixDoctor";
import { analyzeMixHealth, deriveMixAutoFix } from "../../src/analysis/mixDoctor";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../unsuno/golden-synth";

/**
 * U5 — section mix doctor: findings exist ONLY where something was
 * measured (the W0.2 etiquette). The synthetic fixtures are exact:
 * a −6 dB tail must fire one section-quiet finding at that section, a
 * clean track must produce nothing, and a bass-only drone must fire the
 * low-masking report. The real golden house mix (kick clearly audible)
 * must NOT trigger the masking heuristic.
 */

const SR = GOLDEN_SAMPLE_RATE;
const BAR_SEC = 240 / 126;

describe("analyzeSectionMix — measured findings only", () => {
  const house = goldenTracks()[0];

  it("a −6 dB tail section fires exactly one section-quiet finding with numbers", () => {
    const pcm = renderGoldenTrack(house);
    const quiet = new Float32Array(pcm.length);
    quiet.set(pcm);
    const tailFrom = Math.floor(3 * 2 * BAR_SEC * SR);
    for (let i = tailFrom; i < quiet.length; i++) quiet[i] *= 0.5; // −6 dB
    const sections = [0, 1, 2, 3].map((i) => ({
      role: `sec${i}`,
      startSec: i * 2 * BAR_SEC,
      endSec: (i + 1) * 2 * BAR_SEC,
    }));
    const findings = analyzeSectionMix([quiet], SR, sections);
    const quietFindings = findings.filter((f) => f.kind === "section-quiet");
    expect(quietFindings.length).toBe(1);
    expect(quietFindings[0].section).toBe("sec3");
    expect(quietFindings[0].message).toMatch(/5\.\d|6\.\d dB/);
    expect(quietFindings[0].evidence).toMatch(/dBFS/);
  });

  it("a balanced track fires NOTHING — no measurement, no chip", () => {
    const pcm = renderGoldenTrack(house);
    const sections = [0, 1, 2, 3].map((i) => ({
      role: `sec${i}`,
      startSec: i * 2 * BAR_SEC,
      endSec: (i + 1) * 2 * BAR_SEC,
    }));
    expect(analyzeSectionMix([pcm], SR, sections)).toEqual([]);
  });

  it("a sustained bass drone with no kick fires the low-masking report", () => {
    const seconds = 12;
    const mask = new Float32Array(SR * seconds);
    for (let i = 0; i < mask.length; i++) {
      const t = i / SR;
      mask[i] = 0.6 * Math.sin(2 * Math.PI * 70 * t) + 0.05 * Math.sin(2 * Math.PI * 220 * t);
    }
    const findings = analyzeSectionMix([mask], SR, [
      { role: "a", startSec: 0, endSec: 6 },
      { role: "b", startSec: 6, endSec: 12 },
    ]);
    expect(findings.filter((f) => f.kind === "low-masking").length).toBe(2);
    for (const finding of findings) expect(finding.evidence).toMatch(/low share/);
  });

  it("the REAL golden mix (clear kick) does not trigger low-masking — no false advice", () => {
    const pcm = renderGoldenTrack(house);
    const sections = [0, 1, 2, 3].map((i) => ({
      role: `sec${i}`,
      startSec: i * 2 * BAR_SEC,
      endSec: (i + 1) * 2 * BAR_SEC,
    }));
    expect(analyzeSectionMix([pcm], SR, sections).filter((f) => f.kind === "low-masking")).toEqual([]);
  });

  it("fewer than 2 usable sections → silent (no median to compare against)", () => {
    const pcm = renderGoldenTrack(house);
    expect(analyzeSectionMix([pcm], SR, [{ role: "all", startSec: 0, endSec: 10 }])).toEqual([]);
    expect(analyzeSectionMix([pcm], SR, [])).toEqual([]);
  });
});

describe("master fix chip — the existing mechanical rule", () => {
  it("a clipped render yields a master-gain fix; a clean render yields none", () => {
    const clean = renderGoldenTrack(goldenTracks()[0]);
    expect(deriveMixAutoFix(analyzeMixHealth([clean], SR))).toBeNull();
    const clipped = new Float32Array(clean.length);
    for (let i = 0; i < clipped.length; i++) clipped[i] = clean[i] * 1.4 > 1 ? 1 : clean[i] * 1.4;
    const fix = deriveMixAutoFix(analyzeMixHealth([clipped], SR));
    expect(fix).not.toBeNull();
    expect(fix!.label).toMatch(/−1 dBFS/);
    expect(fix!.masterGain).toBeLessThan(1);
  });
});
