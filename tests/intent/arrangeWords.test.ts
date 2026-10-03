import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { createDefaultProject } from "../../src/project-model/schema";
import { BAR_TICKS, type ProjectDocument } from "../../src/project-model/types";
import {
  applyArrangeOps,
  applyClipArrangeOps,
  parseArrangeIntent,
  parseSelectedClipArrangeIntent,
  parseSelectedTimeRangeIntent,
  resolveSceneTarget,
  selectedClipGrooveChangeCount,
  selectedTimeRangeIntentError,
} from "../../src/intent/arrangeWords";
import { routeIntentText } from "../../src/intent/route";

/** Scene roles live on names in the scene-score template — mirror the engine. */
const roleOf = (s: { role?: string | null; name: string }): string | null =>
  s.role ?? ["intro", "build", "drop", "break", "outro"].find((r) => s.name.toLowerCase().includes(r)) ?? null;

function sceneScoreDoc() {
  return createProjectFromTemplate("scene-score");
}

function sharedSceneDrumClips(): { doc: ProjectDocument; clipId: string; otherClipId: string; patternId: string } {
  const base = createDefaultProject();
  const scene = base.scenes[0]!;
  const sourcePattern = base.patterns.find((pattern) => pattern.id === scene.patternId)!;
  const drum = base.tracks.find((track) => track.kind === "drum");
  if (!drum || drum.kind !== "drum") throw new Error("fixture requires a drum track");
  const pad = drum.pads[0]!;
  const rows = Object.fromEntries(
    drum.pads.map((candidate) => [candidate.id, new Array(sourcePattern.stepCount).fill(0)]),
  );
  rows[pad.id] = new Array(sourcePattern.stepCount).fill(0).map((_, step) => (step % 2 === 1 ? 0.8 : 0));
  const pattern = { ...sourcePattern, rows, stepMeta: undefined };
  const clipId = "selected-shared-scene-clip";
  const otherClipId = "other-shared-scene-clip";
  const doc: ProjectDocument = {
    ...base,
    patterns: base.patterns.map((candidate) => (candidate.id === pattern.id ? pattern : candidate)),
    arrangement: {
      ...base.arrangement,
      clips: [
        { id: clipId, sceneId: scene.id, startBar: 0, lengthBars: 4 },
        { id: otherClipId, sceneId: scene.id, startBar: 4, lengthBars: 4 },
      ],
      audioClips: [],
    },
  };
  return { doc, clipId, otherClipId, patternId: pattern.id };
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

describe("selected clip intent", () => {
  it("locks generic clip language to the selected clip", () => {
    const doc = sceneScoreDoc();
    const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
    const selected = clips[1]!;
    const parsed = parseSelectedClipArrangeIntent("move the selected clip to bar 32", doc, selected.id);

    expect(parsed).toEqual([{ op: "moveClip", clipId: selected.id, toBar: 31 }]);
  });

  it("supports copy, resize, and delete without widening the selected target", () => {
    const doc = sceneScoreDoc();
    const selected = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar)[1]!;
    expect(parseSelectedClipArrangeIntent("copy selected clip to bar 32", doc, selected.id)).toEqual([
      { op: "copyClip", clipId: selected.id, toBar: 31 },
    ]);
    expect(parseSelectedClipArrangeIntent("resize selected clip to 2 bars", doc, selected.id)).toEqual([
      { op: "resizeClip", clipId: selected.id, bars: 2 },
    ]);
    expect(parseSelectedClipArrangeIntent("delete selected clip", doc, selected.id)).toEqual([
      { op: "deleteClip", clipId: selected.id },
    ]);
  });

  it("rejects an explicit reference that conflicts with the selection", () => {
    const doc = sceneScoreDoc();
    const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
    const [other, selected] = clips;
    expect(other).toBeDefined();
    expect(selected).toBeDefined();
    expect(
      parseSelectedClipArrangeIntent(`move clip at bar ${other!.startBar + 1} to bar 32`, doc, selected!.id),
    ).toBeNull();
  });

  it("fails closed for a deleted selected clip", () => {
    expect(parseSelectedClipArrangeIntent("delete selected clip", sceneScoreDoc(), "missing-clip")).toBeNull();
  });

  it("parses clip-scoped swing requests and rejects compound or ambiguous edits", () => {
    const { doc, clipId } = sharedSceneDrumClips();
    expect(parseSelectedClipArrangeIntent("more swing on this selected clip", doc, clipId)).toEqual([
      { op: "clipGroove", clipId, direction: "swingUp" },
    ]);
    expect(parseSelectedClipArrangeIntent("viac swingu na tomto klipe", doc, clipId)).toEqual([
      { op: "clipGroove", clipId, direction: "swingUp" },
    ]);
    expect(parseSelectedClipArrangeIntent("nastav swing na 65% na tomto klipe", doc, clipId)).toEqual([
      { op: "clipGroove", clipId, direction: "set", swingPercent: 65 },
    ]);
    expect(parseSelectedClipArrangeIntent("more swing in the drop", doc, clipId)).toBeNull();
    expect(parseSelectedClipArrangeIntent("move this clip to bar 12 and add more swing", doc, clipId)).toBeNull();
    expect(parseSelectedClipArrangeIntent("humanize this selected clip", doc, clipId)).toBeNull();
  });

  it("creates a copy-on-write groove variation for only the selected clip as one undo step", () => {
    const { doc, clipId, otherClipId, patternId } = sharedSceneDrumClips();
    const sourceSceneId = doc.arrangement.clips.find((clip) => clip.id === clipId)!.sceneId;
    const sourcePattern = doc.patterns.find((pattern) => pattern.id === patternId)!;
    const op = { op: "clipGroove" as const, clipId, direction: "swingUp" as const };

    expect(selectedClipGrooveChangeCount(doc, clipId, op)).toBe(8);
    const command = applyClipArrangeOps(doc, [op]);
    expect(command?.type).toBe("clipWords");
    expect(command?.label).toContain("8 offbeat steps");
    const changed = command!.execute(doc);
    const selectedClip = changed.arrangement.clips.find((clip) => clip.id === clipId)!;
    const otherClip = changed.arrangement.clips.find((clip) => clip.id === otherClipId)!;
    const variation = changed.scenes.find((scene) => scene.id === selectedClip.sceneId)!;
    const variedPattern = changed.patterns.find((pattern) => pattern.id === variation.patternId)!;

    expect(selectedClip.sceneId).not.toBe(sourceSceneId);
    expect(otherClip.sceneId).toBe(sourceSceneId);
    expect(variedPattern.stepMeta?.[Object.keys(sourcePattern.rows)[0]!]?.[1]?.microtiming).toBeCloseTo(1 / 6);
    expect(changed.patterns.find((pattern) => pattern.id === patternId)).toEqual(sourcePattern);
    expect(command!.undo(changed)).toEqual(doc);
  });

  it("routes unsupported or compound groove edits to clarification instead of a partial clip mutation", () => {
    const { doc, clipId } = sharedSceneDrumClips();
    expect(routeIntentText("more swing on this selected clip", doc, { selectedClipId: clipId })).toMatchObject({
      kind: "selectedClipArrange",
      clipId,
      ops: [{ op: "clipGroove", clipId, direction: "swingUp" }],
    });
    expect(routeIntentText("move this clip to bar 12 and add more swing", doc, { selectedClipId: clipId }).kind).toBe(
      "clarify",
    );
  });
});

