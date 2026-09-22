/**
 * `migrateProject` failure paths — the trust gate every loaded project
 * passes through.
 *
 * `round-trip-integrity.test.ts` already covers the happy path (current
 * version, determinism, idempotency). This file pins the FAILURE PATH:
 *
 *  - a schemaVersion strictly greater than the running app's `SCHEMA_VERSION`
 *    MUST throw a NAMED error, never silently coerce. A silent downgrade
 *    would lose data the producer just put into the file.
 *  - older versions (schemaVersion 0 / undefined) are upgraded to current
 *    and normalized, exercising the migration seam without a regression
 *    guard.
 *
 * The test is intentionally pure: no IndexedDB, no fixtures, no async.
 */
import { describe, expect, it } from "vitest";
import { migrateProject, SCHEMA_VERSION } from "../../src/project-model/schema";
import { createProjectFromTemplate } from "../../src/project-model/templates";

describe("migrateProject — failure paths", () => {
  it("throws a NAMED error when the doc's schemaVersion is ahead of the running app", () => {
    const future = createProjectFromTemplate("house");
    const ahead = { ...future, schemaVersion: SCHEMA_VERSION + 1 };
    // Silent downgrade would mean a v2 doc loses data on load — the worst-
    // case persistence bug. The check MUST throw.
    expect(() => migrateProject(ahead)).toThrow();
    try {
      migrateProject(ahead);
    } catch (err) {
      // The error must carry the version numbers so the caller / UI can
      // show "this project was made on a newer build, please update".
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toMatch(/newer than supported/);
      expect((err as Error).message).toContain(String(SCHEMA_VERSION + 1));
    }
  });

  it("upgrades a doc with schemaVersion 0 (legacy) to the current version", () => {
    const legacy = { ...createProjectFromTemplate("house"), schemaVersion: 0 };
    const migrated = migrateProject(legacy as Parameters<typeof migrateProject>[0]);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("upgrades a doc with schemaVersion as a negative number", () => {
    const negative = { ...createProjectFromTemplate("house"), schemaVersion: -1 as unknown as number };
    // The non-future branch (anything <= SCHEMA_VERSION) is unconditionally
    // upgraded. Negative must not throw.
    expect(() => migrateProject(negative as Parameters<typeof migrateProject>[0])).not.toThrow();
    const migrated = migrateProject(negative as Parameters<typeof migrateProject>[0]);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("future-by-a-billion error message includes both version numbers (UI-safe for telemetry)", () => {
    // Pin the format so the caller can pattern-match the numbers for an
    // "update your app" toast without parsing free text.
    const huge = { ...createProjectFromTemplate("house"), schemaVersion: 9999 };
    expect(() => migrateProject(huge)).toThrow(
      new RegExp(`Project schema 9999 is newer than supported ${SCHEMA_VERSION}`),
    );
  });
});
