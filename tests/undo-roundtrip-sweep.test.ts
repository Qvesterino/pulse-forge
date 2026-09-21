import { describe, expect, it, vi } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import type { ProjectDocument } from "../src/project-model/types";
import * as C from "../src/commands/commands";
import type { Command } from "../src/commands/types";

/**
 * Undo round-trip SWEEP (GOAL 09): every command factory in the table is
 * executed against a real ProjectStore and undo must restore the exact
 * pre-command document (deep equality — the store's contract is that
 * everything is read post-normalize, so both sides are compared through
 * normalizeProject). The table spans every command domain. Cases needing
 * prior state chain setups through the STORE (fresh doc after each execute)
 * — a stale base doc is the classic sweep-authoring bug.
 */

type Case = {
  name: string;
  /** Sequential setup: each command runs against the store's FRESH doc. */
  setup?: ((store: ProjectStore) => void)[];
  build: (doc: ProjectDocument) => Command;
};

/** Execute a setup command against the store's current doc. */
function run(store: ProjectStore, build: (doc: ProjectDocument) => Command): void {
  store.execute(build(store.doc));
}

function drumOf(doc: ProjectDocument) {
  const drum = doc.tracks.find((t) => t.kind === "drum");
  if (!drum || !("pads" in drum)) throw new Error("template has no drum track");
  return drum as ProjectDocument["tracks"][number] & { pads: { id: string }[] };
}

function instrumentOf(doc: ProjectDocument) {
  const track = doc.tracks.find((t) => t.kind === "instrument");
  if (!track) throw new Error("template has no instrument track");
  return track;
}

function groupOf(doc: ProjectDocument) {
  const group = doc.tracks.find((t) => t.kind === "group");
  if (!group) throw new Error("no group track in setup");
  return group;
}

/**
 * Marker notes carry a pitch NO template note uses (99/98) so the sweep
 * targets ITS OWN setup notes regardless of template content or list order.
 */
function markerNoteId(doc: ProjectDocument, trackId: string): string {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  const notes = (pattern?.notes as unknown as Record<string, { id: string; pitch: number }[] | undefined>)?.[trackId];
  const first = notes?.find((n) => n.pitch === 99)?.id;
  if (!first) throw new Error("marker note missing");
  return first;
}

/** First bar BEYOND every existing arrangement clip (template ships clips). */
function freeBar(doc: ProjectDocument): number {
  return doc.arrangement.clips.reduce((max, clip) => Math.max(max, clip.startBar + clip.lengthBars), 0) + 1;
}

const addNoteTo = (pitch = 61, start = 0, duration = 120) => (store: ProjectStore) =>
  run(store, (d) => C.addNote(d, instrumentOf(d).id, { pitch, start, duration, velocity: 0.7 }));

