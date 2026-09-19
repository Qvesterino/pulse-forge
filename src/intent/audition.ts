import { renderProject } from "../rendering/renderer";
import type { SampleBank } from "../sample-library/factory";
import type { Pattern, ProjectDocument } from "../project-model/types";

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

/** Build the offline-only document that renders ONE pattern in isolation. */
export function auditionDoc(doc: ProjectDocument, pattern: Pattern): ProjectDocument {
  return {
    ...doc,
    patterns: [...doc.patterns, pattern],
    scenes: [],
    arrangement: { ...doc.arrangement, clips: [] },
    activePatternId: pattern.id,
  };
}

let sharedContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;

function playbackContext(): AudioContext {
  if (!sharedContext) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedContext = new Ctor();
  }
  if (sharedContext.state === "suspended") void sharedContext.resume();
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

/** Render one candidate to an AudioBuffer through the project's live chain. */
export async function renderAuditionBuffer(
  doc: ProjectDocument,
  bank: SampleBank,
  pattern: Pattern,
): Promise<AudioBuffer> {
  return renderProject(auditionDoc(doc, pattern), bank, {
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
