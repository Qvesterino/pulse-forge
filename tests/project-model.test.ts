import { describe, expect, it } from "vitest";
import {
  MAX_BPM,
  MIN_BPM,
  SCHEMA_VERSION,
  createDefaultProject,
  migrateProject,
  normalizeProject,
  validateProjectShape,
} from "../src/project-model/schema";
import { PPQ, STEPS_PER_PATTERN } from "../src/project-model/types";
import type { ProjectDocument } from "../src/project-model/types";

function minimalDoc(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  const base = createDefaultProject();
  return { ...base, ...overrides };
}

describe("normalizeProject — base shape", () => {
  it("is a no-op on a freshly created project (deep equality)", () => {
    const doc = createDefaultProject();
    const normalized = normalizeProject(doc);
    expect(normalized).toStrictEqual(doc);
  });

  it("round-trips through JSON without changing identity fields", () => {
    const doc = createDefaultProject();
    const round = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
    const normalized = normalizeProject(round);
    expect(normalized.id).toBe(doc.id);
    expect(normalized.name).toBe(doc.name);
    expect(normalized.bpm).toBe(doc.bpm);
    expect(normalized.tracks).toHaveLength(doc.tracks.length);
    expect(normalized.patterns).toHaveLength(doc.patterns.length);
    expect(normalized.activePatternId).toBe(doc.activePatternId);
  });
});

describe("normalizeProject — timeSignature", () => {
  it("repairs a missing timeSignature to 4/4", () => {
    const doc = { ...createDefaultProject(), timeSignature: undefined } as unknown as ProjectDocument;
    const normalized = normalizeProject(doc);
    expect(normalized.timeSignature).toEqual({ numerator: 4, denominator: 4 });
  });

  it("repairs a timeSignature with non-positive numerator or denominator", () => {
    const doc = createDefaultProject();
    for (const broken of [
      { numerator: 0, denominator: 4 },
      { numerator: 4, denominator: 0 },
      { numerator: -2, denominator: 4 },
      { numerator: 4, denominator: -4 },
      { numerator: 4.5, denominator: 4 },
    ]) {
      const modified = { ...doc, timeSignature: broken } as ProjectDocument;
      const normalized = normalizeProject(modified);
      expect(normalized.timeSignature).toEqual({ numerator: 4, denominator: 4 });
    }
  });

  it("repairs a non-object timeSignature", () => {
    const doc = createDefaultProject();
    for (const broken of [null, 4, "4/4", true]) {
      const modified = { ...doc, timeSignature: broken } as unknown as ProjectDocument;
      const normalized = normalizeProject(modified);
      expect(normalized.timeSignature).toEqual({ numerator: 4, denominator: 4 });
    }
  });

  it("keeps a valid timeSignature", () => {
    const doc = createDefaultProject();
    const modified = { ...doc, timeSignature: { numerator: 3, denominator: 4 } } as ProjectDocument;
    const normalized = normalizeProject(modified);
    expect(normalized.timeSignature).toEqual({ numerator: 3, denominator: 4 });
  });
});

describe("normalizeProject — bpm", () => {
  it("clamps bpm below the minimum to MIN_BPM", () => {
    const doc = minimalDoc({ bpm: 5 });
    const normalized = normalizeProject(doc);
    expect(normalized.bpm).toBe(MIN_BPM);
  });

  it("clamps bpm above the maximum to MAX_BPM", () => {
    const doc = minimalDoc({ bpm: 9999 });
    const normalized = normalizeProject(doc);
    expect(normalized.bpm).toBe(MAX_BPM);
  });

  it("falls back to 120 when bpm is not a finite number", () => {
    const doc = minimalDoc({ bpm: Number.NaN });
    const normalized = normalizeProject(doc);
    expect(normalized.bpm).toBe(120);
  });

  it("keeps a valid bpm unchanged", () => {
    const doc = minimalDoc({ bpm: 124 });
    const normalized = normalizeProject(doc);
    expect(normalized.bpm).toBe(124);
  });
});