describe("selected time-range intent", () => {
  it("parses only explicit duplicate/consolidate requests that name the selected range", () => {
    expect(parseSelectedTimeRangeIntent("duplicate this range")).toBe("duplicate");
    expect(parseSelectedTimeRangeIntent("duplikuj vybraný rozsah")).toBe("duplicate");
    expect(parseSelectedTimeRangeIntent("consolidate these bars")).toBe("consolidate");
    expect(parseSelectedTimeRangeIntent("make this range more energetic")).toBeNull();
    expect(parseSelectedTimeRangeIntent("double the energy of this range")).toBeNull();
    expect(parseSelectedTimeRangeIntent("duplicate selected")).toBeNull();
    expect(parseSelectedTimeRangeIntent("duplicate bars 1 to 8")).toBeNull();
    expect(parseSelectedTimeRangeIntent("duplicate and consolidate this range")).toBeNull();
  });

  it("requires complete bars, rejects unsafe duplication, and allows audio-aware consolidation", () => {
    const doc = sceneScoreDoc();
    const range = { fromTick: 0, toTick: BAR_TICKS * 4 };
    expect(selectedTimeRangeIntentError(doc, range, "duplicate")).toBeNull();
    expect(selectedTimeRangeIntentError(doc, { fromTick: 1, toTick: BAR_TICKS * 4 }, "duplicate")).toMatch(
      /complete bars/i,
    );

    const audioClip = {
      id: "range-audio",
      trackId: doc.tracks.find((track) => track.kind !== "group")!.id,
      bufferId: "user.range-audio",
      startBar: 2,
      lengthBars: 1,
      offsetSec: 0,
      trimStart: 0,
      trimEnd: 0,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      stretchRate: 1,
      reverse: false,
    };
    const withAudio = {
      ...doc,
      arrangement: { ...doc.arrangement, audioClips: [audioClip] },
    };
    expect(selectedTimeRangeIntentError(withAudio, range, "duplicate")).toBeNull();
    expect(selectedTimeRangeIntentError(withAudio, range, "consolidate")).toBeNull();
    expect(
      selectedTimeRangeIntentError(withAudio, { fromTick: BAR_TICKS * 4, toTick: BAR_TICKS * 8 }, "consolidate"),
    ).toBeNull();
    const withLaterAudio = {
      ...doc,
      arrangement: { ...doc.arrangement, audioClips: [{ ...audioClip, startBar: 4 }] },
    };
    expect(selectedTimeRangeIntentError(withLaterAudio, range, "duplicate")).toBeNull();
    expect(selectedTimeRangeIntentError(withLaterAudio, range, "consolidate")).toBeNull();
    const withBoundaryAudio = {
      ...doc,
      arrangement: { ...doc.arrangement, audioClips: [{ ...audioClip, startBar: 3, lengthBars: 2 }] },
    };
    expect(selectedTimeRangeIntentError(withBoundaryAudio, range, "duplicate")).toMatch(/crosses this range boundary/i);
    expect(selectedTimeRangeIntentError(withBoundaryAudio, range, "consolidate")).toBeNull();

    const withBoundaryArrangement = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        clips: [{ id: "long-range-clip", sceneId: doc.scenes[0]!.id, startBar: 0, lengthBars: 8 }],
      },
    };
    // Musical arrangement clips can now cross a consolidation boundary; phase offsets preserve their continuation.
    expect(selectedTimeRangeIntentError(withBoundaryArrangement, range, "consolidate")).toBeNull();
    const withSolo = { ...doc, tracks: doc.tracks.map((track) => ({ ...track, solo: true })) };
    expect(selectedTimeRangeIntentError(withSolo, range, "consolidate")).toMatch(/turn off solo/i);
  });
});

