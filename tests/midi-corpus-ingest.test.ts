import { describe, it, expect } from "vitest";
import {
  detectKeyFromNotes,
  splitRoles,
  toDegreeEvents,
  collectSamples,
  eraOf,
  ERA_BY_CATALOG_STYLE,
  MAX_SAMPLES_PER_ROLE,
  type CatalogPiece,
} from "../src/ai/midi-corpus-ingest";
import { writeMidiFile, parseMidiFile } from "../src/midi/midiFile";
import { MELODIC_FEATURE_COUNT, MELODIC_DURATION_VALUES } from "../src/ai/symbolic/melodic-features";
import { STEP_TICKS } from "../src/project-model/types";
import type { MusicalKey } from "../src/project-model/types";
import type { MidiNote } from "../src/midi/midiFile";

/**
 * W2 — Public-domain MIDI corpus ingest.
 *
 * The ingest is the piece that decides whether real (non-hand-written)
 * music can teach the melodic prior, so its decisions are pinned here:
 * key detection, role split, degree inversion and the per-role cap. A silent
 * change in any of them would silently reshape the training corpus.
 */

const note = (pitch: number, startTick: number, lengthTicks: number): MidiNote => ({
  pitch,
  startTick,
  endTick: startTick + lengthTicks,
  velocity: 0.8,
});

/** A C-major scale run — the textbook key-detection fixture. */
const C_MAJOR_RUN: MidiNote[] = [
  note(60, 0, 480),
  note(62, 480, 480),
  note(64, 960, 480),
  note(65, 1440, 480),
  note(67, 1920, 480),
  note(69, 2400, 480),
  note(71, 2880, 480),
  note(72, 3360, 480),
];

const A_MINOR_RUN: MidiNote[] = [
  note(57, 0, 480),
  note(60, 480, 480),
  note(64, 960, 480),
  note(65, 1440, 480),
  note(69, 1920, 480),
  note(72, 2400, 480),
  note(76, 2880, 480),
  note(81, 3360, 480),
];

describe("midi corpus ingest — key detection", () => {
  it("detects C major from a C-major scale run", () => {
    expect(detectKeyFromNotes(C_MAJOR_RUN)).toBe("C Major");
  });

  it("detects A natural minor from an A-minor run", () => {
    expect(detectKeyFromNotes(A_MINOR_RUN)).toBe("A Natural Minor");
  });

  it("returns null on an empty note list rather than guessing", () => {
    expect(detectKeyFromNotes([])).toBeNull();
  });

  it("is deterministic (same notes → same key)", () => {
    expect(detectKeyFromNotes(C_MAJOR_RUN)).toBe(detectKeyFromNotes([...C_MAJOR_RUN]));
  });
});

describe("midi corpus ingest — role split", () => {
  it("puts the lowest track on bass, the top melody on lead, drops GM drums", () => {
    const parsed = {
      bpm: 120,
      tracks: [
        {
          name: "LH",
          channel: 0,
          notes: [note(40, 0, 480), note(43, 480, 480), note(45, 960, 480), note(40, 1440, 480)],
        },
        {
          name: "drums",
          channel: 9,
          notes: [note(36, 0, 120), note(38, 120, 120), note(42, 240, 120), note(36, 360, 120)],
        },
        {
          name: "RH",
          channel: 0,
          notes: [note(72, 0, 480), note(74, 480, 480), note(76, 960, 480), note(79, 1440, 480)],
        },
      ],
    };
    const split = splitRoles(parsed);
    expect(split.bass.length).toBe(4);
    expect(split.lead.length).toBe(4);
    // The GM drum channel never reaches the melodic corpus.
    expect([...split.bass, ...split.lead, ...split.chord].some((n) => n.pitch === 36)).toBe(false);
    expect(split.key).toBeTruthy();
  });

  it("returns empty roles for a file with no usable melodic track", () => {
    const split = splitRoles({ bpm: 120, tracks: [{ name: "drums", channel: 9, notes: [note(36, 0, 120)] }] });
    expect(split.bass).toEqual([]);
    expect(split.lead).toEqual([]);
    expect(split.chord).toEqual([]);
  });
});

describe("midi corpus ingest — degree inversion", () => {
  it("inverts a C-major bass run to the expected scale degrees", () => {
    const events = toDegreeEvents(
      [note(36, 0, 480), note(43, STEP_TICKS * 2, 480), note(48, STEP_TICKS * 4, 480), note(50, STEP_TICKS * 6, 480)],
      "bass",
      "C Major",
      64,
    );
    expect(events.length).toBe(4);
    // C(E)→ d0, G(E)→ d4, C(E)→ d0, D(E)→ d1
    expect(events.map((e) => e.degree)).toEqual([0, 4, 0, 1]);
    // A quarter note is 4 steps.
    expect(events[0].duration).toBe(4);
  });

  it("snaps an off-scale pitch to its nearest degree rather than dropping it", () => {
    // C# sits a semitone from C and from D in C major — chromatic material
    // is snapped to the nearest scale degree (the same snap the runtime
    // applies to sampled notes), NOT discarded.
    const events = toDegreeEvents([note(61, 0, 480)], "chord", "C Major", 64);
    expect(events).toHaveLength(1);
    expect([0, 1]).toContain(events[0].degree);
  });

  it("drops a note too far from any degree in the role's register (chromatic noise)", () => {
    // An octave-and-a-half away from every degreeToPitch candidate in the
    // ±2-octave search window means the note does not belong to the key at
    // all; ingest treats it as noise instead of mislabelling it.
    const events = toDegreeEvents([note(96, 0, 480)], "bass", "C Major", 64);
    expect(events).toHaveLength(0);
  });

  it("returns nothing for an unparseable key instead of guessing", () => {
    // "H Major" is not a real MusicalKey (there is no H root) — parseKey
    // returns null, so the inversion must refuse rather than fall back to 0.
    expect(toDegreeEvents([note(60, 0, 480)], "bass", "H Major" as MusicalKey, 64)).toEqual([]);
  });
});

