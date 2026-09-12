import { PPQ } from "../project-model/types";
import type { Transport } from "../transport/Transport";

/**
 * Shared transport state for collab jams — broadcast over the awareness
 * channel (ephemeral by design: the pulse is session state, never document
 * state). Anchor math is wall-clock (`Date.now()/1000`, epoch-based so every
 * page shares the timebase; `performance.now()` is per-page and useless
 * across peers). Same-machine jams have ~zero skew; over the internet,
 * typical NTP-synced machines land within tens of ms — band-practice
 * tolerance, not sample-accurate sync.
 */
export interface SharedTransportState {
  playing: boolean;
  /** Epoch seconds of the anchor (tick ↔ wall pair). */
  anchorWall: number;
  /** Transport tick at anchorWall. */
  anchorTick: number;
  bpm: number;
  /** Awareness clientId of the originator — echo suppression. */
  by: string;
  /** Epoch ms — recency when several peers have broadcast. */
  at: number;
}

/**
 * Awareness is a network boundary, so the TypeScript interface alone is not
 * sufficient protection. Keep this validator deliberately strict: an
 * invalid transport pulse must be ignored before it reaches Transport,
 * because NaN/Infinity would poison the scheduler's tick math.
 */
export function isSharedTransportState(value: unknown): value is SharedTransportState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<SharedTransportState>;
  return (
    typeof state.playing === "boolean" &&
    typeof state.anchorWall === "number" &&
    Number.isFinite(state.anchorWall) &&
    typeof state.anchorTick === "number" &&
    Number.isFinite(state.anchorTick) &&
    state.anchorTick >= 0 &&
    typeof state.bpm === "number" &&
    Number.isFinite(state.bpm) &&
    state.bpm >= 20 &&
    state.bpm <= 300 &&
    typeof state.by === "string" &&
    state.by.length > 0 &&
    typeof state.at === "number" &&
    Number.isFinite(state.at)
  );
}

/** Whether a remote play pulse represents a paused → playing transition. */
export function shouldStartRemoteScheduler(wasPlaying: boolean, nextPlaying: boolean): boolean {
  return nextPlaying && !wasPlaying;
}

/** Snapshot the transport into a broadcastable state. */
export function captureTransportState(
  transport: Transport,
  by: string,
  wallNow = Date.now() / 1000,
): SharedTransportState {
  return {
    playing: transport.playing,
    anchorWall: wallNow,
    anchorTick: Math.max(0, transport.position),
    bpm: transport.bpm,
    by,
    at: Date.now(),
  };
}

/**
 * Apply a remote state to the local transport: extrapolate the originator's
 * anchor to THIS instant and re-anchor locally (seek + play), so both
 * playheads read the same musical position at the same wall moment. Remote
 * pause/stop pauses locally at the remote's paused tick; remote stop (tick 0)
 * behaves exactly like a local stop.
 */
export function applyTransportState(
  transport: Transport,
  state: SharedTransportState,
  wallNow = Date.now() / 1000,
): void {
  if (!isSharedTransportState(state) || !Number.isFinite(wallNow)) return;
  if (state.playing) {
    const elapsed = Math.max(0, wallNow - state.anchorWall);
    const desired = Math.max(0, state.anchorTick + (elapsed * state.bpm * PPQ) / 60);
    if (Math.abs(transport.bpm - state.bpm) > 0.001) transport.setBpm(state.bpm);
    if (!transport.playing) transport.play(desired);
    else transport.seek(desired);
  } else {
    if (transport.playing) transport.pause();
    transport.seek(Math.max(0, state.anchorTick));
  }
}
