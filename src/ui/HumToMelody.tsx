import { useEffect, useRef, useState } from "react";
import type { InstrumentTrack, MusicalKey, NoteEvent, Pattern } from "../project-model/types";
import { BAR_TICKS, PPQ, pitchName } from "../project-model/types";
import { useServices } from "./context";
import { PcmMicRecorder } from "../audio-engine/PcmMicRecorder";
import { detectHumReAttacks } from "../audio-workers/hum-onsets";
import { trackPitchAsync } from "../audio-workers/pitch-tracker-client";
import type { PitchFrame } from "../audio-workers/pitch-tracker";
import {
  auditionTimings,
  framesToNotes,
  humToNotesCommand,
  patternLengthTicks,
  shiftNotesOctave,
  shiftNotesToBarStart,
  tileNotesAcrossPattern,
} from "../midi/hum-to-notes";

/**
 * Pure layout for the mini pitch-contour canvas: the hummed pitch curve and
 * the extracted notes projected onto ONE timeline — pattern tick space (the
 * same domain the notes live in; a beat-synced take wraps there exactly like
 * the notes do, so later loops overlay earlier ones like the audition hears
 * them). Exported for unit tests; the canvas component only rasterizes it.
 */
export interface ContourPoint {
  x: number;
  y: number;
  /** Below the voicing gate — drawn as near-invisible dust, not a curve. */
  voiced: boolean;
  /** Frame clarity 0..1 — modulates the dot alpha. */
  clarity: number;
}

export interface ContourNoteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HumContourLayout {
  points: ContourPoint[];
  noteRects: ContourNoteRect[];
  /** X positions of the internal bar lines. */
  barLines: number[];
  pitchMin: number;
  pitchMax: number;
}

export function humContourLayout(
  frames: readonly PitchFrame[],
  notes: readonly NoteEvent[],
  options: {
    bpm: number;
    patternLengthTicks: number;
    /** Transport anchor of a beat-synced take (null = free-time, no wrap). */
    anchorTick: number | null;
    width: number;
    height: number;
    /** Vertical padding inside the canvas (px). */
    padPx?: number;
  },
): HumContourLayout {
  const pad = options.padPx ?? 6;
  const innerH = Math.max(4, options.height - pad * 2);
  const len = options.patternLengthTicks;
  const bpm = Number.isFinite(options.bpm) && options.bpm > 0 ? options.bpm : 120;
  const secPerTick = 60 / (bpm * PPQ);
  const beatSynced = options.anchorTick !== null;
  const anchor = beatSynced ? Math.max(0, options.anchorTick!) : 0;

  // Pitch bounds from everything drawable (notes included — an octave shift
  // must stay visible), padded and with a sane minimum span.
  const pitches = [
    ...notes.map((n) => n.pitch),
    ...frames.filter((f) => f.midi > 0).map((f) => f.midi),
  ];
  let pitchMin = pitches.length > 0 ? Math.min(...pitches) : 48;
  let pitchMax = pitches.length > 0 ? Math.max(...pitches) : 72;
  pitchMin -= 2;
  pitchMax += 2;
  if (pitchMax - pitchMin < 10) {
    const mid = (pitchMax + pitchMin) / 2;
    pitchMin = mid - 5;
    pitchMax = mid + 5;
  }
  const yOf = (pitch: number) => pad + ((pitchMax - pitch) / (pitchMax - pitchMin)) * innerH;
  const xOf = (tick: number) => ((tick % len) + len) % len * (options.width / len);

  const points: ContourPoint[] = [];
  if (beatSynced) {
    for (const frame of frames) {
      points.push({
        x: xOf(anchor + Math.round(frame.timeSec / secPerTick)),
        y: yOf(frame.midi > 0 ? frame.midi : (pitchMin + pitchMax) / 2),
        voiced: frame.midi > 0 && frame.clarity >= 0.55 && frame.rms >= 0.004,
        clarity: frame.clarity,
      });
    }
  } else {
    // Free-time takes may be longer than the pattern — points past the end
    // have no honest slot; drop them (the notes were dropped the same way).
    for (const frame of frames) {
      const tick = anchor + Math.round(frame.timeSec / secPerTick);
      if (tick >= len) continue;
      points.push({
        x: xOf(tick),
        y: yOf(frame.midi > 0 ? frame.midi : (pitchMin + pitchMax) / 2),
        voiced: frame.midi > 0 && frame.clarity >= 0.55 && frame.rms >= 0.004,
        clarity: frame.clarity,
      });
    }
  }

  const noteRects: ContourNoteRect[] = notes.map((note) => ({
    x: xOf(note.start),
    y: yOf(note.pitch + 0.5),
    w: Math.max(2, (note.duration / len) * options.width),
    h: Math.max(2, (1 / (pitchMax - pitchMin)) * innerH),
  }));

  const barLines: number[] = [];
  for (let tick = BAR_TICKS; tick < len; tick += BAR_TICKS) {
    barLines.push((tick / len) * options.width);
  }

  return { points, noteRects, barLines, pitchMin, pitchMax };
}

