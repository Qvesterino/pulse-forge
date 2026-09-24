import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { normalizeIntent } from "../src/intent/normalize";
import { applyMixIntent, planMixProfile } from "../src/intent/mix";
import { clampEffectParam } from "../src/effects/definitions";
import { applyLoudnessIntent } from "../src/intent/loudness";
import { composeFullTrack } from "../src/intent/compose";
import type { SampleBank } from "../src/sample-library/factory";
import type { ProjectDocument } from "../src/project-model/types";
import type { VocalProfile } from "../src/vocal/types";
import { createInstrumentTrackModel } from "../src/project-model/schema";

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
    expect(profile.decisions.some((d) => d.effectType === "ultina")).toBe(false);
  });

  it("plans VLYX ecosystem consumers + a neutral vocal publisher", () => {
    const profile = planMixProfile(intent, {}, { vocalPresent: true });
    const consumers = profile.decisions.filter((d) => d.effectType === "ultina" && d.target !== "vocal");
    expect(consumers.length).toBeGreaterThanOrEqual(2);
    for (const consumer of consumers) {
      expect(consumer.params["unmask.enabled"]).toBe(1);
      expect(consumer.params["unmask.ecosystemEnabled"]).toBe(1);
      expect(consumer.params["unmask.amount"]).toBe(50);
    }
    const publishers = profile.decisions.filter((d) => d.effectType === "ultina" && d.target === "vocal");
    expect(publishers.length).toBe(1);
    expect(publishers[0].params).toEqual({}); // defaults = neutral publisher
  });

  it("clamps the new ultina params against their defs", () => {
    expect(clampEffectParam("ultina", "unmask.ecosystemEnabled", 5)).toBe(1);
    expect(clampEffectParam("ultina", "unmask.amount", 200)).toBe(100);
    expect(clampEffectParam("ultina", "unmask.amount", -10)).toBe(0);
  });

  it("installs publisher on the clip track and consumers on the music", () => {
    const doc = testDoc();
    const trackId = doc.tracks[0].id;
    // Guarantee a lead-role target by name (templates vary in track count).
    const leadTrack = {
      ...createInstrumentTrackModel("analog", doc.tracks.length),
      name: "Lead",
    };
    const withVocal: ProjectDocument = {
      ...doc,
      tracks: [...doc.tracks, leadTrack],
      arrangement: {
        ...doc.arrangement,
        audioClips: [
          {
            id: "clip-v",
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
    const cmd = applyMixIntent(withVocal, planMixProfile(intent, {}, { vocalPresent: true }));
    const next = cmd.execute(withVocal);
    // Publisher: default ultina on the take's track.
    const vocalTrack = next.tracks.find((t) => t.id === trackId)!;
    expect(vocalTrack.effects.some((fx) => fx.type === "ultina")).toBe(true);
    // Consumers: unmask enabled + ecosystem on across the music.
    const unmaskers = next.tracks.flatMap((t) =>
      t.kind === "instrument" ? t.effects.filter((fx) => fx.type === "ultina") : [],
    );
    expect(unmaskers.filter((fx) => fx.params["unmask.enabled"] === 1).length).toBeGreaterThanOrEqual(2);
    expect(
      unmaskers
        .filter((fx) => fx.params["unmask.enabled"] === 1)
        .every((fx) => fx.params["unmask.ecosystemEnabled"] === 1),
    ).toBe(true);
    // One undo step restores the pre-mix chains.
    expect(JSON.stringify(cmd.undo(next).tracks)).toBe(JSON.stringify(withVocal.tracks));
  });

  it("degrades gracefully with no installed takes (consumers still apply)", () => {
    const doc = testDoc();
    const cmd = applyMixIntent(doc, planMixProfile(intent, {}, { vocalPresent: true }));
    const next = cmd.execute(doc);
    const unmaskers = next.tracks.flatMap((t) =>
      t.kind === "instrument" ? t.effects.filter((fx) => fx.type === "ultina") : [],
    );
    expect(unmaskers.some((fx) => fx.params["unmask.enabled"] === 1)).toBe(true);
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

describe("composeFullTrack vocal wiring (take → bent song + pocket mix)", () => {
  function sungProfile(): VocalProfile {
    return {
      version: 1,
      key: null,
      keyConfidence: 0,
      keyMeasured: false,
      tempoBpm: null,
      tempoConfidence: 0,
      tempoMeasured: false,
      energyCurve: [...Array<number>(20).fill(0.9), ...Array<number>(24).fill(0.2)],
      phrases: [{ startBar: 0, endBar: 4, peakEnergy: 0.9 }],
      silenceRatio: 0.2,
      snrDb: 18,
      durationSec: 88,
      bars: 44,
      bpm: 124,
      measured: true,
      profileHash: "produce-song",
    };
  }

  it("a measured take bends sections and opens the pocket", async () => {
    const text = "house at 124";
    const plain = await composeFullTrack(testDoc(), text, {
      input: { genre: "house" },
      seed: "vocal-compose",
      loudness: false,
    });
    const sung = await composeFullTrack(testDoc(), text, {
      input: { genre: "house" },
      seed: "vocal-compose",
      loudness: false,
      vocalProfile: sungProfile(),
    });
    // Pocket in the mix…
    expect(sung.mixSummary ?? "").toContain("pocket");
    expect(plain.mixSummary ?? "").not.toContain("pocket");
    // …and phrasing in the sections (same seed, moved content).
    const hashes = (b: typeof plain.build) => b.sections.map((s) => s.pattern.generation?.outputContentHash);
    expect(hashes(sung.build)).not.toEqual(hashes(plain.build));
  }, 120_000);

  it("an unmeasured take builds the legacy song (no pocket, identical sections)", async () => {
    const text = "house at 124";
    const plain = await composeFullTrack(testDoc(), text, {
      input: { genre: "house" },
      seed: "vocal-compose-flat",
      loudness: false,
    });
    const flat = await composeFullTrack(testDoc(), text, {
      input: { genre: "house" },
      seed: "vocal-compose-flat",
      loudness: false,
      vocalProfile: { ...sungProfile(), measured: false, energyCurve: [] },
    });
    expect(flat.mixSummary ?? "").not.toContain("pocket");
    const hashes = (b: typeof plain.build) => b.sections.map((s) => s.pattern.generation?.outputContentHash);
    expect(hashes(flat.build)).toEqual(hashes(plain.build));
  }, 120_000);
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
