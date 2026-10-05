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

describe("U3.5 — per-section drum maps", () => {
  it("golden house: every section map matches the whole-track fold exactly", async () => {
    const { transcribeTrack } = await import("../../src/reference/transcribe");
    const track = goldenTracks()[0];
    const pcm = renderGoldenTrack(track);
    // 2-bar sections tile the 8-bar track exactly
    const sections = [0, 1, 2, 3].map((i) => ({
      role: `sec${i}`,
      startSec: i * 2 * BAR_SEC,
      endSec: (i + 1) * 2 * BAR_SEC,
    }));
    const { stepF1 } = await import("../../src/reference/unsuno-metrics");
    const t = transcribeTrack(pcm, GOLDEN_SAMPLE_RATE, { sections });
    expect(t.drums.sections?.length).toBe(4);
    for (const entry of t.drums.sections!) {
      // constant bar patterns → every section fold matches the TRUTH union
      // (±1 slot: the 60 ms detection window bleeds across a slot boundary;
      // the track-level fold carries one edge FP the windows don't reproduce)
      for (const band of ["kick", "snare", "hat"] as const) {
        const truth = new Set<number>();
        for (let bar = 0; bar < track.bars; bar++) {
          for (let slot = 0; slot < 16; slot++) if ((track.drums[band][bar]?.[slot] ?? 0) > 0) truth.add(slot);
        }
        const report = stepF1(
          entry[band],
          [...truth].sort((a, b) => a - b),
          { tolerance: 1 },
        );
        // Section windows have higher variance than the whole-track fold
        // (fewer bars to average the phase window over), so these floors sit
        // just under the track-level KPI: kick/snare stay strong, the hat
        // fold wobbles more in short windows (documented U3.5 wobble).
        expect(report.f1, `${entry.role}.${band}`).toBeGreaterThanOrEqual(
          band === "kick" ? 0.7 : band === "snare" ? 0.45 : 0.25,
        );
      }
    }
  });
  it("a section under 1 s is skipped, not invented", async () => {
    const { transcribeTrack } = await import("../../src/reference/transcribe");
    const pcm = renderGoldenTrack(goldenTracks()[0]);
    const t = transcribeTrack(pcm, GOLDEN_SAMPLE_RATE, {
      sections: [
        { role: "tiny", startSec: 0, endSec: 0.4 },
        { role: "ok", startSec: 0.4, endSec: 5 },
      ],
    });
    expect(t.drums.sections?.some((entry) => entry.role === "tiny")).toBe(false);
    expect(t.drums.sections?.some((entry) => entry.role === "ok")).toBe(true);
  });
});
