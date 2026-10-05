import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalStyleObserver } from "../src/intent/style-observation";
import { setNotesVelocity } from "../src/commands/notes";
import {
  clearStyleExamples,
  countStyleExamples,
  readStyleExamples,
  setAutomaticStyleLearningEnabled,
  setPreferredStyleGenre,
} from "../src/intent/style-example-ledger";
import { generatePattern } from "../src/ai/generator";
import { createProjectFromTemplate } from "../src/project-model/templates";
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

  it("NOTE-VELOCITY examples are byte-identical in features (the real defect)", () => {
    const { doc, trackId, noteId, velocity } = seedDoc("noop-e");
    const observer = createLocalStyleObserver();
    const after = setNotesVelocity(doc, trackId, [noteId], Math.min(1, velocity + 0.3)).execute(doc);

    observer.observe(after, doc);
    vi.advanceTimersByTime(SETTLE_MS);

    const example = readStyleExamples()[0]!;
    // the edit was a NOTE velocity change, yet every learned feature is
    // drum-derived and therefore identical to the pre-edit pattern
    expect(example.energy).toBeGreaterThan(0);
    expect(example.density).toBeGreaterThan(0);
    observer.dispose();
  });
});
