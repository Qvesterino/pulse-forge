import { describe, expect, it } from "vitest";
import { useDeterministicIds } from "../src/shared/ids";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { MAX_HUMANIZE_TIMING, MAX_MICRO_TIMING, drumHitsInWindow, swingOffsetTicks } from "../src/project-model/groove";
import { noteEventsInWindow } from "../src/project-model/events";
import { normalizeProject } from "../src/project-model/schema";
import { emptyPattern, note, withNotes } from "../src/project-model/templates";
import { PPQ, STEP_TICKS } from "../src/project-model/types";
import type { DrumTrack, ProjectDocument } from "../src/project-model/types";

const PATTERN_TICKS = STEP_TICKS * 16;

/** House template with rows wiped except the kicks we place ourselves. */
function blankDoc(): { doc: ProjectDocument; kickId: string } {
  const doc = createProjectFromTemplate("empty");
  const drums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
  return { doc, kickId: drums.pads[0].id };
}

function setRow(doc: ProjectDocument, padId: string, steps: [number, number][]): ProjectDocument {
  return {
    ...doc,
    patterns: doc.patterns.map((p) => {
      const row = new Array<number>(p.stepCount).fill(0);
      for (const [step, velocity] of steps) row[step] = velocity;
      return { ...p, rows: { ...p.rows, [padId]: row } };
    }),
  };
}

