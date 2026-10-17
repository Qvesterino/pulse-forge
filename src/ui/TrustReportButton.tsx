import { useCallback, useState } from "react";
import { useServices } from "./context";
import { downloadTrustReport } from "../services/trustReport";

/**
 * TRUST REPORT — one downloadable artifact (markdown for a human, JSON for a
 * machine) that answers "did this app lose my work, and is anything it told me
 * not true?".
 *
 * It sits in the EXPORT panel because that is where the question is asked: you
 * are about to hand the file to someone, and the report carries the durability
 * facts, the freeze integrity, the agent activity, the AI receipts and the
 * render hash of the export itself. The activity panel offers the same report
 * next to the agent log — one implementation, two doors.
 */
export function TrustReportButton() {
  const services = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await downloadTrustReport(services);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trust report failed.");
    } finally {
      setBusy(false);
    }
  }, [busy, services]);

  return (
    <div className="export-verify" role="group" aria-label="Trust report">
      <button
        type="button"
        className="btn"
        disabled={busy}
        title="Download a Trust Report (markdown + JSON): durability, freeze integrity, agent activity, AI receipts, audio health and the last export hash"
        onClick={() => void download()}
      >
        {busy ? "BUILDING…" : "TRUST REPORT"}
      </button>
      {error != null && (
        <span className="save-status save-error" role="alert" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
