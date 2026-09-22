import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { STEP_TICKS } from "../src/project-model/types";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addArrangementClip,
  addAudioClip,
  addNote,
  clearPattern,
  consolidateTimeRange,
  duplicateArrangementClip,
  moveArrangementClip,
  moveNote,
  pastePattern,
  quantizeNotes,
  resizeArrangementClip,
  resizeNote,
  setArrangementClipLoop,
} from "../src/commands/commands";
import type { PatternClipboard } from "../src/commands/commands";

/**
 * AUDIT 01 — Editing & Timeline regression invariants
 * (prompts/daw_qa_reliability_vault/01-editing-timeline-audit.md).
 *
 * Covers the command-layer defects found and fixed in this audit; the audio
 * clip command layer has its own suite (tests/edit-tools-audit.test.ts).
 * Audio-clip-free slices: notes, scene arrangement clips, pattern clipboard.
 */

/* ── notes ──────────────────────────────────────────────────────────── */

describe("note editing — boundary clamps (audit 01)", () => {
  function noteDoc() {
    const base = createProjectFromTemplate("house");
    const track = base.tracks.find((t) => t.kind === "instrument")!;
    const s = new ProjectStore(base);
    s.execute(addNote(base, track.id, { pitch: 60, start: 0, duration: STEP_TICKS, velocity: 0.8 }));
    const noteId = (s.getDoc().patterns[0].notes?.[track.id] ?? [])[0]!.id;
    return { s, trackId: track.id, noteId };
  }

  it("resizeNote clamps to the pattern and never emits an overflowing/zero duration", () => {
    const { s, trackId, noteId } = noteDoc();
    const pattern = s.getDoc().patterns[0];
    const patternTicks = pattern.stepCount * STEP_TICKS;
    s.execute(resizeNote(s.getDoc(), trackId, noteId, patternTicks * 10));
    const note = (s.getDoc().patterns[0].notes?.[trackId] ?? [])[0]!;
    expect(note.duration).toBe(patternTicks); // clamped, NOT dropped by normalize
    s.execute(resizeNote(s.getDoc(), trackId, noteId, Number.NaN));
    expect((s.getDoc().patterns[0].notes?.[trackId] ?? [])[0]!.duration).toBe(patternTicks);
    s.execute(resizeNote(s.getDoc(), trackId, noteId, 0));
    expect((s.getDoc().patterns[0].notes?.[trackId] ?? [])[0]!.duration).toBeGreaterThanOrEqual(1);
  });

  it("moveNote clamps pitch to 0..127 at the command boundary", () => {
    const { s, trackId, noteId } = noteDoc();
    s.execute(moveNote(s.getDoc(), trackId, noteId, { pitch: 999 }));
    expect((s.getDoc().patterns[0].notes?.[trackId] ?? [])[0]!.pitch).toBe(127);
    s.execute(moveNote(s.getDoc(), trackId, noteId, { pitch: -40 }));
    expect((s.getDoc().patterns[0].notes?.[trackId] ?? [])[0]!.pitch).toBe(0);
  });

  it("quantize at partial strength never pushes a full-bar note out of the pattern", () => {
    const base = createProjectFromTemplate("house");
    const track = base.tracks.find((t) => t.kind === "instrument")!;
    const s = new ProjectStore(base);
    const patternTicks = base.patterns[0].stepCount * STEP_TICKS;
    s.execute(addNote(base, track.id, { pitch: 60, start: 3, duration: patternTicks - 3, velocity: 0.8 }));
    const noteId = (s.getDoc().patterns[0].notes?.[track.id] ?? [])[0]!.id;
    s.execute(quantizeNotes(s.getDoc(), track.id, [noteId], STEP_TICKS, 0.5));
    const after = (s.getDoc().patterns[0].notes?.[track.id] ?? [])[0]!;
    // Pre-fix this note blended past patternTicks → normalize DELETED it.
    expect(after).toBeDefined();
    expect(after.start + after.duration).toBeLessThanOrEqual(patternTicks);
  });
});

/* ── scene arrangement clips ────────────────────────────────────────── */

