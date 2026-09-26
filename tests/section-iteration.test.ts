import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { normalizeIntent } from "../src/intent/normalize";
import { buildSong, applySongCommand, reviseSection, replacePatternInPlaceCommand } from "../src/intent/song";
import { contentHash, canonicalizePattern } from "../src/ai/evaluation";

/**
 * FÁZA 5 (AI-first producer): a targeted section change may touch ONLY the
 * declared section — every other section's pattern stays content-identical,
 * scene/clip bindings survive, and a proposal that is never confirmed leaves
 * the project bit-for-bit unchanged. (Audition-first UI semantics: the
 * proposal exists, the command is the only writer.)
 */

const hashPattern = (doc: ReturnType<typeof testDoc>, pattern: { id: string }): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contentHash(canonicalizePattern(doc, pattern as never));

async function songDoc() {
  const doc = testDoc();
  const build = await buildSong(doc, normalizeIntent({ genre: "trap", seed: "f5", bpmRange: [140, 140] }), {
    yieldBetweenSections: false,
  });
  const base = build.resolvedBpm != null ? { ...doc, bpm: build.resolvedBpm } : doc;
  return applySongCommand(doc, build).execute(base);
}

describe("targeted section change — only the declared section moves", () => {
  it("a verse revision leaves every other pattern content-identical", async () => {
    const withSong = await songDoc();
    const dropScene = withSong.scenes.find((scene) => scene.role === "verse");
    expect(dropScene).toBeDefined();
    const outcome = reviseSection(withSong, "verse", "energy", 0.15);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const next = replacePatternInPlaceCommand(withSong, outcome.patternId, outcome.pattern).execute(withSong);

    const dropBefore = withSong.patterns.find((pattern) => pattern.id === dropScene!.patternId)!;
    const dropAfter = next.patterns.find((pattern) => pattern.id === dropScene!.patternId)!;
    expect(dropAfter.generation?.outputContentHash).not.toBe(dropBefore.generation?.outputContentHash);

    // Every OTHER pattern is content-identical.
    const otherBefore = withSong.patterns.filter((pattern) => pattern.id !== dropScene!.patternId);
    for (const before of otherBefore) {
      const after = next.patterns.find((candidate) => candidate.id === before.id)!;
      expect(after).toBeDefined();
      expect(hashPattern(withSong, after)).toBe(hashPattern(withSong, before));
    }
    // Scene bindings survive (same patternId on every scene).
    for (const scene of withSong.scenes) {
      expect(next.scenes.find((candidate) => candidate.id === scene.id)!.patternId).toBe(scene.patternId);
    }
  });

  it("an unconfirmed proposal leaves the project bit-for-bit unchanged", async () => {
    const withSong = await songDoc();
    const before = JSON.stringify(withSong);
    const outcome = reviseSection(withSong, "verse", "energy", 0.15);
    expect(outcome.ok).toBe(true);
    // The outcome exists (auditionable) but nothing executed.
    expect(JSON.stringify(withSong)).toBe(before);
  });

  it("the proposal keeps the in-place identity (id + seed) for audition truth", async () => {
    const withSong = await songDoc();
    const dropScene = withSong.scenes.find((scene) => scene.role === "verse")!;
    const before = withSong.patterns.find((pattern) => pattern.id === dropScene.patternId)!;
    const outcome = reviseSection(withSong, "verse", "energy", 0.15);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // What you heard (the proposal pattern) is EXACTLY what confirm applies:
    // same pattern id, same generation seed, new content.
    expect(outcome.patternId).toBe(dropScene.patternId);
    expect(outcome.pattern.id).toBe(dropScene.patternId);
    expect(outcome.pattern.generation?.seed).toBe(before.generation?.seed);
    expect(outcome.pattern.generation?.outputContentHash).not.toBe(before.generation?.outputContentHash);
  });
});
