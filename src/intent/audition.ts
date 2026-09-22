import type { SampleBank } from "../sample-library/factory";
import type { Pattern, ProjectDocument } from "../project-model/types";
import { foldFxIntoDoc } from "../commands/commands";
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
  currentSource = null;
  if (source) {
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    source.disconnect();
  }
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

/** Play a rendered candidate buffer, stopping any previous audition. */
export function playAuditionBuffer(buffer: AudioBuffer, onEnded?: () => void): void {
  stopAudition();
  const ctx = playbackContext();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.onended = () => {
    if (currentSource === source) currentSource = null;
    onEnded?.();
  };
  source.connect(ctx.destination);
  currentSource = source;
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
