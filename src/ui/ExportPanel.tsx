import { useEffect, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import { renderProject } from "../rendering/renderer";
import { buildStemProject, nonEmptyStemGroups } from "../rendering/stems";
import { downloadWav, encodeWav, sanitizeFilename } from "../rendering/wav";
import { buildScorepack } from "../export/scorepack";
import { exportProject } from "../export/project-io";
import { canExportVideo, recordVideo } from "../export/video";
import { encodeShareCode, shareAppUrl, embedUrl, embedSnippet } from "../export/shareCode";
import type { WavBitDepth } from "../rendering/wav";
import type { PlayMode } from "../project-model/types";
import { summarizeBuffer, type BufferSummary } from "../audio-engine/metering";
import { extensionForMime, LiveRecorder, type RecordSource } from "../audio-engine/recorder";
import { detectLoopBpm } from "../audio-engine/bpm-detect";
import { userSampleId, type UserSampleAsset } from "../persistence/UserSampleRepository";
import { PublishToGalleryButton } from "../gallery/PublishButton";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "done"; label: string; summary: BufferSummary }
  | { kind: "error"; label: string };

type MasterFormat = "wav" | "mp3-192" | "mp3-320" | "video";

const EMPTY_EXPORT_SUMMARY: BufferSummary = {
  peak: 0,
  peakDb: -120,
  truePeakDb: -120,
  rms: 0,
  rmsDb: -120,
  correlation: 1,
  lufsMomentary: -120,
  lufsShortTerm: -120,
  lufsIntegrated: -120,
  monoLossDb: 0,
};

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL?.(url), 5000);
}

type RecSourceKind = "master" | "track" | "mic";
type RecState = "idle" | "recording" | "saving";

