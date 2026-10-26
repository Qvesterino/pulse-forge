/**
 * The export freshness contract (audit F-01, extended by audit E-04).
 *
 * The export panel captures the document at RENDER time, and its selectors
 * are fine-grained: `normalizeProject` preserves object identity for untouched
 * slices, so an edit confined to the arrangement / automation / returns /
 * macros / lfos / scenes does NOT re-render the panel. The captured document
 * can therefore already be stale BEFORE the user clicks — and a stem render
 * is multi-second, so an edit made DURING it has to be caught too.
 *
 * `projectRevisionIdFor` is keyed on the document object identity, so it sees
 * EVERY mutation — including exactly the arrangement edits the fine-grained
 * selectors miss.
 *
 * The master path has guarded this since it was written; the stem and track
 * paths had no guard at all. This module is that contract, in one place, so
 * both paths use the same check and the same message.
 *
 * Audit E-04: a document is not the only input an export renders from — the
 * SAMPLE BANK is. The master path guarded the bank's revision; the stem and
 * track paths did not, so a sample replaced mid-export produced a stem that
 * mixed the old document with the new audio and still reported "N stems
 * exported". The bank revision is part of the captured state, so the one
 * contract guards both facts.
 */
import type { ProjectDocument } from "../project-model/types";
import { projectRevisionIdFor } from "../mastering/report";

/**
 * The facts an export depends on: the document it renders AND the sample bank
 * it renders from.
 */
export interface ExportState {
  doc: ProjectDocument;
  /** The sample bank's content revision (audit E-04). */
  sampleBankRevision: number;
}

export interface ExportSource {
  /** The document captured at call time. */
  doc: ProjectDocument;
  /** The revision id of that document (identity-keyed). */
  revisionId: string;
  /** The sample bank revision captured at call time. */
  sampleBankRevision: number;
}

/**
 * Capture the state an export will render from — AT CALL TIME, never at
 * render time.
 */
export function captureExportSource(getState: () => ExportState): ExportSource {
  const { doc, sampleBankRevision } = getState();
  return { doc, revisionId: projectRevisionIdFor(doc), sampleBankRevision };
}

/**
 * Assert the captured state is still the one the app holds.
 *
 * Throws when the project changed in ANY way, or when the sample bank
 * changed — the export is then stale and its result must be discarded rather
 * than shipped as if it were current.
 */
export function assertExportSourceCurrent(source: ExportSource, getState: () => ExportState): void {
  const { doc: current, sampleBankRevision } = getState();
  if (current.id !== source.doc.id || projectRevisionIdFor(current) !== source.revisionId) {
    throw new Error("The project changed during export. The stale result was discarded; export again.");
  }
  if (sampleBankRevision !== source.sampleBankRevision) {
    throw new Error("The sample bank changed during export. The stale result was discarded; export again.");
  }
}
