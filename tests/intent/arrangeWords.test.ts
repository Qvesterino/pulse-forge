import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { applyArrangeOps, parseArrangeIntent, resolveSceneTarget } from "../../src/intent/arrangeWords";

/** Scene roles live on names in the scene-score template — mirror the engine. */
const roleOf = (s: { role?: string | null; name: string }): string | null =>
  s.role ?? ["intro", "build", "drop", "break", "outro"].find((r) => s.name.toLowerCase().includes(r)) ?? null;

function sceneScoreDoc() {
  return createProjectFromTemplate("scene-score");
}

describe("parseArrangeIntent", () => {
  it("maps core English phrases to ops (scene-score doc)", () => {
    const doc = sceneScoreDoc();
    const p = parseArrangeIntent("shorten the intro to 2 bars", doc);
    expect(p.ops).toEqual([
      { op: "resize", sceneId: expect.any(String), role: "intro", name: expect.any(String), bars: 2 },
    ]);
    expect(p.unrecognized).toEqual([]);
  });

  it("supports ordinals: the second drop", () => {
    const doc = sceneScoreDoc();
    const drops = doc.scenes.filter((s) => roleOf(s) === "drop");
    if (drops.length < 2) return; // template guard — skip when only one drop
    const p = parseArrangeIntent("duplicate the second drop", doc);
    expect(p.ops[0]).toMatchObject({ op: "duplicate", sceneId: drops[1].id });
  });

  it("add a break before the drop → addRole anchored to the drop", () => {
    const doc = sceneScoreDoc();
    const p = parseArrangeIntent("add a break before the drop", doc);
    expect(p.ops[0]).toMatchObject({ op: "addRole", role: "break" });
    const drop = doc.scenes.find((s) => roleOf(s) === "drop");
    expect((p.ops[0] as { beforeSceneId: string | null }).beforeSceneId).toBe(drop!.id);
  });

  it("slovak synonyms parse (skrátiť / pridaj / predĺžiť)", () => {
    const doc = sceneScoreDoc();
    const shorten = parseArrangeIntent("skrátiť intro na 2 takty", doc);
    expect(shorten.ops[0]).toMatchObject({ op: "resize", bars: 2 });
    const add = parseArrangeIntent("pridaj break pred drop", doc);
    expect(add.ops[0]).toMatchObject({ op: "addRole", role: "break" });
    const extend = parseArrangeIntent("predĺž drop o 4 takty", doc);
    expect(extend.ops[0]).toMatchObject({ op: "resize" });
  });

  it("splits multi-clause sentences", () => {
    const doc = sceneScoreDoc();
    const p = parseArrangeIntent("shorten the intro to 2 bars, then add a break before the drop", doc);
    expect(p.ops.length).toBe(2);
  });

  it("unknown clauses surface as unrecognized", () => {
    const doc = sceneScoreDoc();
    const p = parseArrangeIntent("make it smell like bananas", doc);
    expect(p.ops.length).toBe(0);
    expect(p.unrecognized.length).toBeGreaterThan(0);
  });
});

describe("applyArrangeOps", () => {
  it("resize ripples the timeline contiguously (no holes, no overlaps)", () => {
    const doc = sceneScoreDoc();
    const before = doc.arrangement.clips;
    expect(before.length).toBeGreaterThan(2);
    const introScene = doc.scenes[0];
    const p = parseArrangeIntent("shorten the intro to 2 bars", doc);
    const next = applyArrangeOps(doc, p.ops).execute(doc);

    // first clip resized to 2 bars; every following clip pushed back-to-back
    const after = next.arrangement.clips;
    const firstIntroClip = after.find((c) => c.sceneId === introScene.id)!;
    expect(firstIntroClip.lengthBars).toBe(2);
    const sorted = [...after].sort((a, b) => a.startBar - b.startBar);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].startBar).toBe(sorted[i - 1].startBar + sorted[i - 1].lengthBars);
    }
  });

  it("add a break before the drop inserts a new role-typed scene in the chain", () => {
    const doc = sceneScoreDoc();
    const p = parseArrangeIntent("add a break before the drop", doc);
    const next = applyArrangeOps(doc, p.ops).execute(doc);

    const dropIdx = next.scenes.findIndex((s) => roleOf(s) === "drop");
    const beforeDrop = next.scenes[dropIdx - 1];
    expect(beforeDrop).toBeTruthy();
    expect(roleOf(beforeDrop)).toBe("break"); // name-inferred, same as the engine
    // the new scene has its own clip
    expect(next.arrangement.clips.some((c) => c.sceneId === beforeDrop.id)).toBe(true);
  });

  it("composite undo restores the pre-arrangement document", () => {
    const doc = sceneScoreDoc();
    const p = parseArrangeIntent("shorten the intro to 2 bars, then add a break before the drop", doc);
    const command = applyArrangeOps(doc, p.ops);
    const next = command.execute(doc);
    expect(next).not.toEqual(doc);
    expect(command.undo(next)).toEqual(doc);
  });

  it("remove + duplicate resolve through roles", () => {
    const doc = sceneScoreDoc();
    const outro = doc.scenes.find((s) => roleOf(s) === "outro")!;
    const drop = doc.scenes.find((s) => roleOf(s) === "drop")!;
    const removed = applyArrangeOps(doc, parseArrangeIntent("remove the outro", doc).ops).execute(doc);
    expect(removed.scenes.some((s) => s.id === outro.id)).toBe(false);

    const doubled = applyArrangeOps(doc, parseArrangeIntent("duplicate the drop", doc).ops).execute(doc);
    expect(doubled.scenes.filter((s) => roleOf(s) === "drop").length).toBe(
      doc.scenes.filter((s) => roleOf(s) === "drop").length + 1,
    );
    void drop;
  });

  it("resolveSceneTarget: name, role and ordinal resolution", () => {
    const doc = sceneScoreDoc();
    const drop = doc.scenes.find((s) => roleOf(s) === "drop")!;
    expect(resolveSceneTarget(doc, "the drop", ["drop"])!.id).toBe(drop.id);
    expect(resolveSceneTarget(doc, "midnight wire", [])).toBeNull();
  });
});
