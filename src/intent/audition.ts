import type { SampleBank } from "../sample-library/factory";
import type { Pattern, ProjectDocument } from "../project-model/types";
import { foldFxIntoDoc } from "../commands/intentRouting";
import type { ProductionIntent } from "./production";

/**
 * CANDIDATE AUDITION (INTENT_ENGINE.md A1) — hear a candidate BEFORE applying.
 *
 * The candidate pattern is not part of the project yet, so auditioning renders
 * it OFFLINE through the real engine: a temporary document carries the pattern
 * as the active one with an emptied arrangement (mode "pattern" renders
 * exactly the active pattern), renderProject produces an AudioBuffer through
 * the same chain exports use, and a shared AudioContext plays it — stopping
 * whatever was auditioning before. Nothing touches the live engine, project
 * state or transport.
 */

/** Seconds of render tail after the last step (natural cutoff, short). */
const AUDITION_TAIL_SECONDS = 0.4;

/**
 * Build the offline-only document that renders ONE pattern in isolation.
 * `fx` (the candidate's `plan.intent.fx`) folds INTO THE GHOST only — the
 * audition hears the chains the candidate would install, the live project
 * stays untouched. An unresolvable fold degrades to an fx-less ghost: a
 * broken garnish never blocks hearing the pattern.
 */
export function auditionDoc(doc: ProjectDocument, pattern: Pattern, fx?: ProductionIntent | null): ProjectDocument {
  const ghost: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, pattern],
    scenes: [],
    arrangement: { ...doc.arrangement, clips: [] },
    activePatternId: pattern.id,
  };
  if (!fx) return ghost;
  try {
    return foldFxIntoDoc(ghost, fx);
  } catch {
    return ghost;
  }
}

let sharedContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let currentGainNode: GainNode | null = null;

export interface AuditionLevelMatch {
  beforeGain: number;
  afterGain: number;
  targetLufs: number;
  beforeGainDb: number;
  afterGainDb: number;
}

/** Match two measured audition renders by attenuating only the louder take. */
export function matchAuditionLevels(beforeLufs: number | null, afterLufs: number | null): AuditionLevelMatch | null {
  if (
    beforeLufs === null ||
    afterLufs === null ||
    !Number.isFinite(beforeLufs) ||
    !Number.isFinite(afterLufs) ||
    beforeLufs <= -70 ||
    afterLufs <= -70
  ) {
    return null;
  }
  const targetLufs = Math.min(beforeLufs, afterLufs);
  const beforeGainDb = targetLufs - beforeLufs;
  const afterGainDb = targetLufs - afterLufs;
  return {
    beforeGain: Math.pow(10, beforeGainDb / 20),
    afterGain: Math.pow(10, afterGainDb / 20),
    targetLufs,
    beforeGainDb,
    afterGainDb,
  };
}

function playbackContext(): AudioContext {
  // A closed context never recovers (OS audio-device swap, system suspend,
  // explicit close) — rebuild lazily on the next audition instead of playing
  // into a dead graph forever.
  if (!sharedContext || sharedContext.state === "closed") {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedContext = new Ctor();
    sharedContext.onstatechange = () => {
      if (sharedContext?.state === "closed") sharedContext = null;
    };
  }
  // Closed-context races are handled by the rebuild above; a rejected
  // resume (device loss) must not become an unhandled rejection.
  if (sharedContext.state === "suspended") void sharedContext.resume().catch(() => undefined);
  return sharedContext;
}

/** Stop whatever is currently auditioning (safe to call anytime). */
export function stopAudition(): void {
  const source = currentSource;
  const gain = currentGainNode;
  currentSource = null;
  currentGainNode = null;
  if (source) {
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    source.disconnect();
  }
  gain?.disconnect();
}

/**
 * Render one candidate to an AudioBuffer through the project's live chain.
 * `fx` extends the ghost with the candidate's own FX requests — the preview
 * hears exactly what USE would install (preview == apply parity).
 */
export async function renderAuditionBuffer(
  doc: ProjectDocument,
  bank: SampleBank,
  pattern: Pattern,
  fx?: ProductionIntent | null,
): Promise<AudioBuffer> {
  // Dynamic import: the offline renderer carries AudioEngine + worklet
  // loaders — it must not sit in the landing route's static payload.
  const { renderProject } = await import("../rendering/renderer");
  return renderProject(auditionDoc(doc, pattern, fx), bank, {
    mode: "pattern",
    sampleRate: 44100,
    tailSeconds: AUDITION_TAIL_SECONDS,
  });
}

/** Play a rendered candidate buffer, stopping any previous audition. Gain is preview-only. */
export function playAuditionBuffer(buffer: AudioBuffer, onEnded?: () => void, playbackGain = 1): void {
  stopAudition();
  const ctx = playbackContext();
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  gain.gain.value = Number.isFinite(playbackGain) ? Math.max(0, Math.min(1, playbackGain)) : 1;
  source.onended = () => {
    if (currentSource !== source) return;
    currentSource = null;
    currentGainNode = null;
    source.disconnect();
    gain.disconnect();
    onEnded?.();
  };
  source.connect(gain);
  gain.connect(ctx.destination);
  currentSource = source;
  currentGainNode = gain;
  void source.start();
}

/**
 * A2: SONG AUDITION — render the WHOLE song (all sections, transitions,
 * arrangement) offline and return the buffer for playback. Uses mode: "song"
 * on the applied song doc so all clips, scene automation and FX are heard.
 *
 * NOTE on Worker boundary: OfflineAudioContext is main-thread-only, so the
 * render itself CANNOT move to a worker. However, `startRendering()` is async
 * — the UI is not blocked during the audio processing. The sync setup phase
 * (scheduling) is bounded by the song length. For >64-bar songs a chunked
 * section-by-section render is the optimization path.
 */
export async function renderSongAuditionBuffer(bank: SampleBank, songDoc: ProjectDocument): Promise<AudioBuffer> {
  const { renderProject } = await import("../rendering/renderer");
  return renderProject(songDoc, bank, {
    mode: "song",
    sampleRate: 44100,
    tailSeconds: 1,
  });
}
