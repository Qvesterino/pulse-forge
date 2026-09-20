import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { parseExactIntent } from "../src/intent/exact";
import { applyExactIntentCommand } from "../src/commands/commands";
import type { InstrumentTrack, ProjectDocument } from "../src/project-model/types";

/**
 * Exact Intents (master doc §4.1): deterministic extraction of explicit
 * commands — cheap, predictable, testable. Applied as ONE undoable command
 * group folding the existing canonical commands.
 */

describe("parseExactIntent", () => {
  it("tempo: 'set tempo to 142' and '138 bpm'", () => {
    expect(parseExactIntent("set tempo to 142")!.ops).toEqual([{ kind: "tempo", bpm: 142 }]);
    expect(parseExactIntent("138 bpm")!.ops).toEqual([{ kind: "tempo", bpm: 138 }]);
  });

  it("tempo clamps to the legal range", () => {
    expect(parseExactIntent("set tempo to 999")!.ops).toEqual([{ kind: "tempo", bpm: 300 }]);
    expect(parseExactIntent("set tempo to 5")!.ops).toEqual([{ kind: "tempo", bpm: 20 }]);
  });

  it("key: 'change the key to D minor' → D Natural Minor", () => {
    const plan = parseExactIntent("change the key to D minor")!;
    expect(plan.ops).toEqual([{ kind: "key", key: "D Natural Minor" }]);
  });

  it("key: 'key of f# harmonic minor' normalizes flat naming", () => {
    const plan = parseExactIntent("set key to gb harmonic minor")!;
    expect(plan.ops[0]).toEqual({ kind: "key", key: "F# Harmonic Minor" });
  });

  it("mute/unmute with target", () => {
    const mute = parseExactIntent("mute the bass")!;
    expect(mute.ops).toEqual([{ kind: "mute", target: "bass", value: true }]);
    const unmute = parseExactIntent("unmute the bass")!;
    expect(unmute.ops).toEqual([{ kind: "mute", target: "bass", value: false }]);
  });

  it("pan with side and percentage", () => {
    const right = parseExactIntent("pan the hats 80% right")!;
    expect(right.ops).toEqual([{ kind: "pan", target: "drums", value: 0.8 }]);
    const left = parseExactIntent("pan the lead 30 left")!;
    expect(left.ops).toEqual([{ kind: "pan", target: "lead", value: -0.3 }]);
  });

  it("gain dB delta: 'lower drums by 2 dB'", () => {
    const plan = parseExactIntent("lower drums by 2 dB")!;
    expect(plan.ops).toEqual([{ kind: "gainDb", target: "drums", deltaDb: -2 }]);
  });

  it("transpose: 'transpose the lead up one octave' → +12", () => {
    const plan = parseExactIntent("transpose the lead up one octave")!;
    expect(plan.ops).toEqual([{ kind: "transpose", target: "lead", semitones: 12 }]);
  });

  it("pattern length: 'pattern length to 32'", () => {
    const plan = parseExactIntent("pattern length to 32")!;
    expect(plan.ops).toEqual([{ kind: "patternLength", steps: 32 }]);
  });

  it("generation and production intents stay null", () => {
    expect(parseExactIntent("dark rolling techno at 140")).toBeNull();
    expect(parseExactIntent("make the bass deeper")).toBeNull();
    expect(parseExactIntent("")).toBeNull();
  });
});

describe("applyExactIntentCommand", () => {
  const doc = () => createProjectFromTemplate("house");

  it("tempo applies to the document", () => {
    const d = doc();
    const plan = parseExactIntent("set tempo to 142")!;
    const next = applyExactIntentCommand(d, plan).execute(d);
    expect(next.bpm).toBe(142);
  });

  it("mute the bass flips the bass track and undo restores it", () => {
    const d = doc();
    const plan = parseExactIntent("mute the bass")!;
    const next = applyExactIntentCommand(d, plan).execute(d);
    const bass = next.tracks.find(
      (t): t is InstrumentTrack => t.kind === "instrument" && ["bass", "808"].includes(t.instrument),
    );
    expect(bass?.mute).toBe(true);
    const restored = plan && applyExactIntentCommand;
    void restored;
    const undone = applyExactIntentCommand(d, plan); // same op flips back
    const undoneDoc = undone.undo(next);
    const bassUndone = undoneDoc.tracks.find(
      (t): t is InstrumentTrack => t.kind === "instrument" && ["bass", "808"].includes(t.instrument),
    );
    expect(bassUndone?.mute).toBe(false);
  });

  it("multi-op plan applies tempo + key in ONE undo step", () => {
    const d = doc();
    const plan = parseExactIntent("set tempo to 138 and change the key to d minor")!;
    expect(plan.ops.length).toBeGreaterThanOrEqual(2);
    const next = applyExactIntentCommand(d, plan).execute(d);
    expect(next.bpm).toBe(138);
    expect(next.key).toBe("D Natural Minor");
    // One command group = one undo restores everything.
    const undone = applyExactIntentCommand(d, plan).undo(next);
    expect(undone.bpm).toBe(d.bpm);
  });

  it("transpose shifts melodic notes on the target track only", () => {
    const d = doc();
    // house template has an 808 track; give it notes first
    const withNotes: ProjectDocument = {
      ...d,
      patterns: d.patterns.map((p, index) =>
        index === 0
          ? {
              ...p,
              notes: {
                ...p.notes,
                "808-notes": [
                  { id: "n1", pitch: 60, start: 0, duration: 120, velocity: 0.8 },
                  { id: "n2", pitch: 64, start: 120, duration: 120, velocity: 0.8 },
                ],
              },
            }
          : p,
      ),
    };
    const bassId = d.tracks.find((t) => t.name === "808")?.id;
    void bassId;
    // Route through the planner target: 'lead' — use an instrument track that exists
    const inst = withNotes.tracks.find((t) => t.kind === "instrument");
    expect(inst).toBeDefined();
    const plan = parseExactIntent(`transpose the ${inst!.name.toLowerCase()} up one octave`)!;
    const targetId = (inst as InstrumentTrack).id;
    const before = ((withNotes.patterns[0].notes[targetId] ?? []) as { pitch: number }[]).map((n) => n.pitch);
    const next = applyExactIntentCommand(withNotes, plan).execute(withNotes);
    const afterPattern = next.patterns.find((p) => p.id === withNotes.activePatternId)!;
    const after = (afterPattern.notes[targetId] ?? []).map((n) => n.pitch);
    expect(after.map((p) => p - 12)).toEqual(before); // +12 then nothing... assert shift
  });
});
