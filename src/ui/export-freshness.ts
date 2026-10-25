/**
 * The export freshness contract (audit F-01).
 *
 * The export panel captures the document at RENDER time, and its selectors
 * are fine-grained: `normalizeProject` preserves object identity for untouched
 * slices, so an edit confined to the arrangement / automation / returns /
 * macros / lfos / scenes does NOT re-render the panel. The captured document
 * can therefore already be stale BEFORE the user clicks — and a stem render
 * is multi-second, so an edit made DURING the render has to be caught too.
 *
 * `projectRevisionIdFor` is keyed on the document object identity, so it sees
 * EVERY mutation — including exactly the arrangement edits the fine-grained
 * selectors miss.
 *
 * The master path has guarded this since it was written; the stem and track
 * paths had no guard at all. This module is that contract, in one place, so
 * both paths use the same check and the same message.
 */
import type { ProjectDocument } from "../project-model/types";
import { projectRevisionIdFor } from "../mastering/report";

export interface ExportSource {
  /** The document captured at call time. */
  doc: ProjectDocument;
  /** The revision id of that document (identity-keyed). */
  revisionId: string;
}

/**
 * Capture the document an export will render from — AT CALL TIME, never at
 * render time.
 */
export function captureExportSource(getDoc: () => ProjectDocument): ExportSource {
  const doc = getDoc();
  return { doc, revisionId: projectRevisionIdFor(doc) };
}

/**
 * Assert the captured document is still the one the store holds.
 *
 * Throws when the project changed in ANY way — the export is then stale and
 * its result must be discarded rather than shipped as if it were current.
 */
export function assertExportSourceCurrent(source: ExportSource, getDoc: () => ProjectDocument): void {
  const current = getDoc();
  if (current.id !== source.doc.id || projectRevisionIdFor(current) !== source.revisionId) {
    throw new Error("The project changed during export. The stale result was discarded; export again.");
  }
}
