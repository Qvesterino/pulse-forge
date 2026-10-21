import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useServices } from "./context";
import { cancelAllJobs, cancelJob, dismissJobNotice, jobSnapshot, subscribeJobs } from "../services/jobCenter";
import {
  agentTrustSnapshot,
  clearAgentAudit,
  endAgentSession,
  subscribeAgentTrust,
  type AgentAuditEntry,
  type AgentSession,
  type ToolRisk,
} from "../mcp/agentTrust";
import { restoreIntentCheckpoint } from "../intent/checkpoints";

/**
 * ACTIVITY CENTER (Wave 1 A+B) — one visible place for "what is running" and
 * "what did the agent do".
 *
 * Two observers, zero engine/DSP involvement:
 *  - JOBS: the long operations registered in services/jobCenter (agent calls
 *    today; human-facing panels adopt the same registry over time).
 *  - AGENT: the trust-layer audit — every MCP call with its risk class, and
 *    one REVERT SESSION action backed by the pre-session checkpoint.
 *
 * Zero cost when healthy: nothing renders when no job is running and no agent
 * session has been active recently.
 */

const RISK_BADGE: Record<ToolRisk, string> = { read: "R", runtime: "↯", mutate: "✎", destructive: "⚠" };
const RECENT_WINDOW_MS = 30 * 60 * 1000;

function shortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function entryLine(entry: AgentAuditEntry): string {
  const flags = [
    entry.mutated ? "mutated" : null,
    entry.dryRun ? "dry-run" : null,
    entry.replayed ? "replay" : null,
    entry.isError ? `error:${entry.errorCode ?? "?"}` : null,
  ]
    .filter((flag): flag is string => flag != null)
    .join(" · ");
  return `${shortTime(entry.ts)} ${entry.agent} ${entry.tool} [${RISK_BADGE[entry.risk]}] ${Math.round(entry.durationMs)}ms${flags !== "" ? ` · ${flags}` : ""}`;
}

