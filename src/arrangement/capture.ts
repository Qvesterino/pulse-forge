import type { Command } from "../commands/types";
import { appendCapturedArrangement, type CapturedArrangementClip } from "../commands/commands";
import { BAR_TICKS } from "../project-model/types";
import type { ProjectDocument } from "../project-model/types";

export interface ArrangementCaptureSnapshot {
  capturing: boolean;
  launchCount: number;
  firstBar: number | null;
}

interface CapturedLaunch {
  sceneId: string;
  startBar: number;
}

/** Runtime-only recorder for quantized scene launches. */
export class ArrangementCaptureController {
  private capturing = false;
  private firstBar: number | null = null;
  private launches: CapturedLaunch[] = [];
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
