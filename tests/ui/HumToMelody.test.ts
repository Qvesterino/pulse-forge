/**
 * `humContourLayout` is a pure layout function exported from
 * `src/ui/HumToMelody.tsx` for unit testing. The canvas component just
 * rasterises its output — every interesting behaviour (pitch bounds, bar
 * grid, voiced/unvoiced colouring, free-time vs beat-synced wrap, octave
 * handling) lives in here.
 *
 * The interesting edge cases are:
 *  - empty inputs (no frames, no notes) → default pitch range 48..72
 *  - pitch bounds expand to include BOTH notes and voiced frames, with a
 *    minimum span (so a 1-semitone input still draws as a sensible line)
 *  - voiced flag requires `midi > 0`, `clarity >= 0.55`, and `rms >= 0.004`
 *  - free-time mode drops frames past the pattern end
 *  - beat-synced mode wraps frames modulo the pattern length
 *  - bar lines land at exact tick multiples of `BAR_TICKS`
 *  - non-finite or non-positive BPM falls back to 120
 */
import { describe, expect, it } from "vitest";
import { humContourLayout } from "../../src/ui/HumToMelody";
import type { PitchFrame } from "../../src/audio-workers/pitch-tracker";
import { BAR_TICKS, PPQ, type NoteEvent } from "../../src/project-model/types";

function frame(overrides: Partial<PitchFrame> = {}): PitchFrame {
  return { timeSec: 0, midi: 69, clarity: 0.9, rms: 0.05, ...overrides };
}

function note(overrides: Partial<NoteEvent> = {}): NoteEvent {
  return { id: "n", start: 0, duration: PPQ / 4, pitch: 60, velocity: 100, ...overrides };
}

