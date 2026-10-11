import { describe, expect, it } from "vitest";
import { parseSectionTransitionIntent } from "../src/intent/route";
import { reviseSectionTransitions, buildSong } from "../src/intent/song";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument, Scene, SceneRole } from "../src/project-model/types";

/**
 * STRUCTURAL ARRANGEMENT COMMANDS (2026-10-11) — "add a fill before every
 * chorus". Today's revisions knew energy/density/flow but had no grammar
 * for STRUCTURE: the transition treatments existed (the song builder bakes
 * them) yet natural language could not reach them. The parser reads the
 * boundary (transition kind + the role it leads into) and the handler
 * repaints every PREDECESSOR section's pattern with the treatment — one
 * undoable snapshot, kit-agnostic, honest when there is nothing to paint.
 */

describe("parseSectionTransitionIntent", () => {
  it("reads EN + SK fill/riser/break commands with the target role", () => {
    for (const [text, transition, role] of [
      ["add a fill before every chorus", "fill", "chorus"],
      ["add a riser into the drop", "riser", "drop"],
      ["pridaj break pred most", "break", "bridge"],
      ["add fill before the hook", "fill", "chorus"],
      ["pridaj riser pred kazdy drop", "riser", "drop"],
    ] as const) {
      const parsed = parseSectionTransitionIntent(text);
      expect(parsed, text).not.toBeNull();
      expect(parsed!.transition, text).toBe(transition);
      expect(parsed!.targetRole, text).toBe(role);
    }
  });

  it("ignores non-structural sentences and unmatched shapes", () => {
    expect(parseSectionTransitionIntent("make the bridge more energetic")).toBeNull();
    expect(parseSectionTransitionIntent("add a fill")).toBeNull(); // no role
    expect(parseSectionTransitionIntent("add reverb before the chorus")).toBeNull(); // no transition kind
    expect(parseSectionTransitionIntent("dense trap beat")).toBeNull();
  });
});

describe("reviseSectionTransitions", () => {
  /** A doc with a linear scene chain: intro → verse → chorus → verse → chorus. */
  function songDoc(): ProjectDocument {
    const roles: SceneRole[] = ["intro", "verse", "chorus", "verse", "chorus"];
    const base = testDoc();
    const scenes: Scene[] = roles.map((role, index) => ({
      ...base.scenes[0],
      id: `scene-${index}`,
      name: `${role} ${index}`,
      role,
      patternId: `pattern-${index}`,
    }));
    const patterns = roles.map((_, index) => ({
      ...base.patterns[0],
      id: `pattern-${index}`,
      rows: {},
      notes: {},
    }));
    return { ...base, scenes, patterns, activePatternId: "pattern-0" };
  }

  it("paints EVERY predecessor of the target role as one command", async () => {
    const doc = songDoc();
    const build = await buildSong(doc, { genre: "rock", seed: "fill-e2e", length: 64 });
    void build;
    const full = songDoc();
    // Simulate a built song: give every pattern drum rows from the builder.
    const outcome = reviseSectionTransitions(full, "chorus", "fill");
    expect(outcome.ok, outcome.error ?? "ok").toBe(true);
    expect(outcome.command, "one undoable command").toBeDefined();
    // Two chorus scenes → both predecessors (verse@1 and verse@3) painted.
    const applied = outcome.command!.execute(full);
    const verse2Pattern = applied.patterns.find((p) => p.id === "pattern-1")!;
    const verse4Pattern = applied.patterns.find((p) => p.id === "pattern-3")!;
    const lastBarHits = (pattern: typeof verse2Pattern) => {
      const from = Math.max(0, pattern.stepCount - 16);
      return Object.values(pattern.rows).reduce(
        (sum, row) => sum + row.slice(from, pattern.stepCount).filter((v) => v > 0).length,
        0,
      );
    };
    expect(lastBarHits(verse2Pattern), "predecessor 1 carries the fill").toBeGreaterThan(0);
    expect(lastBarHits(verse4Pattern), "predecessor 2 carries the fill").toBeGreaterThan(0);
    // The chorus patterns themselves stay untouched.
    const chorusPattern = applied.patterns.find((p) => p.id === "pattern-2")!;
    expect(lastBarHits(chorusPattern)).toBe(0);
    // Undo restores.
    const undone = outcome.command!.undo(applied);
    expect(lastBarHits(undone.patterns.find((p) => p.id === "pattern-1")!)).toBe(0);
  });

  it("is honest when there is nothing to paint (first-scene role)", () => {
    const doc = songDoc();
    const outcome = reviseSectionTransitions(doc, "intro", "fill");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/nothing to paint/);
  });
});
