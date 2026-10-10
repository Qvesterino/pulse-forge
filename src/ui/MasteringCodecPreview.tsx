import { useCallback, useEffect, useRef, useState } from "react";
import {
  estimateMp3ExportAdditionalWorkingSetBytes,
  assertMp3ExportWorkingSetBudget,
  MAX_MP3_DECODE_PCM_BYTES,
} from "../export/mp3-limits";
import { isMp3SampleRateSupported } from "../export/mp3-capabilities";
import { decodeMp3BlobToAudioBuffer } from "../mastering/mp3PcmDecodeClient";
import { measureMasterBufferRangeLufsAsync } from "../mastering/analysisClient";
import { formatAuditionTrim, getLoudnessMatchGain, resolveLoudnessMatchTarget } from "../mastering/audition";
import { tryAcquireMasteringWork } from "../mastering/workGate";
import { decodeAudioData } from "../services/audio-decode";
import { useServices } from "./context";

const CODEC_PREVIEW_LENGTHS = [5, 10, 15, 20, 30] as const;

interface EncodedPreview {
  buffer: AudioBuffer;
  bitrateKbps: 192 | 320;
  startSeconds: number;
  durationSeconds: number;
  sourceLufs: number | null;
  encodedLufs: number | null;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Codec preview cancelled", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(new DOMException("Codec preview cancelled", "AbortError")));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

async function decodeCodecPreview(
  blob: Blob,
  sampleRate: number,
  channels: number,
  durationSeconds: number,
  signal: AbortSignal,
): Promise<AudioBuffer> {
  const frameAllowance = Math.ceil((durationSeconds + 2) * sampleRate);
  const maxPcmBytes = Math.min(MAX_MP3_DECODE_PCM_BYTES, frameAllowance * channels * Float32Array.BYTES_PER_ELEMENT);
  const bounded = await decodeMp3BlobToAudioBuffer(blob, { sampleRate, channels }, { maxPcmBytes, signal });
  if (signal.aborted) throw new DOMException("Codec preview cancelled", "AbortError");
  if (bounded.status === "decoded") return bounded.buffer;

  const bytes = await blob.arrayBuffer();
  if (signal.aborted) throw new DOMException("Codec preview cancelled", "AbortError");
  const decoded = await abortable(decodeAudioData(bytes, sampleRate), signal);
  if (decoded.sampleRate !== sampleRate || decoded.numberOfChannels !== channels) {
    throw new Error("The browser MP3 decoder changed the preview sample rate or channel count.");
  }
  return decoded;
}

export function MasteringCodecPreview({
  sourceBuffer,
  sourceKey,
  disabled = false,
  residentWorkingSetBytes,
}: {
  sourceBuffer: AudioBuffer;
  sourceKey: string;
  disabled?: boolean;
  residentWorkingSetBytes?: number;
}) {
  const services = useServices();
  const [bitrateKbps, setBitrateKbps] = useState<192 | 320>(192);
  const [lengthSeconds, setLengthSeconds] = useState<(typeof CODEC_PREVIEW_LENGTHS)[number]>(15);
  const [startSeconds, setStartSeconds] = useState(() => Math.min(30, Math.max(0, (sourceBuffer.duration - 15) / 2)));
  const [levelMatch, setLevelMatch] = useState(true);
  const [encodedPreview, setEncodedPreview] = useState<EncodedPreview | null>(null);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [statusRole, setStatusRole] = useState<"status" | "alert">("status");
  const [playing, setPlaying] = useState<"source" | "mp3" | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const playbackIdRef = useRef(0);
  const announceStatus = (message: string, alert = false): void => {
    setStatus(message);
    setStatusRole(alert ? "alert" : "status");
  };

  const maxStartSeconds = Math.max(0, sourceBuffer.duration - 0.5);
  const selectedStartSeconds = Math.min(maxStartSeconds, Math.max(0, Number.isFinite(startSeconds) ? startSeconds : 0));
  const selectedDurationSeconds = Math.min(lengthSeconds, sourceBuffer.duration - selectedStartSeconds);
  const validSource =
    sourceBuffer.numberOfChannels >= 1 &&
    sourceBuffer.numberOfChannels <= 2 &&
    Number.isFinite(sourceBuffer.duration) &&
    sourceBuffer.duration >= 0.5;

  const stopPlayback = useCallback(() => {
    playbackIdRef.current++;
    services.engine.stopPreview();
    setPlaying(null);
  }, [services.engine]);

  useEffect(() => {
    if (disabled) stopPlayback();
  }, [disabled, stopPlayback]);

  const invalidatePreview = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    stopPlayback();
    setEncodedPreview(null);
    setProgress(0);
    setStatus("");
    setStatusRole("status");
  }, [stopPlayback]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      playbackIdRef.current++;
      services.engine.stopPreview();
    };
  }, [services.engine, sourceKey]);

  const createPreview = async (): Promise<void> => {
    if (disabled || working || !validSource) return;
    if (!isMp3SampleRateSupported(sourceBuffer.sampleRate)) {
      announceStatus(
        "MP3 preview is available at supported render rates such as 44.1 or 48 kHz. Change the render rate and analyze again.",
        true,
      );
      return;
    }
    if (selectedDurationSeconds < 0.5) {
      announceStatus("Choose an excerpt of at least 0.5 seconds.", true);
      return;
    }

    const releaseMasteringWork = tryAcquireMasteringWork();
    if (!releaseMasteringWork) {
      announceStatus("Another MASTER audio task is in progress. Try again when it finishes.", true);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setWorking(true);
    setProgress(0);
    setStatus("Preparing the selected excerpt…");
    setStatusRole("status");
    setEncodedPreview(null);
    stopPlayback();

    try {
      const channelCount = sourceBuffer.numberOfChannels;
      const startFrame = Math.floor(selectedStartSeconds * sourceBuffer.sampleRate);
      const endFrame = Math.min(
        sourceBuffer.length,
        startFrame + Math.floor(selectedDurationSeconds * sourceBuffer.sampleRate),
      );
      const frameCount = endFrame - startFrame;
      const excerptPcmBytes = frameCount * channelCount * Float32Array.BYTES_PER_ELEMENT;
      const sourcePcmBytes = sourceBuffer.length * channelCount * Float32Array.BYTES_PER_ELEMENT;
      const residentBytes = residentWorkingSetBytes ?? sourcePcmBytes;
      assertMp3ExportWorkingSetBudget(
        residentBytes,
        estimateMp3ExportAdditionalWorkingSetBytes(excerptPcmBytes, sourceBuffer.sampleRate, bitrateKbps, channelCount),
      );

      const { encodeMp3 } = await import("../export/mp3");
      const blob = await encodeMp3(sourceBuffer, {
        kbps: bitrateKbps,
        startFrame,
        endFrame,
        integerOverflowPolicy: "reject",
        signal: controller.signal,
        onProgress: (fraction) => {
          setProgress(Math.round(fraction * 70));
          setStatus(`Encoding ${bitrateKbps} kbps MP3 preview… ${Math.round(fraction * 70)}%`);
        },
      });
      if (controller.signal.aborted) throw new DOMException("Codec preview cancelled", "AbortError");

      setStatus("Decoding the encoded MP3 preview…");
      const decoded = await decodeCodecPreview(
        blob,
        sourceBuffer.sampleRate,
        channelCount,
        selectedDurationSeconds,
        controller.signal,
      );
      if (controller.signal.aborted) throw new DOMException("Codec preview cancelled", "AbortError");
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
        throw new Error("The browser MP3 decoder returned an invalid preview duration.");
      }
      const playbackDurationSeconds = Math.min(selectedDurationSeconds, decoded.duration);
      if (playbackDurationSeconds < 0.5) throw new Error("The decoded MP3 preview is too short to audition.");

      setProgress(82);
      setStatus("Measuring source and encoded excerpt loudness…");
      const sourceLufs = await measureMasterBufferRangeLufsAsync(
        sourceBuffer,
        selectedStartSeconds,
        playbackDurationSeconds,
        controller.signal,
      );
      const encodedLufs = await measureMasterBufferRangeLufsAsync(
        decoded,
        0,
        playbackDurationSeconds,
        controller.signal,
      );
      if (controller.signal.aborted) throw new DOMException("Codec preview cancelled", "AbortError");

      setEncodedPreview({
        buffer: decoded,
        bitrateKbps,
        startSeconds: selectedStartSeconds,
        durationSeconds: playbackDurationSeconds,
        sourceLufs,
        encodedLufs,
      });
      setProgress(100);
      setStatus(`Ready · ${bitrateKbps} kbps MP3 · ${playbackDurationSeconds.toFixed(1)} s excerpt`);
    } catch (error) {
      if (isAbortError(error)) {
        setStatus("Codec preview cancelled.");
        setStatusRole("status");
      } else {
        announceStatus(error instanceof Error ? error.message : "Codec preview could not be created.", true);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      releaseMasteringWork();
      setWorking(false);
    }
  };

  const matchTarget = encodedPreview
    ? resolveLoudnessMatchTarget([encodedPreview.sourceLufs, encodedPreview.encodedLufs])
    : null;
  const sourceGain = encodedPreview ? getLoudnessMatchGain(encodedPreview.sourceLufs, matchTarget, levelMatch) : 1;
  const mp3Gain = encodedPreview ? getLoudnessMatchGain(encodedPreview.encodedLufs, matchTarget, levelMatch) : 1;

  const audition = (side: "source" | "mp3"): void => {
    if (!encodedPreview || disabled || working) return;
    stopPlayback();
    const playbackId = playbackIdRef.current;
    const buffer = side === "source" ? sourceBuffer : encodedPreview.buffer;
    const gain = side === "source" ? sourceGain : mp3Gain;
    const offset = side === "source" ? encodedPreview.startSeconds : 0;
    setPlaying(side);
    services.engine.previewMasterCompare(
      buffer,
      gain,
      () => {
        if (playbackIdRef.current === playbackId) setPlaying(null);
      },
      offset,
      false,
      encodedPreview.durationSeconds,
    );
  };

  return (
    <section className="mastering-codec-preview" aria-label="Codec preview" data-source-run={sourceKey}>
      <header>
        <span className="mastering-panel-kicker">ENCODED AUDITION</span>
        <h4>Codec Preview</h4>
        <p>
          Encode a short section with KYX&apos;s delivery MP3 encoder, decode it, then compare the actual lossy result
          with the source master. The preview is temporary and does not create a deliverable.
        </p>
      </header>
      {!validSource && (
        <p className="export-policy-warning">Codec preview needs a mono or stereo render at least 0.5 seconds long.</p>
      )}
      <div className="mastering-codec-preview-controls">
        <label className="fx-param-select">
          <span className="slider-label">BITRATE</span>
          <select
            aria-label="Codec preview bitrate"
            value={bitrateKbps}
            disabled={working || disabled || !validSource}
            onChange={(event) => {
              invalidatePreview();
              setBitrateKbps(Number(event.target.value) as 192 | 320);
            }}
          >
            <option value={192}>192 kbps</option>
            <option value={320}>320 kbps</option>
          </select>
        </label>
        <label className="fx-param-select">
          <span className="slider-label">LENGTH</span>
          <select
            aria-label="Codec preview excerpt length"
            value={lengthSeconds}
            disabled={working || disabled || !validSource}
            onChange={(event) => {
              invalidatePreview();
              setLengthSeconds(Number(event.target.value) as (typeof CODEC_PREVIEW_LENGTHS)[number]);
            }}
          >
            {CODEC_PREVIEW_LENGTHS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds} s
              </option>
            ))}
          </select>
        </label>
        <label className="fx-param-select">
          <span className="slider-label">START (s)</span>
          <input
            aria-label="Codec preview start time in seconds"
            type="number"
            min={0}
            max={maxStartSeconds.toFixed(1)}
            step={0.1}
            value={selectedStartSeconds.toFixed(1)}
            disabled={working || disabled || !validSource}
            onChange={(event) => {
              invalidatePreview();
              setStartSeconds(Number(event.target.value));
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn-small"
          disabled={working || disabled || !validSource}
          onClick={() => void createPreview()}
        >
          {working ? "ENCODING PREVIEW…" : "CREATE MP3 PREVIEW"}
        </button>
        {working && (
          <button type="button" className="btn btn-small" onClick={() => abortRef.current?.abort()}>
            CANCEL PREVIEW
          </button>
        )}
      </div>
      {working && (
        <progress
          className="mastering-codec-preview-progress"
          aria-label="Codec preview progress"
          max={100}
          value={progress}
        />
      )}
      {encodedPreview && (
        <div className="mastering-codec-preview-result" role="group" aria-label="Codec preview A/B audition">
          <div className="mastering-codec-preview-loudness">
            <span>
              Source: {encodedPreview.sourceLufs === null ? "N/A" : `${encodedPreview.sourceLufs.toFixed(1)} LUFS`}
            </span>
            <span>
              MP3: {encodedPreview.encodedLufs === null ? "N/A" : `${encodedPreview.encodedLufs.toFixed(1)} LUFS`}
            </span>
            <label>
              <input
                type="checkbox"
                checked={levelMatch}
                disabled={disabled || matchTarget === null}
                onChange={(event) => {
                  stopPlayback();
                  setLevelMatch(event.target.checked);
                }}
              />
              Level-match audition
            </label>
          </div>
          <div className="mastering-codec-preview-audition">
            <button
              type="button"
              className={`btn btn-small ${playing === "source" ? "active" : ""}`}
              aria-pressed={playing === "source"}
              disabled={disabled || working}
              onClick={() => audition("source")}
            >
              PLAY SOURCE · {formatAuditionTrim(sourceGain)}
            </button>
            <button
              type="button"
              className={`btn btn-small ${playing === "mp3" ? "active" : ""}`}
              aria-pressed={playing === "mp3"}
              disabled={disabled || working}
              onClick={() => audition("mp3")}
            >
              PLAY MP3 {encodedPreview.bitrateKbps} · {formatAuditionTrim(mp3Gain)}
            </button>
            {playing && (
              <button type="button" className="btn btn-small" onClick={stopPlayback}>
                STOP
              </button>
            )}
          </div>
          {levelMatch && matchTarget === null && (
            <small>Excerpt LUFS could not be measured reliably, so level matching is unavailable.</small>
          )}
        </div>
      )}
      <div
        className="sr-only"
        role={statusRole}
        aria-live={statusRole === "alert" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {status}
      </div>
      {status && (
        <div className="export-status" aria-hidden="true">
          {status}
        </div>
      )}
    </section>
  );
}
