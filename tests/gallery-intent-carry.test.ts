import { describe, expect, it } from "vitest";
import { intentSnapshotOfDoc, promptFromIntent, freshRegenSeed } from "../src/gallery/intentCarry";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { uid } from "../src/shared/ids";
import type { ProjectDocument } from "../src/project-model/types";

/** Stamp a document's patterns with intent provenance (as the engine does). */
function withIntents(
  doc: ProjectDocument,
  intents: Array<Record<string, unknown> | null>,
): ProjectDocument {
  return {
    ...doc,
    patterns: doc.patterns.map((p, i) =>
      intents[i] ? ({ ...p, intent: intents[i] } as typeof p) : p,
    ),
  };
}

/** The house template ships one pattern and a role-less scene — build a
    deterministic two-pattern + drop-scene fixture for the pick-order tests. */
function twoPatternDoc(): ProjectDocument {
  const base = createProjectFromTemplate("house");
  const patternB = { ...base.patterns[0]!, id: uid("pattern") };
  return {
    ...base,
    patterns: [...base.patterns, patternB],
    scenes: [{ ...base.scenes[0]!, role: "drop", patternId: patternB.id }] as ProjectDocument["scenes"],
  };
}

describe("intentSnapshotOfDoc", () => {
  it("prefers the DROP scene's pattern provenance (the beat's character)", () => {
    // Drop scene → pattern B (stamped trap); pattern A (house) sits first in
    // the array and must LOSE to the drop scene's pick.
    const doc = withIntents(twoPatternDoc(), [{ genre: "house", energy: 0.5 }, { genre: "trap", energy: 0.9 }]);
    const snapshot = intentSnapshotOfDoc(doc);
    expect((snapshot as { genre?: string } | null)?.genre).toBe("trap");
  });

  it("falls back to any pattern with provenance when no drop scene exists", () => {
    const base = createProjectFromTemplate("house");
    const doc = withIntents({ ...base, scenes: [] as ProjectDocument["scenes"] }, [
      { genre: "techno", energy: 0.8 },
    ]);
    const snapshot = intentSnapshotOfDoc(doc);
    expect((snapshot as { genre?: string } | null)?.genre).toBe("techno");
  });

  it("returns null for hand-programmed beats (no provenance) — not regenerable", () => {
    const doc = createProjectFromTemplate("house");
    expect(intentSnapshotOfDoc(doc)).toBeNull();
  });
});

describe("promptFromIntent", () => {
  it("builds a readable one-liner: genre, bpm ceiling, energy word, mood", () => {
    expect(promptFromIntent({ genre: "trap", bpmRange: [130, 145], energy: 0.9, mood: "dark" })).toBe(
      "trap 145 high energy dark",
    );
    expect(promptFromIntent({ genre: "ambient", bpmRange: [70, 80], energy: 0.2 })).toBe("ambient 80 chill");
    expect(promptFromIntent({ genre: "house", energy: 0.5 })).toBe("house");
  });

  it("never throws on junk snapshots", () => {
    expect(promptFromIntent({})).toBe("");
    expect(promptFromIntent({ genre: 42, bpmRange: "x", energy: "high" })).toBe("");
  });
});

describe("freshRegenSeed", () => {
  it("produces usable distinct seeds", () => {
    const a = freshRegenSeed();
    const b = freshRegenSeed();
    expect(a).toMatch(/^regen-/);
    expect(a).not.toBe(b);
  });
});
