import { useCallback, useState } from "react";
import { useServices } from "./context";
import { downloadSessionStory } from "../services/sessionStory";

/**
 * SESSION STORY — the readable account of how the beat came to be: every step
 * in order, the MEASURED reason where one exists (and nothing where none does),
 * what was kept or reverted, which models are in the mix, and the export hash.
 *
 * It sits beside the Trust Report because they are siblings: the report says
 * whether the app was honest about your work, the story says what the work was.
 */
export function SessionStoryButton() {
  const services = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await downloadSessionStory(services);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Session story failed.");
    } finally {
      setBusy(false);
    }
  }, [busy, services]);

  return (
    <div className="export-verify" role="group" aria-label="Session story">
      <button
        type="button"
        className="btn"
        disabled={busy}
        title="Download the Session Story (markdown + JSON): every step in order, the measured reason where one exists, what was kept or reverted, the AI receipts and the export hash"
        onClick={() => void download()}
      >
        {busy ? "WRITING…" : "SESSION STORY"}
      </button>
      {error != null && (
        <span className="save-status save-error" role="alert" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
