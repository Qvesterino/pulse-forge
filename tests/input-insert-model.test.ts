import { describe, expect, it } from "vitest";

/**
 * v22 — per-track `inputInsert`: the model half of the input-insert chain in
 * docs/IMPLEMENTATION-ROADMAP-INPUT-FX-CAB.md (Phase 3).
 *
 * This file asserts the MODEL contract only. Nothing here builds audio nodes,
 * routes a monitoring signal or changes the recorder — the engine half is Phase
 * 4. What is pinned here is the promise the UI would make to a user:
 *
 *   - an absent `inputInsert` means dry monitoring and is the default,
 *   - the chain survives normalize/migrate round-trips (a project that loses its
 *     cabinet when reopened is the bug this whole phase exists to prevent),
 *   - every mutation is one undo step, and undoing back to "no insert" removes
 *     the field rather than leaving an empty husk,
 *   - a group track cannot own an insert, because it has no armed input.
 */
import { createDefaultProject, migrateProject, normalizeProject, SCHEMA_VERSION } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addInputEffect,
  clearInputInsert,
  createGroupTrack,
  inputEffectsOf,
  inputInsertOf,
  setInputInsertMode,
} from "../src/commands/tracks";
import type { ProjectDocument } from "../src/project-model/types";

function firstTrackId(doc: ProjectDocument): string {
  const id = doc.tracks[0]?.id;
  if (!id) throw new Error("default project has no tracks");
  return id;
}

function withGroupTrack(doc: ProjectDocument): ProjectDocument {
  return createGroupTrack(doc).execute(doc) as ProjectDocument;
}

describe("v22 inputInsert — absent is dry monitoring", () => {
  it("a fresh project has no insert chain on any track", () => {
    const doc = createDefaultProject();
    for (const track of doc.tracks) {
      expect("inputInsert" in track).toBe(false);
    }
    expect(inputEffectsOf(doc, firstTrackId(doc))).toEqual([]);
  });

  it("a document from the previous schema migrates without inventing an insert", () => {
    const doc = createDefaultProject();
    const legacy = { ...doc, schemaVersion: SCHEMA_VERSION - 1 } as ProjectDocument;
    const migrated = migrateProject(legacy);

    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    for (const track of migrated.tracks) {
      expect("inputInsert" in track).toBe(false);
    }
  });
});

describe("v22 inputInsert — mode", () => {
  it("defaults to raw on first write, which is the ADR 0014 §3 contract", () => {
    const doc = createDefaultProject();
    const trackId = firstTrackId(doc);
    const next = setInputInsertMode(doc, trackId, "raw").execute(doc) as ProjectDocument;

    expect(inputInsertOf(next, trackId)).toEqual({ mode: "raw", effects: [] });
  });

  it("raw and baked both survive a normalize round-trip", () => {
    for (const mode of ["raw", "baked"] as const) {
      const doc = createDefaultProject();
      const trackId = firstTrackId(doc);
      const stored = setInputInsertMode(doc, trackId, mode).execute(doc) as ProjectDocument;
      const reopened = normalizeProject(stored);

      expect(inputInsertOf(reopened, trackId)?.mode).toBe(mode);
    }
  });

  it("the insert is independent per track", () => {
    const doc = createDefaultProject();
    const a = firstTrackId(doc);
    const b = doc.tracks[1]?.id;
    if (!b) throw new Error("default project needs a second track");

    const next = setInputInsertMode(doc, a, "baked").execute(doc) as ProjectDocument;
    expect(inputInsertOf(next, a)?.mode).toBe("baked");
    expect(inputInsertOf(next, b)).toBeUndefined();
  });
});

describe("v22 inputInsert — undo and clearing", () => {
  it("one undo returns to no insert at all, with the field removed", () => {
    const doc = createDefaultProject();
    const trackId = firstTrackId(doc);
    const store = new ProjectStore(doc);

    store.execute(setInputInsertMode(doc, trackId, "baked"));
    expect(inputInsertOf(store.doc, trackId)).toBeDefined();

    store.undo();
    expect(inputInsertOf(store.doc, trackId)).toBeUndefined();
    expect("inputInsert" in (store.doc.tracks[0] ?? {})).toBe(false);

    store.redo();
    expect(inputInsertOf(store.doc, trackId)?.mode).toBe("baked");
  });

  it("clearing drops the field rather than leaving an empty insert", () => {
    const doc = createDefaultProject();
    const trackId = firstTrackId(doc);
    const store = new ProjectStore(doc);

    store.execute(setInputInsertMode(doc, trackId, "raw"));
    store.execute(clearInputInsert(store.doc, trackId));

    expect(inputInsertOf(store.doc, trackId)).toBeUndefined();

    store.undo();
    expect(inputInsertOf(store.doc, trackId)?.mode).toBe("raw");
  });
});

describe("v22 inputInsert — effect lifecycle", () => {
  it("adds an input effect that survives reload, and undo removes it", () => {
    const doc = createDefaultProject();
    const trackId = firstTrackId(doc);
    const store = new ProjectStore(doc);

    const cmd = addInputEffect(store.doc, trackId, "ozvena");
    store.execute(cmd);
    expect(cmd.effectId).toBeTruthy();

    const effects = inputEffectsOf(store.doc, trackId);
    expect(effects).toHaveLength(1);
    expect(effects[0]?.id).toBe(cmd.effectId);

    const reopened = normalizeProject(store.doc);
    expect(inputEffectsOf(reopened, trackId)[0]?.id).toBe(cmd.effectId);

    store.undo();
    expect(inputEffectsOf(store.doc, trackId)).toEqual([]);
    // The chain itself survives the undo — only the effect is gone.
    expect(inputInsertOf(store.doc, trackId)?.mode).toBe("raw");
  });

  it("editing the chain clears the whole-chain preset identity", () => {
    const doc = createDefaultProject();
    const trackId = firstTrackId(doc);
    const withPreset = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === trackId ? { ...t, inputInsert: { mode: "raw", effects: [], presetId: "cab-v1" } } : t,
      ),
    } as ProjectDocument;

    const next = addInputEffect(withPreset, trackId, "ozvena").execute(withPreset) as ProjectDocument;
    expect(inputInsertOf(next, trackId)?.presetId).toBeNull();
  });
});

describe("v22 inputInsert — group tracks are refused", () => {
  it("a group track has no armed input, so setting a mode throws instead of writing", () => {
    const doc = withGroupTrack(createDefaultProject());
    const group = doc.tracks.find((t) => t.kind === "group");
    if (!group) throw new Error("expected a group track");

    expect(() => setInputInsertMode(doc, group.id, "raw")).toThrow(/no armed audio input/i);
    expect(inputInsertOf(doc, group.id)).toBeUndefined();
  });

  it("an unknown track id throws rather than silently creating a new track", () => {
    const doc = createDefaultProject();
    expect(() => setInputInsertMode(doc, "track-does-not-exist", "raw")).toThrow(/no armed audio input/i);
  });
});
