import type { Command } from "../commands/types";
import { appendCapturedArrangement, snapshot, type CapturedArrangementClip } from "../commands/commands";
import { BAR_TICKS, STEP_TICKS } from "../project-model/types";
import type { NoteEvent, ProjectDocument } from "../project-model/types";

export interface ArrangementCaptureSnapshot {
  capturing: boolean;
  launchCount: number;
  firstBar: number | null;
}

/** One captured performance event (drum step or note) for the MIDI capture ring. */
export interface CapturedEvent {
  trackId: string;
  padId?: string;
  pitch?: number;
  velocity: number;
  tick: number;
  duration?: number;
}

interface CapturedLaunch {
  sceneId: string;
  startBar: number;
}

/** Ring-buffer size: ~8 bars of 16th steps × a few tracks — plenty for a take. */
const CAPTURE_RING_LIMIT = 2048;

/** Runtime-only recorder for quantized scene launches + passive MIDI capture ring. */
export class ArrangementCaptureController {
  private capturing = false;
  private firstBar: number | null = null;
  private launches: CapturedLaunch[] = [];
  /** Passive performance ring (Ableton "Capture last take") — always rolling while scheduler runs. */
  private ring: CapturedEvent[] = [];
  /** Track ids seen in the current ring (for pattern-from-capture mapping). */
  private ringTrackIds = new Set<string>();
  private lastPauseTick: number | null = null;
  private listeners = new Set<() => void>();
  private snapshot: ArrangementCaptureSnapshot = { capturing: false, launchCount: 0, firstBar: null };

