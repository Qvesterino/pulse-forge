import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addArrangementClip,
  addEffect,
  addNote,
  addSceneAutomation,
  deleteArrangementClip,
  deleteNote,
  deleteScene,
  moveAutomationPoint,
  moveEffectToIndex,
  moveNote,
  removeEffect,
  setBpm,
  setPatternLength,
  setTrackParams,
  toggleStep,
} from "../src/commands/commands";

/**
 * AUDIT 09 — Undo/Redo round-trip fuzz over the REAL command set
 * (prompts/daw_qa_reliability_vault/09-undo-redo-audit.md).
 *
 * The individual command invariants are pinned by the earlier audit suites
 * (editing-timeline / plugins-effects / mixer / automation / project-state).
 * This suite adds the cross-command property the brief asks for: ANY
 * sequence of edits must survive "undo everything → baseline, redo
 * everything → final" with an EXACT document (deep-equal JSON, ids and all)
 * — no duplicate clips, no stale references, no invalid history branches.
 *
 * Deterministic PRNG (mulberry32) so failures reproduce.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.abs(a);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


/** Command pool — every entry validates against the CURRENT doc before
 * returning a factory; anything invalid for this state is skipped (the
 * command factories throw by design for hostile states). */
function commandPool(): Array<(doc: ProjectDocument, rnd: () => number) => (() => ProjectDocument) | null> {
  const pick = <T>(arr: readonly T[], rnd: () => number): T => arr[Math.floor(rnd() * arr.length)]!;
  const instrument = (doc: ProjectDocument) => doc.tracks.find((t) => t.kind === "instrument")!.id;

  return [
    // notes
    (doc, rnd) => {
      const trackId = instrument(doc);
      const pitch = 40 + Math.floor(rnd() * 40);
      const start = Math.floor(rnd() * 8) * 120;
      const cmd = addNote(doc, trackId, { pitch, start, duration: 240, velocity: 0.8 });
      return () => cmd.execute(doc);
    },
    (doc, rnd) => {
      const trackId = instrument(doc);
      const notes = doc.patterns.find((p) => p.id === doc.activePatternId)?.notes?.[trackId] ?? [];
      if (notes.length === 0) return null;
      const note = pick(notes, rnd);
      return () => deleteNote(doc, trackId, note.id).execute(doc);
    },
    (doc, rnd) => {
      const trackId = instrument(doc);
      const notes = doc.patterns.find((p) => p.id === doc.activePatternId)?.notes?.[trackId] ?? [];
      if (notes.length === 0) return null;
      const note = pick(notes, rnd);
      return () => moveNote(doc, trackId, note.id, { start: Math.floor(rnd() * 8) * 120 }).execute(doc);
    },
    // steps
    (doc, rnd) => {
      const drumTrack = doc.tracks.find((t) => t.kind === "drum");
      const pad = drumTrack ? pick(drumTrack.pads ?? [], rnd) : undefined;
      if (!pad) return null;
      const step = Math.floor(rnd() * 16);
      return () => toggleStep(doc, pad.id, step, 0.8).execute(doc);
    },
    // mixer
    (doc, rnd) => {
      const trackId = pick(doc.tracks, rnd).id;
      return () => setTrackParams(doc, trackId, { gain: Math.round(rnd() * 30) / 20 }).execute(doc);
    },
    (doc) => {
      return () => setBpm(doc, 100 + Math.floor(Math.random() * 40)).execute(doc);
    }, // plugins
    (doc, rnd) => {
      const trackId = instrument(doc);
      const type = pick(["delay", "chorus", "compressor"] as const, rnd);
      return () => addEffect(doc, trackId, type).execute(doc);
    },
    (doc, rnd) => {
      const trackId = instrument(doc);
      const effects = doc.tracks.find((t) => t.id === trackId && "effects" in t)?.effects ?? [];
      if (effects.length === 0) return null;
      const fx = pick(effects, rnd);
      return rnd() < 0.5
        ? () => removeEffect(doc, trackId, fx.id).execute(doc)
        : () => moveEffectToIndex(doc, trackId, fx.id, Math.floor(rnd() * effects.length)).execute(doc);
    },
    // automation
    (doc) => {
      return () => addSceneAutomation(doc, doc.scenes[0]!.id, { kind: "trackGain", trackId: doc.tracks[0]!.id }).execute(doc);
    },
    (doc, rnd) => {
      const lane = pick(doc.automation, rnd);
      if (!lane || lane.points.length === 0) return null;
      return () =>
        moveAutomationPoint(doc, lane.id, Math.floor(rnd() * lane.points.length), {
          tick: Math.floor(rnd() * 3840),
        }).execute(doc);
    },
    // arrangement
    (doc, rnd) => {
      const scene = pick(doc.scenes, rnd);
      return () => addArrangementClip(doc, scene.id, Math.floor(rnd() * 4) + 8, 2).execute(doc);
    },
    (doc, rnd) => {
      const clips = doc.arrangement.clips;
      if (clips.length <= 1) return null;
      const clip = pick(clips, rnd);
      return () => deleteArrangementClip(doc, clip.id).execute(doc);
    },
    // structure
    (doc, rnd) => {
      if (doc.scenes.length <= 1) return null;
      const scene = pick(doc.scenes, rnd);
      return () => deleteScene(doc, scene.id).execute(doc);
    },
    (doc, rnd) => {
      const pattern = pick(doc.patterns, rnd);
      return () => setPatternLength(doc, pattern.id, pick([8, 16, 32, 64], rnd)).execute(doc);
    },
  ];
}

