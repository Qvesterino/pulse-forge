import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ProjectRepository } from "../src/persistence/ProjectRepository";
import { PresetRepository } from "../src/persistence/PresetRepository";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { InstrumentPreset } from "../src/presets/types";
import type { ProjectDocument } from "../src/project-model/types";

function freshProject(name: string): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  return { ...doc, name };
}

/** Save stamps `updatedAt` with wall-clock time — keep ordering tests deterministic. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("ProjectRepository", () => {
  const repo = new ProjectRepository();

  it("save + load round-trips a project", async () => {
    const doc = freshProject("Round Trip");
    await repo.save(doc);
    const loaded = await repo.load(doc.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(doc.id);
    expect(loaded!.name).toBe("Round Trip");
    expect(loaded!.bpm).toBe(doc.bpm);
  });

  it("load returns null for unknown ids", async () => {
    expect(await repo.load("does-not-exist")).toBeNull();
  });

  it("listAll returns metadata sorted by most recently updated", async () => {
    const a = freshProject("List A");
    const b = freshProject("List B");
    await repo.save(a);
    await tick();
    await repo.save(b);
    const list = await repo.listAll();
    const ids = list.map((m) => m.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    const meta = list.find((m) => m.id === a.id)!;
    expect(meta.name).toBe("List A");
    expect(meta.bpm).toBe(a.bpm);
    expect(meta.trackCount).toBe(a.tracks.length);
  });

  it("rename changes the name and keeps the project loadable", async () => {
    const doc = freshProject("Before Rename");
    await repo.save(doc);
    const renamed = await repo.rename(doc.id, "After Rename");
    expect(renamed!.name).toBe("After Rename");
    const loaded = await repo.load(doc.id);
    expect(loaded!.name).toBe("After Rename");
  });

  it("rename ignores blank names", async () => {
    const doc = freshProject("Keep Me");
    await repo.save(doc);
    const renamed = await repo.rename(doc.id, "   ");
    expect(renamed!.name).toBe("Keep Me");
  });

  it("rename returns null for unknown ids", async () => {
    expect(await repo.rename("missing", "X")).toBeNull();
  });

  it("duplicate copies content under a new id without stealing the recent pointer", async () => {
    const doc = freshProject("Original");
    await repo.save(doc);
    const copy = await repo.duplicate(doc.id);
    expect(copy).not.toBeNull();
    expect(copy!.id).not.toBe(doc.id);
    expect(copy!.name).toBe("Original (copy)");
    expect(copy!.tracks.length).toBe(doc.tracks.length);
    expect(copy!.patterns.length).toBe(doc.patterns.length);
    // The original remains the most recent project.
    const recent = await repo.loadMostRecent();
    expect(recent!.id).toBe(doc.id);
  });

  it("duplicate returns null for unknown ids", async () => {
    expect(await repo.duplicate("missing")).toBeNull();
  });

  it("delete removes the project and clears the recent pointer if it matched", async () => {
    const doc = freshProject("Doomed");
    await repo.save(doc);
    expect(await repo.load(doc.id)).not.toBeNull();
    await repo.delete(doc.id);
    expect(await repo.load(doc.id)).toBeNull();
    const recent = await repo.loadMostRecent();
    expect(recent?.id ?? null).not.toBe(doc.id);
  });

  it("loadMostRecent falls back to the newest remaining project when the recent one is deleted", async () => {
    const older = freshProject("Older Project");
    const newer = freshProject("Newer Project");
    await repo.save(older);
    await tick();
    await repo.save(newer);
    // Pointer now targets `newer`; deleting it must clear the pointer.
    await repo.delete(newer.id);
    const recent = await repo.loadMostRecent();
    expect(recent!.id).toBe(older.id);
  });
});

describe("PresetRepository", () => {
  const presets = new PresetRepository();

  const userPreset: InstrumentPreset = {
    id: "user-preset-1",
    name: "My Bass",
    instrument: "bass",
    genre: null,
    tags: ["user"],
    params: { sub: 0.5, body: 0.5 },
    user: true,
  };

  it("starts empty", async () => {
    const list = await presets.list();
    expect(list.find((p) => p.id === userPreset.id)).toBeUndefined();
  });

  it("save + list round-trips a user preset", async () => {
    await presets.save(userPreset);
    const list = await presets.list();
    const saved = list.find((p) => p.id === userPreset.id);
    expect(saved).toBeDefined();
    expect(saved!.name).toBe("My Bass");
    expect(saved!.user).toBe(true);
  });

  it("delete removes a user preset", async () => {
    await presets.save(userPreset);
    await presets.delete(userPreset.id);
    const list = await presets.list();
    expect(list.find((p) => p.id === userPreset.id)).toBeUndefined();
  });
});
