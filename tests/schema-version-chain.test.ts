import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { openDb, STORE_PROJECTS, tx } from "../src/persistence/db";
import { ProjectRepository } from "../src/persistence/ProjectRepository";
import {
  MIGRATIONS,
  MIN_SCHEMA_VERSION,
  SCHEMA_HISTORY,
  SCHEMA_VERSION,
  applyMigrations,
  createDefaultProject,
  migrateProject,
  normalizeProject,
  resolveLimiterLinks,
} from "../src/project-model/schema";
import type { MasterConfig, ProjectDocument } from "../src/project-model/types";

/**
 * F-13 — the schema version is a MECHANISM, not a comment.
 *
 * The finding was that `migrateProject` never branched on the source version:
 * the whole per-version history was a comment block, so a breaking change had
 * nowhere to live except inside the version-blind normaliser, where it was
 * invisible and unreviewable.
 *
 * What this suite pins:
 *
 *  1. the version ledger (`SCHEMA_HISTORY`) is TOTAL — every version from the
 *     first shape this project ever wrote to today has an entry, and says
 *     what kind of change it was;
 *  2. the ledger and the migration chain (`MIGRATIONS`) correspond in BOTH
 *     directions — a version cannot be declared a transformation without the
 *     step that implements it, and a step cannot exist without a version that
 *     asks for it;
 *  3. the walk is version-aware — a step runs only for documents at or below
 *     its own version, in ascending order;
 *  4. the behaviour the audit locked in is unchanged: migrating from EVERY
 *     version yields exactly the normaliser's result;
 *  5. the version-aware rule and the tolerant path are ONE rule, so a
 *     document that arrives late cannot be read two ways;
 *  6. what this build refuses, it refuses VISIBLY — a document it cannot
 *     open is listed, not lost.
 */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A document that still carries the v19 COMBINED master link and no split links. */
function legacyLinkDoc(): ProjectDocument {
  const base = createDefaultProject();
  const master: MasterConfig = { ...base.master };
  delete master.limiterTransientLink;
  delete master.limiterReleaseLink;
  master.limiterStereoLink = 0.35;
  return { ...base, master };
}

describe("F-13 — the schema version ledger", () => {
  it("documents EVERY version from the first shape this project wrote to today", () => {
    for (let v = MIN_SCHEMA_VERSION; v <= SCHEMA_VERSION; v++) {
      const change = SCHEMA_HISTORY[v];
      expect(change, `schema v${v} has no entry in SCHEMA_HISTORY`).toBeDefined();
      expect(["additive", "inferred", "transform"]).toContain(change.kind);
      expect(change.note.length, `schema v${v} has an empty note`).toBeGreaterThan(0);
      expect(change.note, `schema v${v} does not name its own version`).toContain(`v${v}`);
    }
  });

  it("holds no entry outside the range it claims to cover", () => {
    const keys = Object.keys(SCHEMA_HISTORY).map(Number);
    expect(keys).toHaveLength(SCHEMA_VERSION - MIN_SCHEMA_VERSION + 1);
    for (const key of keys) {
      expect(key).toBeGreaterThanOrEqual(MIN_SCHEMA_VERSION);
      expect(key).toBeLessThanOrEqual(SCHEMA_VERSION);
    }
  });

  it("matches the migration chain in BOTH directions", () => {
    for (let v = MIN_SCHEMA_VERSION; v <= SCHEMA_VERSION; v++) {
      const change = SCHEMA_HISTORY[v];
      const step = MIGRATIONS[v - 1];
      if (change.kind === "transform") {
        expect(step, `schema v${v} is a transform but MIGRATIONS[${v - 1}] is missing`).toBeTypeOf("function");
      } else {
        expect(step, `MIGRATIONS[${v - 1}] exists but schema v${v} is "${change.kind}"`).toBeUndefined();
      }
    }
    for (const key of Object.keys(MIGRATIONS).map(Number)) {
      expect(SCHEMA_HISTORY[key + 1]?.kind, `MIGRATIONS[${key}] has no version asking for it`).toBe("transform");
    }
  });
});

describe("F-13 — the migration walk is version-aware", () => {
  it("runs a step only for documents at or below that step's version, in ascending order", () => {
    const ran: number[] = [];
    const chain = {
      3: (doc: ProjectDocument) => {
        ran.push(3);
        return doc;
      },
      19: (doc: ProjectDocument) => {
        ran.push(19);
        return doc;
      },
      30: (doc: ProjectDocument) => {
        ran.push(30);
        return doc;
      },
    };

    applyMigrations(createDefaultProject(), 19, chain);
    expect(ran, "a step below the source version must not run").toEqual([19, 30]);

    ran.length = 0;
    applyMigrations(createDefaultProject(), 31, chain);
    expect(ran, "a step below the source version must not run").toEqual([]);

    ran.length = 0;
    applyMigrations(createDefaultProject(), 0, chain);
    expect(ran, "an ancient document gets every step up to today").toEqual([3, 19, 30]);
  });

  it("runs no step for a document that is already current", () => {
    const ran: number[] = [];
    const chain = {
      19: (doc: ProjectDocument) => {
        ran.push(19);
        return doc;
      },
    };
    applyMigrations(createDefaultProject(), SCHEMA_VERSION, chain);
    expect(ran).toEqual([]);
  });

  it("is idempotent — every step run twice changes nothing more", () => {
    for (const key of Object.keys(MIGRATIONS).map(Number)) {
      const step = MIGRATIONS[key];
      const once = step(createDefaultProject());
      expect(step(once), `MIGRATIONS[${key}] is not idempotent`).toEqual(once);
    }
  });
});

