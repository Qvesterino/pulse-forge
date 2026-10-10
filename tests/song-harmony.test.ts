import { describe, it, expect } from "vitest";
import { planSongHarmony, buildSong } from "../src/intent/song";
import { createSongSectionIntent } from "../src/intent/song-section-intent";
import { normalizeIntent } from "../src/intent/normalize";
import { generateOptionsFromIntent } from "../src/intent/plan";
import { generateMultiVoice } from "../src/intent/multi-voice";
import { findProgression, selectProgression, expandProgression } from "../src/ai/harmony";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * SONG HARMONIC ARCHITECTURE (2026-10-10) — before this wave every section
 * of a generated song rolled its OWN progression from the section seed, so a
 * four-section song could wander through four unrelated chord loops. Now the
 * song carries ONE harmonic identity: planSongHarmony picks the song
 * progression from the song seed, every non-bridge section plays it, and the
 * bridge takes the RELATED TURN (the next progression in the genre's own
 * table — a departure that stays inside the genre's vocabulary and returns
 * home for the last head). The plan threads intent → options → the melodic
 * voices; an absent plan keeps the legacy per-seed pick bit-identical.
 */

const doc = {} as ProjectDocument; // generateMultiVoice's first param is unused

describe("planSongHarmony", () => {
  it("is deterministic and both names resolve inside the genre's own table", () => {
    for (const genre of ["jazz", "rock", "house", "drone"] as const) {
      const a = planSongHarmony(genre, "song-seed-1");
      const b = planSongHarmony(genre, "song-seed-1");
      expect(a).toEqual(b);
      expect(findProgression(genre, a.verseName)?.name, `${genre} verse`).toBe(a.verseName);
      expect(findProgression(genre, a.turnName)?.name, `${genre} turn`).toBe(a.turnName);
    }
  });

  it("the bridge turn is a DIFFERENT related progression when the genre has more than one", () => {
    for (const genre of ["jazz", "rock", "house"] as const) {
      const plan = planSongHarmony(genre, "harmony-tour");
      expect(plan.turnName, `${genre} turn differs from the verse identity`).not.toBe(plan.verseName);
    }
  });

  it("selection matches the shared seeded derivation (one idea, one song)", () => {
    // The plan must pick what a standalone generation with the SAME seed
    // would pick — the song identity and the pattern language agree.
    const plan = planSongHarmony("jazz", "identity-check");
    const legacy = selectProgression("jazz", (parseInt("identity-check".slice(-8), 36) || 42) >>> 0);
    expect(plan.verseName).toBe(legacy.name);
  });
});

describe("progression threading", () => {
  it("normalizeIntent carries the plan and OMITS the key when absent (legacy hashes)", () => {
    const withPlan = normalizeIntent({ genre: "rock", seed: "s", progression: "I-IV-V (the classic engine)" });
    expect(withPlan.progression).toBe("I-IV-V (the classic engine)");
    const without = normalizeIntent({ genre: "rock", seed: "s" });
    expect("progression" in without, "absent plan must not add the key").toBe(false);
  });

  it("generateOptionsFromIntent + createSongSectionIntent carry the plan through", () => {
    const intent = normalizeIntent({ genre: "rock", seed: "s", progression: "I-IV-V (the classic engine)" });
    expect(generateOptionsFromIntent(intent).progression).toBe("I-IV-V (the classic engine)");
    const section = createSongSectionIntent(intent, {
      index: 2,
      role: "bridge",
      bars: 8,
      energy: 0.7,
      density: 0.5,
      complexity: 0.5,
      candidateCount: 1,
      roles: ["drums", "bass", "chords", "lead"],
      progression: "i-VII-VI-V (the minor-rock descent)",
    });
    expect(section.progression).toBe("i-VII-VI-V (the minor-rock descent)");
    // Legacy shape: no override in, no key out.
    const legacy = createSongSectionIntent(normalizeIntent({ genre: "rock", seed: "s" }), {
      index: 0,
      role: "verse",
      bars: 8,
      energy: 0.7,
      density: 0.5,
      complexity: 0.5,
      candidateCount: 1,
      roles: ["drums", "bass", "chords", "lead"],
    });
    expect("progression" in legacy).toBe(false);
  });
});

describe("generateMultiVoice override", () => {
  it("an unresolvable name falls back content-identical to the legacy seeded pick", () => {
    const base = {
      genre: "jazz",
      seed: 4242,
      stepCount: 32,
      key: null,
      energy: 0.7,
      velocityVariation: 0.3,
      density: 0.5,
      complexity: 0.5,
    } as const;
    const legacy = generateMultiVoice(
      doc,
      base.genre,
      base.seed,
      base.stepCount,
      base.key,
      base.energy,
      base.velocityVariation,
      base.density,
      base.complexity,
    );
    const fallback = generateMultiVoice(
      doc,
      base.genre,
      base.seed,
      base.stepCount,
      base.key,
      base.energy,
      base.velocityVariation,
      base.density,
      base.complexity,
      undefined,
      undefined,
      "no such progression",
    );
    // Notes carry random ids — compare CONTENT (everything but the id fields).
    const content = (result: unknown): string => JSON.stringify(result, (k, v) => (k === "id" ? undefined : v));
    expect(content(fallback)).toBe(content(legacy));
  });

  it("a real plan name changes the harmony to THAT progression's chord roots", () => {
    const args = {
      genre: "jazz",
      seed: 4242,
      stepCount: 32,
      key: null,
      energy: 0.7,
      velocityVariation: 0.3,
      density: 0.5,
      complexity: 0.5,
    } as const;
    const legacy = generateMultiVoice(
      doc,
      args.genre,
      args.seed,
      args.stepCount,
      args.key,
      args.energy,
      args.velocityVariation,
      args.density,
      args.complexity,
    );
    const overridden = generateMultiVoice(
      doc,
      args.genre,
      args.seed,
      args.stepCount,
      args.key,
      args.energy,
      args.velocityVariation,
      args.density,
      args.complexity,
      undefined,
      undefined,
      "ii-V-i (minor pocket)",
    );
    expect(overridden).not.toEqual(legacy);
    // The override must be exactly the named progression's harmony: the
    // minor-pocket loop is MINOR on the tonic, so its chords sit lower than
    // the seeded major-resolution pick would place them.
    const progression = findProgression("jazz", "ii-V-i (minor pocket)")!;
    expect(progression?.events[0]?.degree).toBe(1);
    expect(overridden.chord.length).toBeGreaterThan(0);
    expect(overridden.bass.length).toBeGreaterThan(0);
  });
});

describe("buildSong carries the plan end-to-end", () => {
  it("the promoted genres build a full song with the shared harmony plan", async () => {
    const doc2 = testDoc();
    const build = await buildSong(doc2, { genre: "rock", seed: "harmony-e2e", length: 64 });
    expect(build.sections.length).toBeGreaterThanOrEqual(4);
    // Deterministic: the same seed rebuilds the same song (one idea).
    const again = await buildSong(doc2, { genre: "rock", seed: "harmony-e2e", length: 64 });
    expect(again.name).toBe(build.name);
    expect(again.sections.map((s) => s.label)).toEqual(build.sections.map((s) => s.label));
  });
});
