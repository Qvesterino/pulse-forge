import { useEffect, useState } from "react";
import { useServices } from "./context";
import {
  collectPerformanceReport,
  measureRenderTime,
  measureSongRender,
  type PerformanceReport,
} from "../benchmark/performance";
import { evaluateReport } from "../benchmark/index";

type DiagTab = "engine" | "memory" | "performance";

export function Diagnostics() {
  const services = useServices();
  const [tab, setTab] = useState<DiagTab>("engine");
  const [rows, setRows] = useState<Record<string, string | number | boolean>>({});
  const [perfReport, setPerfReport] = useState<PerformanceReport | null>(null);
  const [renderStatus, setRenderStatus] = useState<string>("");
  const [issues, setIssues] = useState<string[]>([]);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    const update = () => setRows(services.getDiagnostics());
    update();
    const timer = setInterval(update, 400);
    return () => clearInterval(timer);
  }, [services]);

  const refreshPerf = () => {
    const report = collectPerformanceReport(services.engine, services.scheduler, 0, services.bank.size);
    if (perfReport) report.startupMs = perfReport.startupMs;
    setPerfReport(report);
    setIssues(evaluateReport({ performance: report, stressResults: [], timestamp: "", passed: 0, failed: 0 }));
  };

  useEffect(() => {
    if (tab !== "memory") return;
    if (!navigator.storage?.estimate) return;
    void navigator.storage.estimate().then((est) => {
      setStorage({ usage: est.usage ?? 0, quota: est.quota ?? 0 });
    });
  }, [tab]);

  const measureRender = async (mode: "pattern" | "song") => {
    setRenderStatus("Measuring render...");
    try {
      const doc = services.store.doc;
      if (mode === "pattern") {
        const r = await measureRenderTime(doc, services.bank);
        setRenderStatus(`Pattern: ${r.durationMs}ms (${r.bufferDuration.toFixed(1)}s audio, ${r.samples} samples)`);
      } else {
        const r = await measureSongRender(doc, services.bank);
        setRenderStatus(`Song: ${r.durationMs}ms (${r.bufferDuration.toFixed(1)}s audio, ${r.arrangementBars} bars)`);
      }
    } catch (error) {
      setRenderStatus(`Error: ${String(error)}`);
    }
  };

  return (
    <section className="diagnostics" aria-label="Engine diagnostics">
      <h2 className="panel-title">DIAGNOSTICS</h2>

      <div className="diag-tabs">
        {(["engine", "memory", "performance"] as DiagTab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`btn btn-small${tab === t ? " active-solo" : ""}`}
            onClick={() => {
              setTab(t);
              if (t === "performance") refreshPerf();
            }}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      {tab === "engine" && (
        <div className="diagnostics-grid">
          {Object.entries(rows).map(([key, value]) => (
            <div key={key} className="diagnostics-row">
              <span className="diagnostics-key">{key}</span>
              <span className="diagnostics-value">{String(value)}</span>
            </div>
          ))}
        </div>
      )}

      {tab === "memory" && (
        <div className="diagnostics-grid">
          {perfReport ? (
            <>
              <DiagRow label="Heap Used" value={`${perfReport.memoryMB ?? "?"} MB`} />
              <DiagRow label="Factory Bank" value={`${perfReport.bankSize} samples`} />
              <DiagRow label="Tracks" value={String(perfReport.trackCount)} />
              <DiagRow label="Active Instruments" value={String(perfReport.instrumentCount)} />
              <DiagRow label="Active Effects" value={String(perfReport.effectCount)} />
              <DiagRow label="Active LFOs" value={String(perfReport.lfoCount)} />
              <DiagRow label="Drum Voices" value={String(perfReport.drumVoiceCount)} />
            </>
          ) : (
            <button type="button" className="btn btn-small" onClick={refreshPerf}>
              Load metrics
            </button>
          )}
          {storage && storage.quota > 0 ? (
            <>
              <DiagRow label="Storage Used" value={`${(storage.usage / 1048576).toFixed(1)} MB`} />
              <DiagRow label="Storage Quota" value={`${(storage.quota / 1048576).toFixed(0)} MB`} />
              <DiagRow
                label="Storage"
                value={`${Math.round((storage.usage / storage.quota) * 100)}% full${
                  storage.usage / storage.quota > 0.85 ? " — ⚠ low quota" : ""
                }`}
              />
            </>
          ) : storage ? (
            <DiagRow label="Storage" value="Quota unavailable" />
          ) : null}
        </div>
      )}

      {tab === "performance" && (
        <div className="diagnostics-grid">
          <DiagRow label="Startup" value={`${perfReport?.startupMs ?? "?"} ms`} />
          <DiagRow label="AudioNodes" value={`${perfReport?.audioNodeCount ?? "?"}`} />
          <DiagRow label="Scheduler Events" value={String(perfReport?.schedulerEvents ?? 0)} />
          <DiagRow label="Scheduler Windows" value={String(perfReport?.schedulerWindows ?? 0)} />

          <div className="diag-subsection">
            <button type="button" className="btn btn-small" onClick={() => void measureRender("pattern")}>
              MEASURE PATTERN
            </button>
            <button type="button" className="btn btn-small" onClick={() => void measureRender("song")}>
              MEASURE SONG
            </button>
          </div>
          {renderStatus && <DiagRow label="Render" value={renderStatus} />}

          {issues.length > 0 && (
            <div className="diag-issues">
              <div className="diag-issue-title">ISSUES</div>
              {issues.map((issue, i) => (
                <div key={i} className="diag-issue">
                  {issue}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DiagRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="diagnostics-row">
      <span className="diagnostics-key">{label}</span>
      <span className="diagnostics-value">{value}</span>
    </div>
  );
}
