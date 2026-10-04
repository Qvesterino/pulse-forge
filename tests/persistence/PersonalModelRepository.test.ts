import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  putPersonalModel,
  getPersonalModel,
  deletePersonalModel,
  listPersonalModels,
  pruneOrphanedPersonalModels,
  PERSONAL_MODEL_SCHEMA_VERSION,
  type PersonalModelRecord,
} from "../../src/persistence/PersonalModelRepository";
import {
  personalWeightsFromOnnx,
  personalWeightsToJson,
  personalWeightsFromJson,
} from "../../src/intent/personal-melodic-onnx";
import { PERSONAL_DEGREE_CLASSES, PERSONAL_DURATION_CLASSES } from "../../src/intent/personal-melodic-trainer";
import { openDb, STORE_PERSONAL_MODELS, tx } from "../../src/persistence/db";

/**
 * W3 — the personal-model store.
 *
 * The contract that matters: a personal model is keyed by the EXACT shipped
 * artifact it was trained from. These tests pin that hash keying (a new
 * shipped prior must not inherit a stale personal model), the defensive read
 * (corrupt payload → "no personal model", not garbage weights), and the
 * orphan prune that keeps the store honest after a prior upgrade.
 */

const HIDDEN = [64, 32] as const;

function payloadFor(file: string, featureCount: number) {
  const bytes = new Uint8Array(readFileSync(path.resolve("public", "models", file)));
  const weights = personalWeightsFromOnnx(bytes, HIDDEN, PERSONAL_DEGREE_CLASSES, PERSONAL_DURATION_CLASSES);
  const json = personalWeightsToJson(weights, {
    hidden: [HIDDEN[0], HIDDEN[1]],
    featureCount,
    degreeClasses: PERSONAL_DEGREE_CLASSES,
    durationClasses: PERSONAL_DURATION_CLASSES,
  });
  const payload = personalWeightsFromJson(JSON.parse(json));
  if (!payload) throw new Error("fixture payload invalid");
  return payload;
}

function record(kind: string, baseModelHash: string, featureCount = 29, favoritesUsed = 5): PersonalModelRecord {
  return {
    payload: payloadFor("symbolic-melodic-v1.onnx", featureCount),
    base: { kind, baseModelHash },
    favoritesUsed,
    createdAt: new Date().toISOString(),
    schemaVersion: PERSONAL_MODEL_SCHEMA_VERSION,
    report: { finalLoss: 1.23, epochs: 4, steps: 30, topOneWins: 8, topOneCases: 10 },
  };
}

async function resetStore(): Promise<void> {
  const db = await openDb();
  await tx(db, STORE_PERSONAL_MODELS, "readwrite", (store) => {
    store.clear();
  });
}

describe("PersonalModelRepository", () => {
  beforeEach(async () => {
    await resetStore();
  });

  it("round-trips a personal model keyed by the shipped artifact", async () => {
    const written = record("melodic-v2", "abc123");
    expect(await putPersonalModel(written)).toBe(true);
    const read = await getPersonalModel({ kind: "melodic-v2", baseModelHash: "abc123" });
    expect(read).not.toBeNull();
    expect(read!.base).toEqual({ kind: "melodic-v2", baseModelHash: "abc123" });
    expect(read!.favoritesUsed).toBe(5);
    expect(read!.report?.topOneWins).toBe(8);
    expect(read!.payload.w0).toEqual(written.payload.w0);
  });

  it("returns null for a DIFFERENT shipped hash (no stale inheritance)", async () => {
    await putPersonalModel(record("melodic-v2", "oldhash"));
    // A new shipped prior has a new modelHash — the personal model trained on
    // the old artifact must NOT be returned for it.
    expect(await getPersonalModel({ kind: "melodic-v2", baseModelHash: "newhash" })).toBeNull();
  });

  it("normalizes the stored hash to lowercase for lookup", async () => {
    await putPersonalModel(record("melodic", "ABCDEF"));
    expect(await getPersonalModel({ kind: "melodic", baseModelHash: "abcdef" })).not.toBeNull();
    expect(await getPersonalModel({ kind: "melodic", baseModelHash: "ABCDEF" })).not.toBeNull();
  });

  it("drops a corrupted payload on read instead of serving garbage", async () => {
    // Write a structurally valid record whose payload arrays are broken.
    const db = await openDb();
    const broken = record("melodic", "corrupt");
    (broken.payload as unknown as { w0: unknown }).w0 = [1, 2, 3]; // wrong length
    await tx(db, STORE_PERSONAL_MODELS, "readwrite", (store) => {
      store.put(broken, "melodic#corrupt");
    });
    expect(await getPersonalModel({ kind: "melodic", baseModelHash: "corrupt" })).toBeNull();
  });

  it("refuses to install a record with a mismatched schema version", async () => {
    const stale = { ...record("melodic", "schema"), schemaVersion: 99 };
    expect(await putPersonalModel(stale as PersonalModelRecord)).toBe(false);
    expect(await getPersonalModel({ kind: "melodic", baseModelHash: "schema" })).toBeNull();
  });

  it("delete removes only the targeted artifact's model", async () => {
    await putPersonalModel(record("melodic", "keep"));
    await putPersonalModel(record("melodic-v2", "drop"));
    expect(await deletePersonalModel({ kind: "melodic-v2", baseModelHash: "drop" })).toBe(true);
    expect(await getPersonalModel({ kind: "melodic-v2", baseModelHash: "drop" })).toBeNull();
    expect(await getPersonalModel({ kind: "melodic", baseModelHash: "keep" })).not.toBeNull();
  });

  it("lists newest first", async () => {
    const older = record("melodic", "older");
    older.createdAt = new Date(Date.now() - 60_000).toISOString();
    await putPersonalModel(older);
    await putPersonalModel(record("melodic", "newer"));
    const list = await listPersonalModels();
    expect(list[0].base.baseModelHash).toBe("newer");
    expect(list[1].base.baseModelHash).toBe("older");
  });

  it("prunes models whose shipped artifact no longer exists", async () => {
    await putPersonalModel(record("melodic", "ships-today"));
    await putPersonalModel(record("melodic-v2", "gone-tomorrow"));
    const removed = await pruneOrphanedPersonalModels([{ kind: "melodic", baseModelHash: "ships-today" }]);
    expect(removed).toBe(1);
    expect(await getPersonalModel({ kind: "melodic", baseModelHash: "ships-today" })).not.toBeNull();
    expect(await getPersonalModel({ kind: "melodic-v2", baseModelHash: "gone-tomorrow" })).toBeNull();
  });

  it("list returns [] when the store holds nothing (never throws)", async () => {
    expect(await listPersonalModels()).toEqual([]);
  });
});
