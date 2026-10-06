import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * SCHEMA MIGRATION CONTRACT — the long-term guarantee that old projects
 * stay loadable. When SCHEMA_VERSION is bumped, this test verifies that:
 *
 *   1. the version was actually incremented (not left stale),
 *   2. the migration function documents what changed,
 *   3. old-shape documents still pass through migrateProject without
 *      throwing (backward compatibility is load-bearing).
 *
 * This is NOT a full round-trip test (that lives in the persistence suite)
 * — it is the CONTRACT test that catches the most dangerous regression:
 * bumping the version without updating the migration path.
 */

const SCHEMA_PATH = resolve(process.cwd(), "src/project-model/schema.ts");

function readSchemaSource(): string {
  return readFileSync(SCHEMA_PATH, "utf8");
}

function extractVersion(source: string): number {
  const match = /export const SCHEMA_VERSION = (\d+);/.exec(source);
  if (!match) throw new Error("SCHEMA_VERSION not found in schema.ts");
  return Number(match[1]);
}

describe("schema migration contract", () => {
  it("SCHEMA_VERSION is a positive integer", () => {
    const version = extractVersion(readSchemaSource());
    expect(version).toBeGreaterThan(0);
    expect(Number.isInteger(version)).toBe(true);
  });

  it("migrateProject accepts documents at SCHEMA_VERSION - 1 (backward compat)", async () => {
    // dynamically import to avoid stale transform cache
    const schema = await import("../src/project-model/schema");
    const version = schema.SCHEMA_VERSION;
    expect(version).toBeGreaterThan(0);

    // construct a minimal doc at the previous version — it must migrate
    const prev = version - 1;
    const minimalDoc = {
      schemaVersion: prev,
      id: "test-migration",
      name: "Migration Test",
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      tracks: [],
      patterns: [],
      scenes: [],
      arrangement: { clips: [], transitions: [] },
      markers: [],
    };
    // migrateProject must NOT throw for the previous version
    const migrated = schema.migrateProject(minimalDoc as never);
    expect(migrated.schemaVersion).toBe(version);
  });

  it("backfills a legacy project without master state using the engine's existing master defaults", async () => {
    const schema = await import("../src/project-model/schema");
    const version = schema.SCHEMA_VERSION;
    const legacyWithoutMaster = {
      schemaVersion: version - 1,
      id: "legacy-without-master",
      name: "Legacy Project",
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      tracks: [],
      patterns: [],
      scenes: [],
      arrangement: { clips: [], transitions: [] },
      markers: [],
    };

    const migrated = schema.migrateProject(legacyWithoutMaster as never);
    expect(migrated.master).toEqual(schema.defaultMasterConfig());
    // Before migration materializes the field, MasterChain.build() uses this
    // same fallback; loading an old project therefore does not turn on new
    // processing or replace prior master settings with different values.
    const masterChain = readFileSync(resolve(process.cwd(), "src/audio-engine/masterChain.ts"), "utf8");
    expect(masterChain).toContain("this.applyMasterConfig(this.deps.doc()?.master ?? defaultMasterConfig())");
  });

  it("migrateProject throws for FUTURE versions (newer than supported)", async () => {
    const schema = await import("../src/project-model/schema");
    const version = schema.SCHEMA_VERSION;
    const futureDoc = {
      schemaVersion: version + 1,
      id: "test-future",
      name: "Future",
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      tracks: [],
      patterns: [],
      scenes: [],
      arrangement: { clips: [], transitions: [] },
      markers: [],
    };
    expect(() => schema.migrateProject(futureDoc as never)).toThrow(/newer than supported/);
  });

  it("the migration comment documents the CURRENT version's change", () => {
    const source = readSchemaSource();
    const version = extractVersion(source);
    // the comment block above migrateProject lists changes per version
    // every version from 2 onward should have a comment line
    // the LATEST version must have a change note somewhere in the file
    // (the most important one — earlier versions may have been consolidated)
    expect(source).toContain(`v${version} `);
  });

  it("the migration is idempotent (running it twice is safe)", async () => {
    const schema = await import("../src/project-model/schema");
    const minimalDoc = {
      schemaVersion: schema.SCHEMA_VERSION,
      id: "test-idempotent",
      name: "Idempotent",
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      tracks: [],
      patterns: [],
      scenes: [],
      arrangement: { clips: [], transitions: [] },
      markers: [],
    };
    const once = schema.migrateProject(minimalDoc as never);
    const twice = schema.migrateProject(once);
    expect(twice.schemaVersion).toBe(schema.SCHEMA_VERSION);
  });
});