export function ExportPanel({
  selectedTrackId,
  selectedTrackName,
}: {
  selectedTrackId?: string;
  selectedTrackName?: string;
} = {}) {
  const services = useServices();
  const doc = useDoc();
  const [mode, setMode] = useState<PlayMode>(services.playback.mode);
  const [sampleRate, setSampleRate] = useState(44100);
  const [bitDepth, setBitDepth] = useState<WavBitDepth>(16);
  const [format, setFormat] = useState<MasterFormat>("wav");
  // PRISM render quality (8x oversampling offline tier) — defaults ON: the
  // export has no realtime CPU budget, so the cleaner aliasing floor is
  // free; users can trade it back for render speed.
  const [fxeqRenderQuality, setFxEqRenderQuality] = useState(true);
  const hasFxEq = doc.tracks.some((t) => (t.effects ?? []).some((fx) => fx.type === "fxeq" && !fx.bypassed));
  // VØID render quality (render tier offline) — defaults ON for the same
  // reason as PRISM HQ: no realtime CPU budget on export. Only instances
  // left at the default standard tier are bumped; explicit eco/high/render
  // choices are respected.
  const [ozvenaRenderQuality, setOzvenaRenderQuality] = useState(true);
  const hasOzvena = doc.tracks.some((t) => (t.effects ?? []).some((fx) => fx.type === "ozvena" && !fx.bypassed));
  const [clipSeconds, setClipSeconds] = useState(15);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const markerCount = doc.markers.length;
  /** Active export run — the CANCEL button aborts it (roadmap 1.4). */
  const abortRef = useRef<AbortController | null>(null);
  const beginExport = (): AbortSignal => {
    const controller = new AbortController();
    abortRef.current = controller;
    return controller.signal;
  };
  const cancelExport = () => abortRef.current?.abort();
  /** Cancellation is a normal outcome, not an error — surface it as such. */
  const cancelOrElse = (error: unknown, fallbackLabel: string): void => {
    if (error instanceof DOMException && error.name === "AbortError") {
      setStatus({ kind: "done", label: "Export cancelled", summary: EMPTY_EXPORT_SUMMARY });
      return;
    }
    setStatus({ kind: "error", label: fallbackLabel.replace("{err}", String(error)) });
  };

  const [recSource, setRecSource] = useState<RecSourceKind>("master");
  const [recState, setRecState] = useState<RecState>("idle");
  const [recSeconds, setRecSeconds] = useState(0);
  const [recError, setRecError] = useState<string | null>(null);
  const recorderRef = useRef<LiveRecorder | null>(null);

  const busy = status.kind === "busy";
  const baseName = sanitizeFilename(doc.name);
  const groups = nonEmptyStemGroups(doc);
  const videoSupported = canExportVideo();
  const activePatternName = doc.patterns.find((p) => p.id === doc.activePatternId)?.name ?? "pattern";

  const exportMaster = async () => {
    const signal = beginExport();
    setStatus({ kind: "busy", label: "Rendering master…" });
    try {
      const buffer = await renderProject(doc, services.bank, {
        mode,
        sampleRate,
        fxeqRenderQuality,
        ozvenaRenderQuality,
      });
      if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      const summary = summarizeBuffer(buffer);

      if (format === "video") {
        const seconds = Math.min(clipSeconds, buffer.duration);
        const result = await recordVideo(buffer, {
          title: doc.name,
          bpm: doc.bpm,
          seconds,
          signal,
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
        // The LAME encoder is a heavy dependency — fetched on first MP3 export.
        const { encodeMp3 } = await import("../export/mp3");
        const blob = await encodeMp3(buffer, {
          kbps,
          signal,
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
      cancelOrElse(error, `Export failed: {err}`);
    }
  };

  const exportStems = async () => {
    const signal = beginExport();
    try {
      let lastSummary: BufferSummary | null = null;
      for (let i = 0; i < groups.length; i++) {
        if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
        const group = groups[i];
        setStatus({ kind: "busy", label: `Rendering stem ${i + 1}/${groups.length}: ${group.label}…` });
        const stemDoc = buildStemProject(doc, group.filter);
        const buffer = await renderProject(stemDoc, services.bank, {
          mode,
          sampleRate,
          fxeqRenderQuality,
          ozvenaRenderQuality,
        });
        lastSummary = summarizeBuffer(buffer);
        downloadWav(encodeWav(buffer, bitDepth), `${baseName}-${group.id}.wav`);
      }
      setStatus({
        kind: "done",
        label: `${groups.length} stems exported (${groups.map((g) => g.label).join(", ")})`,
        summary: lastSummary ?? EMPTY_EXPORT_SUMMARY,
      });
    } catch (error) {
      cancelOrElse(error, "Stem export failed: {err}");
    }
  };

  const exportTracks = async () => {
    const signal = beginExport();
    try {
      // Group tracks have no own generators — rendering one produces a
      // silent WAV (their children belong to their own stems).
      const renderableTracks = doc.tracks.filter((t) => t.kind !== "group");
      let lastSummary: BufferSummary | null = null;
      for (let i = 0; i < renderableTracks.length; i++) {
        if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
        const track = renderableTracks[i];
        setStatus({ kind: "busy", label: `Rendering track ${i + 1}/${renderableTracks.length}: ${track.name}…` });
        const trackDoc = buildStemProject(doc, (t) => t.id === track.id);
        const buffer = await renderProject(trackDoc, services.bank, {
          mode,
          sampleRate,
          fxeqRenderQuality,
          ozvenaRenderQuality,
        });
        lastSummary = summarizeBuffer(buffer);
        downloadWav(encodeWav(buffer, bitDepth), `${baseName}-track-${sanitizeFilename(track.name)}.wav`);
      }
      setStatus({
        kind: "done",
        label: `${renderableTracks.length} track stems exported`,
        summary: lastSummary ?? EMPTY_EXPORT_SUMMARY,
      });
    } catch (error) {
      cancelOrElse(error, "Track export failed: {err}");
    }
  };

  const copyText = async (text: string, doneLabel: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ kind: "done", label: doneLabel, summary: EMPTY_EXPORT_SUMMARY });
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

  /** MIDI export: the active pattern as a format-1 .mid (drums on ch 10). */
  const exportMidi = async () => {
    try {
      // The SMF writer is a lazy chunk — fetched on first MIDI export.
      const { patternToMidi, downloadMidi } = await import("../midi/midiProject");
      const bytes = patternToMidi(doc, doc.activePatternId);
      downloadMidi(bytes, `${baseName}-${sanitizeFilename(activePatternName)}`);
      setStatus({
        kind: "done",
        label: `MIDI exported (${activePatternName}) — opens in any DAW`,
        summary: EMPTY_EXPORT_SUMMARY,
      });
    } catch (error) {
      setStatus({ kind: "error", label: `MIDI export failed: ${String(error)}` });
    }
  };

  const exportScorepack = async () => {
    const signal = beginExport();
    setStatus({ kind: "busy", label: "Building scorepack…" });
    try {
      const { blob, filename } = await buildScorepack(
        doc,
        services.bank,
        (p) => {
          setStatus({ kind: "busy", label: `Scorepack: ${p.phase}…` });
        },
        signal,
        { fxeqRenderQuality, ozvenaRenderQuality },
      );
      if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL?.(url), 5000);
      setStatus({
        kind: "done",
        label: `Scorepack exported (${filename})`,
        summary: EMPTY_EXPORT_SUMMARY,
      });
    } catch (error) {
      cancelOrElse(error, "Scorepack failed: {err}");
    }
  };

  // ── Realtime resample — bounce what you hear / mic capture ─────────────

  const startRecording = async () => {
    services.engine.ensureContext();
    const ctx = services.engine.getLiveAudioContext();
    if (!ctx) {
      setRecError("Audio engine not ready");
      return;
    }
    const recorder = new LiveRecorder({
      ctx,
      getTapNode: (source: RecordSource) => {
        if (source.kind === "master") return services.engine.getMasterTapNode();
        if (source.kind === "track") return services.engine.getTrackTapNode(source.trackId);
        return null;
      },
    });
    // The TRACK option only renders with a selected track; anything else that
    // slips through falls back to the master tap rather than failing silently.
    const source: RecordSource =
      recSource === "mic"
        ? { kind: "mic" }
        : recSource === "track" && selectedTrackId
          ? { kind: "track", trackId: selectedTrackId }
          : { kind: "master" };
    try {
      await recorder.start(source);
      recorderRef.current = recorder;
      setRecSeconds(0);
      setRecError(null);
      setRecState("recording");
    } catch (err) {
      setRecError(err instanceof Error ? err.message : "Recording failed");
    }
  };

  const stopRecording = async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    setRecState("saving");
    try {
      const take = await recorder.stop();
      if (!take || take.buffer.duration < 0.05) {
        setRecError("Nothing captured — play something while recording");
        setRecState("idle");
        return;
      }
      const { buffer, blob } = take;
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const id = userSampleId(`resample-${stamp}`);
      services.bank.add(id, buffer);
      // Tempo tag for the sample browser — resampled loops fit the same
      // "Fit to project BPM" workflow as imports.
      let bpm: number | undefined;
      try {
        const detected = detectLoopBpm(buffer.getChannelData(0), buffer.sampleRate);
        if (detected) bpm = detected.bpm;
      } catch {
        /* best-effort */
      }
      const asset: UserSampleAsset = {
        id,
        name: `Resample ${stamp}`,
        fileName: `${id}${extensionForMime(blob.type)}`,
        category: "Custom",
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        createdAt: new Date().toISOString(),
        ...(bpm !== undefined ? { bpm } : {}),
      };
      try {
        await services.userSamples.save(asset, await blob.arrayBuffer());
      } catch (err) {
        setRecError(err instanceof Error ? err.message : "Saving the take failed");
        setRecState("idle");
        return;
      }
      setStatus({
        kind: "done",
        label: `Resampled → "${asset.name}" in Samples (${buffer.duration.toFixed(1)}s) — click it in the browser to flip onto a pad`,
        summary: summarizeBuffer(buffer),
      });
      setRecState("idle");
    } finally {
      recorderRef.current = null;
    }
  };

  // Elapsed REC timer.
  useEffect(() => {
    if (recState !== "recording") return;
    const timer = setInterval(() => {
      setRecSeconds(recorderRef.current?.elapsedSeconds ?? 0);
    }, 200);
    return () => clearInterval(timer);
  }, [recState]);

  // A recorder left running at unmount (panel switch, project close) would
  // keep the mic stream, the engine tap and its chunk buffer alive forever.
  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
    },
    [],
  );

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
        {hasFxEq && (
          <label
            className="fx-param-select"
            title="PRISM instances render at their render tier: 8x saturation oversampling for a lower aliasing floor. Slower render, no effect on the live document."
          >
            <span className="slider-label">PRISM HQ</span>
            <select
              value={fxeqRenderQuality ? "on" : "off"}
              onChange={(event) => setFxEqRenderQuality(event.target.value === "on")}
            >
              <option value="on">Render quality (8x)</option>
              <option value="off">Live quality (faster)</option>
            </select>
          </label>
        )}
        {hasOzvena && (
          <label
            className="fx-param-select"
            title="VØID instances left at the standard tier render at the render tier: full oversampling and safety limiter. Slower render, no effect on the live document; explicit eco/high/render choices are respected."
          >
            <span className="slider-label">VØID HQ</span>
            <select
              value={ozvenaRenderQuality ? "on" : "off"}
              onChange={(event) => setOzvenaRenderQuality(event.target.value === "on")}
            >
              <option value="on">Render quality</option>
              <option value="off">Live quality (faster)</option>
            </select>
          </label>
        )}
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
      <div className="export-policy" role="note" aria-label="Export policy">
        {markerCount > 0 && (
          <span className="export-policy-warning">
            MARKERS: {markerCount} cue one-shots are included in SCOREPACK, not the master WAV.
          </span>
        )}
        <span>OFFLINE: CANCEL stops between stages/encoding; the current render stage completes.</span>
        {format === "video" && (
          <span className="export-policy-warning">
            VIDEO: final duration is codec/frame-granular; verify short clips after export.
          </span>
        )}
      </div>
      <div className="export-buttons">
        <button
          type="button"
          className="btn btn-export"
          disabled={busy || (format === "video" && !videoSupported)}
          onClick={() => void exportMaster()}
        >
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
        <PublishToGalleryButton />
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
          title="Download the active pattern as a .mid file (drums on channel 10, one track per instrument)"
          onClick={() => void exportMidi()}
        >
          EXPORT MIDI (PATTERN)
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
        {status.kind === "idle" &&
          "Offline render uses the exact same engine, instruments and effects as playback — plus a 2 s tail for reverb/delay."}
        {status.kind !== "idle" && status.label}
        {busy && (
          <button type="button" className="btn btn-small" onClick={cancelExport} aria-label="Cancel export">
            CANCEL
          </button>
        )}
      </div>
      {status.kind === "done" && <ExportSummary summary={status.summary} />}

      <div className="export-resample" role="group" aria-label="Realtime resample">
        <div className="export-resample-head">RESAMPLE — BOUNCE WHAT YOU HEAR</div>
        <div className="export-resample-row">
          <select
            aria-label="Recording source"
            value={recSource}
            disabled={recState !== "idle"}
            onChange={(event) => setRecSource(event.target.value as RecSourceKind)}
          >
            <option value="master">MASTER (with FX)</option>
            {selectedTrackId && (
              <option value="track">TRACK: {(selectedTrackName ?? selectedTrackId).toUpperCase()}</option>
            )}
            <option value="mic">MIC / LINE IN</option>
          </select>
          {recState === "recording" ? (
            <button type="button" className="btn btn-rec btn-rec-stop" onClick={() => void stopRecording()}>
              ■ STOP {recSeconds.toFixed(0)}s
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-rec"
              disabled={recState === "saving"}
              onClick={() => void startRecording()}
            >
              ● REC
            </button>
          )}
          {recState === "saving" && <span className="export-resample-saving">saving…</span>}
        </div>
        {recError && <div className="export-resample-error">{recError}</div>}
        <div className="export-resample-hint">
          Realtime capture through the full live chain. The take lands in Samples — click it to flip onto a pad.
        </div>
      </div>
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
        <span className="export-summary-value">
          {corr.toFixed(2)} {corrLabel}
        </span>
      </div>
      <div className="export-summary-row">
        <span className="export-summary-label">LUFS-I</span>
        <span className="export-summary-value">
          {summary.lufsIntegrated <= -119 ? "-INF" : summary.lufsIntegrated.toFixed(1)}
        </span>
      </div>
      <div className="export-summary-row">
        <span className="export-summary-label">MONO LOSS</span>
        <span className="export-summary-value">{summary.monoLossDb.toFixed(1)} dB</span>
      </div>
    </div>
  );
}
