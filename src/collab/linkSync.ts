import { PPQ } from "../project-model/types";
import type { Clock, Transport } from "../transport/Transport";
import { isAllowedServerUrl } from "./collabShared";

/**
 * Ableton Link sync over the local WS bridge (`npm run link`).
 *
 * The bridge (server/link-bridge.mjs) owns the session clock and broadcasts
 * an authoritative tempo + absolute beat at 10 Hz; this client extrapolates
 * the beat between frames and phase-locks the transport onto it with
 * `setBpmAnchored` — the same zero-drift re-anchor the scene-tempo seams
 * use. Like real Link, phase is eternal: start/stop stay manual (pressing
 * play snaps into the running session's phase within one frame), and tempo
 * adopted from the session is written into the project document so the
 * onDocChanged tempo re-apply can never fight the correction loop.
 *
 * Pure math helpers are exported for the spec (tests/link-sync.test.ts).
 */

export const LINK_DEFAULT_PORT = 20909;
/** One quarter of a beat at 120 BPM — tighter means chasing our own jitter. */
export const PHASE_SNAP_BEATS = 0.25;
/** Tempo deltas under this are echo, not a session change. */
export const TEMPO_EPSILON = 0.05;
/** Corrections run per frame receipt plus this ticker, ms. */
export const CORRECTION_TICK_MS = 100;

export interface LinkFrame {
  /** Bridge frame discriminator — the only type clients accept. */
  readonly type: "link";
  tempo: number;
  /** Absolute session beats at `at`. */
  beat: number;
  playing: boolean;
  quantum: number;
  peers: number;
  /** Epoch ms of the bridge's beat sample. */
  at: number;
}

/** Network boundary — validate before anything reaches Transport's tick math. */
export function isLinkFrame(value: unknown): value is LinkFrame {
  if (!value || typeof value !== "object") return false;
  const f = value as Partial<LinkFrame>;
  return (
    f.type === "link" &&
    typeof f.tempo === "number" &&
    Number.isFinite(f.tempo) &&
    f.tempo >= 20 &&
    f.tempo <= 300 &&
    typeof f.beat === "number" &&
    Number.isFinite(f.beat) &&
    typeof f.playing === "boolean" &&
    typeof f.quantum === "number" &&
    Number.isFinite(f.quantum) &&
    f.quantum > 0 &&
    typeof f.peers === "number" &&
    Number.isFinite(f.peers) &&
    typeof f.at === "number" &&
    Number.isFinite(f.at)
  );
}

/** Extrapolate the session beat to `nowEpochMs`. Negative/stale deltas clamp. */
export function linkBeatAt(frame: LinkFrame, nowEpochMs: number): number {
  const dt = Math.min(60_000, Math.max(0, nowEpochMs - frame.at));
  return frame.beat + (frame.tempo / 60000) * dt;
}

/** Phase distance between two beat positions, wrapped to [0, quantum/2]. */
export function phaseDistance(a: number, b: number, quantum: number): number {
  const q = quantum > 0 ? quantum : 4;
  let d = (a - b) % q;
  if (d < 0) d += q;
  return Math.min(d, q - d);
}

export interface LinkCorrection {
  /** Hard re-anchor: our playhead is audibly off the session phase. */
  snap: boolean;
  /** Session tempo to adopt (null when within epsilon of ours). */
  tempo: number | null;
  /** Absolute session beat extrapolated to now. */
  sessionBeat: number;
}

/** Decide the corrections the client should apply to its transport. */
export function linkCorrection(
  transportBeat: number,
  transportBpm: number,
  frame: LinkFrame,
  nowEpochMs: number,
): LinkCorrection {
  const sessionBeat = linkBeatAt(frame, nowEpochMs);
  return {
    snap: phaseDistance(transportBeat, sessionBeat, frame.quantum) > PHASE_SNAP_BEATS,
    tempo: Math.abs(frame.tempo - transportBpm) > TEMPO_EPSILON ? frame.tempo : null,
    sessionBeat,
  };
}

export type LinkStatus =
  | { kind: "off" }
  | { kind: "connecting" }
  | { kind: "error"; message: string }
  | { kind: "on"; tempo: number; playing: boolean; peers: number; phase: number };

export function defaultLinkUrl(): string {
  const host = typeof location !== "undefined" && location.hostname ? location.hostname : "127.0.0.1";
  return `ws://${host}:${LINK_DEFAULT_PORT}`;
}

/**
 * Link session client. Polls (never hooks transport.onGesture — that slot
 * belongs to the collab follow logic), so broadcasting our state and applying
 * the session's are both driven by the 100 ms correction tick.
 */
