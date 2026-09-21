import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { encodeShareCode } from "../src/export/shareCode";
import { intentSnapshotOfDoc } from "../src/gallery/intentCarry";
import { decodeShareCodeMeta } from "../server/collab-server.mjs";
import type { Pattern, ProjectDocument } from "../src/project-model/types";
import type { PatternGeneration } from "../src/project-model/types";

/**
 * Gallery intent-metadata CONTRACT (GOAL 06): the collab server (plain JS)
 * and the studio client (TS) independently read intent provenance from the
 * same untyped share-code JSON. A drift between the two readers is invisible
 * until a feed card and the studio disagree — this matrix pins both sides to
 * identical verdicts on every provenance shape:
 *   - engine writer shape  `pattern.generation.intent` (attachProvenance)
 *   - legacy top-level     `pattern.intent` (pre-reader-fix fixtures)
 *   - junk / absent shapes must read as not-regenerable everywhere.
 */

function docWithPattern(pattern: Partial<Pattern>): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  return { ...doc, patterns: [{ ...doc.patterns[0]!, ...pattern } as Pattern] };
}

const INTENT = { genre: "trap", energy: 0.9, density: 0.6, seed: "abc", bpmRange: [130, 145] };

const FIXTURES: Array<{ name: string; pattern: Partial<Pattern>; genre: string | null; regenerable: boolean }> = [
  {
    name: "engine writer shape (generation.intent)",
    pattern: { generation: { intent: INTENT } as PatternGeneration },
    genre: "trap",
    regenerable: true,
  },
  {
    name: "legacy top-level shape (pattern.intent)",
    pattern: { intent: INTENT } as Partial<Pattern>,
    genre: "trap",
    regenerable: true,
  },
  {
    name: "both shapes present — generation wins",
    pattern: { generation: { intent: INTENT } as PatternGeneration, intent: { genre: "house" } } as Partial<Pattern>,
    genre: "trap",
    regenerable: true,
  },
  {
    name: "intent without a valid genre string — regenerable, no genre",
    pattern: { generation: { intent: { energy: 0.5 } } as PatternGeneration },
    genre: null,
    regenerable: true,
  },
  {
    name: "genre that fails the server slug check — client may read it, server must not",
    pattern: { generation: { intent: { genre: "Not A Slug!" } } as PatternGeneration },
    genre: null,
    regenerable: true,
  },
  {
    name: "no provenance at all — hand-made beat",
    pattern: {},
    genre: null,
    regenerable: false,
  },
];

describe("gallery intent metadata — server/client contract", () => {
  for (const fixture of FIXTURES) {
    it(`agrees on: ${fixture.name}`, () => {
      const doc = docWithPattern(fixture.pattern);
      const code = encodeShareCode(doc);

      // Server side (gallery card metadata).
      const meta = decodeShareCodeMeta(code);
      expect(meta, fixture.name).not.toBeNull();
      expect(meta.regenerable, fixture.name).toBe(fixture.regenerable);
      expect(meta.genre, fixture.name).toBe(fixture.genre);

      // Client side (studio regen carry / embed CTA verdicts).
      const snapshot = intentSnapshotOfDoc(doc);
      expect(snapshot !== null, fixture.name).toBe(fixture.regenerable);
      const clientGenre =
        snapshot && typeof snapshot.genre === "string" && /^[a-z0-9-]{1,24}$/.test(snapshot.genre)
          ? snapshot.genre
          : null;
      expect(clientGenre, fixture.name).toBe(fixture.genre);
    });
  }

  it("both readers reject junk codes/docs identically", () => {
    expect(decodeShareCodeMeta("not-a-code")).toBeNull();
    expect(intentSnapshotOfDoc(null as unknown as ProjectDocument)).toBeNull();
    expect(intentSnapshotOfDoc({} as unknown as ProjectDocument)).toBeNull();
  });
});
