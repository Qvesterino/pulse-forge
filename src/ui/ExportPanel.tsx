import { useEffect, useRef, useState } from "react";
import { useActivePatternId, useMarkers, useMaster, usePatterns, useServices, useTracks } from "./context";
import { renderProject } from "../rendering/renderer";
import { buildStemProject, nonEmptyStemGroups } from "../rendering/stems";
import { downloadWav, encodeWav, sanitizeFilename } from "../rendering/wav";
import { buildScorepack } from "../export/scorepack";
import { buildZyvoTransfer } from "../export/zyvo-transfer";
import { exportProject } from "../export/project-io";
import { canExportVideo, recordVideo } from "../export/video";
import { downloadBlob } from "../export/download";
import { encodeShareCode, shareAppUrl, embedUrl, embedSnippet } from "../export/shareCode";
import type { WavBitDepth } from "../rendering/wav";
import type { PlayMode } from "../project-model/types";
import {
  summarizeBuffer,
  evaluateExportMonoGuard,
  evaluateMasterVerdict,
  computeStageAdjustment,
  type BufferSummary,
} from "../audio-engine/metering";
import { extensionForMime, LiveRecorder, type RecordSource } from "../audio-engine/recorder";
import type { PcmMicRecorder } from "../audio-engine/PcmMicRecorder";
import type { MaterializedPcmTake } from "../audio-engine/pcmRecording";
import { detectLoopBpm } from "../audio-engine/bpm-detect";
import { userSampleId, type UserSampleAsset } from "../persistence/UserSampleRepository";
import { PublishToGalleryButton } from "../gallery/PublishButton";
import { setMasterConfig } from "../commands/commands";

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
  // Fine-grained selectors (GOAL 04): ExportPanel reads markers (count
  // badge), patterns (active pattern name), tracks (renderable tracks,
  // total count), and master (LUFS target, ceiling dB for the meter). Root
  // scalars (`doc.name`, `doc.bpm`) come from a plain getter.
  const markers = useMarkers();
  const patterns = usePatterns();
  const activePatternId = useActivePatternId();
  const tracks = useTracks();
  const master = useMaster();
  const doc = services.store.getDoc();
  const [mode, setMode] = useState<PlayMode>(services.playback.mode);
  const [sampleRate, setSampleRate] = useState(44100);
  const [bitDepth, setBitDepth] = useState<WavBitDepth>(16);
  const [format, setFormat] = useState<MasterFormat>("wav");
  // Global Live/Export quality switch — defaults to STUDIO: the export has
  // no realtime CPU budget, so PRISM's 8× saturation oversampling and VØID's
  // render tier (default-tier instances only; explicit eco/high/render
  // choices are respected) are free. LIVE renders exactly what you hear,
  // faster. Freeze/bounce stay on the live tier by default.
  const [quality, setQuality] = useState<"live" | "studio">("studio");
  const [includeTrackStems, setIncludeTrackStems] = useState(true);
  const [clipSeconds, setClipSeconds] = useState(15);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const markerCount = markers.length;
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
  const recorderRef = useRef<LiveRecorder | PcmMicRecorder | null>(null);
  const stoppingRecordingRef = useRef(false);

  const busy = status.kind === "busy";
  const baseName = sanitizeFilename(doc.name);
  const groups = nonEmptyStemGroups(doc);
  const videoSupported = canExportVideo();
  const activePatternName = patterns.find((p) => p.id === activePatternId)?.name ?? "pattern";

  const exportMaster = async () => {
    const signal = beginExport();
    setStatus({ kind: "busy", label: "Rendering master…" });
    try {
      const buffer = await renderProject(doc, services.bank, {
        mode,
        sampleRate,
        quality,
        signal,
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
          quality,
          signal,
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
      const renderableTracks = tracks.filter((t) => t.kind !== "group");
      let lastSummary: BufferSummary | null = null;
      for (let i = 0; i < renderableTracks.length; i++) {
        if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
        const track = renderableTracks[i];
        setStatus({ kind: "busy", label: `Rendering track ${i + 1}/${renderableTracks.length}: ${track.name}…` });
        const trackDoc = buildStemProject(doc, (t) => t.id === track.id);
        const buffer = await renderProject(trackDoc, services.bank, {
          mode,
          sampleRate,
          quality,
          signal,
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
      const bytes = patternToMidi(doc, activePatternId);
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
        { quality },
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

  const exportZyvoTransfer = async () => {
    const signal = beginExport();
    setStatus({ kind: "busy", label: "Preparing KYX → ZYVO transfer…" });
    try {
      const result = await buildZyvoTransfer(
        doc,
        services.bank,
        (progress) => setStatus({ kind: "busy", label: `ZYVO transfer: ${progress.phase}…` }),
        signal,
        { quality, includeTrackStems },
      );
      if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL?.(url), 30_000);
      setStatus({
        kind: "done",
        label: `ZYVO transfer ready (${result.manifest.stems.length} stems · ${result.blob.size.toLocaleString()} bytes)`,
        summary: result.masterSummary,
      });
    } catch (error) {
      cancelOrElse(error, "ZYVO transfer failed: {err}");
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
    // The TRACK option only renders with a selected track; anything else that
    // slips through falls back to the master tap rather than failing silently.
    const source: RecordSource =
      recSource === "mic"
        ? { kind: "mic" }
        : recSource === "track" && selectedTrackId
          ? { kind: "track", trackId: selectedTrackId }
          : { kind: "master" };
    try {
      if (source.kind === "mic") {
        const { PcmMicRecorder } = await import("../audio-engine/PcmMicRecorder");
        const recorder = new PcmMicRecorder({ ctx, recovery: services.recordingRecovery });
        recorderRef.current = recorder;
        let startResolved = false;
        let earlyError: string | null = null;
        recorder.onError = (message) => {
          setRecError(message);
          if (startResolved) void stopRecording();
          else earlyError = message;
        };
        const start = recorder.start(() => {
          const currentDoc = services.store.doc;
          const selected = currentDoc.tracks.find((track) => track.id === selectedTrackId);
          return {
            projectId: currentDoc.id,
            trackId: selected?.id ?? "",
            trackName: "Standalone microphone resample",
            placeOnTimeline: false,
            startBar: 0,
            bpm: currentDoc.bpm,
          };
        });
        await start;
        setRecSeconds(0);
        setRecError(null);
        setRecState("recording");
        startResolved = true;
        if (earlyError) void stopRecording();
        return;
      }

      const recorder = new LiveRecorder({
        ctx,
        getTapNode: (recordSource: RecordSource) => {
          if (recordSource.kind === "master") return services.engine.getMasterTapNode();
          if (recordSource.kind === "track") return services.engine.getTrackTapNode(recordSource.trackId);
          return null;
        },
      });
      recorderRef.current = recorder;
      await recorder.start(source);
      setRecSeconds(0);
      setRecError(null);
      setRecState("recording");
    } catch (err) {
      const recorder = recorderRef.current;
      if (recorder) await Promise.resolve(recorder.cancel()).catch(() => undefined);
      recorderRef.current = null;
      setRecError(err instanceof Error ? err.message : "Recording failed");
    }
  };

  const stopRecording = async () => {
    const recorder = recorderRef.current;
    if (!recorder || stoppingRecordingRef.current) return;
    stoppingRecordingRef.current = true;
    setRecState("saving");
    try {
      const take = await recorder.stop();
      if (!take) {
        setRecError("Nothing was captured. Any staged microphone audio remains available for recovery.");
        setRecState("idle");
        return;
      }
      const buffer = take.buffer;
      let pcmTake: MaterializedPcmTake | null = null;
      let blob: Blob | null = null;
      if ("session" in take) {
        pcmTake = take;
      } else {
        blob = take.blob;
      }
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
        fileName: `${id}${pcmTake ? ".wav" : extensionForMime(blob!.type)}`,
        category: "Custom",
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        createdAt: new Date().toISOString(),
        ...(bpm !== undefined ? { bpm } : {}),
      };
      try {
        if (pcmTake) {
          await services.recordingRecovery.finalize(pcmTake.session.id, asset);
          services.userSamples.invalidateCache();
        } else {
          await services.userSamples.save(asset, await blob!.arrayBuffer());
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Saving the take failed";
        setRecError(pcmTake ? `${detail}. The staged PCM remains available for recovery.` : detail);
        setRecState("idle");
        return;
      }
      setStatus({
        kind: "done",
        label: `Resampled → "${asset.name}" in Samples (${buffer.duration.toFixed(1)}s) — click it in the browser to flip onto a pad`,
        summary: summarizeBuffer(buffer),
      });
      setRecState("idle");
    } catch (error) {
      setRecError(error instanceof Error ? error.message : "Could not finish the recording");
      setRecState("idle");
    } finally {
      recorderRef.current = null;
      stoppingRecordingRef.current = false;
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

  // A recorder left running at unmount must release its device/nodes while
  // preserving any committed PCM blocks for the recovery prompt.
  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && "onError" in recorder) recorder.onError = null;
      if (recorder) void Promise.resolve(recorder.cancel()).catch(() => undefined);
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
        <label
          className="fx-param-select"
          title="STUDIO: PRISM renders at 8x saturation oversampling and default-tier VØID at the render tier (explicit eco/high/render choices respected). Slower render, no effect on the live document. LIVE renders exactly what you hear, faster."
        >
          <span className="slider-label">QUALITY</span>
          <select value={quality} onChange={(event) => setQuality(event.target.value as "live" | "studio")}>
            <option value="studio">Studio HQ</option>
            <option value="live">Live (faster)</option>
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
          EXPORT ALL TRACKS ({tracks.length})
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
        <label className="export-policy" title="Track stems are rendered as time-aligned 32-bit-float WAVs to preserve headroom; long sessions can make the transfer large.">
          <input
            type="checkbox"
            checked={includeTrackStems}
            disabled={busy}
            onChange={(event) => setIncludeTrackStems(event.target.checked)}
          />
          INCLUDE TRACK STEMS
        </label>
        <button
          type="button"
          className="btn btn-export btn-export-scorepack"
          disabled={busy}
          title="Create a VocalForge / ZYVO transfer with a 48 kHz 32-bit-float master, optional aligned stems, arrangement metadata, and the original KYX project."
          onClick={() => void exportZyvoTransfer()}
        >
          EXPORT TO ZYVO
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
      {status.kind === "done" && (
        <ExportSummary summary={status.summary} lufsTarget={master.lufsTarget ?? -14} ceilingDb={master.ceilingDb} />
      )}
      {status.kind === "done" && <AutoStageButton summary={status.summary} />}

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

/**
 * One-click export gain staging. Applies the verdict's advice (master IN so
 * the true peak lands at ceiling − 1 dBTP while honoring the streaming
 * target) as a single undoable command — the ceiling stays untouched.
 * Hidden when the last render is already staged (or silent/muted).
 */
function AutoStageButton({ summary }: { summary: BufferSummary }) {
  const services = useServices();
  const master = useMaster();
  const [staged, setStaged] = useState(false);
  const adj = computeStageAdjustment(summary, master.masterGain ?? 1, master.lufsTarget ?? -14, master.ceilingDb);
  if (adj.noop) return null;
  return (
    <button
      type="button"
      className="btn btn-export"
      disabled={staged}
      title="Apply the gain verdict as one undoable step (master IN only — re-export to verify)"
      onClick={() => {
        services.store.execute(setMasterConfig(services.store.getDoc(), { masterGain: adj.masterGain }));
        setStaged(true);
      }}
    >
      {staged
        ? `STAGED ✓ ${adj.applied[0]} — re-export to verify`
        : `AUTO STAGE (${adj.deltaDb >= 0 ? "+" : ""}${adj.deltaDb.toFixed(1)} dB)`}
    </button>
  );
}

function ExportSummary({
  summary,
  lufsTarget,
  ceilingDb,
}: {
  summary: BufferSummary;
  lufsTarget: number;
  ceilingDb: number;
}) {
  const corr = summary.correlation;
  const corrLabel = corr > 0.5 ? "Mono OK" : corr < 0 ? "Phase" : "Wide";
  const clipped = summary.peakDb > -0.3 || summary.truePeakDb > -0.3;
  // Mono-loss guardian: same thresholds as the live mix-check verdict, so
  // the export summary never disagrees with the master meter wall.
  const monoGuard = evaluateExportMonoGuard(summary);
  // Gain-staging verdict: the same print-ready verdict the live master
  // meter shows (loudness vs streaming target, true peak vs limiter
  // ceiling, mono, balance) — the export tells you what to turn.
  const verdict = evaluateMasterVerdict(
    {
      lufsIntegrated: summary.lufsIntegrated,
      truePeakDb: summary.truePeakDb,
      monoLossDb: summary.monoLossDb,
      correlation: summary.correlation,
      // The offline summary carries no L/R-imbalance reading — 0 keeps the
      // balance check neutral instead of inventing a measurement.
      lrImbalanceDb: 0,
    },
    lufsTarget,
    ceilingDb,
  );
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
        <span className={`export-summary-value${monoGuard.level !== "ok" ? " export-summary-clipped" : ""}`}>
          {summary.monoLossDb.toFixed(1)} dB
          {monoGuard.level !== "ok" && " ⚠"}
        </span>
      </div>
      <div className="export-summary-row">
        <span className="export-summary-label">GAIN VERDICT</span>
        <span className="export-summary-value" data-level={verdict.level}>
          {verdict.headline}
          {verdict.loudnessDeltaDb !== 0 && ` (Δ ${verdict.loudnessDeltaDb.toFixed(1)} dB)`}
        </span>
      </div>
      {verdict.hints.length > 0 && (
        <div className="export-summary-row">
          <span className="export-summary-label">FIX IT</span>
          {verdict.hints.map((hint) => (
            <span key={hint} className="export-summary-value">
              {hint}
            </span>
          ))}
        </div>
      )}
      {monoGuard.level !== "ok" && (
        <div className="export-summary-guard" role="alert" data-level={monoGuard.level}>
          <span className="export-summary-label">MONO GUARD</span>
          {monoGuard.hints.map((hint) => (
            <span key={hint} className="export-summary-value">
              {hint}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
