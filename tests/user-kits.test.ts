import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { KitRepository, type UserKit } from "../src/persistence/KitRepository";
import { createDefaultProject } from "../src/project-model/schema";
import { applyKitToDrumTrack, captureKitFromTrack } from "../src/commands/commands";
import { decodeKitCode, encodeKitCode } from "../src/export/kitCode";
import { getDrumTrack } from "../src/project-model/types";

function makeKit(name: string): UserKit {
  return {
    id: `ukit-${name}`,
    name,
    genre: "custom",
    description: "",
    createdAt: new Date().toISOString(),
    pads: [
      { idx: 0, assetId: "factory.kick.deep", gain: 1, pan: 0, chokeGroup: 1, pitch: 0 },
      { idx: 1, assetId: "factory.snare.main", gain: 0.8, pan: 0.2, chokeGroup: null, pitch: -2 },
    ],
  };
}

describe("KitRepository", () => {
  it("saves, lists and deletes kits", async () => {
    const repo = new KitRepository();
    await repo.save(makeKit("Boom Bap"));
    const list = await repo.list();
    expect(list.map((k) => k.name)).toContain("Boom Bap");
    await repo.remove("ukit-Boom Bap");
    expect((await repo.list()).map((k) => k.name)).not.toContain("Boom Bap");
  });
});

describe("capture/apply kit commands", () => {
  it("capture reads pad mapping and apply writes it back (round-trip)", () => {
    let doc = createDefaultProject();
    const drum = getDrumTrack(doc);
    // Customise two pads.
    doc = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === drum.id
          ? {
              ...t,
              pads: (t as typeof drum).pads.map((p, i) =>
                i === 0 ? { ...p, assetId: "factory.kick.punch", gain: 0.7, pan: -0.5 } : p,
              ),
            }
          : t,
      ),
    };
    const pads = captureKitFromTrack(doc, drum.id);
    expect(pads[0]).toMatchObject({ idx: 0, assetId: "factory.kick.punch", gain: 0.7, pan: -0.5 });

    // Re-map pad 0 AFTER the capture — applying the captured kit must revert
    // it to the captured values (proves the kit, not current state, wins).
    doc = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === drum.id
          ? {
              ...t,
              pads: (t as typeof drum).pads.map((p, i) => (i === 0 ? { ...p, assetId: "other.later", gain: 1.5 } : p)),
            }
          : t,
      ),
    };
    const next = applyKitToDrumTrack(doc, drum.id, "My Kit", pads).execute(doc);
    const applied = getDrumTrack(next);
    expect(applied.pads[0].assetId).toBe("factory.kick.punch");
    expect(applied.pads[0].gain).toBe(0.7);
    expect(applied.pads[0].pan).toBe(-0.5);
    // Pads the kit defined keep their samples; undefined kit pads keep theirs too.
    expect(applied.pads[1].assetId).toBe(pads[1].assetId);
    expect(applied.pads[2].assetId).toBe(
      doc.tracks.find((t) => t.id === drum.id && t.kind === "drum") && getDrumTrack(doc).pads[2].assetId,
    );
  });

  it("null assetId pads keep their current sample", () => {
    let doc = createDefaultProject();
    const drum = getDrumTrack(doc);
    const pads = captureKitFromTrack(doc, drum.id).map((p, i) => (i === 0 ? { ...p, assetId: null } : p));
    const next = applyKitToDrumTrack(doc, drum.id, "partial", pads).execute(doc);
    expect(getDrumTrack(next).pads[0].assetId).toBe(getDrumTrack(doc).pads[0].assetId);
  });

  it("throws for a non-drum or missing track", () => {
    const doc = createDefaultProject();
    const instrument = doc.tracks.find((t) => t.kind === "instrument");
    expect(() => captureKitFromTrack(doc, instrument?.id ?? "x")).toThrow(/not found/u);
  });
});

describe("kit share codes", () => {
  it("round-trips name and pads through encode/decode", () => {
    const code = encodeKitCode("Trap Vol. 2", [
      { idx: 0, assetId: "factory.kick.808", gain: 1.2, pan: 0, chokeGroup: 1, pitch: -3 },
      { idx: 4, assetId: "user.resample-abc", gain: 0.9, pan: -0.3, chokeGroup: null, pitch: 2 },
    ]);
    expect(code.startsWith("PFKIT1:")).toBe(true);
    const kit = decodeKitCode(code);
    expect(kit).not.toBeNull();
    expect(kit!.name).toBe("Trap Vol. 2");
    expect(kit!.pads[0]).toMatchObject({ idx: 0, assetId: "factory.kick.808", gain: 1.2, pitch: -3 });
    expect(kit!.pads[1].assetId).toBe("user.resample-abc");
  });

  it("rejects garbage, tampered and empty codes", () => {
    expect(decodeKitCode("hello world")).toBeNull();
    expect(decodeKitCode("PFKIT1:notvalidbase64!!!")).toBeNull();
    expect(decodeKitCode("")).toBeNull();
    const evil = encodeKitCode("x", [
      { idx: 0, assetId: "ok" },
      { idx: 0, assetId: "duplicate-idx" },
    ]);
    const kit = decodeKitCode(evil);
    expect(kit!.pads.filter((p) => p.idx === 0).length).toBe(1);
  });
});
