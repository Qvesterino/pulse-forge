/**
 * Ableton Link bridge — pure session core (no I/O, unit-testable).
 *
 * The bridge owns ONE authoritative session clock: an absolute beat counter
 * integrated from tempo changes. That mirrors what real Link peers share —
 * a tempo plus a beat phase — while giving every WebSocket client a single
 * monotonic timeline to extrapolate between 10 Hz frames. Tempo changes are
 * rebased so the beat counter stays continuous (no phase jump when someone
 * drags a fader mid-bar), and `playing` is a display/follow flag only:
 * phase keeps flowing even when every transport is stopped, exactly like
 * Link's eternal session phase.
 */

export const LINK_DEFAULT_PORT = 20909;
export const LINK_DEFAULT_HOST = "127.0.0.1";
export const MIN_TEMPO = 20;
export const MAX_TEMPO = 300;
export const DEFAULT_QUANTUM = 4;
/** Integration cap: a stalled client clock must not launch the beat into orbit. */
export const MAX_INTEGRATION_MS = 60_000;

export function clampTempo(bpm) {
  if (!Number.isFinite(bpm)) return null;
  return Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, bpm));
}

export function createLinkCore({ quantum = DEFAULT_QUANTUM, tempo: initialTempo = 120, now = () => Date.now() } = {}) {
  let tempo = clampTempo(initialTempo) ?? 120;
  let playing = false;
  let beat = 0;
  let anchorEpoch = now();
  const peers = new Map();

  function currentBeat(atEpoch) {
    if (!Number.isFinite(atEpoch)) return beat;
    const dt = Math.min(MAX_INTEGRATION_MS, Math.max(0, atEpoch - anchorEpoch));
    return beat + (tempo / 60000) * dt;
  }

  return {
    get tempo() {
      return tempo;
    },
    get playing() {
      return playing;
    },
    get quantum() {
      return quantum;
    },
    get peerCount() {
      return peers.size;
    },
    touchPeer(id, name = "peer") {
      peers.set(id, { name, lastSeen: now() });
    },
    dropPeer(id) {
      peers.delete(id);
    },
    /**
     * Adopt a client's transport state — last writer wins, but the beat
     * counter never jumps: the integration anchor is frozen at `now` before
     * the new tempo applies, so phase is continuous across the change.
     */
    applyClientState(state = {}) {
      const at = now();
      const clamped = clampTempo(state.tempo);
      if (clamped !== null && Math.abs(clamped - tempo) > 0.001) {
        beat = currentBeat(at);
        anchorEpoch = at;
        tempo = clamped;
      }
      if (typeof state.playing === "boolean") playing = state.playing;
      return { tempo, playing };
    },
    /** Hand the native Link module's tempo/playing into the same LWW path. */
    applyNativeState(state = {}) {
      this.applyClientState({
        ...(state.tempo !== undefined ? { tempo: state.tempo } : {}),
        ...(state.playing !== undefined ? { playing: !!state.playing } : {}),
      });
    },
    /** Authoritative snapshot for a WebSocket broadcast. */
    frame() {
      const at = now();
      return { type: "link", tempo, beat: currentBeat(at), playing, quantum, peers: peers.size, at };
    },
  };
}