describe("normalizeProject — active pattern", () => {
  it("repairs an activePatternId that points to a missing pattern", () => {
    const doc = minimalDoc({ activePatternId: "pattern-does-not-exist" });
    const normalized = normalizeProject(doc);
    expect(normalized.activePatternId).toBe(doc.patterns[0].id);
  });

  it("keeps the active pattern when it exists", () => {
    const doc = createDefaultProject();
    const normalized = normalizeProject(doc);
    expect(normalized.activePatternId).toBe(doc.activePatternId);
  });
});

describe("normalizeProject — scenes", () => {
  it("creates a default scene when scenes are missing", () => {
    const doc = { ...createDefaultProject(), scenes: undefined } as unknown as ProjectDocument;
    const normalized = normalizeProject(doc);
    expect(normalized.scenes).toHaveLength(1);
    expect(normalized.scenes[0].patternId).toBe(normalized.activePatternId);
  });

  it("creates a default scene when scenes is an empty array", () => {
    const doc = minimalDoc({ scenes: [] });
    const normalized = normalizeProject(doc);
    expect(normalized.scenes.length).toBeGreaterThan(0);
    expect(normalized.scenes[0].patternId).toBe(normalized.activePatternId);
  });

  it("drops scenes that reference missing patterns and falls back if empty", () => {
    const doc = minimalDoc();
    const dangling = { ...doc, scenes: [{ id: "scene-orphan", name: "Orphan", patternId: "pattern-gone" }] };
    const normalized = normalizeProject(dangling);
    expect(normalized.scenes.find((s) => s.id === "scene-orphan")).toBeUndefined();
    expect(normalized.scenes.length).toBeGreaterThan(0);
    expect(normalized.scenes[0].patternId).toBe(normalized.activePatternId);
  });

  it("keeps well-formed scenes", () => {
    const doc = createDefaultProject();
    const normalized = normalizeProject(doc);
    expect(normalized.scenes).toEqual(doc.scenes);
  });
});

describe("normalizeProject — arrangement, automation, lfos", () => {
  it("creates an empty arrangement when missing", () => {
    const doc = { ...createDefaultProject(), arrangement: undefined } as unknown as ProjectDocument;
    const normalized = normalizeProject(doc);
    expect(normalized.arrangement.clips).toEqual([]);
  });

  it("sorts arrangement clips by startBar and drops invalid ones", () => {
    const doc = minimalDoc();
    const sceneIds = doc.scenes.map((s) => s.id);
    const [firstScene] = sceneIds;
    const clips = [
      { id: "clip-b", sceneId: firstScene!, startBar: 8, lengthBars: 4 },
      { id: "clip-a", sceneId: firstScene!, startBar: 0, lengthBars: 2 },
      { id: "clip-bad", sceneId: "scene-missing", startBar: 16, lengthBars: 2 },
      { id: "clip-neg", sceneId: firstScene!, startBar: -1, lengthBars: 2 },
    ];
    const modified = { ...doc, arrangement: { clips } };
    const normalized = normalizeProject(modified);
    expect(normalized.arrangement.clips.map((c) => c.id)).toEqual(["clip-a", "clip-b"]);
  });

  it("creates empty automation and lfos when missing", () => {
    const doc = {
      ...createDefaultProject(),
      automation: undefined,
      lfos: undefined,
    } as unknown as ProjectDocument;
    const normalized = normalizeProject(doc);
    expect(normalized.automation).toEqual([]);
    expect(normalized.lfos).toEqual([]);
  });

  it("drops automation lanes whose trackId no longer exists", () => {
    const doc = createDefaultProject();
    const trackId = doc.tracks[0].id;
    const withLane = {
      ...doc,
      automation: [
        { id: "lane-1", target: { kind: "trackGain" as const, trackId }, points: [] },
        { id: "lane-2", target: { kind: "trackGain" as const, trackId: "track-orphan" }, points: [] },
      ],
    };
    const normalized = normalizeProject(withLane);
    expect(normalized.automation.map((l) => l.id)).toEqual(["lane-1"]);
  });

  it("drops LFOs whose trackId no longer exists", () => {
    const doc = createDefaultProject();
    const trackId = doc.tracks[0].id;
    const lfo = {
      id: "lfo-1",
      trackId,
      param: "gain" as const,
      wave: "sine" as const,
      rateMode: "sync" as const,
      rateHz: 2,
      division: 2,
      amount: 0.3,
    };
    const withLfos = {
      ...doc,
      lfos: [lfo, { ...lfo, id: "lfo-2", trackId: "track-orphan" }],
    };
    const normalized = normalizeProject(withLfos);
    expect(normalized.lfos.map((l) => l.id)).toEqual(["lfo-1"]);
  });
});

