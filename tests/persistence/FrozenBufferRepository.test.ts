import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { FrozenBufferRepository, restoreFrozenTracks } from "../../src/persistence/FrozenBufferRepository";
import { SampleBank } from "../../src/sample-library/factory";
import { freezeTrack } from "../../src/commands/commands";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { ProjectDocument } from "../../src/project-model/types";

function fakeBuffer(): AudioBuffer {
  return { duration: 30, sampleRate: 44100 } as unknown as AudioBuffer;
}

function frozenDoc(bufferIds: { drum: string; inst: string }): ProjectDocument {
  const base = createProjectFromTemplate("house");
  const drum = base.tracks.find((t) => t.kind === "drum")!;
  const withDrum = freezeTrack(base, drum.id, bufferIds.drum, 30, 44100).execute(base);
  const inst = withDrum.tracks.find((t) => t.kind === "instrument")!;
  return freezeTrack(withDrum, inst.id, bufferIds.inst, 30, 44100).execute(withDrum);
}

describe("FrozenBufferRepository", () => {
  it("save/load/remove round-trips buffer ids", async () => {
    const repo = new FrozenBufferRepository();
    await repo.save("frozen-a", new ArrayBuffer(8));
    expect((await repo.load("frozen-a"))?.byteLength).toBe(8);
    expect(await repo.load("frozen-missing")).toBeUndefined();
    await repo.remove("frozen-a");
    expect(await repo.load("frozen-a")).toBeUndefined();
  });

  it("list returns saved entries (for orphan GC at project open)", async () => {
    const repo = new FrozenBufferRepository();
    await repo.save("frozen-gc", new ArrayBuffer(4));
    const ids = (await repo.list()).map((e) => e.id);
    expect(ids).toContain("frozen-gc");
  });

  it("surfaces storage failure instead of reporting a non-durable freeze as saved", async () => {
    const repo = new FrozenBufferRepository(async () => {
      throw new Error("quota exceeded");
    });

    await expect(repo.save("frozen-failed", new ArrayBuffer(8))).rejects.toThrow(
      /Could not persist frozen audio for frozen-failed: quota exceeded/,
    );
  });
});

describe("restoreFrozenTracks", () => {
  it("decodes stored audio into the bank and reports missing buffer ids", async () => {
    const doc = frozenDoc({ drum: "frozen-ok", inst: "frozen-gone" });
    const repo = new FrozenBufferRepository();
    await repo.save("frozen-ok", new ArrayBuffer(4)); // "frozen-gone" was never stored
    const bank = new SampleBank();

    const missing = await restoreFrozenTracks(doc, bank, repo, async () => fakeBuffer());

    // Missing ids are the caller's signal to auto-unfreeze those tracks —
    // a frozen track without a buffer is permanently silent.
    expect(missing).toEqual(["frozen-gone"]);
    expect(bank.get("frozen-ok")).toBeDefined();
  });

  it("skips buffer ids already present in the bank", async () => {
    const doc = frozenDoc({ drum: "frozen-cached", inst: "frozen-cached-2" });
    const bank = new SampleBank();
    bank.add("frozen-cached", fakeBuffer());
    bank.add("frozen-cached-2", fakeBuffer());
    const repo = new FrozenBufferRepository();

    const missing = await restoreFrozenTracks(doc, bank, repo, async () => {
      throw new Error("should not decode when the bank already has the buffer");
    });

    expect(missing).toEqual([]);
  });

  it("reports the id when decoding throws", async () => {
    const doc = frozenDoc({ drum: "frozen-corrupt", inst: "frozen-corrupt-2" });
    const repo = new FrozenBufferRepository();
    await repo.save("frozen-corrupt", new ArrayBuffer(4));
    await repo.save("frozen-corrupt-2", new ArrayBuffer(4));
    const bank = new SampleBank();

    const missing = await restoreFrozenTracks(doc, bank, repo, async () => {
      throw new Error("decode failed");
    });

    expect(missing.sort()).toEqual(["frozen-corrupt", "frozen-corrupt-2"]);
    expect(bank.size).toBe(0);
  });
});