export function ActivityCenter() {
  const services = useServices();
  const jobs = useSyncExternalStore(subscribeJobs, jobSnapshot);
  const trust = useSyncExternalStore(subscribeAgentTrust, agentTrustSnapshot);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const lastEntryTs = trust.entries.length > 0 ? trust.entries[trust.entries.length - 1]!.ts : 0;
  const freshNotice = jobs.notices.length > 0 ? jobs.notices[jobs.notices.length - 1]! : null;
  const noticeFresh = freshNotice != null && Date.now() - freshNotice.ts < 8000;

  const visible = jobs.runningCount > 0 || trust.session != null || Date.now() - lastEntryTs < RECENT_WINDOW_MS;

  // Re-render only while something on screen is time-sensitive (a fresh
  // completion notice or a running job's elapsed clock).
  useEffect(() => {
    if (!noticeFresh && !(open && jobs.runningCount > 0)) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 2000);
    return () => window.clearInterval(timer);
  }, [noticeFresh, open, jobs.runningCount]);

  const revertSession = useCallback(
    async (session: AgentSession) => {
      setBusy(true);
      setError(null);
      try {
        const restored = await restoreIntentCheckpoint(session.docId, session.checkpointName);
        if (restored == null) {
          setError("The session checkpoint is no longer available (evicted) — nothing was changed.");
          return;
        }
        const before = services.store.getDoc();
        if (before.id !== restored.doc.id) {
          setError("A different project is open now — revert aborted.");
          return;
        }
        // Safety net mirroring the snapshot panel: a mistaken revert stays
        // recoverable even after a reload.
        void services.core.snapshots
          .save(before.id, before, "Auto — before agent revert")
          .then(() => services.core.snapshots.prune(before.id))
          .catch(() => undefined);
        const restoredDoc = typeof structuredClone === "function" ? structuredClone(restored.doc) : restored.doc;
        services.store.execute({
          type: "restoreSnapshot",
          label: `Revert agent session (${session.agent})`,
          execute: () => restoredDoc,
          undo: () => before,
        });
        endAgentSession();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Session revert failed.");
      } finally {
        setBusy(false);
      }
    },
    [services],
  );

  const finished = useMemo(
    () =>
      jobs.jobs
        .filter((job) => job.status !== "running")
        .slice(-5)
        .reverse(),
    [jobs.jobs],
  );
  const running = useMemo(() => jobs.jobs.filter((job) => job.status === "running"), [jobs.jobs]);
  const audit = useMemo(() => [...trust.entries].slice(-15).reverse(), [trust.entries]);

  /**
   * TRUST REPORT — one downloadable artifact (markdown for a human, JSON for a
   * machine) built from the live stores. It is deliberately reachable from
   * HERE, next to the agent log: the moment you wonder "what did that thing do
   * to my project?" is the moment you want the report.
   */
  const downloadReport = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Loaded at the click, not at boot: the report builder carries the
      // render manifest and the zip writer (13 KB built) plus the whole
      // trust-report module, and the activity center is mounted on every
      // studio boot whether or not anyone ever asks for a report.
      const { downloadTrustReport } = await import("../services/trustReport");
      await downloadTrustReport(services);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trust report failed.");
    } finally {
      setBusy(false);
    }
  }, [services]);

  /** The story beside the report: what the session WAS, next to whether it was honest. */
  const downloadStory = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { downloadSessionStory } = await import("../services/sessionStory");
      await downloadSessionStory(services);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Session story failed.");
    } finally {
      setBusy(false);
    }
  }, [services]);

  if (!visible && !open) return null;

  const chipText =
    noticeFresh && freshNotice != null
      ? freshNotice.text
      : jobs.runningCount > 0
        ? `● JOBS ${jobs.runningCount}`
        : trust.session != null
          ? `AGENT ${RISK_BADGE[trust.session.mutations > 0 ? "mutate" : "read"]} ${trust.session.calls}`
          : `AGENT ${trust.entries.length}`;

  return (
    <>
      <button
        type="button"
        className={`save-status ${noticeFresh && freshNotice?.status === "failed" ? "save-error" : ""}`}
        style={{ position: "fixed", right: 12, bottom: 72, zIndex: 40 }}
        title="Activity — running jobs and the agent audit log"
        data-tick={tick}
        onClick={() => {
          // Opening the panel supersedes the transient completion text.
          if (freshNotice != null) dismissJobNotice(freshNotice.id);
          setOpen((value) => !value);
        }}
      >
        {chipText}
      </button>
      {open && (
        <div
          className="context-menu"
          role="dialog"
          aria-label="Activity center"
          style={{
            right: 12,
            bottom: 108,
            top: "auto",
            left: "auto",
            width: 460,
            maxHeight: "60vh",
            overflowY: "auto",
            zIndex: 41,
          }}
        >
          <div className="context-menu-header">ACTIVITY</div>

          <div style={{ padding: "0 10px 6px", fontSize: 11, color: "var(--muted)" }}>
            JOBS {jobs.runningCount > 0 ? `· ${jobs.runningCount} running` : "· idle"}
            {jobs.runningCount > 1 && (
              <button
                type="button"
                className="btn"
                style={{ marginLeft: 8 }}
                onClick={() => cancelAllJobs()}
                disabled={busy}
              >
                CANCEL ALL
              </button>
            )}
          </div>
          {running.length === 0 && finished.length === 0 && (
            <div style={{ padding: "0 10px 8px", fontSize: 11, color: "var(--muted)" }}>No jobs yet.</div>
          )}
          {running.map((job) => (
            <div
              key={job.id}
              style={{ padding: "2px 10px", fontSize: 11, display: "flex", gap: 8, alignItems: "center" }}
            >
              <span style={{ flex: 1 }}>
                ● {job.label}
                {job.progress >= 0 ? ` — ${Math.round(job.progress * 100)}%` : ""} {job.note ? `· ${job.note}` : ""}
              </span>
              {job.cancellable && (
                <button type="button" className="btn" onClick={() => cancelJob(job.id)}>
                  CANCEL
                </button>
              )}
            </div>
          ))}
          {finished.map((job) => (
            <div key={job.id} style={{ padding: "2px 10px", fontSize: 11, color: "var(--muted)" }}>
              {job.status === "done" ? "✓" : "✗"} {job.label}
              {job.error ? ` — ${job.error}` : ""} · {shortTime(job.finishedAt ?? job.startedAt)}
            </div>
          ))}

          <div className="context-menu-header" style={{ marginTop: 6 }}>
            AGENT · {trust.session != null ? `SESSION (${trust.session.agent})` : "HISTORY"}
          </div>
          {trust.session != null && (
            <div style={{ padding: "0 10px 6px", fontSize: 11, display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ flex: 1 }}>
                {trust.session.calls} calls · {trust.session.mutations} changes · since{" "}
                {shortTime(trust.session.startedAt)}
                {trust.session.checkpointSaved
                  ? ` · checkpoint "${trust.session.checkpointName}"`
                  : " · checkpoint not durable (storage unavailable — revert disabled)"}
              </span>
              <button
                type="button"
                className="btn btn-export"
                disabled={busy || !trust.session.checkpointSaved}
                title="Restore the project to the state BEFORE this session's first change (one undoable step)"
                onClick={() => void revertSession(trust.session!)}
              >
                REVERT SESSION
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => endAgentSession()}>
                END
              </button>
            </div>
          )}
          {error != null && (
            <div className="save-status save-error" role="alert" style={{ margin: "0 10px 6px" }}>
              {error}
            </div>
          )}
          {audit.length === 0 && (
            <div style={{ padding: "0 10px 8px", fontSize: 11, color: "var(--muted)" }}>No agent calls logged.</div>
          )}
          {audit.map((entry) => (
            <div
              key={entry.id}
              style={{
                padding: "2px 10px",
                fontSize: 11,
                fontFamily: "monospace",
                color: entry.isError ? "var(--danger, #f87171)" : undefined,
              }}
              title={entry.summary ?? ""}
            >
              {entryLine(entry)}
            </div>
          ))}
          {trust.entries.length > 0 ? (
            <div style={{ padding: "6px 10px", display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn btn-export"
                disabled={busy}
                title="Download a Trust Report (markdown + JSON): durability, freeze integrity, agent activity, AI receipts, audio health and the last export hash"
                onClick={() => void downloadReport()}
              >
                {busy ? "BUILDING…" : "TRUST REPORT"}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  clearAgentAudit();
                }}
              >
                CLEAR LOG
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                title="Download the Session Story (markdown + JSON): every step, what was kept or reverted, the measured reasons and the export hash"
                onClick={() => void downloadStory()}
              >
                STORY
              </button>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                CLOSE
              </button>
            </div>
          ) : (
            <div style={{ padding: "6px 10px", display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn btn-export"
                disabled={busy}
                title="Download a Trust Report (markdown + JSON): durability, freeze integrity, agent activity, AI receipts, audio health and the last export hash"
                onClick={() => void downloadReport()}
              >
                {busy ? "BUILDING…" : "TRUST REPORT"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                title="Download the Session Story (markdown + JSON): every step, what was kept or reverted, the measured reasons and the export hash"
                onClick={() => void downloadStory()}
              >
                STORY
              </button>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                CLOSE
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