describe("normalizeProject — macros, returns, master", () => {
  it("creates default macros when missing or empty", () => {
    const doc = { ...createDefaultProject(), macros: undefined } as unknown as ProjectDocument;
    const normalized = normalizeProject(doc);
    expect(normalized.macros.length).toBeGreaterThan(0);
  });

  it("creates default returns when missing", () => {
    const doc = { ...createDefaultProject(), returns: undefined } as unknown as ProjectDocument;
    const normalized = normalizeProject(doc);
    expect(normalized.returns.length).toBeGreaterThan(0);
  });

  it("creates default master when missing", () => {
    const doc = { ...createDefaultProject(), master: undefined } as unknown as ProjectDocument;
    const normalized = normalizeProject(doc);
    expect(normalized.master).toEqual({ limiterEnabled: true, clipperEnabled: false });
  });
});

describe("normalizeProject — pattern rows and notes", () => {
  it("repairs a pattern row that has the wrong length", () => {
    const doc = createDefaultProject();
    const pattern = doc.patterns[0];
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    const padId = drum.pads[0].id;
    const broken = {
      ...doc,
      patterns: [
        {
          ...pattern,
          rows: { ...pattern.rows, [padId]: [0.1, 0.2, 0.3] },
        },
      ],
    };
    const normalized = normalizeProject(broken);
    expect(normalized.patterns[0].rows[padId]).toHaveLength(pattern.stepCount);
    expect(normalized.patterns[0].rows[padId][0]).toBeCloseTo(0.1, 5);
    expect(normalized.patterns[0].rows[padId][3]).toBe(0);
  });

  it("drops pattern notes for tracks that no longer exist", () => {
    const doc = createDefaultProject();
    const pattern = doc.patterns[0];
    const instrument = doc.tracks.find((t) => t.kind === "instrument")!;
    const survivingNotes = (pattern.notes?.[instrument.id] ?? []).map((n) => ({ ...n }));
    const modified = {
      ...doc,
      patterns: [
        {
          ...pattern,
          notes: {
            [instrument.id]: survivingNotes,
            "track-orphan": [{ id: "note-x", pitch: 60, start: 0, duration: PPQ, velocity: 0.5 }],
          },
        },
      ],
    };
    const normalized = normalizeProject(modified);
    expect(normalized.patterns[0].notes[instrument.id]).toEqual(survivingNotes);
    expect(normalized.patterns[0].notes["track-orphan"]).toBeUndefined();
  });

  it("repairs stepCount when invalid (zero, negative, non-finite)", () => {
    const doc = createDefaultProject();
    const pattern = doc.patterns[0];
    for (const broken of [0, -3, Number.NaN]) {
      const modified = { ...doc, patterns: [{ ...pattern, stepCount: broken }] };
      const normalized = normalizeProject(modified);
      expect(normalized.patterns[0].stepCount).toBe(STEPS_PER_PATTERN);
    }
  });

  it("drops pattern rows whose padId no longer exists in any drum track", () => {
    const doc = createDefaultProject();
    const pattern = doc.patterns[0];
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    const padId = drum.pads[0].id;
    const originalRow = pattern.rows[padId];
    const modified = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.kind === "drum" ? { ...t, pads: t.pads.filter((p) => p.id !== padId) } : t,
      ),
      patterns: [
        {
          ...pattern,
          rows: {
            ...pattern.rows,
            [padId]: originalRow,
            "row-orphan": [0.1, 0.2],
          },
        },
      ],
    };
    const normalized = normalizeProject(modified);
    expect(normalized.patterns[0].rows[padId]).toBeUndefined();
    expect(normalized.patterns[0].rows["row-orphan"]).toBeUndefined();
  });
});