  constructor(
    private readonly projectRef: () => ProjectDocument,
    private readonly execute: (command: Command) => void,
    private readonly getTransportTick: () => number,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ArrangementCaptureSnapshot => this.snapshot;

  // ── Passive capture ring (Ableton Capture) ──────────────────────────────

  /**
   * Record a performed event into the ring. Called by the scheduler for every
   * scheduled hit/note regardless of "recording" state — the ring always has
   * the last ~8 bars, so a genius fill is never lost after the fact.
   */
  recordEvent = (event: CapturedEvent): void => {
    this.ring.push(event);
    if (event.padId || event.pitch !== undefined) this.ringTrackIds.add(event.trackId);
    if (this.ring.length > CAPTURE_RING_LIMIT) {
      const drop = this.ring.length - CAPTURE_RING_LIMIT;
      this.ring.splice(0, drop);
    }
  };

  /** Non-empty when there is material worth capturing after a pause/stop. */
  get hasCapturedMaterial(): boolean {
    return this.ring.length > 0;
  }

  /** Number of events in the current ring (for the toast copy). */
  get capturedEventCount(): number {
    return this.ring.length;
  }

  /** Called by PlaybackController on pause — the moment "Capture last take?" becomes relevant. */
  markPause = (): void => {
    this.lastPauseTick = Math.max(0, this.getTransportTick());
  };

  /**
   * Build one Command: a new pattern holding the captured events (relative to
   * the playhead's bar at pause), launched via a scene chip + an arrangement
   * clip at the content end. One undo returns everything.
   * Returns null when the ring is empty or the mapped pattern would be empty.
   */
  captureLastTake = (): Command | null => {
    if (this.ring.length === 0) return null;
    const doc = this.projectRef();
    const baseTick = Math.floor(Math.max(0, this.lastPauseTick ?? this.getTransportTick()) / STEP_TICKS) * STEP_TICKS;
    // Group events by track: drum tracks → step rows, instrument tracks → notes.
    const rows: Record<string, number[]> = {};
    const stepMeta: NonNullable<import("../project-model/types").Pattern["stepMeta"]> = {};
    const notes: Record<string, NoteEvent[]> = {};
    let minStep = Infinity;
    let maxStep = -Infinity;
    for (const ev of this.ring) {
      const relStep = Math.floor((ev.tick - baseTick) / STEP_TICKS);
      if (ev.padId) {
        minStep = Math.min(minStep, relStep);
        maxStep = Math.max(maxStep, relStep);
        const row = (rows[ev.padId] ??= new Array<number>(16).fill(0));
        // Wrap into a 16-step grid: pattern repeats, so mod 16 and take the highest velocity
        const wrapped = ((relStep % 16) + 16) % 16;
        if (wrapped >= 0 && wrapped < row.length) row[wrapped] = Math.max(row[wrapped], ev.velocity);
        if (Math.abs(relStep - wrapped) > 0) {
          const padMeta = (stepMeta[ev.padId] ??= {});
          const cycle = Math.floor(relStep / 16);
          padMeta[wrapped] = { ...(padMeta[wrapped] ?? {}), amount: Math.min(1, Math.max(0.05, ev.velocity)) };
          void cycle;
        }
      } else if (ev.pitch !== undefined) {
        minStep = Math.min(minStep, relStep);
        maxStep = Math.max(maxStep, relStep);
        const list = (notes[ev.trackId] ??= []);
        list.push({
          id: `cap-${ev.trackId}-${relStep}-${ev.pitch}-${list.length}`,
          pitch: ev.pitch,
          start: Math.max(0, relStep * STEP_TICKS),
          duration: Math.max(STEP_TICKS, (Math.round((ev.duration ?? 0.25) * 1000) / 1000) * 0 + STEP_TICKS),
          velocity: Math.min(1, Math.max(0.05, ev.velocity)),
        });
      }
    }
    if (minStep === Infinity || maxStep === -Infinity) return null;
    // Determine track kind mapping: pads belong to drum tracks by pad id, notes to instrument ids
    const drumPads = new Set<string>();
    for (const t of doc.tracks) if (t.kind === "drum") for (const p of t.pads) drumPads.add(p.id);
    const rowsFiltered: Record<string, number[]> = {};
    for (const [padId, row] of Object.entries(rows)) if (drumPads.has(padId)) rowsFiltered[padId] = row;
    const notesFiltered: Record<string, NoteEvent[]> = {};
    for (const [tid, list] of Object.entries(notes)) {
      if (doc.tracks.some((t) => t.id === tid && t.kind === "instrument") && list.length > 0) notesFiltered[tid] = list;
    }
    const hasSteps = Object.values(rowsFiltered).some((r) => r.some((v) => v > 0));
    const hasNotes = Object.keys(notesFiltered).length > 0;
    if (!hasSteps && !hasNotes) return null;

    // Build a command directly (avoids import cycle with schema helpers).
    const stepCount = 16;
    const patternId = `cap-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const pattern: import("../project-model/types").Pattern = {
      id: patternId,
      name: `Captured ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      stepCount,
      rows: rowsFiltered,
      notes: notesFiltered,
      stepMeta: Object.keys(stepMeta).length > 0 ? stepMeta : undefined,
    };
    const sceneId = `caps-${patternId}`;
    const clipId = `capc-${patternId}`;
    const startBar = doc.arrangement.clips.reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0);
    const next: ProjectDocument = {
      ...doc,
      patterns: [...doc.patterns, pattern],
      scenes: [...doc.scenes, { id: sceneId, name: pattern.name, patternId, intensity: 0.7 }],
      arrangement: {
        ...doc.arrangement,
        clips: [...doc.arrangement.clips, { id: clipId, sceneId, startBar, lengthBars: 1 }],
      },
      activePatternId: patternId,
    };
    this.ring = [];
    this.ringTrackIds.clear();
    // Audit 08 D7: delta snapshot, not a whole-doc pin — `undo: () => doc`
    // clobbered any change that reached the store between capture build and
    // the undo (async finalize, generative refresh).
    return snapshot("captureLastTake", `Capture last take (${this.capturedEventCount || ""} events)`, doc, next) as Command;
  };

  // ── Arrangement launch capture (existing feature) ───────────────────────

  start = (): void => {
    if (this.capturing) return;
    this.capturing = true;
    this.firstBar = null;
    this.launches = [];
    this.notify();
  };

  recordSceneLaunch = (sceneId: string, currentTick: number): void => {
    if (!this.capturing || !this.projectRef().scenes.some((scene) => scene.id === sceneId)) return;
    const nextBar = Math.floor(Math.max(0, currentTick) / BAR_TICKS) + 1;
    if (this.firstBar === null) this.firstBar = nextBar;
    const relativeBar = Math.max(0, nextBar - this.firstBar);
    const existing = this.launches.findIndex((launch) => launch.startBar === relativeBar);
    const launch = { sceneId, startBar: relativeBar };
    if (existing >= 0) this.launches[existing] = launch;
    else this.launches.push(launch);
    this.launches.sort((a, b) => a.startBar - b.startBar);
    this.notify();
  };

  finish = (): boolean => {
    if (!this.capturing) return false;
    if (this.launches.length === 0) {
      this.reset();
      return false;
    }
    const currentBar = Math.floor(Math.max(0, this.getTransportTick()) / BAR_TICKS);
    const endBar = Math.max(1, currentBar - (this.firstBar ?? 0));
    const captured: CapturedArrangementClip[] = this.launches.map((launch, index) => ({
      sceneId: launch.sceneId,
      startBar: launch.startBar,
      lengthBars: Math.max(
        1,
        index < this.launches.length - 1
          ? this.launches[index + 1].startBar - launch.startBar
          : endBar - launch.startBar,
      ),
    }));
    this.execute(appendCapturedArrangement(this.projectRef(), captured));
    this.reset();
    return true;
  };

  cancel = (): void => {
    if (!this.capturing && this.launches.length === 0) return;
    this.reset();
  };

  private reset(): void {
    this.capturing = false;
    this.firstBar = null;
    this.launches = [];
    this.notify();
  }

  private notify(): void {
    this.snapshot = {
      capturing: this.capturing,
      launchCount: this.launches.length,
      firstBar: this.firstBar,
    };
    for (const listener of this.listeners) listener();
  }
}