describe("midi corpus ingest — sample emission", () => {
  const events = toDegreeEvents(
    [note(36, 0, 480), note(43, STEP_TICKS * 4, 480), note(48, STEP_TICKS * 8, 960), note(50, STEP_TICKS * 14, 240)],
    "bass",
    "C Major",
    64,
  );

  it("emits one sample per note plus the wrap-around pair", () => {
    const samples = collectSamples(events, "classical.baroque#midi:test", "ambient", "bass", MAX_SAMPLES_PER_ROLE);
    expect(samples).toHaveLength(events.length + 1);
  });

  it("keeps every row at the frozen feature width with in-range classes", () => {
    const samples = collectSamples(events, "classical.baroque#midi:test", "ambient", "bass", MAX_SAMPLES_PER_ROLE);
    for (const sample of samples) {
      expect(sample.x).toHaveLength(MELODIC_FEATURE_COUNT);
      expect(sample.degree).toBeGreaterThanOrEqual(0);
      expect(sample.degree).toBeLessThanOrEqual(7);
      expect(sample.duration).toBeGreaterThanOrEqual(0);
      expect(sample.duration).toBeLessThan(MELODIC_DURATION_VALUES.length);
      for (const value of sample.x) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("groups every row of a piece under one leak-guard group per role", () => {
    const samples = collectSamples(events, "classical.baroque#midi:test", "ambient", "bass", MAX_SAMPLES_PER_ROLE);
    expect(new Set(samples.map((s) => s.group))).toEqual(new Set(["classical.baroque#midi:test#bass"]));
  });

  it("never emits more rows than the per-role cap", () => {
    const long = toDegreeEvents(
      Array.from({ length: 400 }, (_, i) => note(36 + (i % 7) * 2, i * 120, 240)),
      "bass",
      "C Major",
      100000,
    );
    expect(long.length).toBeGreaterThan(MAX_SAMPLES_PER_ROLE);
    const samples = collectSamples(long, "classical.romantic#midi:long", "ambient", "bass", MAX_SAMPLES_PER_ROLE);
    expect(samples).toHaveLength(MAX_SAMPLES_PER_ROLE);
  });

  it("returns nothing for an empty event list", () => {
    expect(collectSamples([], "classical.modern#midi:empty", "ambient", "lead", MAX_SAMPLES_PER_ROLE)).toEqual([]);
  });
});

describe("midi corpus ingest — licensing / era mapping", () => {
  const piece = (style?: string): CatalogPiece => ({
    id: "x",
    title: "t",
    composer: "c",
    style,
    file: "midi/x.mid",
    license: "Public Domain",
    sha1: "0".repeat(40),
  });

  it("maps catalog eras onto the classical conditioning regions", () => {
    expect(eraOf(piece("Baroque"))).toBe("baroque");
    expect(eraOf(piece("Romantic"))).toBe("romantic");
    expect(eraOf(piece("Modern"))).toBe("modern");
  });

  it("folds non-era styles (Jazz, March, Technique) into the generic region", () => {
    for (const style of ["Jazz", "March", "Technique", "Song", "Popular / Dance"]) {
      expect(eraOf(piece(style))).toBe("classical");
    }
  });

  it("falls back to the generic region for an unknown or missing style", () => {
    expect(eraOf(piece("Something New"))).toBe("classical");
    expect(eraOf(piece(undefined))).toBe("classical");
  });

  it("only ever emits eras that exist in the embedding pack", () => {
    for (const style of Object.keys(ERA_BY_CATALOG_STYLE)) {
      expect(eraOf(piece(style))).toBeTruthy();
    }
  });
});

describe("midi corpus ingest — SMF round trip (the real parse path)", () => {
  it("parses a written MIDI file back into the roles the ingest expects", () => {
    const bytes = writeMidiFile({
      division: 480,
      bpm: 120,
      timeSignature: { num: 4, den: 4 },
      tracks: [
        {
          name: "Bass",
          channel: 0,
          notes: [
            { pitch: 36, startTick: 0, endTick: 480, velocity: 0.8 },
            { pitch: 43, startTick: 480, endTick: 960, velocity: 0.8 },
            { pitch: 48, startTick: 960, endTick: 1440, velocity: 0.8 },
            { pitch: 50, startTick: 1440, endTick: 1920, velocity: 0.8 },
          ],
        },
        {
          name: "Lead",
          channel: 1,
          notes: [
            { pitch: 72, startTick: 0, endTick: 480, velocity: 0.8 },
            { pitch: 74, startTick: 480, endTick: 960, velocity: 0.8 },
            { pitch: 76, startTick: 960, endTick: 1440, velocity: 0.8 },
            { pitch: 79, startTick: 1440, endTick: 1920, velocity: 0.8 },
          ],
        },
      ],
    });
    const parsed = parseMidiFile(bytes);
    expect(parsed.bpm).toBe(120);
    expect(parsed.tracks.length).toBe(2);
    const split = splitRoles(parsed);
    expect(split.bass.length).toBe(4);
    expect(split.lead.length).toBe(4);
    const events = toDegreeEvents(split.bass, "bass", split.key!, 64);
    expect(events.map((e) => e.degree)).toEqual([0, 4, 0, 1]);
  });
});
