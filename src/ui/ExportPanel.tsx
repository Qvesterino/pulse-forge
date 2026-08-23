import { useState } from "react";
import { useDoc, useServices } from "./context";
import { renderProject } from "../rendering/renderer";
import { buildStemProject, nonEmptyStemGroups } from "../rendering/stems";
import { downloadWav, encodeWav, sanitizeFilename } from "../rendering/wav";
import { buildScorepack } from "../export/scorepack";
import { exportProject } from "../export/project-io";
import { encodeMp3 } from "../export/mp3";
import { canExportVideo, recordVideo } from "../export/video";
import { encodeShareCode, shareAppUrl, embedUrl, embedSnippet } from "../export/shareCode";
import type { WavBitDepth } from "../rendering/wav";
import type { PlayMode } from "../project-model/types";
import { summarizeBuffer, type BufferSummary } from "../audio-engine/metering";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "done"; label: string; summary: BufferSummary }
  | { kind: "error"; label: string };

type MasterFormat = "wav" | "mp3-192" | "mp3-320" | "video";

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function ExportPanel() {
  const services = useServices();
  const doc = useDoc();
  const [mode, setMode] = useState<PlayMode>(services.playback.mode);
  const [sampleRate, setSampleRate] = useState(44100);
  const [bitDepth, setBitDepth] = useState<WavBitDepth>(16);
  const [format, setFormat] = useState<MasterFormat>("wav");
  const [clipSeconds, setClipSeconds] = useState(15);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const busy = status.kind === "busy";
  const baseName = sanitizeFilename(doc.name);
  const groups = nonEmptyStemGroups(doc);
  const videoSupported = canExportVideo();

  const exportMaster = async () => {
    setStatus({ kind: "busy", label: "Rendering master…" });
    try {
      const buffer = await renderProject(doc, services.bank, { mode, sampleRate });
      const summary = summarizeBuffer(buffer);

      if (format === "video") {
        const seconds = Math.min(clipSeconds, buffer.duration);
        const result = await recordVideo(buffer, {
          title: doc.name,
          bpm: doc.bpm,
          seconds,
          onProgress: (f) => setStatus({ kind: "busy", label: `Recording video… ${Math.round(f * 100)}%` }),
        });
        downloadBlob(result.blob, `${baseName}-clip.${result.ext}`);
        setStatus({
          kind: "done",
          label: `Video exported — ${seconds}s ${result.ext.toUpperCase()}, ${(result.bytes / 1e6).toFixed(1)} MB, ready for Reels/Shorts/TikTok`,
          summary,
        });
        return;
      }

      if (format.startsWith("mp3")) {
        const kbps = format === "mp3-320" ? 320 : 192;
        const blob = await encodeMp3(buffer, {
          kbps,
          onProgress: (f) => setStatus({ kind: "busy", label: `Encoding MP3 ${kbps}… ${Math.round(f * 100)}%` }),
        });
        downloadBlob(blob, `${baseName}-${kbps}.mp3`);
        setStatus({
          kind: "done",
          label: `MP3 exported (${buffer.duration.toFixed(1)}s, ${kbps} kbps, ${(blob.size / 1e6).toFixed(2)} MB)`,
          summary,
        });
        return;
      }

      downloadWav(encodeWav(buffer, bitDepth), `${baseName}-master.wav`);
      setStatus({
        kind: "done",
        label: `Master exported (${buffer.duration.toFixed(1)}s, ${sampleRate} Hz, ${bitDepth}-bit)`,
        summary,
      });
    } catch (error) {
      setStatus({ kind: "error", label: `Export failed: ${String(error)}` });
    }
  };

  const exportStems = async () => {
    try {
      let lastSummary: BufferSummary | null = null;
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        setStatus({ kind: "busy", label: `Rendering stem ${i + 1}/${groups.length}: ${group.label}…` });
        const stemDoc = buildStemProject(doc, group.filter);
        const buffer = await renderProject(stemDoc, services.bank, { mode, sampleRate });
        lastSummary = summarizeBuffer(buffer);
        downloadWav(encodeWav(buffer, bitDepth), `${baseName}-${group.id}.wav`);
      }
      setStatus({
        kind: "done",
        label: `${groups.length} stems exported (${groups.map((g) => g.label).join(", ")})`,
        summary: lastSummary ?? { peak: 0, peakDb: -120, truePeakDb: -120, rms: 0, rmsDb: -120, correlation: 1 },
      });
    } catch (error) {
      setStatus({ kind: "error", label: `Stem export failed: ${String(error)}` });
    }
  };

  const exportTracks = async () => {
    try {
      let lastSummary: BufferSummary | null = null;
      for (let i = 0; i < doc.tracks.length; i++) {
        const track = doc.tracks[i];
        setStatus({ kind: "busy", label: `Rendering track ${i + 1}/${doc.tracks.length}: ${track.name}…` });
        const trackDoc = buildStemProject(doc, (t) => t.id === track.id);
        const buffer = await renderProject(trackDoc, services.bank, { mode, sampleRate });
        lastSummary = summarizeBuffer(buffer);
        downloadWav(encodeWav(buffer, bitDepth), `${baseName}-track-${sanitizeFilename(track.name)}.wav`);
      }
      setStatus({
        kind: "done",
        label: `${doc.tracks.length} track stems exported`,
        summary: lastSummary ?? { peak: 0, peakDb: -120, truePeakDb: -120, rms: 0, rmsDb: -120, correlation: 1 },
      });
    } catch (error) {
      setStatus({ kind: "error", label: `Track export failed: ${String(error)}` });
    }
  };

  const copyText = async (text: string, doneLabel: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ kind: "done", label: doneLabel, summary: { peak: 0, peakDb: -120, truePeakDb: -120, rms: 0, rmsDb: -120, correlation: 1 } });
    } catch {
      setStatus({ kind: "error", label: "Clipboard blocked by the browser — copy failed" });
    }
  };

  /** Share link: the whole project compressed into the URL (?import=…). */
  const copyShareLink = () => {
    const code = encodeShareCode(doc);
    const url = shareAppUrl(code, location.origin);
    const approxKb = Math.round(url.length / 1024);
    return copyText(url, `Share link copied (${approxKb} kB URL) — opens this project in the studio`);
  };

  /** Embed snippet: self-contained player iframe for Discord/Reddit/websites. */
  const copyEmbedCode = () => {
    const code = encodeShareCode(doc);
    const snippet = embedSnippet(embedUrl(code, location.origin));
    return copyText(snippet, "Embed iframe copied — paste it into a website");
  };

  const exportScorepack = async () => {
    setStatus({ kind: "busy", label: "Building scorepack…" });
    try {
      const { blob, filename } = await buildScorepack(doc, services.bank, (p) => {
        setStatus({ kind: "busy", label: `Scorepack: ${p.phase}…` });
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setStatus({
        kind: "done",
        label: `Scorepack exported (${filename})`,
        summary: { peak: 0, peakDb: -120, truePeakDb: -120, rms: 0, rmsDb: -120, correlation: 1 },
      });
    } catch (error) {
      setStatus({ kind: "error", label: `Scorepack failed: ${String(error)}` });
    }
  };

  return (
    <section className="export-panel" aria-label="Export">
      <div className="export-options">
        <label className="fx-param-select">
          <span className="slider-label">SOURCE</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as PlayMode)}>
            <option value="song">Arrangement (SONG)</option>
            <option value="pattern">Active pattern (1 pass)</option>
          </select>
        </label>
        <label className="fx-param-select">
          <span className="slider-label">RATE</span>
          <select value={sampleRate} onChange={(event) => setSampleRate(Number(event.target.value))}>
            <option value={44100}>44.1 kHz</option>
            <option value={48000}>48 kHz</option>
          </select>
        </label>
        <label className="fx-param-select">
          <span className="slider-label">FORMAT</span>
          <select value={format} onChange={(event) => setFormat(event.target.value as MasterFormat)}>
            <option value="wav">WAV (studio)</option>
            <option value="mp3-192">MP3 192 (share)</option>
            <option value="mp3-320">MP3 320 (hq share)</option>
            <option value="video" disabled={!videoSupported}>
              VIDEO {videoSupported ? "(Reels/TikTok)" : "(unsupported)"}
            </option>
          </select>
        </label>
        {format === "video" && (
          <label className="fx-param-select">
            <span className="slider-label">LENGTH</span>
            <select value={clipSeconds} onChange={(event) => setClipSeconds(Number(event.target.value))}>
              <option value={5}>5 s</option>
              <option value={10}>10 s</option>
              <option value={15}>15 s</option>
              <option value={30}>30 s</option>
            </select>
          </label>
        )}
        <label className="fx-param-select">
          <span className="slider-label">DEPTH</span>
          <select
            value={bitDepth}
            disabled={format !== "wav"}
            title={format !== "wav" ? "Depth applies to WAV only" : undefined}
            onChange={(event) => setBitDepth(Number(event.target.value) as WavBitDepth)}
          >
            <option value={16}>16-bit PCM</option>
            <option value={24}>24-bit PCM</option>
            <option value={32}>32-bit float</option>
          </select>
        </label>
      </div>
      <div className="export-buttons">
        <button type="button" className="btn btn-export" disabled={busy || (format === "video" && !videoSupported)} onClick={() => void exportMaster()}>
          {format === "video" ? "EXPORT VIDEO" : `EXPORT MASTER${format.startsWith("mp3") ? " (MP3)" : ""}`}
        </button>
        <button
          type="button"
          className="btn btn-export"
          disabled={busy || groups.length === 0}
          title="Grouped stems: drums / bass / music (solo is disabled in stems)"
          onClick={() => void exportStems()}
        >
          EXPORT STEMS ({groups.length})
        </button>
        <button type="button" className="btn btn-export" disabled={busy} onClick={() => void exportTracks()}>
          EXPORT ALL TRACKS ({doc.tracks.length})
        </button>
        <button
          type="button"
          className="btn btn-export"
          disabled={busy}
          title="Copy a link that opens this project in the full studio"
          onClick={() => void copyShareLink()}
        >
          COPY SHARE LINK
        </button>
        <button
          type="button"
          className="btn btn-export"
          disabled={busy}
          title="Copy an iframe embed with a playable beat player"
          onClick={() => void copyEmbedCode()}
        >
          COPY EMBED CODE
        </button>
        <button
          type="button"
          className="btn btn-export btn-export-scorepack"
          disabled={busy}
          title="Export a .scorepack ZIP: master + stems + cues + JSON manifests"
          onClick={() => void exportScorepack()}
        >
          EXPORT SCOREPACK
        </button>
        <button
          type="button"
          className="btn btn-export"
          disabled={busy}
          title="Download project as JSON file for backup or sharing"
          onClick={() => exportProject(doc)}
        >
          EXPORT JSON
        </button>
      </div>
      <div className={`export-status export-${status.kind}`}>
        {status.kind === "idle" && "Offline render uses the exact same engine, instruments and effects as playback — plus a 2 s tail for reverb/delay."}
        {status.kind !== "idle" && status.label}
      </div>
      {status.kind === "done" && <ExportSummary summary={status.summary} />}
    </section>
  );
}

function ExportSummary({ summary }: { summary: BufferSummary }) {
  const corr = summary.correlation;
  const corrLabel = corr > 0.5 ? "Mono OK" : corr < 0 ? "Phase" : "Wide";
  const clipped = summary.peakDb > -0.3 || summary.truePeakDb > -0.3;
  return (
    <div className="export-summary" aria-label="Export summary">
      <div className="export-summary-row">
        <span className="export-summary-label">PEAK</span>
        <span className="export-summary-value">{summary.peakDb.toFixed(1)} dB</span>
      </div>
      <div className="export-summary-row">
        <span className="export-summary-label">TRUE PEAK</span>
        <span className={`export-summary-value${clipped ? " export-summary-clipped" : ""}`}>
          {summary.truePeakDb.toFixed(1)} dB
          {clipped && " ⚠"}
        </span>
      </div>
      <div className="export-summary-row">
        <span className="export-summary-label">RMS</span>
        <span className="export-summary-value">{summary.rmsDb.toFixed(1)} dB</span>
      </div>
      <div className="export-summary-row">
        <span className="export-summary-label">×CORR</span>
        <span className="export-summary-value">{corr.toFixed(2)} {corrLabel}</span>
      </div>
    </div>
  );
}
