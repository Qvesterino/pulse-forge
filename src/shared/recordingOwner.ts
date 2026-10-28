/**
 * RECORDING OWNER IDENTITY — the per-tab id that owns live recording
 * recovery rows.
 *
 * Identifies this browser context (tab load) so `listRecoverable` can hide
 * the tab's own still-live take. A crash keeps the row with the old owner id,
 * so after a reload (new id) the interrupted take remains recoverable.
 *
 * It lives in the shared layer, not in the persistence module: the capture
 * recorder (audio engine) stamps its recovery sessions with this id, and the
 * architecture layer gate forbids the audio engine from importing the
 * persistence layer. The value itself has NO storage dependency — it is a
 * random per-load identity — so the persistence module re-exports it and
 * every existing importer keeps working.
 */
export const RECORDING_OWNER_ID: string = (() => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
})();