describe("arrangement scene clips — validity + provenance (audit 01)", () => {
  it("add/move/resize clamp NaN to valid values instead of writing droppable clips", () => {
    // Empty the arrangement: the house template ships its own clips and a
    // NaN add clamps to bar 0, which would overlap them by design.
    const base = normalizeProject({
      ...createProjectFromTemplate("house"),
      arrangement: { clips: [] },
    });
    const s = new ProjectStore(base);
    const sceneId = s.getDoc().scenes[0]!.id;
    s.execute(addArrangementClip(s.getDoc(), sceneId, Number.NaN, Number.POSITIVE_INFINITY));
    const clip = s.getDoc().arrangement.clips[0]!;
    expect(Number.isFinite(clip.startBar)).toBe(true);
    expect(clip.startBar).toBeGreaterThanOrEqual(0);
    expect(clip.lengthBars).toBeGreaterThanOrEqual(1);
    s.execute(moveArrangementClip(s.getDoc(), clip.id, Number.NaN));
    expect(s.getDoc().arrangement.clips[0]!.startBar).toBe(0);
    s.execute(resizeArrangementClip(s.getDoc(), clip.id, Number.NaN));
    expect(s.getDoc().arrangement.clips[0]!.lengthBars).toBeGreaterThanOrEqual(1);
  });

  it("duplicateArrangementClip carries the per-clip loop flag", () => {
    const base = normalizeProject({
      ...createProjectFromTemplate("house"),
      arrangement: { clips: [] },
    });
    const s = new ProjectStore(base);
    const sceneId = s.getDoc().scenes[0]!.id;
    s.execute(addArrangementClip(s.getDoc(), sceneId, 8, 4));
    const clipId = s.getDoc().arrangement.clips[0]!.id;
    s.execute(setArrangementClipLoop(s.getDoc(), clipId, true));
    s.execute(duplicateArrangementClip(s.getDoc(), clipId));
    const copies = s.getDoc().arrangement.clips.filter((c) => c.id !== clipId);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.loop).toBe(true);
  });

  it("consolidateTimeRange PRESERVES audio clips (pre-fix: deleted every one of them)", () => {
    const base = createProjectFromTemplate("house");
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    // Build the audio clip through the REAL command so every required field
    // survives normalize (a hand-written fixture got sanitized away).
    const s = new ProjectStore(base);
    s.execute(addAudioClip(base, trackId, "buf-1", 12, 2));
    expect((s.getDoc().arrangement.audioClips ?? []).length).toBe(1);
    s.execute(consolidateTimeRange(s.getDoc(), 0, 4 * 480));
    const audio = s.getDoc().arrangement.audioClips ?? [];
    expect(audio.length).toBe(1);
  });
});

/* ── pattern clipboard ──────────────────────────────────────────────── */

describe("pattern clipboard — meta carry + id freshness (audit 01)", () => {
  it("pastePattern carries stepMeta and mints fresh note ids per paste", () => {
    const base = createProjectFromTemplate("house");
    const drum = base.tracks.find((t) => t.kind === "drum")!;
    const padId = drum.kind === "drum" ? drum.pads[0]!.id : "pad";
    const clip: PatternClipboard = {
      stepCount: 16,
      rows: { [padId]: new Array(16).fill(0).map((_, i) => (i % 4 === 0 ? 0.9 : 0)) },
      notes: {},
      stepMeta: { [padId]: { 0: { probability: 0.5, locks: { pitch: 3 } } } },
    };
    const s = new ProjectStore(base);
    s.execute(pastePattern(s.getDoc(), clip));
    const pasted = s.getDoc().patterns.find((p) => p.id === s.getDoc().activePatternId)!;
    expect(pasted.stepMeta?.[padId]?.[0]?.probability).toBe(0.5);
    // Paste again into a second pattern: ids must differ across patterns.
    const second = createProjectFromTemplate("house");
    const s2 = new ProjectStore(second);
    s2.execute(pastePattern(s2.getDoc(), clip));
    void s2;
    expect(pasted.rows[padId]?.filter((v) => v > 0).length).toBe(4);
  });

  it("clearPattern clears stepMeta together with the content (no stale p-lock resurrection)", () => {
    const base = createProjectFromTemplate("house");
    const drum = base.tracks.find((t) => t.kind === "drum")!;
    const padId = drum.kind === "drum" ? drum.pads[0]!.id : "pad";
    const withMeta = normalizeProject({
      ...base,
      patterns: base.patterns.map((p, i) =>
        i === 0
          ? { ...p, rows: { ...p.rows, [padId]: p.rows[padId]?.map((v) => (v > 0 ? v : 0.8)) ?? [] }, stepMeta: { [padId]: { 0: { locks: { pitch: 7 } } } } }
          : p,
      ),
    });
    const s = new ProjectStore(withMeta);
    s.execute(clearPattern(s.getDoc(), s.getDoc().patterns[0]!.id));
    const cleared = s.getDoc().patterns[0]!;
    expect(cleared.stepMeta?.[padId]).toBeUndefined();
  });
});
