import { describe, expect, it } from "vitest";
import { PatternRecorder } from "../src/midi/patternRecorder";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * AUDIT 07 — Recording regression invariants
 * (prompts/daw_qa_reliability_vault/07-recording-audit.md).
 *
 * Earlier passes covered PcmMicRecorder recovery durability, the mic claim,
 * device-loss finalization and the capture worklet. This suite pins the
 * Audit-07 fixes: pattern-record drops events from a stopped transport and
 * from the count-in/pre-roll region, and the count-in placement trim.
 *
 * ⚠ The house template's active pattern SHIPS with pre-filled rows/notes —
 * every assertion compares BEFORE vs AFTER, never against a zero baseline.
 */

describe("PatternRecorder — stopped-transport + count-in gating (audit 07)", () => {
  function recorder(playing: boolean, contentStart: number | null) {
    const base = createProjectFromTemplate("house");
    const store = new ProjectStore(base);
    const padId = base.tracks.find((t) => t.kind === "drum")!.pads[0]!.id;
    let currentTick = playing ? (contentStart ?? 0) : 0;
    const rec = new PatternRecorder({
      getDoc: () => store.doc,
      execute: (command) => store.execute(command),
      getTick: () => currentTick,
      isPlaying: () => playing,
      getContentStartTick: () => (playing ? contentStart : null),
      beginUndoFrame: () => {},
      endUndoFrame: () => {},
    });
    rec.setArmed(true);
    const rowBefore = JSON.stringify(
      store.getDoc().patterns.find((p) => p.id === store.getDoc().activePatternId)!.rows[padId] ?? [],
    );
    return { rec, store, padId, setCurrentTick: (t: number) => (currentTick = t), rowBefore };
  }

  it("drops performed hits while the transport is STOPPED (pre-fix: drift to random steps)", () => {
    const { rec, store, padId, rowBefore } = recorder(false, null);
    rec.drumHit(padId, 0.8);
    rec.drumHit(padId, 0.8);
    const rowAfter = JSON.stringify(
      store.getDoc().patterns.find((p) => p.id === store.getDoc().activePatternId)!.rows[padId] ?? [],
    );
    expect(rowAfter, "stopped-transport hits must be dropped, not stamped at drifting steps").toBe(rowBefore);
  });

  it("drops hits inside the count-in region, records from the content start", () => {
    // Content starts at tick 1920 (bar 2); count-in occupies tick < 1920.
    const { rec, store, padId, setCurrentTick, rowBefore } = recorder(true, 1920);
    setCurrentTick(960); // count-in region
    rec.drumHit(padId, 0.8);
    let rowAfter = JSON.stringify(
      store.getDoc().patterns.find((p) => p.id === store.getDoc().activePatternId)!.rows[padId] ?? [],
    );
    expect(rowAfter, "count-in hits must be dropped").toBe(rowBefore);
    setCurrentTick(2400); // content region
    rec.drumHit(padId, 0.8);
    rowAfter = JSON.stringify(
      store.getDoc().patterns.find((p) => p.id === store.getDoc().activePatternId)!.rows[padId] ?? [],
    );
    expect(rowAfter, "the content-region hit must stamp exactly one step").not.toBe(rowBefore);
  });

  it("instrument notes during count-in are dropped (noteOn + noteOff)", () => {
    const base = createProjectFromTemplate("house");
    const store = new ProjectStore(base);
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    const notesBefore = JSON.stringify(store.getDoc().patterns[0]!.notes?.[trackId] ?? []);
    let currentTick = 960; // count-in
    const rec = new PatternRecorder({
      getDoc: () => store.doc,
      execute: (command) => store.execute(command),
      getTick: () => currentTick,
      isPlaying: () => true,
      getContentStartTick: () => 1920,
      beginUndoFrame: () => {},
      endUndoFrame: () => {},
    });
    rec.setArmed(true);
    rec.noteOn(trackId, 77, 0.8); // unique pitch — no template collision
    currentTick = 1440; // still count-in
    rec.noteOff(77);
    const notesAfter = JSON.stringify(store.getDoc().patterns[0]!.notes?.[trackId] ?? []);
    expect(notesAfter, "count-in notes must not stamp the pattern").toBe(notesBefore);
  });
});

/* ── D1: count-in placement trim (source pins + placement math) ────── */

describe("count-in lead-in placement trim (audit 07)", () => {
  it("metadata carries leadInSec and placement applies offsetSec (source pins)", () => {
    const metadata = readFileSync(resolve(process.cwd(), "src/audio-engine/PcmMicRecorder.ts"), "utf8");
    expect(metadata).toContain("leadInSec?: number");
    const panel = readFileSync(resolve(process.cwd(), "src/ui/ArrangementPanel.tsx"), "utf8");
    expect(panel).toContain("leadInWillApply");
    expect(panel.match(/offsetSec: (?:take\.session|session)\.leadInSec/g)?.length ?? 0).toBe(2);
    expect(panel).toContain("take.buffer.duration - (take.session.leadInSec ?? 0)");
  });
});
