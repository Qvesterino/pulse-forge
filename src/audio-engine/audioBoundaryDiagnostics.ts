/**
 * AUDIO-BOUNDARY DIAGNOSTICS (engine audit 2026-10-18)
 *
 * The note/drum/bend entries DROP non-finite events instead of letting
 * `setValueAtTime(NaN)` throw inside a scheduler tick — the safe behaviour on
 * an audio path, but a silent one. This counter makes the drop observable
 * without spamming: the FIRST occurrence per kind logs a single warning, every
 * later occurrence only increments the counter. The engine exposes the snapshot
 * (`audioBoundaryDiagnostics`) so the diagnostics panel or a test can assert
 * what was dropped; a fresh engine starts from zero.
 *
 * Reachability (why this is not merely theoretical): a corrupt/old project, the
 * MCP agent surface, and a non-finite pitch bend — which is STORED on the
 * instrument state and would otherwise poison every later note on the track.
 */
export type AudioBoundaryEvent = "note" | "slide" | "noteOff" | "drumHit" | "pitchBend" | "poly";

export interface AudioBoundaryDiagnostics {
  reportDropped(kind: AudioBoundaryEvent): void;
  snapshot(): Readonly<Record<string, number>>;
}

export function createAudioBoundaryDiagnostics(
  warn: (message: string) => void = (message) => console.warn(message),
): AudioBoundaryDiagnostics {
  const dropped: Record<string, number> = {};
  const warned = new Set<string>();
  return {
    reportDropped(kind) {
      dropped[kind] = (dropped[kind] ?? 0) + 1;
      if (!warned.has(kind)) {
        warned.add(kind);
        warn(`[audio-engine] dropped a non-finite ${kind} event (further occurrences are counted, not logged)`);
      }
    },
    snapshot() {
      return { ...dropped };
    },
  };
}
