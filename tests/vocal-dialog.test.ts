import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { normalizeIntent } from "../src/intent/normalize";
import { applySongCommand, buildSong } from "../src/intent/song";
import { producerNotes, summarizeVocalProfile } from "../src/vocal/notes";
import { phraseRole, replacePatternInPlaceCommand, revisePhraseSection } from "../src/vocal/revise";
import { keepVocalSession, rateVocalSession, readVocalSessions } from "../src/vocal/sessions";
import type { VocalProfile } from "../src/vocal/types";

/**
 * V3 DIALÓG — producer notes (SK+EN), phrase→role mapping, voice-driven
 * revise through the existing C3 machinery, and the local session ledger.
 */

function sungProfile(): VocalProfile {
  return {
    version: 1,
    key: "A Natural Minor",
    keyConfidence: 0.82,
    keyMeasured: true,
    tempoBpm: 96,
    tempoConfidence: 0.6,
    tempoMeasured: true,
    energyCurve: [0.9, 0.8, 0.85, 0.7, 0.4, 0.5, 0.75, 0.8, 0.7, 0.6],
    phrases: [
      { startBar: 0, endBar: 3, peakEnergy: 0.9 },
      { startBar: 4, endBar: 5, peakEnergy: 0.5 },
      { startBar: 6, endBar: 9, peakEnergy: 0.8 },
    ],
    silenceRatio: 0,
    snrDb: 18,
    durationSec: 20,
    bars: 10,
    bpm: 120,
    measured: true,
    profileHash: "dialog001",
  };
}

function silentProfile(): VocalProfile {
  return {
    ...sungProfile(),
    measured: false,
    key: null,
    keyMeasured: false,
    tempoBpm: null,
    tempoMeasured: false,
    phrases: [],
    profileHash: "silent001",
  };
}

describe("summarizeVocalProfile / producerNotes (SK+EN, honest)", () => {
  it("card carries key, tempo and phrase count in both languages", () => {
    const sk = summarizeVocalProfile(sungProfile(), "sk");
    expect(sk.join("\n")).toContain("A Natural Minor");
    expect(sk.join("\n")).toContain("96");
    expect(sk.join("\n")).toContain("3 frázy");
    const en = summarizeVocalProfile(sungProfile(), "en");
    expect(en.join("\n")).toContain("A Natural Minor");
    expect(en.join("\n")).toContain("3 phrases");
  });

  it("silence gets honesty, not guesses", () => {
    expect(summarizeVocalProfile(silentProfile(), "sk").join("\n")).toContain("Neslyším");
    expect(summarizeVocalProfile(silentProfile(), "en").join("\n")).toContain("No singing");
    expect(producerNotes(silentProfile(), ["key set"], "sk").length).toBe(2); // card only, no echo
  });

  it("applied actions echo plus the peak-bar hint", () => {
    const notes = producerNotes(sungProfile(), ["key A Natural Minor", "tempo 96"], "sk");
    expect(notes.join("\n")).toContain("✓ key A Natural Minor");
    expect(notes.join("\n")).toContain("takte 1–4");
  });
});

describe("phraseRole (phrase → scene role)", () => {
  it("maps peak→chorus, first→intro, last→outro, rest→verse", () => {
    const profile = sungProfile(); // peaks: 0.9 @0, 0.5 @1, 0.8 @2 → peak index 0
    expect(phraseRole(profile, 0)).toBe("chorus");
    expect(phraseRole(profile, 1)).toBe("verse");
    expect(phraseRole(profile, 2)).toBe("outro");
  });

  it("a middle peak still wins chorus; edges fall back", () => {
    const profile: VocalProfile = {
      ...sungProfile(),
      phrases: [
        { startBar: 0, endBar: 1, peakEnergy: 0.4 },
        { startBar: 2, endBar: 5, peakEnergy: 0.95 },
        { startBar: 6, endBar: 7, peakEnergy: 0.5 },
        { startBar: 8, endBar: 9, peakEnergy: 0.3 },
      ],
    };
    expect(phraseRole(profile, 1)).toBe("chorus");
    expect(phraseRole(profile, 0)).toBe("intro");
    expect(phraseRole(profile, 3)).toBe("outro");
    expect(phraseRole(profile, 2)).toBe("verse");
  });

  it("unknown input maps to null (caller falls back to text routing)", () => {
    const profile = sungProfile();
    expect(phraseRole(null, 0)).toBeNull();
    expect(phraseRole(profile, -1)).toBeNull();
    expect(phraseRole(profile, 99)).toBeNull();
    expect(phraseRole(silentProfile(), 0)).toBeNull();
  });
});

describe("revisePhraseSection (voice-driven C3 revise)", () => {
  it("revises the chorus the peak phrase maps to, one undo step", async () => {
    const doc = testDoc();
    const build = await buildSong(doc, normalizeIntent({ genre: "trap", seed: "vocal-revise" }), {
      yieldBetweenSections: false,
    });
    const withSong = applySongCommand(doc, build).execute(doc);

    const profile: VocalProfile = {
      ...sungProfile(),
      phrases: [
        { startBar: 0, endBar: 3, peakEnergy: 0.5 },
        { startBar: 4, endBar: 11, peakEnergy: 0.95 },
        { startBar: 12, endBar: 15, peakEnergy: 0.4 },
      ],
    };
    const outcome = revisePhraseSection(withSong, profile, 1, "energy", 0.15);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.role).toBe("chorus");

    const before = withSong.patterns.find((p) => p.id === outcome.patternId)?.generation?.outputContentHash;
    const installed = replacePatternInPlaceCommand(withSong, outcome.patternId, outcome.pattern).execute(withSong);
    const after = installed.patterns.find((p) => p.id === outcome.patternId)?.generation?.outputContentHash;
    expect(before).toBeDefined();
    expect(after).not.toBe(before); // the section actually moved
  }, 60_000);
});

describe("vocal session ledger (local-only memory)", () => {
  it("keeps, dedupes by hash, rates and caps", () => {
    const stamp = `dlg-${Date.now() % 100000}`;
    keepVocalSession({
      profileHash: `${stamp}-a`,
      key: "A Natural Minor",
      tempoBpm: 96,
      phrases: 3,
      applied: ["key"],
      rating: 0,
    });
    keepVocalSession({
      profileHash: `${stamp}-a`,
      key: "A Natural Minor",
      tempoBpm: 96,
      phrases: 3,
      applied: ["key", "tempo"],
      rating: 0,
    });
    const kept = readVocalSessions().filter((e) => e.profileHash.startsWith(stamp));
    expect(kept.length).toBe(1); // dedupe: newest wins
    expect(kept[0].applied).toEqual(["key", "tempo"]);

    rateVocalSession(`${stamp}-a`, 1);
    expect(readVocalSessions().find((e) => e.profileHash === `${stamp}-a`)?.rating).toBe(1);

    for (let i = 0; i < 60; i++) {
      keepVocalSession({
        profileHash: `${stamp}-cap-${i}`,
        key: null,
        tempoBpm: null,
        phrases: 0,
        applied: [],
        rating: 0,
      });
    }
    expect(readVocalSessions().length).toBeLessThanOrEqual(50);
    // our rated entry was pushed out by the cap flood — ledger is bounded
    rateVocalSession("no-such-hash", -1); // unknown hash: silent no-op
  });
});