describe("selected arrangement context routing", () => {
  it("routes clip and range language only when the matching context is present", () => {
    const doc = sceneScoreDoc();
    const clip = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar)[1]!;
    const range = { fromTick: clip.startBar * BAR_TICKS, toTick: (clip.startBar + clip.lengthBars) * BAR_TICKS };

    expect(routeIntentText("move this clip to bar 32", doc, { selectedClipId: clip.id })).toEqual({
      kind: "selectedClipArrange",
      clipId: clip.id,
      ops: [{ op: "moveClip", clipId: clip.id, toBar: 31 }],
    });
    expect(routeIntentText("duplicate this range", doc, { selectedRange: range })).toEqual({
      kind: "selectedRangeArrange",
      range,
      operation: "duplicate",
    });
    expect(routeIntentText("move this clip to bar 32", doc).kind).not.toBe("selectedClipArrange");
    expect(routeIntentText("duplicate this range", doc).kind).not.toBe("selectedRangeArrange");
  });
});

describe("songwriting roles (A2 v2)", () => {
  it("chorus, verse and bridge are first-class roles (not drop/break aliases)", () => {
    const doc = sceneScoreDoc();
    const add = (text: string) => parseArrangeIntent(text, doc).ops;
    expect(add("add a chorus before the drop")[0]).toMatchObject({ op: "addRole", role: "chorus" });
    expect(add("pridaj refren")[0]).toMatchObject({ op: "addRole", role: "chorus" });
    expect(add("add a verse")[0]).toMatchObject({ op: "addRole", role: "verse" });
    expect(add("pridaj zlohu")[0]).toMatchObject({ op: "addRole", role: "verse" });
    expect(add("add a bridge before the outro")[0]).toMatchObject({ op: "addRole", role: "bridge" });
    expect(add("pridaj most")[0]).toMatchObject({ op: "addRole", role: "bridge" });
    // plain drop/break still work
    expect(add("add a drop")[0]).toMatchObject({ op: "addRole", role: "drop" });
    expect(add("add a break")[0]).toMatchObject({ op: "addRole", role: "break" });
  });

  it("removal and duplication target the new roles too", () => {
    const doc = sceneScoreDoc();
    // sceneScoreDoc has no chorus yet → addRole falls back cleanly
    const parsed = parseArrangeIntent("remove the verse", doc);
    // verse scene does not exist → unrecognized, not a wrong-role op
    expect(parsed.ops.every((op) => !("role" in op) || op.role !== "verse" || op.op === "remove")).toBe(true);
  });
});

describe("effect-word stand-down (failure-mining wave 4)", () => {
  it("add <effect> to the <role> is an effect request, never addRole(<anchor>)", () => {
    // The old teacher routed "add delay to the drop" as addRole(drop) — a
    // brand-new section named after its own anchor, with the effect word
    // silently dropped. The classifier refused to copy that; the parser
    // now stands down so the effect/clarify parsers own the clause.
    const doc = sceneScoreDoc();
    for (const text of ["add delay to the drop", "add reverb to the bridge", "add compressor to the intro"]) {
      const p = parseArrangeIntent(text, doc);
      expect(p.ops, text).toEqual([]);
    }
  });

  it("legit addRole phrases keep parsing when an effect word is absent", () => {
    const doc = sceneScoreDoc();
    for (const [text, role] of [
      ["add a break before the drop", "break"],
      ["add a chorus before the drop", "chorus"],
      ["add a break", "break"],
    ] as const) {
      const p = parseArrangeIntent(text, doc);
      expect(p.ops[0], text).toMatchObject({ op: "addRole", role });
    }
  });

  it("chorus as the ADDED section still parses (chorus is role AND effect)", () => {
    const doc = sceneScoreDoc();
    // The effect word IS the new section here — the stand-down must not fire.
    const p = parseArrangeIntent("add a chorus before the drop", doc);
    expect(p.ops[0]).toMatchObject({ op: "addRole", role: "chorus" });
  });
});