describe("normalizeProject — tracks", () => {
  it("adds empty effects to a drum track missing the field", () => {
    const doc = createDefaultProject();
    const modified = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.kind === "drum" ? { ...t, effects: undefined } : t)),
    } as unknown as ProjectDocument;
    const normalized = normalizeProject(modified);
    expect(normalized.tracks.find((t) => t.kind === "drum")!.effects).toEqual([]);
  });

  it("adds default params to an instrument track missing the field", () => {
    const doc = createDefaultProject();
    const modified = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.kind === "instrument" ? { ...t, params: undefined as unknown as Record<string, number> } : t,
      ),
    };
    const normalized = normalizeProject(modified);
    const inst = normalized.tracks.find((t) => t.kind === "instrument")!;
    if (inst.kind !== "instrument") throw new Error("expected instrument");
    expect(inst.params).toBeDefined();
    expect(Object.keys(inst.params).length).toBeGreaterThan(0);
  });

  it("merges missing instrument params with current ones", () => {
    const doc = createDefaultProject();
    const modified = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.kind === "instrument" ? { ...t, params: { ...t.params, decay: 2 } } : t,
      ),
    };
    const normalized = normalizeProject(modified);
    const inst = normalized.tracks.find((t) => t.kind === "instrument")!;
    if (inst.kind !== "instrument") throw new Error("expected instrument");
    expect(inst.params.decay).toBe(2);
    expect(Object.keys(inst.params).length).toBeGreaterThan(1);
  });

  it("adds empty sends to any track missing the field", () => {
    const doc = createDefaultProject();
    const modified = {
      ...doc,
      tracks: doc.tracks.map((t) => ({ ...t, sends: undefined as unknown as Record<string, number> })),
    };
    const normalized = normalizeProject(modified);
    for (const track of normalized.tracks) {
      expect(track.sends).toEqual({});
    }
  });
});

describe("normalizeProject — timestamps", () => {
  it("repairs missing createdAt/updatedAt with the current time", () => {
    const doc = {
      ...createDefaultProject(),
      createdAt: undefined,
      updatedAt: undefined,
    } as unknown as ProjectDocument;
    const before = Date.now();
    const normalized = normalizeProject(doc);
    const after = Date.now();
    const created = Date.parse(normalized.createdAt);
    const updated = Date.parse(normalized.updatedAt);
    expect(Number.isFinite(created)).toBe(true);
    expect(Number.isFinite(updated)).toBe(true);
    expect(created).toBeGreaterThanOrEqual(before - 5);
    expect(created).toBeLessThanOrEqual(after + 5);
  });

  it("keeps existing timestamps when they are valid strings", () => {
    const doc = createDefaultProject();
    const stamped = "2024-01-01T00:00:00.000Z";
    const modified = { ...doc, createdAt: stamped, updatedAt: stamped };
    const normalized = normalizeProject(modified);
    expect(normalized.createdAt).toBe(stamped);
    expect(normalized.updatedAt).toBe(stamped);
  });
});

