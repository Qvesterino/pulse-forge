import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalStyleObserver } from "../src/intent/style-observation";
import { setNotesVelocity } from "../src/commands/notes";
import {
  clearStyleExamples,
  countStyleExamples,
  setAutomaticStyleLearningEnabled,
  setPreferredStyleGenre,
} from "../src/intent/style-example-ledger";
import { generatePattern } from "../src/ai/generator";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { personalStyleProfile } from "../src/intent/personal-style";
import type { GenerateOptions } from "../src/ai/types";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * MEASUREMENT: does a no-op write (identical velocity) contaminate the ledger?
 *
 * setNotesVelocity always builds a new pattern object, so a redundant gesture
 * still looks like an edit. The observer guards contentHash (observe) and
 * lastCaptureKey (capture) — this pins whether those guards actually hold.
 */

const SETTLE_MS = 1400;

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    genre: "techno",
    style: null,
    seed: "noop-test",
    stepCount: 32,
    key: null,
    drumTrackId: undefined,
    roles: ["drums", "bass", "chords", "lead"],
    replaceMode: "replace",
    ...overrides,
  } as GenerateOptions;
}

function seedDoc(seed: string): { doc: ProjectDocument; trackId: string; noteId: string; velocity: number } {
  const doc = createProjectFromTemplate("techno");
  const pattern = generatePattern(doc, options({ seed }));
  const withPattern: ProjectDocument = { ...doc, patterns: [pattern], activePatternId: pattern.id };
  const instrument = withPattern.tracks.find((track) => track.kind === "instrument")!;
  const note = withPattern.patterns[0].notes[instrument.id]![0];
  return { doc: withPattern, trackId: instrument.id, noteId: note.id, velocity: note.velocity };
}

/** The pad carrying the most hits — thinning an empty pad changes nothing. */
function busiestPad(pattern: { rows: Record<string, number[]> }, padIds: readonly string[]): string {
  const id = padIds
    .filter((candidate) => (pattern.rows[candidate] ?? []).some((velocity) => velocity > 0))
    .sort((a, b) => (pattern.rows[b] ?? []).length - (pattern.rows[a] ?? []).length)[0];
  expect(id).toBeDefined();
  return id!;
}