describe("F-13 — the behaviour the audit locked in is unchanged", () => {
  it("migrating from EVERY version yields exactly the normaliser's result", () => {
    // ONE source document: `createDefaultProject` mints fresh ids on every
    // call, so the reference and every migration must start from the same one.
    const source = legacyLinkDoc();
    const reference = normalizeProject(clone(source));
    for (let v = MIN_SCHEMA_VERSION; v <= SCHEMA_VERSION; v++) {
      const migrated = migrateProject({ ...clone(source), schemaVersion: v } as ProjectDocument);
      expect(migrated, `v${v} did not migrate to the normaliser's result`).toEqual(reference);
    }
  });

  it("the version-aware step and the tolerant path are ONE rule", () => {
    const source = legacyLinkDoc();
    const stepped = MIGRATIONS[19](clone(source));
    const tolerated = normalizeProject(clone(source));
    expect(stepped.master?.limiterTransientLink).toBe(0.35);
    expect(stepped.master?.limiterReleaseLink).toBe(0.35);
    expect(tolerated.master?.limiterTransientLink).toBe(stepped.master?.limiterTransientLink);
    expect(tolerated.master?.limiterReleaseLink).toBe(stepped.master?.limiterReleaseLink);
    expect(resolveLimiterLinks(0.35, undefined, undefined)).toEqual({ transient: 0.35, release: 0.35 });
  });

  it("migrateProject runs the v19 step for a v19 document", () => {
    const migrated = migrateProject({ ...clone(legacyLinkDoc()), schemaVersion: 19 } as ProjectDocument);
    expect(migrated.master?.limiterTransientLink).toBe(0.35);
    expect(migrated.master?.limiterReleaseLink).toBe(0.35);
    expect(migrated.master?.limiterStereoLink).toBeUndefined();
  });

  it("a document that arrives LATE still carrying the deprecated field keeps its value", () => {
    const tolerated = normalizeProject(clone(legacyLinkDoc()));
    expect(tolerated.master?.limiterTransientLink).toBe(0.35);
    expect(tolerated.master?.limiterReleaseLink).toBe(0.35);
  });
});

describe("F-13 — what the build refuses, it refuses visibly", () => {
  it("refuses a document from the future", () => {
    const doc = { ...createDefaultProject(), schemaVersion: SCHEMA_VERSION + 1 } as ProjectDocument;
    expect(() => migrateProject(doc)).toThrow(/newer than supported/);
  });

  it("refuses a version that is not a version number", () => {
    for (const bad of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      const doc = { ...createDefaultProject(), schemaVersion: bad } as ProjectDocument;
      expect(() => migrateProject(doc), `schemaVersion ${bad} must be refused`).toThrow(/not a valid schema version/);
    }
  });

  it("still UPGRADES every integer version at or below the current one", () => {
    for (const v of [0, -1, 1, 2, 19, 38]) {
      const doc = { ...createDefaultProject(), schemaVersion: v } as ProjectDocument;
      expect(migrateProject(doc).schemaVersion, `schemaVersion ${v} must be upgraded`).toBe(SCHEMA_VERSION);
    }
  });

  it("lists a document with an impossible version instead of letting it vanish", async () => {
    const brokenRow = {
      id: "proj-impossible-version",
      name: "Broken version",
      bpm: 120,
      tracks: [],
      patterns: [],
      activePatternId: "p",
      schemaVersion: Number.NaN,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as ProjectDocument;
    const goodRow = { ...createDefaultProject(), id: "proj-openable" } as ProjectDocument;

    const db = await openDb();
    await tx(db, STORE_PROJECTS, "readwrite", (store) => {
      store.put(brokenRow);
      store.put(goodRow);
    });

    const repo = new ProjectRepository();
    const incompatible = await repo.listIncompatible();
    const listed = incompatible.find((meta) => meta.id === "proj-impossible-version");
    expect(listed, "a document this build cannot open must not vanish from the library").toBeDefined();
    expect(listed?.direction).toBe("unsupported");

    const metas = await repo.listAll();
    expect(metas.map((meta) => meta.id)).not.toContain("proj-impossible-version");
    expect(metas.map((meta) => meta.id)).toContain("proj-openable");
    await expect(repo.load("proj-impossible-version")).resolves.toBeNull();
  });
});