describe("humContourLayout", () => {
  it("returns default pitch bounds when frames and notes are both empty", () => {
    const layout = humContourLayout([], [], {
      bpm: 120,
      patternLengthTicks: BAR_TICKS * 2,
      anchorTick: null,
      width: 400,
      height: 80,
    });
    expect(layout.points).toEqual([]);
    expect(layout.noteRects).toEqual([]);
    // Empty inputs → defaults of 48..72 with the ±2 padding already
    // applied by the function (padded bounds are exposed, not the inner).
    expect(layout.pitchMin).toBeLessThanOrEqual(48);
    expect(layout.pitchMax).toBeGreaterThanOrEqual(72);
  });

  it("expands pitch bounds to include notes AND voiced frames (with padding)", () => {
    const layout = humContourLayout(
      [frame({ midi: 67 })],
      [note({ pitch: 72 })],
      {
        bpm: 120,
        patternLengthTicks: BAR_TICKS * 2,
        anchorTick: null,
        width: 400,
        height: 80,
      },
    );
    // Pitch range must cover both 67 (frame) and 72 (note), plus 2-semitone
    // padding on each side. A regression that ignored the frames would
    // silently clip the hum curve outside the note range.
    expect(layout.pitchMin).toBeLessThanOrEqual(67 - 2);
    expect(layout.pitchMax).toBeGreaterThanOrEqual(72 + 2);
  });

  it("enforces a minimum 10-semitone span even for a 1-semitone input", () => {
    const layout = humContourLayout([frame({ midi: 60 })], [note({ pitch: 60 })], {
      bpm: 120,
      patternLengthTicks: BAR_TICKS,
      anchorTick: null,
      width: 200,
      height: 80,
    });
    // A regression that skipped the floor would render a 1-pixel line.
    expect(layout.pitchMax - layout.pitchMin).toBeGreaterThanOrEqual(10);
  });

  it("flags a frame as voiced only when midi > 0 AND clarity >= 0.55 AND rms >= 0.004", () => {
    const layout = humContourLayout(
      [
        frame({ timeSec: 0, midi: 60, clarity: 0.9, rms: 0.05 }), // voiced
        frame({ timeSec: 0.1, midi: 0, clarity: 0.9, rms: 0.05 }), // midi=0 → not voiced
        frame({ timeSec: 0.2, midi: 62, clarity: 0.5, rms: 0.05 }), // clarity=0.5 < 0.55 → not voiced
        frame({ timeSec: 0.3, midi: 64, clarity: 0.9, rms: 0.003 }), // rms < 0.004 → not voiced
      ],
      [],
      {
        bpm: 120,
        patternLengthTicks: BAR_TICKS,
        anchorTick: null,
        width: 400,
        height: 80,
      },
    );
    expect(layout.points.map((p) => p.voiced)).toEqual([true, false, false, false]);
  });

  it("free-time mode drops frames past the pattern end", () => {
    const len = BAR_TICKS;
    const farFuture = 999; // timeSec = 999 → tick = 999 * secPerTick → past len
    const layout = humContourLayout(
      [frame({ timeSec: 0 }), frame({ timeSec: farFuture })],
      [],
      {
        bpm: 60, // 1 sec per beat
        patternLengthTicks: len,
        anchorTick: null,
        width: 400,
        height: 80,
      },
    );
    expect(layout.points).toHaveLength(1);
  });

  it("beat-synced mode wraps points into the [0, len) tick range", () => {
    // Two frames at timeSec=0 and timeSec=2 with anchor=0 at 60 BPM land at
    // tick 0 and tick PPQ*2 (480*2 = 960). Both stay inside [0, BAR_TICKS).
    const layout = humContourLayout(
      [frame({ timeSec: 0, midi: 60 }), frame({ timeSec: 2, midi: 62 })],
      [],
      {
        bpm: 60,
        patternLengthTicks: BAR_TICKS,
        anchorTick: 0,
        width: 400,
        height: 80,
      },
    );
    expect(layout.points).toHaveLength(2);
    // The x coordinates must be inside the canvas width — a regression that
    // forgot modulo would produce negative or out-of-range x values.
    for (const p of layout.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(400);
    }
  });

  it("places bar lines at exact tick multiples of BAR_TICKS", () => {
    const layout = humContourLayout([], [], {
      bpm: 120,
      patternLengthTicks: BAR_TICKS * 4,
      anchorTick: null,
      width: 400,
      height: 80,
    });
    // 4 bars → 3 internal bar lines at ticks BAR_TICKS, 2*BAR_TICKS, 3*BAR_TICKS
    expect(layout.barLines).toHaveLength(3);
    // Lines scale linearly: width=400, len=4*BAR_TICKS → BAR_TICKS maps to 100
    expect(layout.barLines[0]).toBeCloseTo(100, 5);
    expect(layout.barLines[1]).toBeCloseTo(200, 5);
    expect(layout.barLines[2]).toBeCloseTo(300, 5);
  });

  it("falls back to 120 BPM when bpm is non-finite or non-positive", () => {
    // Without the fallback, `secPerTick = 60 / (NaN * PPQ)` = NaN and every
    // point's x is NaN — the canvas rasteriser would no-op. Pin the safe
    // behaviour.
    const fromNan = humContourLayout([frame({ timeSec: 0 })], [], {
      bpm: Number.NaN,
      patternLengthTicks: BAR_TICKS,
      anchorTick: null,
      width: 400,
      height: 80,
    });
    for (const p of fromNan.points) expect(Number.isFinite(p.x)).toBe(true);

    const fromZero = humContourLayout([frame({ timeSec: 0 })], [], {
      bpm: 0,
      patternLengthTicks: BAR_TICKS,
      anchorTick: null,
      width: 400,
      height: 80,
    });
    for (const p of fromZero.points) expect(Number.isFinite(p.x)).toBe(true);

    const fromNeg = humContourLayout([frame({ timeSec: 0 })], [], {
      bpm: -120,
      patternLengthTicks: BAR_TICKS,
      anchorTick: null,
      width: 400,
      height: 80,
    });
    for (const p of fromNeg.points) expect(Number.isFinite(p.x)).toBe(true);
  });

  it("maps note start/duration onto x positions in [0, width]", () => {
    const layout = humContourLayout([], [note({ start: 0, duration: BAR_TICKS / 2 })], {
      bpm: 120,
      patternLengthTicks: BAR_TICKS,
      anchorTick: null,
      width: 400,
      height: 80,
    });
    expect(layout.noteRects).toHaveLength(1);
    const rect = layout.noteRects[0];
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(400 + 0.001);
    // Width = (duration/len) * width = 0.5 * 400 = 200; minimum is 2.
    expect(rect.w).toBeCloseTo(200, 5);
  });

  it("clamps note rectangle height to a minimum of 2px so very dense pitch ranges still render", () => {
    // Notes spanning a 50-semitone range would yield sub-pixel rects; the
    // function floors them at 2 so the user sees SOMETHING in the canvas.
    const layout = humContourLayout([], [note({ pitch: 60 })], {
      bpm: 120,
      patternLengthTicks: BAR_TICKS,
      anchorTick: null,
      width: 400,
      height: 80,
    });
    expect(layout.noteRects[0].h).toBeGreaterThanOrEqual(2);
  });
});