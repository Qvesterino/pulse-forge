import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLatencyCalibration, useServices } from "./context";
import { useFocusRestore } from "./useFocusRestore";
import { AudioLatencyCalibrationError, measureAudioRoundTrip } from "../audio-engine/latencyProbe";
import { MAX_MIDI_REFERENCE_OFFSET_MS, MIN_MIDI_REFERENCE_OFFSET_MS } from "../audio-engine/latencyCalibration";
import {
  MAX_RECORDING_INPUT_OFFSET_MS,
  MIN_RECORDING_INPUT_OFFSET_MS,
  recordingAlignment,
  recordingOffsetFromMeasurement,
} from "../audio-engine/recordingAlignment";

type WizardPhase = "intro" | "permission" | "audio" | "audio-result" | "midi" | "error";

interface PlaybackSnapshot {
  wasPlaying: boolean;
  position: number;
}

interface LatencyCalibrationWizardProps {
  open: boolean;
  onClose: () => void;
}

export function LatencyCalibrationWizard({ open, onClose }: LatencyCalibrationWizardProps) {
  const overlayRef = useFocusRestore<HTMLDivElement>(open);
  const services = useServices();
  const calibration = useLatencyCalibration();
  const recordingInputOffsetMs = useSyncExternalStore(
    recordingAlignment.subscribe,
    recordingAlignment.getSnapshot,
    recordingAlignment.getSnapshot,
  );
  const [phase, setPhase] = useState<WizardPhase>("intro");
  const [error, setError] = useState("");
  const [testPlaying, setTestPlaying] = useState(false);
  /** Offset actually applied to recording placement by the last stable measurement
   * (post-clamp); null when the current run has not applied anything. */
  const [appliedOffsetMs, setAppliedOffsetMs] = useState<number | null>(null);
  /** Raw (pre-clamp) measurement behind `appliedOffsetMs`, for the limited-range note. */
  const [measuredOffsetMs, setMeasuredOffsetMs] = useState<number | null>(null);
  const playbackSnapshotRef = useRef<PlaybackSnapshot | null>(null);
  const runTokenRef = useRef(0);
  const audioAbortRef = useRef<AbortController | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setPhase("intro");
    setError("");
    setTestPlaying(false);
    setAppliedOffsetMs(null);
    setMeasuredOffsetMs(null);
    playbackSnapshotRef.current = {
      wasPlaying: services.transport.playing,
      position: services.transport.position,
    };
    closeRef.current?.focus();
    return () => {
      runTokenRef.current += 1;
      audioAbortRef.current?.abort();
      audioAbortRef.current = null;
      restorePlayback(services, playbackSnapshotRef.current);
      playbackSnapshotRef.current = null;
    };
  }, [open, services]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeWizard();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!open) return null;

  const closeWizard = () => {
    runTokenRef.current += 1;
    audioAbortRef.current?.abort();
    audioAbortRef.current = null;
    restorePlayback(services, playbackSnapshotRef.current);
    playbackSnapshotRef.current = null;
    onClose();
  };

  const pauseForAudioTest = () => {
    if (!services.transport.playing) return;
    services.playback.stop();
  };

  const runAudioCalibration = async () => {
    const token = ++runTokenRef.current;
    audioAbortRef.current?.abort();
    const audioAbort = new AbortController();
    audioAbortRef.current = audioAbort;
    setPhase("permission");
    setError("");
    pauseForAudioTest();
    try {
      const context = services.engine.ensureContext();
      if (typeof AudioContext === "undefined" || !(context instanceof AudioContext)) {
        throw new AudioLatencyCalibrationError("A live AudioContext is required for calibration.");
      }
      const measurement = await measureAudioRoundTrip(context, audioAbort.signal, () => {
        if (token === runTokenRef.current) setPhase("audio");
      });
      if (token !== runTokenRef.current) return;
      services.latency.setAudioMeasurement(measurement);
      // Feed the measured round trip into recording placement (previously
      // display-only): a stable measurement seeds the mic recording offset,
      // which every take compensates via compensateRecordingStartBar.
      const measuredOffset = recordingOffsetFromMeasurement(measurement);
      setMeasuredOffsetMs(measuredOffset);
      if (measuredOffset !== null) {
        recordingAlignment.setOffsetMs(measuredOffset);
        setAppliedOffsetMs(recordingAlignment.getSnapshot());
      } else {
        setAppliedOffsetMs(null);
      }
      setPhase("audio-result");
    } catch (cause) {
      if (token !== runTokenRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    } finally {
      if (audioAbortRef.current === audioAbort) audioAbortRef.current = null;
    }
  };

  const toggleTestPlayback = () => {
    services.playback.playPause();
    setTestPlaying(services.transport.playing);
  };

  const resetCalibration = () => {
    runTokenRef.current += 1;
    audioAbortRef.current?.abort();
    audioAbortRef.current = null;
    restorePlayback(services, playbackSnapshotRef.current);
    services.latency.reset();
    recordingAlignment.reset();
    setPhase("intro");
    setError("");
    setTestPlaying(false);
  };

  const phaseTitle = (() => {
    switch (phase) {
      case "intro":
        return "LATENCY CALIBRATION";
      case "permission":
        return "MICROPHONE ACCESS";
      case "audio":
        return "MEASURING AUDIO PATH";
      case "audio-result":
        return "AUDIO PATH RESULT";
      case "midi":
        return "MIDI FINE-TUNE";
      case "error":
        return "AUDIO TEST UNAVAILABLE";
    }
  })();

  return (
    <div
      className="latency-overlay"

      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Latency calibration"
      onClick={(event) => {
        if (event.target === event.currentTarget) closeWizard();
      }}
    >
      <section className="latency-card">
        <header className="latency-header">
          <div>
            <h2 className="panel-title">{phaseTitle}</h2>
            <span className="latency-step">{phase === "midi" ? "2 / 2" : "1 / 2"}</span>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn btn-small"
            onClick={closeWizard}
            aria-label="Close latency calibration"
          >
            CLOSE
          </button>
        </header>

        {phase === "intro" && (
          <div className="latency-body">
            <p className="latency-copy">
              Audio test measures the speaker or headphone output returning to your microphone.
            </p>
            <p className="latency-copy">
              Use speakers or an acoustic loopback. MIDI timing is tuned separately and stays browser-local.
            </p>
            {calibration.audioRoundTripMs !== null && <AudioResult calibration={calibration} />}
            <div className="latency-actions">
              <button type="button" className="btn btn-small active-solo" onClick={() => void runAudioCalibration()}>
                START AUDIO TEST
              </button>
              <button type="button" className="btn btn-small" onClick={() => setPhase("midi")}>
                SKIP TO MIDI
              </button>
            </div>
          </div>
        )}

        {phase === "permission" && (
          <div className="latency-body latency-busy">
            <div className="latency-pulse" aria-hidden="true" />
            <p className="latency-copy">Requesting microphone access…</p>
            <p className="latency-hint">Allow microphone access to measure the audio path.</p>
          </div>
        )}

        {phase === "audio" && (
          <div className="latency-body latency-busy">
            <div className="latency-pulse" aria-hidden="true" />
            <p className="latency-copy">Listening for eight calibration pulses…</p>
            <p className="latency-hint">Keep the output at a comfortable level and let the test finish.</p>
          </div>
        )}

        {phase === "audio-result" && (
          <div className="latency-body">
            <AudioResult calibration={calibration} />
            <AppliedOffsetNote appliedOffsetMs={appliedOffsetMs} measuredOffsetMs={measuredOffsetMs} />
            <p className="latency-copy">
              This is an audio-path measurement, not the physical latency of a MIDI controller.
            </p>
            <div className="latency-actions">
              <button type="button" className="btn btn-small active-solo" onClick={() => setPhase("midi")}>
                CONTINUE TO MIDI
              </button>
              <button type="button" className="btn btn-small" onClick={() => void runAudioCalibration()}>
                MEASURE AGAIN
              </button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="latency-body">
            <div className="latency-error" role="alert">
              {error}
            </div>
            <p className="latency-copy">You can still tune the reference playback manually with MIDI.</p>
            <div className="latency-actions">
              <button type="button" className="btn btn-small active-solo" onClick={() => setPhase("midi")}>
                CONTINUE TO MIDI
              </button>
              <button type="button" className="btn btn-small" onClick={() => void runAudioCalibration()}>
                TRY AGAIN
              </button>
            </div>
          </div>
        )}

        {phase === "midi" && (
          <div className="latency-body">
            {calibration.audioRoundTripMs !== null && <AudioResult calibration={calibration} />}
            <AppliedOffsetNote appliedOffsetMs={appliedOffsetMs} measuredOffsetMs={measuredOffsetMs} />
            <p className="latency-copy">
              Start the test loop, play a repeated MIDI note, then move the offset until the live note sits with the
              project transient.
            </p>
            <div className="latency-test-row">
              <button
                type="button"
                className={`btn btn-small${testPlaying ? " active-solo" : ""}`}
                onClick={toggleTestPlayback}
              >
                {testPlaying ? "STOP TEST LOOP" : "START TEST LOOP"}
              </button>
              <span className="latency-hint">Positive values delay the project reference.</span>
            </div>
            <label className="latency-offset-control">
              <span>MIDI REFERENCE OFFSET</span>
              <output>{calibration.midiReferenceOffsetMs} ms</output>
              <input
                type="range"
                min={MIN_MIDI_REFERENCE_OFFSET_MS}
                max={MAX_MIDI_REFERENCE_OFFSET_MS}
                step={1}
                value={calibration.midiReferenceOffsetMs}
                aria-label="MIDI reference offset"
                onChange={(event) => services.latency.setMidiReferenceOffsetMs(Number(event.target.value))}
              />
            </label>
            <label className="latency-offset-control">
              <span>MIC RECORDING OFFSET</span>
              <output>{recordingInputOffsetMs} ms</output>
              <input
                type="range"
                min={MIN_RECORDING_INPUT_OFFSET_MS}
                max={MAX_RECORDING_INPUT_OFFSET_MS}
                step={1}
                value={recordingInputOffsetMs}
                aria-label="Microphone recording offset"
                onChange={(event) => recordingAlignment.setOffsetMs(Number(event.target.value))}
              />
              <span className="latency-hint">
                Recording placement correction: positive values move recorded clips earlier. A stable audio test seeds
                this value; nudge the slider to fine-tune.
              </span>
            </label>
            <div className="latency-actions">
              <button type="button" className="btn btn-small active-solo" onClick={closeWizard}>
                DONE
              </button>
              <button type="button" className="btn btn-small btn-danger" onClick={resetCalibration}>
                RESET
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function AudioResult({ calibration }: { calibration: ReturnType<typeof useLatencyCalibration> }) {
  return (
    <div className={`latency-result${calibration.audioStable === false ? " latency-result-unstable" : ""}`}>
      <div>
        <span>ROUND TRIP</span>
        <strong>{calibration.audioRoundTripMs?.toFixed(1) ?? "—"} ms</strong>
      </div>
      <div>
        <span>JITTER</span>
        <strong>{calibration.audioJitterMs?.toFixed(1) ?? "—"} ms</strong>
      </div>
      <div>
        <span>SAMPLES</span>
        <strong>{calibration.audioSampleCount}</strong>
      </div>
      {calibration.audioStable === false && (
        <p>Measurement is unstable. Try quieter surroundings or a clearer acoustic return.</p>
      )}
    </div>
  );
}

/** Confirms the measured round trip now drives recording placement (or that the ±500 ms limit clipped it). */
function AppliedOffsetNote({
  appliedOffsetMs,
  measuredOffsetMs,
}: {
  appliedOffsetMs: number | null;
  measuredOffsetMs: number | null;
}) {
  if (appliedOffsetMs === null) return null;
  const limited = measuredOffsetMs !== null && measuredOffsetMs !== appliedOffsetMs;
  return (
    <p className="latency-hint" role="status">
      Applied to mic recording placement: {appliedOffsetMs} ms
      {limited ? ` (measured ${measuredOffsetMs} ms — limited to ±${MAX_RECORDING_INPUT_OFFSET_MS} ms)` : ""}. New takes
      are placed earlier by this amount; the slider in the MIDI step fine-tunes it.
    </p>
  );
}

function restorePlayback(services: ReturnType<typeof useServices>, snapshot: PlaybackSnapshot | null): void {
  if (!snapshot) return;
  services.playback.stop();
  services.transport.seek(Math.max(0, snapshot.position));
  if (snapshot.wasPlaying) services.playback.playPause();
}
