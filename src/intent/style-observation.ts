import type { ProjectDocument } from "../project-model/types";
import {
  automaticStyleLearningEnabled,
  countStyleExamples,
  preferredStyleGenre,
  readStyleExamples,
  recordStyleExample,
  STYLE_EXAMPLES_CLEARED_EVENT,
  type StyleExampleV1,
} from "./style-example-ledger";
import { patternStyleExampleFromProject } from "./pattern-style-example";

const OBSERVATION_SETTLE_MS = 1400;

/**
 * The four features `personalStyleProfileFromExamples` actually averages,
 * plus the genre it groups by. An automatic capture whose taste vector is
 * identical to one already in the ledger teaches the profile nothing: the
 * recency-weighted mean of a repeated vector is that same vector.
 */
function learnedTasteKey(example: StyleExampleV1): string {
  return [
    example.genre,
    example.energy.toFixed(6),
    example.density.toFixed(6),
    example.complexity.toFixed(6),
    example.variation.toFixed(6),
  ].join("|");
}

/**
 * An edit can move `contentHash` without moving any learned feature. Note
 * velocity is the measured case: `normalizedContentHash` hashes note velocity,
 * but `energy`/`velocitySpread` are derived from drum hits whenever the pattern
 * has drums, so a melodic-velocity edit records a new example that is
 * feature-identical to the one already stored. That inflates `exampleCount`
 * and lets `confidence` reach 1.0 with no signal behind it.
 */
function alreadyLearned(example: StyleExampleV1): boolean {
  const key = learnedTasteKey(example);
  return readStyleExamples().some((existing) => learnedTasteKey(existing) === key);
}

export interface LocalStyleObserver {
  observe(doc: ProjectDocument, previousDoc: ProjectDocument): void;
  flush(): void;
  dispose(): void;
}

/**
 * Capture only after a human editor has been quiet briefly. This collapses
 * paint strokes and note drags into one example and stores summary features,
 * never project or note data. AI, import, undo, remote and automation commands
 * do not reach this observer.
 */
export function createLocalStyleObserver(onLearned?: (count: number) => void): LocalStyleObserver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: ProjectDocument | null = null;
  let lastCaptureKey: string | null = null;

  const clearPending = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
    lastCaptureKey = null;
  };

  if (typeof window !== "undefined") window.addEventListener(STYLE_EXAMPLES_CLEARED_EVENT, clearPending);

  const capture = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const doc = pending;
    pending = null;
    if (!doc || !automaticStyleLearningEnabled()) return;
    const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
    if (!pattern) return;
    const example = patternStyleExampleFromProject(doc, pattern, preferredStyleGenre());
    if (!example) return;
    const captureKey = `${example.genre}:${example.contentHash}`;
    if (captureKey === lastCaptureKey) return;
    if (alreadyLearned(example)) return;
    if (!recordStyleExample(example)) return;
    lastCaptureKey = captureKey;
    try {
      onLearned?.(countStyleExamples());
    } catch {
      /* observers are isolated from the editing path */
    }
  };

  return {
    observe(doc, previousDoc) {
      if (!automaticStyleLearningEnabled()) return;
      if (doc.activePatternId !== previousDoc.activePatternId) return;
      const previousPattern = previousDoc.patterns.find((candidate) => candidate.id === previousDoc.activePatternId);
      const nextPattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
      if (!previousPattern || !nextPattern) return;
      const genre = preferredStyleGenre();
      const previousExample = patternStyleExampleFromProject(previousDoc, previousPattern, genre);
      const nextExample = patternStyleExampleFromProject(doc, nextPattern, genre);
      if (!nextExample) return;
      if (previousExample?.contentHash === nextExample.contentHash && previousExample.genre === nextExample.genre) {
        return;
      }
      pending = doc;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(capture, OBSERVATION_SETTLE_MS);
    },
    flush: capture,
    dispose() {
      clearPending();
      if (typeof window !== "undefined") window.removeEventListener(STYLE_EXAMPLES_CLEARED_EVENT, clearPending);
    },
  };
}
