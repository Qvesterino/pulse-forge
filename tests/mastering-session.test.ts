import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  captureMasteringSnapshot,
  loadMasteringABSession,
  replaceSnapshot,
  saveMasteringABSession,
} from "../src/mastering/snapshots";
import { MasteringReferenceRepository } from "../src/mastering/referenceRepository";
import type { MasteringReferenceRecord } from "../src/mastering/referenceRepository";
import { testDoc } from "./fixtures/doc";

function projectWithId(id: string) {
  return { ...testDoc(), id };
}

describe("mastering A/B session snapshots", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips complete, cloned master configurations per project", () => {
    const doc = projectWithId("snapshot-project-a");
    const config = {
      ...doc.master,
      masterGain: 1.35,
      deliveryProfileId: "vinyl" as const,
      deliveryTruePeakDb: -2,
      effects: [
        {
          id: "master-zenit-snapshot",
          type: "zenit" as const,
          bypassed: false,
          params: { ceiling: -1.5, limit: 0.25, glue: 0.2 },
        },
      ],
    };
    const snapshot = captureMasteringSnapshot(config);
    const session = replaceSnapshot(loadMasteringABSession(doc), "A", snapshot);

    config.effects[0]!.params.ceiling = -4;
    expect(saveMasteringABSession(session)).toBe(true);

    const loaded = loadMasteringABSession(doc);
    expect(loaded.a?.id).toBe(snapshot.id);
    expect(loaded.a?.config).toMatchObject({
      masterGain: 1.35,
      deliveryProfileId: "vinyl",
      deliveryTruePeakDb: -2,
      effects: [{ id: "master-zenit-snapshot", type: "zenit", params: { ceiling: -1.5 } }],
    });
    expect(loadMasteringABSession(projectWithId("snapshot-project-b"))).toMatchObject({ a: null, b: null });
    expect(doc.master).not.toBe(loaded.a?.config);
  });

  it("fails closed on malformed, foreign-project, or future-version storage", () => {
    const doc = projectWithId("snapshot-corruption");
    const key = `kyx.mastering.ab.v1:${doc.id}`;
    const empty = { version: 1, projectId: doc.id, a: null, b: null };

    sessionStorage.setItem(key, "{");
    expect(loadMasteringABSession(doc)).toEqual(empty);
    sessionStorage.setItem(key, JSON.stringify({ ...empty, version: 2 }));
    expect(loadMasteringABSession(doc)).toEqual(empty);
    sessionStorage.setItem(key, JSON.stringify({ ...empty, projectId: "another-project" }));
    expect(loadMasteringABSession(doc)).toEqual(empty);
  });
});

describe("mastering reference repository", () => {
  it("rejects an invalid persisted reference record", async () => {
    const repository = new MasteringReferenceRepository();
    const projectId = `mastering-reference-corrupt-${Date.now()}`;
    const corrupt = {
      projectId,
      fileName: "broken.wav",
      mimeType: "audio/wav",
      byteLength: 99,
      importedAt: new Date().toISOString(),
      source: { size: 3, type: "audio/wav" },
    } as MasteringReferenceRecord;

    await repository.put(corrupt);
    await expect(repository.get(projectId)).rejects.toThrow("saved mastering reference record is invalid");
  });
});