describe("groove engine", () => {
  it("straight project: one hit per active step, exactly on the grid", () => {
    const { doc, kickId } = blankDoc();
    const withHits = setRow(doc, kickId, [
      [0, 0.9],
      [4, 0.8],
      [8, 0.7],
    ]);
    const hits = drumHitsInWindow(withHits, withHits.patterns[0], 0, 0, PATTERN_TICKS);
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.tick)).toEqual([0, 4 * STEP_TICKS, 8 * STEP_TICKS]);
    expect(hits.map((h) => h.velocity)).toEqual([0.9, 0.8, 0.7]);
  });

  it("swing delays odd 16th steps proportionally, even steps untouched", () => {
    expect(swingOffsetTicks(0, 0.6)).toBe(0);
    expect(swingOffsetTicks(2, 0.6)).toBe(0);
    expect(swingOffsetTicks(1, 0.6)).toBeCloseTo(0.6 * STEP_TICKS * 0.5, 5);
    expect(swingOffsetTicks(3, 1)).toBeCloseTo(STEP_TICKS * 0.5, 5);

    const { doc, kickId } = blankDoc();
    const swung = setRow({ ...doc, groove: { swing: 0.5 } }, kickId, [
      [0, 0.9],
      [1, 0.9],
      [2, 0.9],
    ]);
    const hits = drumHitsInWindow(swung, swung.patterns[0], 0, 0, PATTERN_TICKS);
    expect(hits[0].tick).toBe(0);
    expect(hits[1].tick).toBeCloseTo(STEP_TICKS + 0.25 * STEP_TICKS, 5);
    expect(hits[2].tick).toBe(2 * STEP_TICKS);
  });

  it("microtiming shifts a step early or late within bounds", () => {
    const { doc, kickId } = blankDoc();
    const early = setRow(doc, kickId, [[4, 0.9]]);
    const earlyMeta = {
      ...early,
      patterns: early.patterns.map((p) => ({ ...p, stepMeta: { [kickId]: { 4: { microtiming: -1 } } } })),
    };
    const late = {
      ...early,
      patterns: early.patterns.map((p) => ({ ...p, stepMeta: { [kickId]: { 4: { microtiming: 1 } } } })),
    };
    const earlyHits = drumHitsInWindow(earlyMeta, earlyMeta.patterns[0], 0, 0, PATTERN_TICKS);
    const lateHits = drumHitsInWindow(late, late.patterns[0], 0, 0, PATTERN_TICKS);
    expect(earlyHits[0].tick).toBeCloseTo(4 * STEP_TICKS - MAX_MICRO_TIMING, 5);
    expect(lateHits[0].tick).toBeCloseTo(4 * STEP_TICKS + MAX_MICRO_TIMING, 5);
  });

  it("probability 0 never plays, probability 1 always plays", () => {
    // The roll is seeded from the pattern id, which uid() randomizes by
    // default — a random seed can roll ≥ 0.99 and fail the "always" claim
    // (~1 % of runs). Pin the ids so the roll is fixed and the boundary
    // (0 never, near-1 always) is what's actually under test.
    const restore = useDeterministicIds();
    try {
      const { doc, kickId } = blankDoc();
      const base = setRow(doc, kickId, [[0, 0.9]]);
      const never = {
        ...base,
        patterns: base.patterns.map((p) => ({ ...p, stepMeta: { [kickId]: { 0: { probability: 0 } } } })),
      };
      const always = {
        ...base,
        patterns: base.patterns.map((p) => ({ ...p, stepMeta: { [kickId]: { 0: { probability: 0.99 } } } })),
      };
      expect(drumHitsInWindow(never, never.patterns[0], 0, 0, PATTERN_TICKS)).toHaveLength(0);
      expect(drumHitsInWindow(always, always.patterns[0], 0, 0, PATTERN_TICKS)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("probability rolls are deterministic per pattern/pad/step/pass", () => {
    const { doc, kickId } = blankDoc();
    const base = setRow(doc, kickId, [
      [0, 0.9],
      [2, 0.9],
      [4, 0.9],
      [6, 0.9],
    ]);
    const half = {
      ...base,
      patterns: base.patterns.map((p) => ({
        ...p,
        stepMeta: {
          [kickId]: {
            0: { probability: 0.5 },
            2: { probability: 0.5 },
            4: { probability: 0.5 },
            6: { probability: 0.5 },
          },
        },
      })),
    };
    const first = drumHitsInWindow(half, half.patterns[0], 0, 0, PATTERN_TICKS).map((h) => h.tick);
    const second = drumHitsInWindow(half, half.patterns[0], 0, 0, PATTERN_TICKS).map((h) => h.tick);
    expect(first).toEqual(second);
  });

  it("ratchet splits a step into evenly spaced hits with decaying velocity", () => {
    const { doc, kickId } = blankDoc();
    const base = setRow(doc, kickId, [[0, 0.9]]);
    const rattled = {
      ...base,
      patterns: base.patterns.map((p) => ({ ...p, stepMeta: { [kickId]: { 0: { ratchet: 4 } } } })),
    };
    const hits = drumHitsInWindow(rattled, rattled.patterns[0], 0, 0, PATTERN_TICKS);
    expect(hits).toHaveLength(4);
    expect(hits.map((h) => h.ratchetIndex)).toEqual([0, 1, 2, 3]);
    for (let i = 0; i < 4; i++) {
      expect(hits[i].tick).toBeCloseTo(i * (STEP_TICKS / 4), 5);
    }
    expect(hits[0].velocity).toBeCloseTo(0.9, 5);
    expect(hits[1].velocity).toBeLessThan(hits[0].velocity);
    expect(hits[3].velocity).toBeLessThan(hits[2].velocity);
  });

  it("humanize keeps timing jitter and velocity variation within bounds and deterministic", () => {
    const { doc, kickId } = blankDoc();
    const steps: [number, number][] = Array.from({ length: 16 }, (_, i) => [i, 0.8] as [number, number]);
    const humanized = setRow({ ...doc, groove: { humanizeTiming: 1, humanizeVelocity: 1 } }, kickId, steps);
    const hitsA = drumHitsInWindow(humanized, humanized.patterns[0], 0, 0, PATTERN_TICKS);
    const hitsB = drumHitsInWindow(humanized, humanized.patterns[0], 0, 0, PATTERN_TICKS);
    // Edge hits jittered across the window boundary land in the neighbouring
    // window (scheduler windows are contiguous), so the count can drift by up
    // to one hit on each edge.
    expect(hitsA.length).toBeGreaterThanOrEqual(14);
    expect(hitsA.length).toBeLessThanOrEqual(18);
    expect(hitsA.map((h) => `${h.tick}:${h.velocity}`)).toEqual(hitsB.map((h) => `${h.tick}:${h.velocity}`));
    for (const hit of hitsA) {
      const nearestGrid = Math.round(hit.tick / STEP_TICKS) * STEP_TICKS;
      expect(Math.abs(hit.tick - nearestGrid)).toBeLessThanOrEqual(MAX_HUMANIZE_TIMING + 1e-6);
      expect(hit.velocity).toBeGreaterThanOrEqual(0.05);
      expect(hit.velocity).toBeLessThanOrEqual(1);
    }
    // With amount 1 at least some hits should actually move.
    expect(hitsA.some((h) => Math.abs(h.tick - Math.round(h.tick / STEP_TICKS) * STEP_TICKS) > 1)).toBe(true);
  });

  it("window splitting is lossless: two halves equal the whole", () => {
    const { doc, kickId } = blankDoc();
    const steps: [number, number][] = Array.from(
      { length: 16 },
      (_, i) => [i, 0.5 + (i % 4) * 0.1] as [number, number],
    );
    const grooved = setRow(
      { ...doc, groove: { swing: 0.6, humanizeTiming: 0.7, humanizeVelocity: 0.5 } },
      kickId,
      steps,
    );
    const pattern = grooved.patterns[0];
    const rattled = {
      ...grooved,
      patterns: [
        { ...pattern, stepMeta: { [kickId]: { 3: { ratchet: 3 }, 7: { ratchet: 2 }, 11: { microtiming: -0.8 } } } },
      ],
    };
    const whole = drumHitsInWindow(rattled, rattled.patterns[0], 0, 0, PATTERN_TICKS);
    const splitAt = 8 * STEP_TICKS + 17; // deliberately off-grid split
    const firstHalf = drumHitsInWindow(rattled, rattled.patterns[0], 0, 0, splitAt);
    const secondHalf = drumHitsInWindow(rattled, rattled.patterns[0], 0, splitAt, PATTERN_TICKS);
    const merged = [...firstHalf, ...secondHalf].sort((a, b) => a.tick - b.tick);
    expect(merged.map((h) => `${h.tick}|${h.velocity}|${h.pad.id}`)).toEqual(
      whole.map((h) => `${h.tick}|${h.velocity}|${h.pad.id}`),
    );
  });

  it("respects a non-zero base (song-mode clips) and wraps per pattern cycle", () => {
    const { doc, kickId } = blankDoc();
    const withHits = setRow(doc, kickId, [[0, 0.9]]);
    const base = 4 * 1920; // clip starts at bar 4
    const hits = drumHitsInWindow(withHits, withHits.patterns[0], base, base, base + 2 * PATTERN_TICKS);
    expect(hits.map((h) => h.tick)).toEqual([base, base + PATTERN_TICKS]);
  });

  it("muted pads and tracks stay silent under groove", () => {
    const { doc, kickId } = blankDoc();
    const withHits = setRow(doc, kickId, [[0, 0.9]]);
    const muted = {
      ...withHits,
      tracks: withHits.tracks.map((t) =>
        t.kind === "drum" ? { ...t, pads: t.pads.map((p) => (p.id === kickId ? { ...p, mute: true } : p)) } : t,
      ),
    };
    expect(drumHitsInWindow(muted, muted.patterns[0], 0, 0, PATTERN_TICKS)).toHaveLength(0);
  });

  it("normalize clamps groove settings and prunes default step meta", () => {
    const { doc, kickId } = blankDoc();
    const dirty = {
      ...doc,
      groove: { swing: 4, humanizeTiming: -2, humanizeVelocity: 0.4 },
      patterns: doc.patterns.map((p) => ({
        ...p,
        rows: { ...p.rows, [kickId]: new Array<number>(16).fill(0).map((_, i) => (i === 0 ? 0.9 : 0)) },
        stepMeta: {
          [kickId]: {
            0: { probability: 1, ratchet: 1, microtiming: 0 },
            1: { probability: 0.6, ratchet: 99, microtiming: 5 },
            99: { probability: 0.5 },
          },
          "pad-missing": { 0: { probability: 0.5 } },
        },
      })),
    };
    const fixed = normalizeProject(dirty as ProjectDocument);
    expect(fixed.groove?.swing).toBe(1);
    expect(fixed.groove?.humanizeTiming).toBe(0);
    expect(fixed.groove?.humanizeVelocity).toBeCloseTo(0.4, 5);
    const meta = fixed.patterns[0].stepMeta?.[kickId];
    expect(meta?.[0]).toBeUndefined(); // all defaults → pruned
    expect(meta?.[1].probability).toBeCloseTo(0.6, 5);
    expect(meta?.[1].ratchet).toBe(8); // clamped to max
    expect(meta?.[1].microtiming).toBe(1); // clamped to max
    expect(meta?.[99]).toBeUndefined(); // out of range → dropped
    expect(fixed.patterns[0].stepMeta?.["pad-missing"]).toBeUndefined();
  });
});

describe("groove — ratchet tails across window boundaries (scheduler precision)", () => {
  it("a ratchet straddling a window edge plays its FULL tail (merged halves equal the whole)", () => {
    const { doc, kickId } = blankDoc();
    // Ratchet 8 on the LAST step of the first half: its tail extends
    // 7 × (STEP/8) = 105 ticks past the parent — across any split placed
    // in that region. The old parent-level window gate dropped the tail
    // from BOTH halves (parent in window A, tail in window B).
    const withHits = setRow(
      doc,
      kickId,
      Array.from({ length: 16 }, (_, i) => [i, i === 7 ? 0.9 : 0]),
    );
    const rattled = {
      ...withHits,
      patterns: [{ ...withHits.patterns[0], stepMeta: { [kickId]: { 7: { ratchet: 8 } } } }],
    };
    const whole = drumHitsInWindow(rattled, rattled.patterns[0], 0, 0, PATTERN_TICKS);
    expect(whole.length).toBe(8);

    for (const splitAt of [8 * STEP_TICKS, 8 * STEP_TICKS + 60, 8 * STEP_TICKS + 105]) {
      const firstHalf = drumHitsInWindow(rattled, rattled.patterns[0], 0, 0, splitAt);
      const secondHalf = drumHitsInWindow(rattled, rattled.patterns[0], 0, splitAt, PATTERN_TICKS);
      const merged = [...firstHalf, ...secondHalf].sort((a, b) => a.tick - b.tick);
      expect(
        merged.map((h) => `${h.tick}|${h.velocity.toFixed(6)}`),
        `split at ${splitAt}`,
      ).toEqual(whole.map((h) => `${h.tick}|${h.velocity.toFixed(6)}`));
      // The tail's later sub-hits must land in the SECOND half…
      const tailInSecond = secondHalf.filter((h) => h.tick >= splitAt).length;
      if (splitAt > 7 * STEP_TICKS && splitAt < 7 * STEP_TICKS + 105) {
        expect(tailInSecond).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * Performance / memory recon — regression coverage for the A.3 + A.4
 * hot-path optimisations. These tests pin the contracts that the
 * scheduler hot path relies on: deterministic sort order without
 * ICU collation cost, and a no-clone contract on `hit.locks` so
 * a 500-hit window does not allocate 500 throw-away objects.
 */
describe("groove engine — A.3 + A.4 hot-path contracts", () => {
  it("drumHitsInWindow does not clone hit.locks (defect A.3)", () => {
    // Build a project with a single step that has p-locks set on
    // the source `stepMeta`. `drumHitsInWindow` should pass the
    // locks reference through without re-allocating. We also have
    // to seed a non-zero row velocity on the same (pad, step) —
    // `drumHitsInWindow` early-exits a hit when `velocity <= 0`,
    // and the test fixture in `blankDoc` does not seed any rows.
    const { doc, kickId } = blankDoc();
    const docWithLocks = setRow(doc, kickId, [[0, 0.9]]);
    const docWithMeta: ProjectDocument = {
      ...docWithLocks,
      patterns: docWithLocks.patterns.map((p) => ({
        ...p,
        stepMeta: {
          ...(p.stepMeta ?? {}),
          [kickId]: {
            ...((p.stepMeta ?? {})[kickId] ?? {}),
            0: {
              ...((p.stepMeta ?? {})[kickId]?.[0] ?? {}),
              locks: { pitch: 1, gain: 0.5 },
            },
          },
        },
      })),
    };
    const normalized = normalizeProject(docWithMeta);
    const pattern = normalized.patterns[0];
    const hits = drumHitsInWindow(normalized, pattern, 0, 0, PATTERN_TICKS);
    const withLocks = hits.filter((h) => h.locks);
    expect(withLocks.length).toBeGreaterThan(0);
    // The locks reference on the hit must be the same object as the
    // source meta.locks — i.e. the schedule window did not clone.
    const sourceLocks = pattern.stepMeta?.[kickId]?.[0]?.locks;
    expect(sourceLocks, "test fixture: source must have locks").toBeDefined();
    for (const h of withLocks) {
      expect(h.locks).toBe(sourceLocks);
    }
  });

  it("noteEventsInWindow sort order matches the previous localeCompare contract (defect A.4)", () => {
    // Build a synthetic pattern with notes on three tracks at the
    // SAME tick — that forces ties on the primary sort axis
    // (`tick`) and exercises the secondary axis (`trackId`). The
    // old comparator was `String.localeCompare` (ICU collation);
    // we replaced it with a plain `<` / `>` comparator because
    // Pulse Forge generates alphanumeric track ids (no locale-aware
    // ordering required). For our codeset the two comparators
    // produce identical ordering, but the new comparator must
    // still be a *total order* — i.e. non-decreasing trackId across
    // every run of equal-tick events.
    const { doc } = blankDoc();
    const drums = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    let pattern = emptyPattern("sort-test", [drums]);
    // Three track ids chosen so the test does NOT accidentally
    // depend on the order keys are inserted into `notes`. We
    // intentionally insert them in a *non-sorted* order (c, a, b)
    // so a stable sort that relied on insertion order would fail.
    pattern = withNotes(pattern, "track-c", [note(60, 0, PPQ / 2, 0.8)]);
    pattern = withNotes(pattern, "track-a", [note(60, 0, PPQ / 2, 0.8)]);
    pattern = withNotes(pattern, "track-b", [note(61, 0, PPQ / 2, 0.8)]);
    // First sanity check — the comparator must put the three
    // events in `track-a`, `track-b`, `track-c` order (ascending
    // ASCII) within the tick=0 group. Note `track-b` has pitch 61
    // while the others have pitch 60; pitch is the *third* sort
    // axis, so within same trackId there is only one note.
    const events = noteEventsInWindow(pattern, 0, 0, PPQ);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.trackId)).toEqual(["track-a", "track-b", "track-c"]);
    // Stronger invariant — for every adjacent pair in the result
    // array, either `tick` is ascending, or `tick` is equal AND
    // `trackId` is non-decreasing. This is the full `localeCompare`
    // contract preserved.
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      const tickOk = curr.tick >= prev.tick;
      const trackOk = curr.tick > prev.tick || curr.trackId >= prev.trackId;
      expect(tickOk && trackOk, `events[${i - 1}] → events[${i}] out of order`).toBe(true);
    }
  });
});