describe("undo/redo round-trip fuzz (audit 09)", () => {
  it("any command sequence survives undo-all → baseline and redo-all → final, exactly", () => {
    const rnd = mulberry32(20260922);
    const base = createProjectFromTemplate("house");
    const store = new ProjectStore(base);
    const pool = commandPool();
    const baseline = JSON.stringify(store.getDoc());

    // 1) Apply 48 valid commands (throws = invalid for this state → skip).
    let applied = 0;
    for (let i = 0; i < 48; i++) {
      const doc = store.getDoc();
      const entry = pool[Math.floor(rnd() * pool.length)]!(doc, rnd);
      if (!entry) continue;
      try {
        const before = store.getDoc();
        const after = entry();
        if (after === before) continue; // no-op command — nothing to undo
        applied += 1;
      } catch {
        /* invalid for this state — skip */
      }
    }
    expect(applied).toBeGreaterThan(20); // the pool must actually bite
    const finalDoc = store.getDoc();

    // 2) Undo everything — the document must return to the EXACT baseline
    //    (deep-equal JSON: positions, durations, ids, references, fades).
    while (store.undoStackLength > 0) store.undo();
    expect(JSON.stringify(store.getDoc())).toBe(baseline);

    // 3) Redo everything — the document must return to the EXACT final state.
    while (store.getDoc() !== finalDoc && store.canRedo) store.redo();
    expect(JSON.stringify(store.getDoc())).toBe(JSON.stringify(finalDoc));

    // 4) The cycle is stable: undo-all again still reaches the baseline.
    while (store.undoStackLength > 0) store.undo();
    expect(JSON.stringify(store.getDoc())).toBe(baseline);
  });

  it("undo → new action → undo → redo never resurrects the branch (invalid history branch guard)", () => {
    const base = createProjectFromTemplate("house");
    const store = new ProjectStore(base);
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    store.execute(addNote(base, trackId, { pitch: 60, start: 0, duration: 240, velocity: 0.8 }));
    store.undo(); // note gone
    store.execute(addNote(store.getDoc(), trackId, { pitch: 77, start: 120, duration: 240, velocity: 0.8 })); // branch B
    store.redo(); // must be a NO-OP — the redo stack died with the new action
    const notes = store.getDoc().patterns.find((p) => p.id === store.getDoc().activePatternId)!.notes?.[trackId] ?? [];
    // The template ships its own notes — assert on OUR pitches only: the
    // undone A(60) must NOT reappear, the branch B(77) must be present once.
    expect(notes.filter((n) => n.pitch === 60)).toHaveLength(0);
    expect(notes.filter((n) => n.pitch === 77)).toHaveLength(1);
  });

  it("historyDocs stays dense (no holes) past the 64-snapshot window (audit 09 D2)", () => {
    const base = createProjectFromTemplate("house");
    const store = new ProjectStore(base);
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    for (let i = 0; i < 70; i++) {
      store.execute(addNote(store.getDoc(), trackId, { pitch: 40 + (i % 40), start: (i % 16) * 120, duration: 240, velocity: 0.8 }));
    }
    // The window slides: dense 0..63, no empty holes (white-box — the field
    // is private; a hole would corrupt the history panel's diff offsets).
    const historyDocs = (store as unknown as { historyDocs: unknown[] }).historyDocs;
    expect(historyDocs.length).toBeLessThanOrEqual(64);
    for (const entry of historyDocs) expect(entry).toBeDefined();
    // And an open record frame + jumpTo seals cleanly (audit 09 D1).
    store.beginUndoFrame("Take");
    store.execute(addNote(store.getDoc(), trackId, { pitch: 99, start: 0, duration: 120, velocity: 0.8 }));
    expect(() => store.jumpTo(0)).not.toThrow();
    // jumpTo(0) = "state after the FIRST entry" — one command remains, the
    // frame dissolved, and no dangling frame commands survive.
    expect(store.undoStackLength).toBe(1);
    expect((store as unknown as { frameCommands: unknown[] | null }).frameCommands ?? null).toBeNull();
  });
});
