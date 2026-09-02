/**
 * MIDI file I/O — SMF parser/writer + project mapping.
 *
 * The writer is the fixture factory for the parser (round-trip), plus
 * hand-built byte sequences for the edge cases real files hit (running
 * status, velocity-0 offs, hanging notes, SMPTE rejection).
 */
import { describe, expect, it } from "vitest";
import { MidiParseError, parseMidiFile, writeMidiFile } from "../src/midi/midiFile";
import { importMidiCommand, patternToMidi } from "../src/midi/midiProject";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { STEP_TICKS, type DrumTrack } from "../src/project-model/types";

describe("SMF writer + parser round-trip", () => {
  it("preserves notes, channels, names, tempo and division", () => {
    const bytes = writeMidiFile({
      division: 480,
      bpm: 132,
      timeSignature: { num: 4, den: 4 },
      tracks: [
        {
          name: "Kick",
          channel: 9,
          notes: [
            { pitch: 36, startTick: 0, endTick: 120, velocity: 0.9 },
            { pitch: 38, startTick: 480, endTick: 600, velocity: 0.5 },
          ],
        },
        {
          name: "Lead",
          channel: 1,
          notes: [{ pitch: 72, startTick: 240, endTick: 960, velocity: 1 }],
        },
      ],
    });

    const parsed = parseMidiFile(bytes);
    expect(parsed.division).toBe(480);
    expect(parsed.bpm).toBe(132);
    expect(parsed.timeSignature).toEqual({ num: 4, den: 4 });
    expect(parsed.tracks).toHaveLength(2);

    const drums = parsed.tracks.find((t) => t.channel === 9)!;
    expect(drums.name).toBe("Kick");
    expect(drums.notes).toHaveLength(2);
    expect(drums.notes[0]).toMatchObject({ pitch: 36, startTick: 0, endTick: 120 });
    expect(drums.notes[0].velocity).toBeCloseTo(0.9, 2);

    const lead = parsed.tracks.find((t) => t.channel === 1)!;
    expect(lead.notes[0]).toMatchObject({ pitch: 72, startTick: 240, endTick: 960 });
  });

  it("keeps a valid file under 2 KB for a full pattern (sanity on VLQ encoding)", () => {
    const notes = Array.from({ length: 128 }, (_, i) => ({
      pitch: 36 + (i % 12),
      startTick: i * 30,
      endTick: i * 30 + 25,
      velocity: 0.8,
    }));
    const bytes = writeMidiFile({ bpm: 120, tracks: [{ channel: 0, notes }] });
    expect(bytes.length).toBeLessThan 	(2048);
    expect(() => parseMidiFile(bytes)).not.toThrow();
  });
});

describe("SMF parser edge cases", () => {
  function mthd(division: number): number[] {
    return [
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1,
      (division >>> 8) & 0xff, division & 0xff,
    ];
  }

  function mtrk(payload: number[]): number[] {
    const len = payload.length;
    return [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...payload];
  }

  it("reads running status (note events without repeated status bytes)", () => {
    // delta 0, noteOn C4 (0x90 ch0), then SAME status implied: noteOn D4, noteOn E4.
    const payload = [
      0x00, 0x90, 60, 100,
      0x60, 62, 100, // running status — no 0x90 prefix
      0x60, 64, 100,
      0x00, 0xff, 0x2f, 0x00,
    ];
    const parsed = parseMidiFile(new Uint8Array([...mthd(480), ...mtrk(payload)]));
    expect(parsed.tracks[0].notes.map((n) => n.pitch)).toEqual([60, 62, 64]);
  });

  it("treats velocity-0 note-ons as note-offs", () => {
    const payload = [
      0x00, 0x90, 60, 100,
      0x60, 0x90, 60, 0, // off via zero velocity
      0x00, 0xff, 0x2f, 0x00,
    ];
    const parsed = parseMidiFile(new Uint8Array([...mthd(480), ...mtrk(payload)]));
    expect(parsed.tracks[0].notes).toHaveLength(1);
    expect(parsed.tracks[0].notes[0].endTick).toBe(96);
  });

  it("closes hanging notes at the last event tick", () => {
    const payload = [
      0x00, 0x90, 60, 100,
      0x60, 0xb0, 7, 100, // a CC moves the clock, note never gets an off
      0x00, 0xff, 0x2f, 0x00,
    ];
    const parsed = parseMidiFile(new Uint8Array([...mthd(480), ...mtrk(payload)]));
    const note = parsed.tracks[0].notes[0];
    expect(note.endTick).toBe(96);
  });

  it("rejects SMPTE division and garbage with clear errors", () => {
    expect(() => parseMidiFile(new Uint8Array(mthd(0xe250)))).toThrow(MidiParseError);
    expect(() => parseMidiFile(new Uint8Array([1, 2, 3]))).toThrow(MidiParseError);
  });
});

