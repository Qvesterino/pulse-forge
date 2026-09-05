/**
 * Ultina user presets (roadmap phase U5): local-first storage of named
 * full-parameter-map snapshots, with schema-validating reads — a corrupted or
 * foreign entry degrades to its valid subset instead of poisoning the DSP.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  UltinaPresetRepository,
  sanitizeUltinaPresetParams,
  ULTINA_PRESET_SCHEMA_VERSION,
} from "../../src/persistence/UltinaPresetRepository";

describe("sanitizeUltinaPresetParams", () => {
  it("drops unknown ids, clamps out-of-range values, rejects non-numbers", () => {
    const out = sanitizeUltinaPresetParams({
      "eq.band0.gainDb": 999, // clamp → 18
      "bogus.param": 5, // unknown → dropped
      "comp.thresholdDb": null, // non-number → dropped
      "global.mix": 75, // valid → kept
    });
    expect(out).toEqual({ "eq.band0.gainDb": 18, "global.mix": 75 });
  });

  it("returns an empty map for garbage input", () => {
    expect(sanitizeUltinaPresetParams(null)).toEqual({});
    expect(sanitizeUltinaPresetParams("nope")).toEqual({});
    expect(sanitizeUltinaPresetParams({})).toEqual({});
  });
});

describe("UltinaPresetRepository", () => {
  it("saves, lists and removes presets (sorted newest first)", async () => {
    const repo = new UltinaPresetRepository();
    await repo.save({
      id: "p1",
      name: "Vocal Chain",
      params: { "comp.thresholdDb": -18 },
      createdAt: "2026-09-05T10:00:00Z",
      schemaVersion: ULTINA_PRESET_SCHEMA_VERSION,
    });
    await repo.save({
      id: "p2",
      name: "Bus Glue",
      params: { "comp.ratio": 4 },
      createdAt: "2026-09-05T11:00:00Z",
      schemaVersion: ULTINA_PRESET_SCHEMA_VERSION,
    });

    const all = await new UltinaPresetRepository().list();
    expect(all.map((p) => p.name)).toEqual(["Bus Glue", "Vocal Chain"]);

    const repo3 = new UltinaPresetRepository();
    await repo3.remove("p1");
    const after = await new UltinaPresetRepository().list();
    expect(after.map((p) => p.id)).toEqual(["p2"]);
  });

  it("a corrupted stored entry degrades to its valid subset", async () => {
    const repo = new UltinaPresetRepository();
    // Write an entry whose params contain garbage (simulating an older
    // schema or a hand-edited record).
    await repo.save({
      id: "corrupt",
      name: "Corrupt",
      params: { "eq.band0.q": 999, "ghost.param": 1, "comp.attackMs": 20 } as Record<string, number>,
      createdAt: "2026-09-05T09:00:00Z",
      schemaVersion: 0,
    });
    // The fake DB is shared across tests in this file — scope to OUR record.
    const entry = (await new UltinaPresetRepository().list()).find((p) => p.id === "corrupt")!;
    expect(entry.params["eq.band0.q"]).toBe(24); // clamped
    expect(entry.params["ghost.param"]).toBeUndefined(); // dropped
    expect(entry.params["comp.attackMs"]).toBe(20); // untouched
    expect(entry.schemaVersion).toBe(ULTINA_PRESET_SCHEMA_VERSION);
  });

  it("entries without a usable name are dropped on read", async () => {
    const repo = new UltinaPresetRepository();
    await repo.save({
      id: "nameless",
      name: "   ",
      params: {},
      createdAt: "2026-09-05T09:00:00Z",
      schemaVersion: ULTINA_PRESET_SCHEMA_VERSION,
    });
    // Shared fake DB: assert OUR nameless record was dropped, not the store.
    const all = await new UltinaPresetRepository().list();
    expect(all.find((p) => p.id === "nameless")).toBeUndefined();
  });
});