describe("no-op write does not contaminate the learned-style ledger", () => {
  beforeEach(() => {
    localStorage.clear();
    clearStyleExamples();
    setAutomaticStyleLearningEnabled(true);
    setPreferredStyleGenre("techno");
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("writing the SAME velocity records no new example", () => {
    const { doc, trackId, noteId, velocity } = seedDoc("noop-a");
    const observer = createLocalStyleObserver();
    const after = setNotesVelocity(doc, trackId, [noteId], velocity).execute(doc);

    expect(after).not.toBe(doc); // a new document IS produced by the no-op

    observer.observe(after, doc);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(countStyleExamples()).toBe(0);
    observer.dispose();
  });

  it("a REAL velocity change records exactly one example", () => {
    const { doc, trackId, noteId, velocity } = seedDoc("noop-b");
    const observer = createLocalStyleObserver();
    const after = setNotesVelocity(doc, trackId, [noteId], Math.min(1, velocity + 0.2)).execute(doc);

    observer.observe(after, doc);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(countStyleExamples()).toBe(1);
    observer.dispose();
  });

  it("a no-op AFTER a real edit does not add a second example", () => {
    const { doc, trackId, noteId, velocity } = seedDoc("noop-c");
    const observer = createLocalStyleObserver();
    const target = Math.min(1, velocity + 0.2);

    const real = setNotesVelocity(doc, trackId, [noteId], target).execute(doc);
    observer.observe(real, doc);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(countStyleExamples()).toBe(1);

    const noop = setNotesVelocity(real, trackId, [noteId], target).execute(real);
    observer.observe(noop, real);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(countStyleExamples()).toBe(1);
    observer.dispose();
  });

  it("repeated no-op + flush records nothing", () => {
    const { doc, trackId, noteId, velocity } = seedDoc("noop-d");
    const observer = createLocalStyleObserver();
    const after = setNotesVelocity(doc, trackId, [noteId], velocity).execute(doc);
    observer.observe(after, doc);
    observer.flush();
    observer.observe(after, doc);
    observer.flush();
    expect(countStyleExamples()).toBe(0);
    observer.dispose();
  });

  it("repeated note-velocity edits do not fill the ledger with feature-identical examples", () => {
    const { doc, trackId, noteId, velocity } = seedDoc("noop-e");
    const observer = createLocalStyleObserver();
    const first = setNotesVelocity(doc, trackId, [noteId], Math.min(1, velocity + 0.3)).execute(doc);

    observer.observe(first, doc);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(countStyleExamples()).toBe(1);

    // each further velocity tweak moves contentHash but not the learned vector
    let current = first;
    for (const delta of [0.1, 0.15, 0.2]) {
      const nextNote = current.patterns[0].notes[trackId]![0];
      const next = setNotesVelocity(current, trackId, [nextNote.id], Math.min(1, nextNote.velocity + delta)).execute(
        current,
      );
      expect(next.patterns[0]).not.toBe(current.patterns[0]);
      current = next;
      observer.observe(next, current);
      vi.advanceTimersByTime(SETTLE_MS);
    }

    // four velocity nudges, one real taste signal
    expect(countStyleExamples()).toBe(1);
    const profile = personalStyleProfile("techno");
    expect(profile?.exampleCount).toBe(1);
    expect(profile?.confidence ?? 0).toBeLessThan(1);
    observer.dispose();
  });

  it("a genuine DRUM edit still moves the learned vector and is recorded", () => {
    const doc = createProjectFromTemplate("techno");
    const pattern = generatePattern(doc, options({ seed: "drum-edit" }));
    const withPattern: ProjectDocument = { ...doc, patterns: [pattern], activePatternId: pattern.id };
    const drumTrack = withPattern.tracks.find((track) => track.kind === "drum")!;
    const padId = busiestPad(
      pattern,
      drumTrack.pads.map((pad) => pad.id),
    );
    const observer = createLocalStyleObserver();

    // thin the kit out across a whole bar: density and energy both move
    const thinned = {
      ...withPattern,
      patterns: [
        {
          ...pattern,
          rows: { ...pattern.rows, [padId]: (pattern.rows[padId] ?? []).map((v, i) => (i % 4 === 0 ? 0 : v)) },
        },
      ],
    } as ProjectDocument;

    observer.observe(thinned, withPattern);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(countStyleExamples()).toBe(1);
    expect(personalStyleProfile("techno")?.exampleCount).toBe(1);
    observer.dispose();
  });

  it("a second, DIFFERENT drum feel is not blocked by the guard", () => {
    const doc = createProjectFromTemplate("techno");
    const pattern = generatePattern(doc, options({ seed: "drum-two" }));
    const withPattern: ProjectDocument = { ...doc, patterns: [pattern], activePatternId: pattern.id };
    const drumTrack = withPattern.tracks.find((track) => track.kind === "drum")!;
    const padId = busiestPad(
      pattern,
      drumTrack.pads.map((pad) => pad.id),
    );
    const observer = createLocalStyleObserver();

    const sparse = {
      ...withPattern,
      patterns: [
        {
          ...pattern,
          rows: { ...pattern.rows, [padId]: (pattern.rows[padId] ?? []).map((v, i) => (i % 4 === 0 ? 0 : v)) },
        },
      ],
    } as ProjectDocument;
    const dense = {
      ...withPattern,
      patterns: [{ ...pattern, rows: { ...pattern.rows, [padId]: (pattern.rows[padId] ?? []).map((v) => v || 0.8) } }],
    } as ProjectDocument;

    observer.observe(sparse, withPattern);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(countStyleExamples()).toBe(1);

    observer.observe(dense, sparse);
    vi.advanceTimersByTime(SETTLE_MS);
    // the two feels differ, so the guard must not swallow the second one
    expect(countStyleExamples()).toBe(2);
    observer.dispose();
  });
});
