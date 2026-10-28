/**
 * The sample-drag CONTRACT — a leaf module on purpose.
 *
 * These two members used to live in SampleBrowser.tsx, and three boot-path
 * modules imported them FROM THERE: TrackTabs and Sequencer (both statically
 * imported by App.tsx) and LivePadsPanel. That one import pulled the whole
 * sample browser into the studio boot closure — SampleBrowser statically
 * imports DropZone and IntakeTray, which import `importAudioFile` from
 * sample-import.ts, which drags the BPM probe, the user-sample repository and
 * the bank persistence with it: 39.3 KB of the static boot closure for two
 * small helpers and a MIME string.
 *
 * A module leaves the boot path only when NOTHING inside the closure still
 * imports it statically, so the fix is not a dynamic import at the call site
 * but a LEAF: the contract moves here, and the browser keeps the browser.
 * Same shape as the wave-6 "the mix planner's word table became a leaf
 * module" seam.
 *
 * This module must stay dependency-free. It is imported by the boot path, so
 * anything it imports is in the closure too.
 */

/** MIME type carrying a sample asset id in drag&drop (ROADMAP-UI-2027 V4).
 *  Drop targets: sequencer drum rows (pad asset) and instrument track tabs. */
export const KYX_SAMPLE_MIME = "application/kyx-sample";

/** Read a dragged sample id from a drop event — null when the drag carries
 *  no KYX sample (files, text, external drags all pass through untouched). */
export function sampleIdFromDrag(dt: DataTransfer): string | null {
  const id = dt.getData(KYX_SAMPLE_MIME);
  if (id) return id;
  // Some hosts (Safari private mode, synthetic test events) drop the custom
  // MIME but keep text/plain — the id also rides there.
  const plain = dt.getData("text/plain");
  return plain && /^[a-z0-9-]{8,}$/i.test(plain) ? plain : null;
}
