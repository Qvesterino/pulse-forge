/**
 * Live play activity — one tiny pub/sub for "a note just fired" events.
 * Consumed by the MIDI readout in the top bar and the pad flash in the
 * sequencer, so performed input confirms its routing without sound.
 */
export interface PlayActivity {
  padId?: string;
  pitch?: number;
  at: number;
}

let last: PlayActivity | null = null;
const listeners = new Set<() => void>();

export function recordPlayActivity(event: Omit<PlayActivity, "at">): void {
  last = { ...event, at: performance.now() };
  for (const listener of listeners) listener();
}

export function subscribePlayActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLastPlayActivity(): PlayActivity | null {
  return last;
}
