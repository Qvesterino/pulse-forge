import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ProjectRepository } from "../../src/persistence/ProjectRepository";
import { TEMPLATES, createProjectFromTemplate } from "../../src/project-model/templates";
import { migrateProject, normalizeProject } from "../../src/project-model/schema";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * Project persistence & data integrity audit.
 *
 * Required invariants, exercised over EVERY shipped template (the widest
 * doc-shape variety available without hand-authored fixtures):
 *
 *  1. saving then loading preserves semantically identical project state
 *     (deep equality, not just id/name/bpm);
 *  2. normalization is idempotent — healing a doc twice is a no-op the
 *     second time, so a persisted doc re-loaded from disk never mutates;
 *  3. migration is deterministic and idempotent for current-version docs;
 *  4. corrupted input heals to a stable doc (heal → heal is identity) and
 *     survives a save/load cycle without further change.
 *
 * `createdAt`/`updatedAt` are creation/stamp metadata — `repo.save()` re-stamps
 * `updatedAt` on every write by design, so both are stripped before comparing.
 */

const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

function stripStamps(doc: ProjectDocument): Record<string, unknown> {
  const { createdAt, updatedAt, ...rest } = doc as unknown as Record<string, unknown>;
  void createdAt;
  void updatedAt;
  return rest;
}

describe("persistence integrity — deep save/load round-trip", () => {
  it("save → load preserves the full project state for every template", async () => {
    const repo = new ProjectRepository();
    for (const id of TEMPLATE_IDS) {
      const doc = createProjectFromTemplate(id);
      await repo.save(doc);
      const loaded = await repo.load(doc.id);
      expect(stripStamps(loaded!), `template ${id} must round-trip deeply`).toEqual(stripStamps(doc));
    }
  });

  it("save → load of a loaded doc is a fixed point (load(load(doc)) does not change)", async () => {
    const repo = new ProjectRepository();
    const doc = createProjectFromTemplate("scene-score");
    await repo.save(doc);
    const first = (await repo.load(doc.id))!;
    await repo.save(first);
    const second = await repo.load(first.id);
    expect(stripStamps(second!)).toEqual(stripStamps(first));
  });
});

describe("persistence integrity — normalizeProject idempotency", () => {
  it("normalize(normalize(doc)) deep-equals normalize(doc) for every template", () => {
    for (const id of TEMPLATE_IDS) {
      const once = normalizeProject(createProjectFromTemplate(id));
      const twice = normalizeProject(once);
      expect(twice, `template ${id} must be a normalize fixed point`).toEqual(once);
    }
  });
});

describe("persistence integrity — migrateProject determinism", () => {
  it("migrating twice is identical to migrating once (current-version docs)", () => {
    for (const id of TEMPLATE_IDS) {
      const doc = createProjectFromTemplate(id);
      const once = migrateProject(doc);
      const twice = migrateProject(once);
      expect(twice, `template ${id} migration must be idempotent`).toEqual(once);
    }
  });

  it("migrateProject is deterministic for the same valid input", () => {
    const doc = createProjectFromTemplate("house");
    // Already-normalized input contains every id, so two migrations cannot
    // invent fresh uid()s — they must agree exactly.
    const stable = normalizeProject(doc);
    expect(migrateProject(stable)).toEqual(migrateProject(stable));
  });
});

describe("persistence integrity — corruption healing", () => {
  it("heals garbage input to a stable doc that survives a save/load cycle", async () => {
    const repo = new ProjectRepository();
    const doc = createProjectFromTemplate("house") as unknown as Record<string, unknown>;
    const track = (doc.tracks as Record<string, unknown>[])[0];
    (track.effects as unknown[]).push({ id: "fx-bad", type: "not-a-real-effect", bypassed: false, params: {} });
    doc.bpm = -999; // below MIN_BPM → clamped
    doc.activePatternId = "pattern-does-not-exist"; // dangling → first pattern

    const healed = normalizeProject(doc as unknown as ProjectDocument);
    // Healing must reach a fixed point: a second pass changes nothing.
    expect(normalizeProject(healed)).toEqual(healed);
    // And the healed doc must persist identically.
    await repo.save(healed);
    const loaded = await repo.load(healed.id);
    expect(stripStamps(loaded!)).toEqual(stripStamps(healed));
  });

  it("JSON serialize/parse (share-code/export shape) round-trips normalized state", () => {
    for (const id of TEMPLATE_IDS) {
      const doc = createProjectFromTemplate(id);
      const parsed = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
      const normalized = normalizeProject(parsed);
      expect(normalized, `template ${id} must survive a JSON boundary`).toEqual(doc);
    }
  });
});