const CASES: Case[] = [
  // ── project ──
  { name: "setProjectName", build: (d) => C.setProjectName(d, "Renamed") },
  { name: "setBpm", build: (d) => C.setBpm(d, 150) },
  { name: "setGroove", build: (d) => C.setGroove(d, { swing: 0.3 }) },
  // ── steps ──
  { name: "toggleStep", build: (d) => C.toggleStep(d, drumOf(d).pads[0]!.id, 0) },
  {
    name: "setStepVelocityCommand",
    setup: [(store) => run(store, (d) => C.toggleStep(d, drumOf(d).pads[0]!.id, 0))],
    build: (d) => C.setStepVelocityCommand(d, drumOf(d).pads[0]!.id, 0, 0.5),
  },
  { name: "setPadParams", build: (d) => C.setPadParams(d, drumOf(d).pads[0]!.id, { gain: 1.2, pan: -0.25 }) },
  {
    name: "setPadColor",
    build: (d) => C.setPadColor(d, drumOf(d).id, drumOf(d).pads[0]!.id, "#ff8800"),
  },
  {
    name: "setStepsVelocity",
    setup: [(store) => run(store, (d) => C.toggleStep(d, drumOf(d).pads[0]!.id, 0))],
    build: (d) =>
      C.setStepsVelocity(d, d.activePatternId, [{ padId: drumOf(d).pads[0]!.id, stepIndex: 0, velocity: 0.9 }]),
  },
  // ── patterns ──
  { name: "createPattern", build: (d) => C.createPattern(d, "New Pattern") },
  { name: "duplicatePattern", build: (d) => C.duplicatePattern(d, d.patterns[0]!.id) },
  { name: "renamePattern", build: (d) => C.renamePattern(d, d.patterns[0]!.id, "Renamed Pattern") },
  { name: "setPatternLength", build: (d) => C.setPatternLength(d, d.patterns[0]!.id, 32) },
  { name: "clearPattern", build: (d) => C.clearPattern(d, d.patterns[0]!.id) },
  {
    name: "setActivePattern",
    setup: [(store) => run(store, (d) => C.createPattern(d, "Other"))],
    build: (d) => C.setActivePattern(d, d.patterns[0]!.id),
  },
  {
    name: "deletePattern (setup: create spare)",
    setup: [(store) => run(store, (d) => C.createPattern(d, "Spare"))],
    build: (d) => C.deletePattern(d, d.patterns[d.patterns.length - 1]!.id),
  },
  // ── tracks / groups / returns ──
  { name: "createDrumTrack", build: (d) => C.createDrumTrack(d) },
  { name: "createInstrumentTrack", build: (d) => C.createInstrumentTrack(d, "keys") },
  { name: "createGroupTrack", build: (d) => C.createGroupTrack(d) },
  { name: "createReturnTrack", build: (d) => C.createReturnTrack(d, "Rev Return") },
  {
    name: "deleteTrack (setup: spare instrument)",
    setup: [(store) => run(store, (d) => C.createInstrumentTrack(d, "keys"))],
    build: (d) => C.deleteTrack(d, d.tracks[d.tracks.length - 1]!.id),
  },
  { name: "duplicateTrack", build: (d) => C.duplicateTrack(d, instrumentOf(d).id) },
  { name: "setTrackParams", build: (d) => C.setTrackParams(d, instrumentOf(d).id, { gain: 0.42, pan: 0.2 }) },
  { name: "setTrackColor", build: (d) => C.setTrackColor(d, instrumentOf(d).id, "#00ffcc") },
  {
    name: "addToGroup",
    setup: [(store) => run(store, (d) => C.createGroupTrack(d))],
    build: (d) => C.addToGroup(d, instrumentOf(d).id, groupOf(d).id),
  },
  {
    name: "setGroupCollapsed",
    setup: [(store) => run(store, (d) => C.createGroupTrack(d))],
    build: (d) => C.setGroupCollapsed(d, groupOf(d).id, true),
  },
  {
    name: "setGroupMute",
    setup: [(store) => run(store, (d) => C.createGroupTrack(d))],
    build: (d) => C.setGroupMute(d, groupOf(d).id, true),
  },
  {
    name: "removeFromGroup",
    setup: [
      (store) => run(store, (d) => C.createGroupTrack(d)),
      (store) => run(store, (d) => C.addToGroup(d, instrumentOf(d).id, groupOf(d).id)),
    ],
    build: (d) => C.removeFromGroup(d, instrumentOf(d).id),
  },
  // ── FX ──
  { name: "addEffectToTracks", build: (d) => C.addEffectToTracks(d, [instrumentOf(d).id], "delay") },
  {
    name: "removeEffectFromTracks",
    setup: [(store) => run(store, (d) => C.addEffectToTracks(d, [instrumentOf(d).id], "delay"))],
    build: (d) => C.removeEffectFromTracks(d, [instrumentOf(d).id], "delay"),
  },
  {
    name: "setEffectBypassOnTracks",
    setup: [(store) => run(store, (d) => C.addEffectToTracks(d, [instrumentOf(d).id], "delay"))],
    build: (d) => C.setEffectBypassOnTracks(d, [instrumentOf(d).id], "delay", true),
  },
  {
    name: "clearAllSolos",
    setup: [(store) => run(store, (d) => C.setTrackParams(d, instrumentOf(d).id, { solo: true }))],
    build: (d) => C.clearAllSolos(d),
  },
  // ── notes ──
  { name: "addNote", build: (d) => C.addNote(d, instrumentOf(d).id, { pitch: 61, start: 0, duration: 120, velocity: 0.7 }) },
  {
    name: "deleteNote",
    setup: [addNoteTo(99, 3, 150)],
    build: (d) => C.deleteNote(d, instrumentOf(d).id, markerNoteId(d, instrumentOf(d).id)),
  },
  {
    name: "moveNote",
    setup: [addNoteTo(99, 3, 150)],
    build: (d) => C.moveNote(d, instrumentOf(d).id, markerNoteId(d, instrumentOf(d).id), { start: 240, pitch: 62 }),
  },
  {
    name: "resizeNote",
    setup: [addNoteTo(99, 3, 150)],
    build: (d) => C.resizeNote(d, instrumentOf(d).id, markerNoteId(d, instrumentOf(d).id), 240),
  },
  {
    name: "setNoteVelocity",
    setup: [addNoteTo(99, 3, 150)],
    build: (d) => C.setNoteVelocity(d, instrumentOf(d).id, markerNoteId(d, instrumentOf(d).id), 0.3),
  },
  {
    name: "quantizeNotes",
    setup: [addNoteTo(99, 7, 120), addNoteTo(98, 131, 90)],
    build: (d) => {
      const pattern = d.patterns.find((p) => p.id === d.activePatternId);
      const notes = (pattern?.notes as unknown as Record<string, { id: string; pitch: number }[]>)?.[
        instrumentOf(d).id
      ];
      const marker = notes?.find((n) => n.pitch === 98)?.id;
      if (!marker) throw new Error("second marker note missing");
      return C.quantizeNotes(d, instrumentOf(d).id, [markerNoteId(d, instrumentOf(d).id), marker], 16, 1);
    },
  },
  {
    name: "splitNotes",
    setup: [addNoteTo(99, 0, 480)],
    build: (d) => C.splitNotes(d, instrumentOf(d).id, [markerNoteId(d, instrumentOf(d).id)]),
  },
  {
    name: "glueNotes",
    setup: [addNoteTo(99, 0, 120), addNoteTo(99, 120, 120)],
    build: (d) => {
      const pattern = d.patterns.find((p) => p.id === d.activePatternId);
      const notes = (pattern?.notes as unknown as Record<string, { id: string; pitch: number; start: number }[]>)?.[
        instrumentOf(d).id
      ];
      const mine = (notes ?? []).filter((n) => n.pitch === 99).sort((a, b) => a.start - b.start);
      return C.glueNotes(d, instrumentOf(d).id, [mine[0]!.id, mine[1]!.id]);
    },
  },
  // ── instrument ──
  { name: "setInstrumentParam", build: (d) => C.setInstrumentParam(d, instrumentOf(d).id, "attack", 0.25) },
  {
    name: "setInstrumentSample (clear a real value)",
    setup: [(store) => run(store, (d) => C.setInstrumentSample(d, instrumentOf(d).id, "user.fake-sample"))],
    build: (d) => C.setInstrumentSample(d, instrumentOf(d).id, null),
  },
  // ── scenes ──
  { name: "createScene", build: (d) => C.createScene(d, "New Scene") },
  { name: "renameScene", build: (d) => C.renameScene(d, d.scenes[0]!.id, "Renamed Scene") },
  { name: "setSceneRole", build: (d) => C.setSceneRole(d, d.scenes[0]!.id, "drop") },
  {
    name: "reorderScenes",
    setup: [(store) => run(store, (d) => C.createScene(d, "Second"))],
    build: (d) => C.reorderScenes(d, 1, 0),
  },
  {
    name: "deleteScene (setup: spare)",
    setup: [(store) => run(store, (d) => C.createScene(d, "Spare"))],
    build: (d) => C.deleteScene(d, d.scenes[d.scenes.length - 1]!.id),
  },
  // ── arrangement clips ──
  {
    name: "addArrangementClip (past template clips)",
    build: (d) => C.addArrangementClip(d, d.scenes[0]!.id, freeBar(d), 4),
  },
  {
    name: "moveArrangementClip",
    setup: [(store) => run(store, (d) => C.addArrangementClip(d, d.scenes[0]!.id, freeBar(d), 4))],
    build: (d) => C.moveArrangementClip(d, d.arrangement.clips[d.arrangement.clips.length - 1]!.id, freeBar(d) + 8),
  },
  {
    name: "resizeArrangementClip",
    setup: [(store) => run(store, (d) => C.addArrangementClip(d, d.scenes[0]!.id, freeBar(d), 4))],
    build: (d) => C.resizeArrangementClip(d, d.arrangement.clips[d.arrangement.clips.length - 1]!.id, 8),
  },
  {
    name: "duplicateArrangementClip",
    setup: [(store) => run(store, (d) => C.addArrangementClip(d, d.scenes[0]!.id, freeBar(d), 4))],
    build: (d) => C.duplicateArrangementClip(d, d.arrangement.clips[d.arrangement.clips.length - 1]!.id),
  },
  {
    name: "deleteArrangementClip",
    setup: [(store) => run(store, (d) => C.addArrangementClip(d, d.scenes[0]!.id, freeBar(d), 4))],
    build: (d) => C.deleteArrangementClip(d, d.arrangement.clips[d.arrangement.clips.length - 1]!.id),
  },
  // ── arrangement transitions ──
  {
    name: "addArrangementTransition",
    setup: [
      (store) => run(store, (d) => C.addArrangementClip(d, d.scenes[0]!.id, freeBar(d), 4)),
      (store) => run(store, (d) => C.addArrangementClip(d, d.scenes[0]!.id, freeBar(d) + 8, 4)),
    ],
    build: (d) =>
      C.addArrangementTransition(
        d,
        d.arrangement.clips[d.arrangement.clips.length - 2]!.id,
        d.arrangement.clips[d.arrangement.clips.length - 1]!.id,
        "fill",
      ),
  },
  {
    name: "removeArrangementTransition",
    setup: [
      (store) => run(store, (d) => C.addArrangementClip(d, d.scenes[0]!.id, freeBar(d), 4)),
      (store) => run(store, (d) => C.addArrangementClip(d, d.scenes[0]!.id, freeBar(d) + 8, 4)),
      (store) =>
        run(store, (d) =>
          C.addArrangementTransition(
            d,
            d.arrangement.clips[d.arrangement.clips.length - 2]!.id,
            d.arrangement.clips[d.arrangement.clips.length - 1]!.id,
            "fill",
          ),
        ),
    ],
    build: (d) =>
      C.removeArrangementTransition(d, d.arrangement.transitions?.[d.arrangement.transitions.length - 1]!.id!),
  },
  // ── automation ──
  {
    name: "addAutomationLane",
    build: (d) => C.addAutomationLane(d, { kind: "trackGain", trackId: instrumentOf(d).id }),
  },
  {
    name: "addAutomationPoint",
    setup: [(store) => run(store, (d) => C.addAutomationLane(d, { kind: "trackGain", trackId: instrumentOf(d).id }))],
    build: (d) => C.addAutomationPoint(d, d.automation[0]!.id, 0, 0.8),
  },
  {
    name: "removeAutomationLane",
    setup: [(store) => run(store, (d) => C.addAutomationLane(d, { kind: "trackGain", trackId: instrumentOf(d).id }))],
    build: (d) => C.removeAutomationLane(d, d.automation[0]!.id),
  },
  // ── LFOs / macros ──
  { name: "addLfo", build: (d) => C.addLfo(d, instrumentOf(d).id, "osc") },
  {
    name: "setLfoParams",
    setup: [(store) => run(store, (d) => C.addLfo(d, instrumentOf(d).id, "osc"))],
    build: (d) => {
      // Lfo fields are amount + rateHz (NOT rate/depth — junk keys would be
      // stripped by normalize, silently turning the command into a no-op).
      const current = d.lfos[0]!;
      return C.setLfoParams(d, d.lfos[0]!.id, {
        amount: current.amount === 0.9 ? 0.2 : 0.9,
        rateHz: current.rateHz === 0.5 ? 6.5 : 0.5,
      });
    },
  },
  { name: "setMacroValue", build: (d) => C.setMacroValue(d, d.macros[0]!.id, 0.2) },
  { name: "renameMacro", build: (d) => C.renameMacro(d, d.macros[0]!.id, "Filter Macro") },
];

