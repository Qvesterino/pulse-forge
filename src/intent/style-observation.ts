import type { ProjectDocument } from "../project-model/types";
import {
  automaticStyleLearningEnabled,
  countStyleExamples,
  preferredStyleGenre,
  recordStyleExample,
  STYLE_EXAMPLES_CLEARED_EVENT,
} from "./style-example-ledger";
import { patternStyleExampleFromProject } from "./pattern-style-example";

const OBSERVATION_SETTLE_MS = 1400;

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
