import { useEffect, useState } from "react";
import { useServices } from "./context";
// Lazy benchmark stack: Diagnostics is the only consumer and every call site
// is user-triggered — the eager import parked the whole measurement harness
// in the studio boot graph for a panel most sessions never open.
import type { PerformanceReport } from "../benchmark/performance";
import { isWorkletReady } from "../audio-worklets/loader";
import { nativeCapabilities } from "../mobile/nativeBridge";
import {
  downloadOfflinePack,
  formatBytes,
  loadOfflinePackManifest,
  type OfflinePack,
  type OfflinePackManifest,
} from "../pwa/offlinePack";

type DiagTab = "engine" | "memory" | "performance" | "device";

export function Diagnostics() {
  const services = useServices();
  const [tab, setTab] = useState<DiagTab>("engine");
  const [rows, setRows] = useState<Record<string, string | number | boolean>>({});
  const [perfReport, setPerfReport] = useState<PerformanceReport | null>(null);
  const [renderStatus, setRenderStatus] = useState<string>("");
  const [issues, setIssues] = useState<string[]>([]);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [device, setDevice] = useState<Record<string, string>>({});
  const [offlineManifest, setOfflineManifest] = useState<OfflinePackManifest | null>(null);
  const [offlineState, setOfflineState] = useState<Record<string, string>>({});
  const [offlineBusy, setOfflineBusy] = useState<string | null>(null);

  const refreshDevice = () => {
    const ctx = services.engine.getLiveAudioContext();
    const caps = nativeCapabilities();
    const root = document.documentElement;
    const matchMedia = (window as unknown as { matchMedia?: (query: string) => MediaQueryList }).matchMedia;
    const standalone = matchMedia ? matchMedia("(display-mode: standalone)").matches : false;
    const sw = navigator.serviceWorker?.controller ? "active" : "not controlling";
    const midi = navigator.requestMIDIAccess ? "Web MIDI" : caps.midi ? "native bridge" : "unavailable";
    const ms = (value: number | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? `${(value * 1000).toFixed(1)} ms` : "—";
    setDevice({
      "Audio context": ctx?.state ?? "not started",
      "Sample rate": ctx ? `${Math.round(ctx.sampleRate)} Hz` : "—",
      "Base latency": ctx ? ms(ctx.baseLatency) : "—",
      "Output latency": ctx ? ms(ctx.outputLatency) : "—",
      "Core worklets": ctx ? (isWorkletReady("bitcrusher", ctx) ? "ready" : "loading / bypass") : "no context",
      "FX extras": ctx ? (isWorkletReady("vocoder", ctx) ? "ready" : "lazy (not loaded)") : "—",
      "Mobile profile": root.getAttribute("data-mobile-profile") ?? "unknown",
      "Input mode": root.getAttribute("data-input-mode") ?? "unknown",
      "PWA display": standalone ? "standalone" : "browser",
      "Service worker": sw,
      MIDI: midi,
      "Native MIDI": caps.midi ? "available" : "absent",
      "Native SAF": caps.files ? "available" : "absent",
      "Native audio session": caps.audioSession ? "available" : "absent",
    });
  };

  useEffect(() => {
    if (tab !== "device") return;
    refreshDevice();
    if (!offlineManifest) {
      void loadOfflinePackManifest().then(setOfflineManifest);
    }
    // refreshDevice reads live services; re-run on tab entry only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, offlineManifest]);

  useEffect(() => {
    const update = () => setRows(services.getDiagnostics());
    update();
    const timer = setInterval(update, 400);
    return () => clearInterval(timer);
  }, [services]);

  const refreshPerf = async () => {
    const [{ collectPerformanceReport }, { evaluateReport }] = await Promise.all([
      import("../benchmark/performance"),
      import("../benchmark/index"),
    ]);
    const report = collectPerformanceReport(services.engine, services.scheduler, 0, services.bank.size);
    if (perfReport) report.startupMs = perfReport.startupMs;
    setPerfReport(report);
    setIssues(evaluateReport({ performance: report, stressResults: [], timestamp: "", passed: 0, failed: 0 }));
  };

  useEffect(() => {
    if (tab !== "memory" && tab !== "device") return;
    if (!navigator.storage?.estimate) return;
    void navigator.storage.estimate().then((est) => {
      setStorage({ usage: est.usage ?? 0, quota: est.quota ?? 0 });
    });
  }, [tab]);

  const measureRender = async (mode: "pattern" | "song") => {
    setRenderStatus("Measuring render...");
    try {
      const { measureRenderTime, measureSongRender } = await import("../benchmark/performance");
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

  const downloadPack = async (pack: OfflinePack) => {
    setOfflineBusy(pack.id);
    setOfflineState((prev) => ({ ...prev, [pack.id]: "Preparing cache…" }));
    try {
      await navigator.storage?.persist?.();
    } catch {
      /* optional */
    }
    try {
      const result = await downloadOfflinePack(pack, {
        onProgress: (progress) => {
          setOfflineState((prev) => ({
            ...prev,
            [pack.id]: `${progress.completed}/${progress.total} · ${formatBytes(progress.downloadedBytes)}`,
          }));
        },
      });
      setOfflineState((prev) => ({
        ...prev,
        [pack.id]: `${result.aborted ? "Cancelled" : "Offline"}: ${result.downloaded} new, ${result.skipped} cached${
          result.failed ? `, ${result.failed} failed` : ""
        }`,
      }));
    } catch (error) {
      setOfflineState((prev) => ({ ...prev, [pack.id]: `Failed: ${String(error)}` }));
    } finally {
      setOfflineBusy(null);
    }
  };

  return (
    <section className="diagnostics" aria-label="Engine diagnostics">
      <h2 className="panel-title">DIAGNOSTICS</h2>

      <div className="diag-tabs">
        {(["engine", "memory", "performance", "device"] as DiagTab[]).map((t) => (
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

      {tab === "device" && (
        <div className="diagnostics-grid">
          {Object.entries(device).map(([key, value]) => (
            <DiagRow key={key} label={key} value={value} />
          ))}
          {storage && storage.quota > 0 && (
            <DiagRow
              label="Storage"
              value={`${(storage.usage / 1048576).toFixed(1)} / ${(storage.quota / 1048576).toFixed(0)} MB`}
            />
          )}

          <div className="diag-subsection diag-packs">
            <div className="diag-issue-title">OFFLINE AUDIO PACKS</div>
            {offlineManifest ? (
              offlineManifest.packs.map((pack) => (
                <div key={pack.id} className="diag-pack">
                  <div className="diag-pack-copy">
                    <strong>{pack.label}</strong>
                    <span className="latency-hint">
                      {formatBytes(pack.bytes)} · {pack.files.length} files
                    </span>
                    {offlineState[pack.id] && <span className="latency-hint">{offlineState[pack.id]}</span>}
                  </div>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={offlineBusy !== null}
                    onClick={() => void downloadPack(pack)}
                  >
                    {offlineBusy === pack.id ? "DOWNLOADING…" : "DOWNLOAD"}
                  </button>
                </div>
              ))
            ) : (
              <p className="latency-hint">
                Offline pack manifest unavailable. Rebuild with `npm run build:sample-pack-manifest`.
              </p>
            )}
            <p className="latency-hint">
              Samples cache on first use. This prefills the same cache for offline work; the piano pack is large, use
              Wi-Fi.
            </p>
          </div>

          <div className="diag-subsection">
            <button type="button" className="btn btn-small" onClick={refreshDevice}>
              REFRESH DEVICE
            </button>
          </div>
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