/**
 * Note lists are SETS semantically (each note carries absolute start/pitch;
 * playback and rendering iterate order-independently). Some undos restore a
 * deleted note by append rather than original index — same set, different
 * order. The sweep canonicalizes that order so only real state drift fails.
 */
function canonize(doc: ProjectDocument): ProjectDocument {
  const clone = structuredClone(doc);
  for (const pattern of clone.patterns) {
    const notes = pattern.notes as unknown as Record<string, { id: string }[] | undefined>;
    for (const key of Object.keys(notes ?? {})) {
      notes[key] = [...(notes[key] ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    }
  }
  return clone;
}

describe("undo round-trip sweep — execute → undo restores the exact pre-command doc (GOAL 09)", () => {
  for (const testCase of CASES) {
    it(`undo restores exactly: ${testCase.name}`, () => {
      const store = new ProjectStore(createProjectFromTemplate("house"));
      if (testCase.setup) for (const step of testCase.setup) step(store);
      const pre = canonize(normalizeProject(store.doc));

      store.execute(testCase.build(store.doc));
      // The command must actually change something (guards against a no-op
      // test entry passing trivially).
      expect(store.undoStackLength).toBeGreaterThan(0);

      store.undo();
      expect(canonize(store.doc)).toEqual(pre);
      // Redo lands back on the post-command state; undo returns again.
      store.redo();
      expect(canonize(store.doc)).not.toEqual(pre);
      store.undo();
      expect(canonize(store.doc)).toEqual(pre);
    });
  }
});

describe("undo/redo bounds, replaceDoc watermark, coalescing (GOAL 09)", () => {
  it("undo past history start and redo past end are safe no-ops", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    expect(() => store.undo()).not.toThrow();
    expect(() => store.redo()).not.toThrow();

    store.execute(C.setBpm(store.doc, 160));
    store.undo();
    expect(() => store.undo()).not.toThrow(); // past start
    store.redo();
    expect(() => store.redo()).not.toThrow(); // past end — no throw, no change
    expect(store.doc.bpm).toBe(160);
  });

  it("replaceDoc clears history and the saved-at watermark", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    store.execute(C.setBpm(store.doc, 170));
    store.setSaveStatus("saved");
    expect(store.lastSavedAt).not.toBeNull();

    const replacement = createProjectFromTemplate("trap");
    store.replaceDoc(replacement);

    expect(store.undoStackLength).toBe(0);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
    expect(store.lastSavedAt).toBeNull();
    expect(store.doc.id).toBe(replacement.id);
  });

  it("same-key rapid commands coalesce into ONE undo step; different keys do not", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    try {
      const store = new ProjectStore(createProjectFromTemplate("house"));
      const track = store.doc.tracks.find((t) => t.kind === "instrument")!;

      // GranularPanel-style drag: factories have no key arg — callers attach
      // one (spread) exactly like GranularPanel does.
      const drag = (v: number) => ({
        ...C.setInstrumentParam(store.doc, track.id, "attack", v),
        coalesceKey: "granular-drag",
      });
      store.execute(drag(0.1));
      vi.setSystemTime(new Date("2026-09-21T12:00:00.400Z"));
      store.execute(drag(0.3));
      vi.setSystemTime(new Date("2026-09-21T12:00:00.800Z"));
      store.execute(drag(0.5));
      expect(store.undoStackLength).toBe(1);
      store.undo();
      const restored = store.doc.tracks.find((t) => t.id === track.id) as unknown as { params: Record<string, number> };
      expect(restored.params).toEqual(track.params);

      // Different keys inside the window stay separate steps.
      store.execute({ ...C.setInstrumentParam(store.doc, track.id, "attack", 0.1), coalesceKey: "drag-a" });
      store.execute({ ...C.setInstrumentParam(store.doc, track.id, "attack", 0.2), coalesceKey: "drag-b" });
      expect(store.undoStackLength).toBe(2); // undo popped the coalesced gesture; +2 separate
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DEBUG note diffs", () => {
  function diffKeys(pre: unknown, post: unknown, path = ""): void {
    const p = pre as Record<string, unknown>;
    const q = post as Record<string, unknown>;
    if (JSON.stringify(p) === JSON.stringify(q)) return;
    if (typeof p !== "object" || typeof q !== "object" || p === null || q === null) {
      console.log("DIFF", path, JSON.stringify(p)?.slice(0, 120), "VS", JSON.stringify(q)?.slice(0, 120));
      return;
    }
    const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
    for (const k of keys) diffKeys(p[k as keyof typeof p], q[k as keyof typeof q], `${path}.${k}`);
  }
  it("deleteNote undo diff", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const instr = store.doc.tracks.find((t) => t.kind === "instrument")!;
    store.execute(C.addNote(store.doc, instr.id, { pitch: 61, start: 0, duration: 120, velocity: 0.7 }));
    const noteId = (store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!.notes as Record<string, { id: string }[]>)[instr.id]![0]!.id;
    store.execute(C.deleteNote(store.doc, instr.id, noteId));
    const pre = normalizeProject(store.doc);
    store.undo();
    diffKeys(pre, store.doc, "root");
  });
  it("resizeNote redo diff", () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const instr = store.doc.tracks.find((t) => t.kind === "instrument")!;
    store.execute(C.addNote(store.doc, instr.id, { pitch: 61, start: 0, duration: 120, velocity: 0.7 }));
    const pattern = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!;
    const notes = pattern.notes as Record<string, { id: string; duration: number }[]>;
    const noteId = notes[instr.id]![0]!.id;
    console.log("note count:", notes[instr.id]!.length, "durations:", notes[instr.id]!.map((n) => n.duration));
    const pre = normalizeProject(store.doc);
    store.execute(C.resizeNote(store.doc, instr.id, noteId, 240));
    const post = normalizeProject(store.doc);
    const postNotes = (post.patterns.find((p) => p.id === store.doc.activePatternId)!.notes as Record<string, { id: string; duration: number }[]>)[instr.id]!;
    console.log("after execute durations:", postNotes?.map((n) => n.duration), "target id:", noteId);
    console.log("execute changed:", JSON.stringify(pre) !== JSON.stringify(post));
    store.undo();
    store.redo();
    const redone = (store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!.notes as Record<string, { id: string; duration: number }[]>)[instr.id]!;
    console.log("after redo durations:", redone?.map((n) => n.duration), "count:", redone?.length);
  });
});