describe("MIDI → project import", () => {
  it("scales ticks from foreign divisions, maps GM drums to pads and names tracks", () => {
    const bytes = writeMidiFile({
      division: 96, // quarter = 96 ticks → ×5 into our PPQ 480
      bpm: 100,
      tracks: [
        {
          name: "Drums",
          channel: 9,
          notes: [
            { pitch: 36, startTick: 0, endTick: 12, velocity: 0.9 }, // kick step 0
            { pitch: 38, startTick: 24, endTick: 30, velocity: 0.6 }, // snare step 1 (24 ticks @ 96 div = one 16th)
          ],
        },
        {
          name: "Bassline",
          channel: 0,
          notes: [{ pitch: 36, startTick: 0, endTick: 48, velocity: 0.8 }], // low → bass kind
        },
      ],
    });

    const doc = createProjectFromTemplate("empty");
    const command = importMidiCommand(doc, bytes, "My Loop.mid");
    const next = command.execute(doc);

    // New pattern active, 16 steps (content fits one bar), project BPM applied.
    const pattern = next.patterns.find((p) => p.id === next.activePatternId)!;
    expect(pattern.name).toBe("My Loop");
    expect(pattern.stepCount).toBe(16);
    expect(next.bpm).toBe(100);

    // Drum track + one bass instrument track (imported ones are new ids).
    const drumTrack = next.tracks.find(
      (t): t is DrumTrack => t.kind === "drum" && !doc.tracks.some((b) => b.id === t.id),
    )!;
    expect(drumTrack).toBeTruthy();
    const kickPad = drumTrack.pads[0]; // GM 36 → pad 0 (Kick Deep)
    expect(pattern.rows[kickPad.id][0]).toBeCloseTo(0.9, 2);
    const snarePad = drumTrack.pads[4]; // GM 38 → pad 4 (Snare)
    expect(pattern.rows[snarePad.id][1]).toBeCloseTo(0.6, 2);

    const bassTrack = next.tracks.find((t) => t.kind === "instrument" && t.name === "Bassline")!;
    expect(bassTrack).toBeTruthy();
    expect(bassTrack.kind === "instrument" && bassTrack.instrument === "bass").toBe(true);
    const notes = pattern.notes[bassTrack.id];
    expect(notes).toHaveLength(1);
    // 96-division tick 0 → 0; duration 48 ticks ×5 = 240.
    expect(notes[0]).toMatchObject({ pitch: 36, start: 0, duration: 240 });

    // Undo restores the original document.
    const undone = command.undo(next);
    expect(undone.tracks).toHaveLength(doc.tracks.length);
    expect(undone.patterns).toHaveLength(doc.patterns.length);
  });

  it("rounds pattern length up to whole bars for multi-bar files", () => {
    const bytes = writeMidiFile({
      bpm: 120,
      tracks: [{ name: "Seq", channel: 0, notes: [{ pitch: 60, startTick: 2 * 1920 + 10, endTick: 2 * 1920 + 130, velocity: 0.8 }] }],
    });
    const doc = createProjectFromTemplate("empty");
    const next = importMidiCommand(doc, bytes, "bars").execute(doc);
    const pattern = next.patterns.find((p) => p.id === next.activePatternId)!;
    // Content lives in bar 3 → rounded up to 48 steps (3 bars).
    expect(pattern.stepCount).toBe(48);
  });
});

describe("project → MIDI export", () => {
  it("exports drums on channel 10 and tempo, and re-imports identically", () => {
    const doc = createProjectFromTemplate("house");
    const bytes = patternToMidi(doc, doc.activePatternId);
    const parsed = parseMidiFile(bytes);

    expect(parsed.bpm).toBe(doc.bpm);
    const drumTracks = parsed.tracks.filter((t) => t.channel === 9);
    expect(drumTracks).toHaveLength(1);

    // House has at least a kick on step 0.
    const kickHits = drumTracks[0].notes.filter((n) => n.pitch === 36);
    expect(kickHits.length).toBeGreaterThan(0);
    expect(kickHits[0].startTick).toBe(0);

    // Round-trip through import yields a playable pattern with the same
    // number of drum steps in bar 1.
    const base = createProjectFromTemplate("empty");
    const importCmd = importMidiCommand(base, bytes, "house");
    const imported = importCmd.execute(base);
    const pattern = imported.patterns.find((p) => p.id === imported.activePatternId)!;
    const importedDrums = imported.tracks.find(
      (t): t is DrumTrack => t.kind === "drum" && !base.tracks.some((b) => b.id === t.id),
    )!;
    const drumRow = pattern.rows[importedDrums.pads[0].id];
    const originalDrums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    const originalRow = doc.patterns.find((p) => p.id === doc.activePatternId)!.rows[originalDrums.pads[0].id];
    // MIDI velocity is 7-bit — 0.95 becomes 121/127 ≈ 0.9528 on the way back.
    expect(drumRow).toHaveLength(originalRow.length);
    drumRow.forEach((v, i) => expect(v).toBeCloseTo(originalRow[i], 2));
  });

  it("one pattern step equals one 16th (120 ticks) in the exported file", () => {
    const doc = createProjectFromTemplate("house");
    const bytes = patternToMidi(doc, doc.activePatternId);
    const parsed = parseMidiFile(bytes);
    const drums = parsed.tracks.find((t) => t.channel === 9)!;
    const starts = new Set(drums.notes.map((n) => n.startTick));
    for (const start of starts) expect(start % STEP_TICKS).toBe(0);
    for (const note of drums.notes) expect(note.endTick - note.startTick).toBe(STEP_TICKS);
  });
});
