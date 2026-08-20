import { useState } from "react";
import { useDoc, useServices } from "./context";
import { renderProject } from "../rendering/renderer";
import { buildStemProject, nonEmptyStemGroups } from "../rendering/stems";
import { downloadWav, encodeWav, sanitizeFilename } from "../rendering/wav";
import type { WavBitDepth } from "../rendering/wav";
import type { PlayMode } from "../project-model/types";
import { summarizeBuffer, type BufferSummary } from "../audio-engine/metering";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "done"; label: string; summary: BufferSummary }
  | { kind: "error"; label: string };

export function ExportPanel() {
  const services = useServices();
  const doc = useDoc();
  const [mode, setMode] = useState<PlayMode>(services.playback.mode);
  const [sampleRate, setSampleRate] = useState(44100);
  const [bitDepth, setBitDepth] = useState<WavBitDepth>(16);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const busy = status.kind === "busy";
  const baseName = sanitizeFilename(doc.name);
  const groups = nonEmptyStemGroups(doc);

  const exportMaster = async () => {
    setStatus({ kind: "busy", label: "Rendering master…" });
    try {
      const buffer = await renderProject(doc, services.bank, { mode, sampleRate });
      const summary = summarizeBuffer(buffer);
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
          <span className="slider-label">DEPTH</span>
          <select value={bitDepth} onChange={(event) => setBitDepth(Number(event.target.value) as WavBitDepth)}>
            <option value={16}>16-bit PCM</option>
            <option value={24}>24-bit PCM</option>
            <option value={32}>32-bit float</option>
          </select>
        </label>
      </div>
      <div className="export-buttons">
        <button type="button" className="btn btn-export" disabled={busy} onClick={() => void exportMaster()}>
          EXPORT MASTER
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
