import { describe, expect, it } from "vitest";
import { applyVocalEnsembleCommand } from "../src/vocal/ensemble";
import { testDoc } from "./fixtures/doc";
import type { InstrumentTrack } from "../src/project-model/types";

/**
 * HUM→VOICE ENSEMBLE (KROK 1 of HUM A HIT, 2026-10-12) — a vocal STACK from
 * ONE hum: the staged voiceify render played by three vocalchop tracks with
 * identity constants (Lead C 1.0 / Double L-offset 0.6 / Harmony R 0.5,
 * +3 st). All constants — never random — so the same hum always renders the
 * same stack. Re-apply refreshes sampleId on the existing tracks; one
 * undoable snapshot installs all three.
 */

const doc = testDoc();

describe("applyVocalEnsembleCommand", () => {
  it("installs three ensemble tracks with the identity constants", () => {
    const outcome = applyVocalEnsembleCommand(doc, {
      bufferId: "voiceify-render",
      renderTicks: 1920,
      bpm: 120,
    });
    expect(outcome.ok).toBe(true);
    const applied = outcome.command!.execute(doc);

    const ensemble = applied.tracks.filter(
      (t): t is InstrumentTrack => t.kind === "instrument" && t.name.startsWith("Voice Ensemble — hum"),
    );
    expect(ensemble).toHaveLength(3);
    const byName = new Map(ensemble.map((t) => [t.name, t]));
    const lead = byName.get("Voice Ensemble — hum (Lead)")!;
    const double = byName.get("Voice Ensemble — hum (Double)")!;
    const harmony = byName.get("Voice Ensemble — hum (Harmony)")!;
    for (const t of [lead, double, harmony]) {
      expect(t.sampleId).toBe("voiceify-render");
      expect(t.instrument).toBe("vocalchop");
    }
    expect(lead.pan).toBe(0);
    expect(double.pan).toBeCloseTo(-0.5, 5);
    expect(harmony.pan).toBeCloseTo(0.5, 5);
    expect(lead.gain).toBe(1);
    expect(double.gain).toBeCloseTo(0.6, 5);
    expect(harmony.gain).toBeCloseTo(0.5, 5);
  });

  it("harmony pitch is the lead + the interval; double starts ~20 ms later", () => {
    const outcome = applyVocalEnsembleCommand(doc, {
      bufferId: "voiceify-render",
      renderTicks: 1920,
      bpm: 120,
      harmonyInterval: 4,
    });
    const applied = outcome.command!.execute(doc);
    const ensemble = applied.tracks.filter(
      (t): t is InstrumentTrack => t.kind === "instrument" && t.name.startsWith("Voice Ensemble — hum"),
    );
    const byName = new Map(ensemble.map((t) => [t.name, t]));
    const leadNote = applied.patterns.find((p) => p.id === applied.activePatternId)!.notes[
      byName.get("Voice Ensemble — hum (Lead)")!.id
    ]![0];
    const harmonyNote = applied.patterns.find((p) => p.id === applied.activePatternId)!.notes[
      byName.get("Voice Ensemble — hum (Harmony)")!.id
    ]![0];
    expect(harmonyNote.pitch).toBe(leadNote.pitch + 4);
    // 20 ms at 120 BPM, PPQ 480 = 19.2 → rounds to 19 ticks.
    const doubleNote = applied.patterns.find((p) => p.id === applied.activePatternId)!.notes[
      byName.get("Voice Ensemble — hum (Double)")!.id
    ]![0];
    expect(doubleNote.start).toBe(Math.max(1, Math.round((20 / 1000) * (120 / 60) * 480)));
  });

  it("re-apply refreshes sampleId without track spam; one undo removes all three", () => {
    const first = applyVocalEnsembleCommand(doc, {
      bufferId: "render-v1",
      renderTicks: 1920,
      bpm: 120,
    }).command!.execute(doc);
    const second = applyVocalEnsembleCommand(first, {
      bufferId: "render-v2",
      renderTicks: 1920,
      bpm: 120,
    }).command!.execute(first);
    const ensemble = second.tracks.filter(
      (t): t is InstrumentTrack => t.kind === "instrument" && t.name.startsWith("Voice Ensemble — hum"),
    );
    expect(ensemble, "no track spam").toHaveLength(3);
    for (const t of ensemble) expect(t.sampleId).toBe("render-v2");

    // The second command's undo restores the FIRST pass's state: the three
    // tracks still exist, pointing at the previous render.
    const secondCmd = applyVocalEnsembleCommand(first, {
      bufferId: "render-v2",
      renderTicks: 1920,
      bpm: 120,
    }).command!;
    const undone = secondCmd.undo(second);
    const undoneEnsemble = undone.tracks.filter(
      (t): t is InstrumentTrack => t.kind === "instrument" && t.name.startsWith("Voice Ensemble — hum"),
    );
    expect(undoneEnsemble).toHaveLength(3);
    for (const t of undoneEnsemble) expect((t as { sampleId?: string }).sampleId).toBe("render-v1");
  });

  it("refuses honestly without staging or a render length", () => {
    expect(() => applyVocalEnsembleCommand(doc, { bufferId: "", renderTicks: 1920, bpm: 120 })).toThrow(/not staged/);
    expect(() => applyVocalEnsembleCommand(doc, { bufferId: "x", renderTicks: 0, bpm: 120 })).toThrow(
      /render's length/,
    );
  });
});