export class LinkSync {
  private ws: WebSocket | null = null;
  private transport: Transport | null = null;
  private frame: LinkFrame | null = null;
  private lastSentTempo = 0;
  private lastSentPlaying: boolean | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(status: LinkStatus) => void>();
  status: LinkStatus = { kind: "off" };

  /** Same wall clock the transport was built with — anchor times must agree. */
  constructor(
    private readonly clock: Clock,
    /** Writes an adopted session tempo into the project doc (undoable command). */
    private readonly setDocTempo: (bpm: number) => void = () => {},
  ) {}

  subscribe(listener: (status: LinkStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: LinkStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  attachTransport(transport: Transport): void {
    this.transport = transport;
  }

  get enabled(): boolean {
    return this.ws !== null;
  }

  connect(urlOverride?: string): void {
    if (this.ws) return;
    const url = urlOverride ?? defaultLinkUrl();
    // Same security gate as the collab relay: only same-host ws/wss passes.
    if (!isAllowedServerUrl(url)) {
      this.setStatus({
        kind: "error",
        message: `LINK bridge URL rejected (${url}) — only same-host ws:// is allowed`,
      });
      return;
    }
    if (typeof WebSocket === "undefined") {
      this.setStatus({ kind: "error", message: "WebSocket unavailable in this environment" });
      return;
    }
    this.setStatus({ kind: "connecting" });
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.setStatus({ kind: "error", message: `LINK bridge connect failed: ${String(err)}` });
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          name: "KYX",
          tempo: this.transport?.bpm,
          playing: this.transport?.playing ?? false,
        }),
      );
      this.ticker = setInterval(() => this.tick(), CORRECTION_TICK_MS);
      this.setStatus({
        kind: "on",
        tempo: this.frame?.tempo ?? this.transport?.bpm ?? 120,
        playing: false,
        peers: 1,
        phase: 0,
      });
    };
    ws.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (isLinkFrame(parsed)) {
        this.frame = parsed;
        this.applyCorrection();
      }
    };
    ws.onerror = () => {
      this.setStatus({ kind: "error", message: "LINK bridge unreachable — start it with `npm run link`" });
    };
    ws.onclose = () => {
      this.teardown();
      this.setStatus(this.status.kind === "error" ? this.status : { kind: "off" });
    };
  }

  disconnect(): void {
    const ws = this.ws;
    this.teardown();
    this.setStatus({ kind: "off" });
    if (ws) ws.close();
  }

  private teardown(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.ws = null;
    this.frame = null;
    this.lastSentTempo = 0;
    this.lastSentPlaying = null;
  }

  dispose(): void {
    this.disconnect();
    this.listeners.clear();
  }

  /**
   * One correction/broadcast step. Order matters: apply the session first
   * (so an adopted tempo is what we rebroadcast, not our stale one), then
   * publish any gesture the session hasn't echoed yet.
   */
  private tick(): void {
    this.applyCorrection();
    this.broadcastState();
  }

  private applyCorrection(): void {
    const transport = this.transport;
    const frame = this.frame;
    if (!transport || !frame || !transport.playing) return;
    // A looping transport wraps inside its region — phase snapping would
    // fight the loop. Session tempo still applies.
    if (transport.loopEnabled) {
      if (Math.abs(transport.bpm - frame.tempo) > TEMPO_EPSILON) this.adoptTempo(frame.tempo);
      return;
    }
    const correction = linkCorrection(transport.position / PPQ, transport.bpm, frame, Date.now());
    if (correction.tempo !== null) this.adoptTempo(correction.tempo);
    if (correction.snap) {
      // Zero-drift re-anchor: tick ← session beat, time ← now, tempo ← session.
      transport.setBpmAnchored(frame.tempo, correction.sessionBeat * PPQ, this.clock.now());
    }
  }

  /** Session tempo becomes the doc tempo, so doc re-applies agree with Link. */
  private adoptTempo(bpm: number): void {
    this.setDocTempo(Math.round(bpm * 10) / 10);
  }

  private broadcastState(): void {
    const transport = this.transport;
    const ws = this.ws;
    if (!transport || !ws || ws.readyState !== WebSocket.OPEN) return;
    const tempo = transport.bpm;
    const playing = transport.playing;
    if (Math.abs(tempo - this.lastSentTempo) > TEMPO_EPSILON || playing !== this.lastSentPlaying) {
      this.lastSentTempo = tempo;
      this.lastSentPlaying = playing;
      ws.send(JSON.stringify({ type: "state", tempo, playing }));
    }
  }
}
