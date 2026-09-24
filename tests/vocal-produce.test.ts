import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { normalizeIntent } from "../src/intent/normalize";
import { applyMixIntent, planMixProfile } from "../src/intent/mix";
import { applyLoudnessIntent } from "../src/intent/loudness";
import type { SampleBank } from "../src/sample-library/factory";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * V2 POCKET MIX + VOCAL LOUDNESS SEAM.
 *
 * Pocket: with a vocal take present, the music tracks get a high-mid dip
 * where the voice lives — additive, clamped, one undo step. Without a vocal
 * the profile is exactly the legacy one.
 *
 * Loudness seam: the measurement render receives the vocal arrangement
 * (audioClips travel into the render input), so the trim answers the mix
 * the singer actually hears.
 */

function pocketEqs(doc: ProjectDocument): Array<{ highMidGain: number; highMidFreq: number }> {
  const out: Array<{ highMidGain: number; highMidFreq: number }> = [];
  for (const track of doc.tracks) {
    if (track.kind !== "instrument") continue;
    for (const fx of track.effects) {
      if (fx.type !== "eq") continue;
      if (typeof fx.params.highMidGain === "number") {
        out.push({ highMidGain: fx.params.highMidGain, highMidFreq: fx.params.highMidFreq });
      }
    }
  }
  return out;
}

describe("vocal pocket (planMixProfile vocalPresent)", () => {
  const intent = normalizeIntent({ genre: "house", seed: "vocal-pocket" });

  it("adds a high-mid dip on the music tracks when a vocal is present", () => {
    const profile = planMixProfile(intent, {}, { vocalPresent: true });
    expect(profile.summary.join(" ")).toContain("pocket");
    const pockets = profile.decisions.filter((d) => d.effectType === "eq" && "highMidGain" in d.params);
    expect(pockets.length).toBeGreaterThanOrEqual(2);
    for (const pocket of pockets) {
      expect(pocket.params.highMidGain).toBe(-2.5);
      expect(pocket.params.highMidFreq).toBe(2800);
    }
  });

  it("leaves the legacy profile untouched without a vocal", () => {
    const profile = planMixProfile(intent, {}, {});
    expect(profile.summary.join(" ")).not.toContain("pocket");
    expect(profile.decisions.some((d) => "highMidGain" in d.params)).toBe(false);
  });

  it("applies and undoes as one step", () => {
    const doc = testDoc();
    const before = JSON.stringify(doc.tracks);
    const cmd = applyMixIntent(doc, planMixProfile(intent, {}, { vocalPresent: true }));
    const next = cmd.execute(doc);
    expect(pocketEqs(next).some((eq) => eq.highMidGain === -2.5 && eq.highMidFreq === 2800)).toBe(true);
    expect(JSON.stringify(cmd.undo(next).tracks)).toBe(before);
  });
});

describe("loudness hears the vocal arrangement", () => {
  function docWithVocal(): ProjectDocument {
    const doc = testDoc();
    const trackId = doc.tracks[0].id;
    return {
      ...doc,
      master: { ...doc.master, loudnessTrimDb: 0 },
      arrangement: {
        ...doc.arrangement,
        audioClips: [
          {
            id: "clip-vocal-1",
            trackId,
            bufferId: "vocal.take1",
            startBar: 0,
            lengthBars: 4,
            offsetSec: 0,
            trimStart: 0,
            trimEnd: 0,
            gain: 1,
            fadeIn: 0,
            fadeOut: 0,
            stretchRate: 1,
            reverse: false,
          },
        ],
      },
    };
  }

  it("the measurement render receives the vocal clip doc and the trim answers", async () => {
    const bank = {} as unknown as SampleBank;
    let receivedClips = -1;
    const render = async (doc: ProjectDocument) => {
      receivedClips = doc.arrangement.audioClips?.length ?? 0;
      const sampleRate = 44100;
      const length = sampleRate * 3;
      const data = new Float32Array(length);
      for (let i = 0; i < length; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * 997 * i) / sampleRate);
      return {
        numberOfChannels: 1,
        sampleRate,
        length,
        getChannelData: (channel: number) => (channel === 0 ? data : new Float32Array(length)),
        duration: length / sampleRate,
      } as unknown as AudioBuffer;
    };
    const outcome = await applyLoudnessIntent(docWithVocal(), bank, { direction: "louder", detected: [] }, { render });
    expect(receivedClips).toBe(1); // the vocal arrangement traveled into measurement
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.trim).toBeGreaterThan(0); // loud take + louder nudge → trim up
  });
});
