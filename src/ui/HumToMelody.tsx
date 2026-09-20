import { useEffect, useRef, useState } from "react";
import type { InstrumentTrack, MusicalKey, NoteEvent, Pattern } from "../project-model/types";
import { pitchName } from "../project-model/types";
import { useServices } from "./context";
import { PcmMicRecorder } from "../audio-engine/PcmMicRecorder";
import { trackPitchAsync } from "../audio-workers/pitch-tracker-client";
import {
  auditionTimings,
  framesToNotes,
  humToNotesCommand,
  patternLengthTicks,
  shiftNotesOctave,
} from "../midi/hum-to-notes";

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
  const [toBeat, setToBeat] = useState(true);
  const [auditioning, setAuditioning] = useState(false);
  const recRef = useRef<PcmMicRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  /** Pending AUDITION timeouts — cleared for instant stop (nothing is ever
   *  scheduled ahead inside the engine, so clearing = silence). */
  const auditionTimersRef = useRef<number[]>([]);
  /** Transport tick sampled at recording start (beat-synced mapping). */
  const humStartTickRef = useRef<number | null>(null);
  /** Transport lifecycle WE started — restored when the hum ends. */
  const transportRestoreRef = useRef<{ startedByHum: boolean; metronomeBefore: boolean } | null>(null);

  const restoreTransport = () => {
    const restore = transportRestoreRef.current;
    transportRestoreRef.current = null;
    if (!restore) return;
    if (restore.startedByHum && services.transport.playing) services.playback.playPause();
    if (restore.startedByHum || !services.transport.playing) {
      services.transport.setMetronome(restore.metronomeBefore);
    }
  };

  /** Clear pending audition notes — instant silence (nothing is scheduled
   *  ahead inside the engine, only our own timeouts fire noteOn). */
  const stopAudition = () => {
    for (const t of auditionTimersRef.current) clearTimeout(t);
    auditionTimersRef.current = [];
    setAuditioning(false);
  };

  const startAudition = () => {
    if (notes.length === 0) return;
    stopAudition();
    const ctx = services.engine.getLiveAudioContext();
    if (!ctx) return;
    const timings = auditionTimings(notes, services.store.getDoc().bpm);
    const lastMs = timings.length > 0 ? Math.max(...timings.map((t) => t.delayMs)) : 0;
    // Absolute anchor t0 for every note (one clock read, no drift chain);
    // each timeout fires noteOn at its own remaining delay.
    const t0 = ctx.currentTime + timings[0]!.delayMs / 1000;
    auditionTimersRef.current = timings.map((timing) =>
      window.setTimeout(
        () => {
          const when = Math.max(t0 + timing.delayMs / 1000, ctx.currentTime + 0.005);
          services.engine.noteOn(track.id, timing.pitch, timing.velocity, when, timing.durationSec);
        },
        Math.max(0, timing.delayMs - timings[0]!.delayMs),
      ),
    );
    setAuditioning(true);
    // Self-stop when the melody finishes (keep the timer array for cleanup).
    auditionTimersRef.current.push(
      window.setTimeout(() => setAuditioning(false), lastMs - timings[0]!.delayMs + 250),
    );
  };

  const shiftOctave = (octaves: number) => {
    stopAudition();
    setNotes((current) => shiftNotesOctave(current, octaves));
  };

  // Leftover recorder at unmount would keep the mic stream alive — and a
  // transport WE started must stop with the panel (pending audition notes too).
  useEffect(
    () => () => {
      const rec = recRef.current;
      recRef.current = null;
      if (rec) {
        rec.onError = null;
        void rec.cancel();
      }
      if (timerRef.current !== null) clearInterval(timerRef.current);
      for (const t of auditionTimersRef.current) clearTimeout(t);
      auditionTimersRef.current = [];
      restoreTransport();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      // Beat-synced hum: roll the transport first so there IS a beat to hum
      // to — with the click on when we started it (the user needs a pulse;
      // if the transport was already playing we leave their click alone).
      // Song mode is skipped: arrangement ticks do not map onto this
      // pattern's grid, so the free-time mapping stays the honest one.
      const beatSync =
        toBeat && services.playback.mode === "pattern" && typeof services.transport.position === "number";
      humStartTickRef.current = null;
      if (beatSync) {
        const startedByHum = !services.transport.playing;
        transportRestoreRef.current = {
          startedByHum,
          metronomeBefore: services.transport.metronome,
        };
        if (startedByHum) {
          services.transport.setMetronome(true);
          services.playback.playPause();
        }
      }

      const rec = new PcmMicRecorder({ ctx, recovery: services.recordingRecovery });
      recRef.current = rec;
      rec.setMonitoring(false);
      rec.onError = (message) => {
        setError(message);
        setPhase("error");
        void teardownRecorder();
        restoreTransport();
      };
      await rec.start(() => {
        // Runs at take start — sample the transport tick as close to the
        // first captured sample as the recorder lets us (scheduler ticks at
        // 25 ms; the 16th-grid quantize absorbs the residue).
        if (beatSync) humStartTickRef.current = Math.max(0, services.transport.position);
        return {
          projectId: services.store.getDoc().id,
          trackId: track.id,
          trackName: track.name,
          placeOnTimeline: false,
          startBar: 0,
          bpm: services.store.getDoc().bpm,
        };
      });
      if (recRef.current !== rec) {
        // An error during "starting" already reset the panel — a late start
        // resolution must not resurrect the recording state.
        void rec.cancel();
        restoreTransport();
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
      restoreTransport();
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
    // The hum is over — hand the transport back (stop it if we started it,
    // restore the click state we found).
    const startTick = humStartTickRef.current;
    humStartTickRef.current = null;
    restoreTransport();
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
        ...(startTick !== null ? { transportStartTick: startTick } : {}),
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
            {toBeat
              ? `Hum to the beat — the transport rolls with the click and notes land where you sing (${pattern.stepCount} steps @ ${services.store.getDoc().bpm} BPM${docKey ? `, ${docKey}` : ""}).`
              : `Hum the melody free-time (${pattern.stepCount} steps @ ${services.store.getDoc().bpm} BPM${docKey ? `, snapped to ${docKey}` : ""}).`}
          </p>
          <label className="hum-mode" title="Beat-synced: start the transport with a click and map hummed timing from the transport position. Off: take time maps from tick 0.">
            <input
              type="checkbox"
              checked={toBeat}
              onChange={(e) => setToBeat(e.target.checked)}
              disabled={phase === "starting"}
            />
            TO BEAT
          </label>
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