/** Mini pitch-contour canvas: hummed curve (dots) vs extracted notes (blocks). */
function HumPitchCanvas({
  frames,
  notes,
  bpm,
  anchorTick,
  patternLengthTicks,
  width,
  height,
}: {
  frames: readonly PitchFrame[];
  notes: readonly NoteEvent[];
  bpm: number;
  anchorTick: number | null;
  patternLengthTicks: number;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const style = getComputedStyle(canvas);
    const accent = style.getPropertyValue("--accent").trim() || "#f59e0b";
    const dim = style.getPropertyValue("--text-faint").trim() || "#3a3d44";
    const layout = humContourLayout(frames, notes, {
      bpm,
      patternLengthTicks,
      anchorTick,
      width,
      height,
    });

    // Bar grid.
    ctx.strokeStyle = dim;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    for (const x of layout.barLines) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, height);
      ctx.stroke();
    }

    // Extracted notes — the promise of what APPLY writes.
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = accent;
    for (const rect of layout.noteRects) ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    // The hum itself — one 2px dot per tracked frame, alpha by clarity.
    // Unvoiced frames become near-invisible dust (breaths stay visible as
    // absence, not as pitch garbage).
    for (const point of layout.points) {
      ctx.globalAlpha = point.voiced ? 0.35 + 0.65 * Math.min(1, point.clarity) : 0.06;
      ctx.fillStyle = point.voiced ? accent : dim;
      ctx.fillRect(point.x - 1, point.y - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
  }, [frames, notes, bpm, anchorTick, patternLengthTicks, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className="hum-contour"
      style={{ width, height }}
      role="img"
      aria-label="Hummed pitch contour against the extracted notes"
    />
  );
}

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
  /** Contour-canvas inputs: the raw tracked frames + their transport anchor. */
  const [contour, setContour] = useState<{ frames: PitchFrame[]; anchorTick: number | null } | null>(null);
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
      // Pitch tracking (worker) + hum re-attack detection (cheap, sync) —
      // the re-attacks split same-pitch notes ("da-da") that pitch-only
      // segmentation would merge into one long note.
      const frames = await trackPitchAsync(channel, take.buffer.sampleRate);
      const onsets = detectHumReAttacks(channel, take.buffer.sampleRate);
      const extracted = framesToNotes(frames, {
        bpm: services.store.getDoc().bpm,
        key: docKey,
        quantize: true,
        patternLengthTicks: patternLengthTicks(pattern),
        onsets,
        ...(startTick !== null ? { transportStartTick: startTick } : {}),
      });
      if (extracted.length === 0) {
        setPhase("error");
        setError("No steady pitches found — hum louder and hold each note a beat or two.");
        return;
      }
      setNotes(extracted);
      // Keep the contour inputs so the canvas can draw hum-vs-notes: raw
      // frames + the transport anchor that mapped them into pattern space.
      setContour({ frames, anchorTick: startTick });
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

  // FILL button state: how many copies the phrase tiles into, and whether
  // there is room to fill at all (a phrase already reaching the pattern end
  // has nowhere to tile).
  const len = patternLengthTicks(pattern);
  const fillCopies = (() => {
    if (notes.length === 0) return 1;
    const first = Math.min(...notes.map((n) => n.start));
    const lastEnd = Math.max(...notes.map((n) => n.start + n.duration));
    const span = lastEnd - first;
    if (span <= 0) return 1;
    const period = Math.max(1, Math.ceil(span / BAR_TICKS)) * BAR_TICKS;
    return Math.max(1, Math.ceil((len - first) / period));
  })();
  const canFill = notes.length > 0 && fillCopies > 1;

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
          {contour && (
            <HumPitchCanvas
              frames={contour.frames}
              notes={notes}
              bpm={services.store.getDoc().bpm}
              anchorTick={contour.anchorTick}
              patternLengthTicks={patternLengthTicks(pattern)}
              width={216}
              height={96}
            />
          )}
          <div className="hum-actions">
            <button
              type="button"
              className={`btn btn-small${auditioning ? " active-solo" : ""}`}
              title="Play the extracted notes through this track's instrument before applying"
              onClick={() => (auditioning ? stopAudition() : startAudition())}
            >
              {auditioning ? "■ STOP" : "▶ AUDITION"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              title="Shift the whole take one octave down (people hum below the synth's comfortable range)"
              onClick={() => shiftOctave(-1)}
            >
              OCT −
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              title="Shift the whole take one octave up"
              onClick={() => shiftOctave(1)}
            >
              OCT +
            </button>
          </div>
          <div className="hum-actions">
            <button
              type="button"
              className="btn btn-ghost"
              title="Snap the whole take so the first note lands on the pattern start (free-time takes begin wherever you started humming)"
              onClick={() => {
                stopAudition();
                setNotes((current) => shiftNotesToBarStart(current));
              }}
            >
              TO START
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              title="Tile the phrase forward across the whole pattern (hum one bar, get the full groove)"
              disabled={!canFill}
              onClick={() => {
                stopAudition();
                setNotes((current) => tileNotesAcrossPattern(current, patternLengthTicks(pattern)));
              }}
            >
              {fillCopies > 1 ? `FILL ×${fillCopies}` : "FILL"}
            </button>
          </div>
          <label className="hum-mode">
            Mode{" "}
            <select value={mode} onChange={(e) => setMode(e.target.value as "replace" | "merge")}>
              <option value="replace">Replace track notes</option>
              <option value="merge">Merge into track</option>
            </select>
          </label>
          <div className="hum-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                stopAudition();
                apply();
              }}
            >
              APPLY
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                stopAudition();
                setNotes([]);
                setContour(null);
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