describe("migrateProject", () => {
  it("normalizes without rewriting when schemaVersion already matches", () => {
    const doc = createDefaultProject();
    const migrated = migrateProject(doc);
    expect(migrated).toStrictEqual(doc);
  });

  it("rewrites schemaVersion to the current value when it is older", () => {
    const doc = createDefaultProject();
    const older = { ...doc, schemaVersion: 0 } as ProjectDocument;
    const migrated = migrateProject(older);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("throws on a schemaVersion newer than supported", () => {
    const doc = createDefaultProject();
    const newer = { ...doc, schemaVersion: SCHEMA_VERSION + 5 } as ProjectDocument;
    expect(() => migrateProject(newer)).toThrow(/newer than supported/);
  });

  it("repairs a minimal project loaded from older storage with missing fields", () => {
    const doc = createDefaultProject();
    const { id, name, bpm, tracks, patterns, activePatternId, schemaVersion } = doc;
    const partial = { id, name, bpm, tracks, patterns, activePatternId, schemaVersion } as unknown as ProjectDocument;
    const migrated = migrateProject(partial);
    expect(migrated.scenes.length).toBeGreaterThan(0);
    expect(migrated.arrangement).toBeDefined();
    expect(migrated.automation).toEqual([]);
    expect(migrated.lfos).toEqual([]);
    expect(migrated.macros.length).toBeGreaterThan(0);
    expect(migrated.returns.length).toBeGreaterThan(0);
    expect(migrated.master).toBeDefined();
    expect(migrated.createdAt).toBeTruthy();
    expect(migrated.updatedAt).toBeTruthy();
  });
});

describe("validateProjectShape", () => {
  it("accepts a fresh default project", () => {
    expect(validateProjectShape(createDefaultProject())).toBe(true);
  });

  it("rejects null and primitives", () => {
    expect(validateProjectShape(null)).toBe(false);
    expect(validateProjectShape(undefined)).toBe(false);
    expect(validateProjectShape(42)).toBe(false);
    expect(validateProjectShape("string")).toBe(false);
  });

  it("rejects a project missing required identity fields", () => {
    const doc = createDefaultProject() as unknown as Record<string, unknown>;
    expect(validateProjectShape({ ...doc, id: undefined })).toBe(false);
    expect(validateProjectShape({ ...doc, bpm: undefined })).toBe(false);
    expect(validateProjectShape({ ...doc, tracks: undefined })).toBe(false);
    expect(validateProjectShape({ ...doc, activePatternId: undefined })).toBe(false);
  });

  it("rejects a non-integer or non-positive timeSignature", () => {
    const doc = createDefaultProject() as unknown as Record<string, unknown>;
    for (const broken of [
      { numerator: 0, denominator: 4 },
      { numerator: 4, denominator: 0 },
      { numerator: -2, denominator: 4 },
      { numerator: 4.5, denominator: 4 },
      { numerator: "4", denominator: 4 },
    ]) {
      expect(validateProjectShape({ ...doc, timeSignature: broken })).toBe(false);
    }
  });

  it("accepts a valid timeSignature", () => {
    const doc = createDefaultProject() as unknown as Record<string, unknown>;
    expect(validateProjectShape({ ...doc, timeSignature: { numerator: 3, denominator: 4 } })).toBe(true);
  });

  it("rejects non-array optional collections when present", () => {
    const doc = createDefaultProject() as unknown as Record<string, unknown>;
    expect(validateProjectShape({ ...doc, scenes: "not-array" })).toBe(false);
    expect(validateProjectShape({ ...doc, automation: { 0: "x" } })).toBe(false);
    expect(validateProjectShape({ ...doc, lfos: 42 })).toBe(false);
    expect(validateProjectShape({ ...doc, macros: null })).toBe(false);
    expect(validateProjectShape({ ...doc, returns: true })).toBe(false);
  });

  it("rejects a non-object master or arrangement", () => {
    const doc = createDefaultProject() as unknown as Record<string, unknown>;
    expect(validateProjectShape({ ...doc, master: "off" })).toBe(false);
    expect(validateProjectShape({ ...doc, arrangement: null })).toBe(false);
    expect(validateProjectShape({ ...doc, arrangement: { clips: "x" } })).toBe(false);
    expect(validateProjectShape({ ...doc, arrangement: { clips: [] } })).toBe(true);
  });

  it("rejects non-string timestamps when present", () => {
    const doc = createDefaultProject() as unknown as Record<string, unknown>;
    expect(validateProjectShape({ ...doc, createdAt: 12345 })).toBe(false);
    expect(validateProjectShape({ ...doc, updatedAt: null })).toBe(false);
  });
});
