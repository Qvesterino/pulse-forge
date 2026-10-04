import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalStyleObserver } from "../src/intent/style-observation";
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
 * LEARN LOCAL PRODUCER STYLE FROM EDITS — the observer.
 *
 * The observer is the piece that watches human edits and captures a compact
 * example after the editor goes quiet. Its contract:
 *   - it collapses a burst of edits into ONE example (settle window),
 *   - it ignores pattern SWITCHES (not an edit of the current idea),
 *   - it honors the auto-learn switch and the manual-capture path,
 *   - it never lets a storage/observer failure surface into the edit path.
 */

const SETTLE_MS = 1400;

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    genre: "techno",
    style: null,
    seed: "observer-test",
    stepCount: 32,
    key: null,
    drumTrackId: undefined,
    roles: ["drums", "bass", "chords", "lead"],
    replaceMode: "replace",
    ...overrides,
  } as GenerateOptions;
}

/** Two documents that differ only in one pattern's notes (a real edit). */
function editedPair(seed: string): { before: ProjectDocument; after: ProjectDocument } {
  const doc = createProjectFromTemplate("techno");
  const pattern = generatePattern(doc, options({ seed }));
  const withPattern: ProjectDocument = { ...doc, patterns: [pattern], activePatternId: pattern.id };
  const instrument = withPattern.tracks.find((track) => track.kind === "instrument")!;
  const editedPattern = {
    ...pattern,
    notes: {
      ...pattern.notes,
      [instrument.id]: [
        ...(pattern.notes[instrument.id] ?? []),
        { id: "obs-edit", pitch: 67, start: 0, duration: 120, velocity: 0.85 },
      ],
    },
  };
  return { before: withPattern, after: { ...withPattern, patterns: [editedPattern] } };
}

describe("local style observer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    setAutomaticStyleLearningEnabled(true);
    setPreferredStyleGenre("techno");
  });

  it("captures one example after the settle window, not per edit", () => {
    const observer = createLocalStyleObserver();
    const { before, after } = editedPair("obs-a");
    // A burst of edits within the window collapses to one capture.
    observer.observe(after, before);
    observer.observe(after, before);
    observer.observe(after, before);
    expect(countStyleExamples()).toBe(0); // nothing yet — still settling
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(countStyleExamples()).toBe(1);
    observer.dispose();
  });

  it("ignores a pattern SWITCH (active pattern changed, not an edit)", () => {
    const observer = createLocalStyleObserver();
    const { before } = editedPair("obs-b");
    const other = generatePattern(before, options({ seed: "other-pattern" }));
    const switched: ProjectDocument = { ...before, patterns: [...before.patterns, other], activePatternId: other.id };
    observer.observe(switched, before);
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(countStyleExamples()).toBe(0);
    observer.dispose();
  });

  it("does not capture when automatic learning is paused", () => {
    setAutomaticStyleLearningEnabled(false);
    const observer = createLocalStyleObserver();
    const { before, after } = editedPair("obs-c");
    observer.observe(after, before);
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(countStyleExamples()).toBe(0);
    observer.dispose();
  });

  it("flush captures a pending edit immediately", () => {
    const observer = createLocalStyleObserver();
    const { before, after } = editedPair("obs-d");
    observer.observe(after, before);
    observer.flush();
    expect(countStyleExamples()).toBe(1);
    observer.dispose();
  });

  it("reports the learned count to the callback", () => {
    const counts: number[] = [];
    const observer = createLocalStyleObserver((count) => counts.push(count));
    const { before, after } = editedPair("obs-e");
    observer.observe(after, before);
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(counts).toEqual([1]);
    observer.dispose();
  });

  it("clearing the ledger cancels a pending capture", () => {
    const observer = createLocalStyleObserver();
    const { before, after } = editedPair("obs-f");
    observer.observe(after, before);
    clearStyleExamples();
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(countStyleExamples()).toBe(0);
    observer.dispose();
  });

  it("survives an invalid edit pair without throwing", () => {
    const observer = createLocalStyleObserver();
    const doc = createProjectFromTemplate("techno");
    // No active pattern at all — the observer must simply skip.
    expect(() => observer.observe({ ...doc, patterns: [], activePatternId: "" }, doc)).not.toThrow();
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(readStyleExamples()).toEqual([]);
    observer.dispose();
  });
});
