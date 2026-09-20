import { useEffect, useRef, useState } from "react";
import type { InstrumentTrack, MusicalKey, NoteEvent, Pattern } from "../project-model/types";
import { pitchName } from "../project-model/types";
import { useServices } from "./context";
import { PcmMicRecorder } from "../audio-engine/PcmMicRecorder";
import { trackPitchAsync } from "../audio-workers/pitch-tracker-client";
import { framesToNotes, humToNotesCommand, patternLengthTicks } from "../midi/hum-to-notes";

/**
 * HUM-TO-MELODY panel (piano roll toolbar → HUM).
 *
 * Record a short hummed take straight into note drafts: the take is pitch-
 * tracked off the main thread, segmented and snapped to the project key +
 * 16th grid, previewed, and applied to the current pattern/track as ONE
 * undoable command. The staged PCM session is discarded right after
 * materialization — a hum is sketch material, not library content.
 */

type HumPhase = "idle" | "starting" | "recording" | "analyzing" | "preview" | "error";

export function HumToMelodyPanel({
  track,
  pattern,
  docKey,
  onClose,
}: {
  track: InstrumentTrack;
  pattern: Pattern;
  docKey: MusicalKey | null;
  onClose: () => void;
}) {
  const services = useServices();
  const [phase, setPhase] = useState<HumPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notes, setNotes] = useState<NoteEvent[]>([]);
  const [mode, setMode] = useState<"replace" | "merge">("replace");
  const recRef = useRef<PcmMicRecorder | null>(null);
  const timerRef = useRef<number | null>(null);

  // Leftover recorder at unmount would keep the mic stream alive.
  useEffect(
    () => () => {
      const rec = recRef.current;
      recRef.current = null;
      if (rec) {
        rec.onError = null;
        void rec.cancel();
      }
      if (timerRef.current !== null) clearInterval(timerRef.current);
    },
    [],
  );

  const startRecording = async () => {
    if (phase === "starting" || phase === "recording" || recRef.current) return;
    setError(null);
    setPhase("starting");
    try {
      services.engine.ensureContext();
      const ctx = services.engine.getLiveAudioContext();
      if (!ctx) throw new Error("Audio engine is not ready");
      const rec = new PcmMicRecorder({ ctx, recovery: services.recordingRecovery });
      recRef.current = rec;
      rec.setMonitoring(false);
      rec.onError = (message) => {
        setError(message);
        setPhase("error");
        void teardownRecorder();
      };
      await rec.start(() => ({
        projectId: services.store.getDoc().id,
        trackId: track.id,
        trackName: track.name,
        placeOnTimeline: false,
        startBar: 0,
        bpm: services.store.getDoc().bpm,
      }));
      if (recRef.current !== rec) {
        // An error during "starting" already reset the panel — a late start
        // resolution must not resurrect the recording state.
        void rec.cancel();
        return;
      }
      setElapsed(0);
      setPhase("recording");
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch (err) {
      void recRef.current?.cancel();
      recRef.current = null;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  };

  const teardownRecorder = async () => {
    const rec = recRef.current;
    recRef.current = null;
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return rec;
  };

  const stopAndAnalyze = async () => {
    if (phase !== "recording") return;
    setPhase("analyzing");
    const rec = await teardownRecorder();
    if (!rec) {
      setPhase("idle");
      return;
    }
    try {
      const take = await rec.stop();
      if (!take || take.buffer.length === 0) {
        setPhase("error");
        setError("Nothing was captured — check that the microphone is not muted.");
        return;
      }
      // The staged session's purpose is served the moment we hold the buffer.
      try {
        await services.recordingRecovery.remove(take.session.id);
      } catch {
        /* recovery cleanup is best-effort — never block the flow */
      }
      const channel = take.buffer.getChannelData(0);
      const frames = await trackPitchAsync(channel, take.buffer.sampleRate);
      const extracted = framesToNotes(frames, {
        bpm: services.store.getDoc().bpm,
        key: docKey,
        quantize: true,
        patternLengthTicks: patternLengthTicks(pattern),
      });
      if (extracted.length === 0) {
        setPhase("error");
        setError("No steady pitches found — hum louder and hold each note a beat or two.");
        return;
      }
      setNotes(extracted);
      setPhase("preview");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const apply = () => {
    try {
      services.store.execute(
        humToNotesCommand(services.store.getDoc(), notes, {
          trackId: track.id,
          patternId: pattern.id,
          mode,
        }),
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  };

  const range = notes.length
    ? `${pitchName(Math.min(...notes.map((n) => n.pitch)))} – ${pitchName(Math.max(...notes.map((n) => n.pitch)))}`
    : "";

  return (
    <div className="hum-panel context-menu" role="dialog" aria-label="Hum to melody">
      <div className="context-menu-header">HUM → NOTES</div>
      {(phase === "idle" || phase === "starting" || phase === "error") && (
        <>
          <p className="hum-hint">
            Hum the melody ({pattern.stepCount} steps @ {services.store.getDoc().bpm} BPM
            {docKey ? `, snapped to ${docKey}` : ""}).
          </p>
          <button
            type="button"
            className="btn btn-small"
            disabled={phase === "starting"}
            onClick={() => void startRecording()}
          >
            {phase === "starting" ? "ARMING…" : "● RECORD"}
          </button>
        </>
      )}
      {phase === "recording" && (
        <>
          <p className="hum-hint">
            Recording… {elapsed}s <span className="hum-rec-dot" aria-hidden="true" />
          </p>
          <button type="button" className="btn btn-small" onClick={() => void stopAndAnalyze()}>
            ■ STOP &amp; ANALYZE
          </button>
        </>
      )}
      {phase === "analyzing" && <p className="hum-hint">Tracking pitch…</p>}
      {phase === "preview" && (
        <>
          <p className="hum-hint">
            {notes.length} notes · {range}
            {docKey ? ` · snapped to ${docKey}` : ""}
          </p>
          <label className="hum-mode">
            Mode{" "}
            <select value={mode} onChange={(e) => setMode(e.target.value as "replace" | "merge")}>
              <option value="replace">Replace track notes</option>
              <option value="merge">Merge into track</option>
            </select>
          </label>
          <div className="hum-actions">
            <button type="button" className="btn btn-small" onClick={apply}>
              APPLY
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setNotes([]);
                setPhase("idle");
              }}
            >
              RE-RECORD
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="hum-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn-ghost hum-close" aria-label="Close hum to melody" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
