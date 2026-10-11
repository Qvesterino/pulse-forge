import { describe, expect, it } from "vitest";
import { generateLocalResult } from "../src/intent/pipeline";
import { generatePattern } from "../src/ai/generator";
import { normalizeIntent } from "../src/intent/normalize";
import { testDoc } from "./fixtures/doc";
import type { GenerateOptions } from "../src/ai/types";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * HARMONY-FIRST GENERATION (2026-10-10) — the highest-leverage intent fix:
 * the multi-voice engine (chord progressions + voice leading) was reachable
 * ONLY from the never-invoked symbolic-prior branch, so every real
 * generation played Markov templates that knew nothing about the
 * progression tables — and the song-level harmony plan had no living
 * consumer. Now generatePattern routes melodic roles through the engine
 * (all-or-nothing per candidate — bass/chords/lead are one harmonic
 * decision), with the templates as fallback.
 *
 * Locked here: the progression plan REACHES the default generation path
 * (different plans → different chords on the same seed), the previously
 * melody-less genres produce melodic content on the default path, the dice
 * role scope is respected, and everything stays deterministic.
 */

const doc: ProjectDocument = testDoc();

function notes(result: ReturnType<typeof generateLocalResult>): string {
  // Strip the random note IDS by key — everything else is content.
  return JSON.stringify(result.proposal?.pattern.notes ?? {}, (key, value) => (key === "id" ? undefined : value));
}

describe("harmony-first generation", () => {
  it("the progression plan REACHES the default path — different plans, different chords, same seed", () => {
    const a = generateLocalResult(
      doc,
      normalizeIntent({ genre: "jazz", seed: "route-proof", length: 32, progression: "ii-V-i (minor pocket)" }),
      "apply",
    );
    const b = generateLocalResult(
      doc,
      normalizeIntent({
        genre: "jazz",
        seed: "route-proof",
        length: 32,
        progression: "I-VI-ii-V (rhythm changes bridge)",
      }),
      "apply",
    );
    const aChords = notes(a);
    const bChords = notes(b);
    expect(aChords, "plan A produced chords").not.toBe("{}");
    expect(aChords, "the two plans must diverge (the plan is live)").not.toBe(bChords);
    // Determinism: the same plan rebuilds the same content.
    expect(
      notes(
        generateLocalResult(
          doc,
          normalizeIntent({ genre: "jazz", seed: "route-proof", length: 32, progression: "ii-V-i (minor pocket)" }),
          "apply",
        ),
      ),
    ).toBe(aChords);
  });

  it("the previously melody-less genres now sing on the default path", () => {
    for (const genre of ["drill", "amapiano", "postrock", "boombap", "trance"] as const) {
      const result = generateLocalResult(doc, normalizeIntent({ genre, seed: `melody-${genre}`, length: 32 }), "apply");
      const tracks = Object.values(result.proposal?.pattern.notes ?? {});
      const total = tracks.reduce((sum, part) => sum + part.length, 0);
      expect(total, `${genre} melodic notes on the template-less default path`).toBeGreaterThan(0);
    }
  });

  it("the dice role scope cuts across the engine (drums+bass gets no chords/lead)", () => {
    const options: GenerateOptions = {
      genre: "house",
      seed: "role-scope",
      stepCount: 32,
      ghostWeight: 0.3,
      microWeight: 0.2,
      velocityVariation: 0.3,
      temperature: 1,
      replaceMode: "new",
      roles: ["drums", "bass"],
    };
    const pattern = generatePattern(doc, options);
    // The chord and lead TRACKS must stay empty — the engine computed the
    // full harmonic stack but the role scope drops everything above bass.
    const chordTrack = doc.tracks.find((t) => t.kind === "instrument" && t.name.toLowerCase().includes("analog"));
    void chordTrack;
    for (const [trackId, part] of Object.entries(pattern.notes)) {
      const track = doc.tracks.find((t) => t.id === trackId);
      const isChordOrLead =
        track &&
        track.kind === "instrument" &&
        /chord|lead|synth|analog/i.test(track.name) === true &&
        !/bass|808/i.test(track.name);
      if (isChordOrLead) {
        expect(part.length, `${track.name} must stay empty at drums+bass scope`).toBe(0);
      }
    }
    // And the bass role still sings (the engine's bass carries the harmony).
    const totalBassish = Object.entries(pattern.notes).reduce((sum, [trackId, part]) => {
      const track = doc.tracks.find((t) => t.id === trackId);
      return sum + (track && track.kind === "instrument" && /bass|808/i.test(track.name) ? part.length : 0);
    }, 0);
    expect(totalBassish, "the bass voice plays under the drums+bass scope").toBeGreaterThan(0);
  });
});
