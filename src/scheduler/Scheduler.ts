import type { DrumTrack, Pattern, PlayMode, ProjectDocument } from "../project-model/types";
import { BAR_TICKS, getActivePattern, STEP_TICKS } from "../project-model/types";
import { drumHitsInWindow } from "../project-model/groove";
import type { Transport } from "../transport/Transport";

export interface SchedulerDeps {
  getProject(): ProjectDocument;
  getTransport(): Transport;
  getAudioTime(): number;
  getMode(): PlayMode;
  trigger(trackId: string, pad: DrumTrack["pads"][number], when: number, velocity: number): void;
  noteOn(trackId: string, pitch: number, velocity: number, when: number, durationSec: number): void;
  applyAutomation(fromTick: number, toTick: number, relOf: (tick: number) => number): void;
  /** Apply a single per-scene automation lane within a song window. */
  applySceneAutomationLane?(
    lane: import("../project-model/types").SceneAutomation,
    fromTick: number,
    toTick: number,
    sceneStartTick: number,
  ): void;
  /** Commit a queued (quantized) pattern launch into the project model. */
  applyPatternLaunch(patternId: string): void;
  /** Called once per scheduler window with the absolute tick window. */
  onSongWindow?(fromTick: number, toTick: number, mode: PlayMode): void;
  /** Trigger a marker cue at the absolute project tick (asset id may be null). */
  triggerMarker?(assetId: string | null, when: number, trackId?: string): void;
  /** Update the live scene intensity signal (0..1). */
  setSceneIntensity?(intensity: number): void;
  /** MIDI output: send a note on to external hardware. */
  midiNoteOn?(trackId: string, channel: number, note: number, velocity: number, when: number): void;
  /** MIDI output: send a note off to external hardware. */
  midiNoteOff?(trackId: string, channel: number, note: number, when: number): void;
  /** MIDI output: send a CC message. */
  midiCC?(channel: number, cc: number, value: number): void;
}

const INTERVAL_MS = 25;
const HORIZON_SECONDS = 0.12;

const mod = (value: number, m: number): number => ((value % m) + m) % m;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private windowStartTick = 0;
  private stopped = true;
  private pendingLaunch: { patternId: string; atTick: number } | null = null;
  /** Marker ids that have already fired in this playback session. Cleared on stop. */
  private firedMarkerIds = new Set<string>();
  /** Marker ids scheduled to fire in the current window (deferred trigger). */
  private pendingMarkers: { assetId: string | null; when: number; trackId?: string }[] = [];
  stats = { scheduledEvents: 0, lastHorizonTick: 0, windows: 0 };
  private listeners = new Set<() => void>();

  constructor(private deps: SchedulerDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get isRunning(): boolean {
    return !this.stopped;
  }

  /** Pattern id waiting for a quantized launch, if any (for UI indication). */
  get pendingPatternId(): string | null {
    return this.pendingLaunch?.patternId ?? null;
  }

  start(): void {
    if (this.timer !== null) return;
    const transport = this.deps.getTransport();
    this.windowStartTick = Math.max(0, transport.position);
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // A queued scene launch survives a stop as an immediate switch — the user
    // asked for that pattern; stopping should not silently discard the choice.
    if (this.pendingLaunch) {
      this.deps.applyPatternLaunch(this.pendingLaunch.patternId);
      this.pendingLaunch = null;
      this.notify();
    }
    // Markers re-arm on stop so a future play replays them.
    this.firedMarkerIds.clear();
    this.pendingMarkers.length = 0;
    this.stopped = true;
  }

  /** Re-align the scheduling window to the transport (after a seek while playing). */
  resync(): void {
    const transport = this.deps.getTransport();
    this.windowStartTick = Math.max(0, transport.position);
  }

  /** Queue a pattern switch at an absolute tick (next bar boundary for scene launches). */
  queuePatternLaunch(patternId: string, atTick: number): void {
    this.pendingLaunch = { patternId, atTick };
    this.notify();
  }

  cancelPatternLaunch(): void {
    if (this.pendingLaunch) {
      this.pendingLaunch = null;
      this.notify();
    }
  }

  private tick(): void {
    const transport = this.deps.getTransport();
    if (!transport.playing) {
      this.stop();
      return;
    }
    if (transport.loopEnabled) {
      const doc = this.deps.getProject();
      const mode = this.deps.getMode();
      const loopStart = transport.loopStart;
      const loopEnd =
        transport.loopEnd > 0
          ? transport.loopEnd
          : mode === "pattern"
            ? STEP_TICKS * getActivePattern(doc).stepCount
            : Math.max(
                0,
                ...doc.arrangement.clips.map((c) => (c.startBar + c.lengthBars) * BAR_TICKS),
              );
      const position = transport.position;
      if (position >= loopEnd || position < loopStart) {
        transport.seek(loopStart);
        this.windowStartTick = loopStart;
      }
    }
    const now = this.deps.getAudioTime();
    const horizon = now + HORIZON_SECONDS;
    const windowEnd = transport.tickAt(horizon);
    const windowStart = this.windowStartTick;
    if (windowEnd <= windowStart) {
      this.stats.windows += 1;
      return;
    }
    const doc = this.deps.getProject();
    const mode = this.deps.getMode();

    let automationCtx: { base: number; patternTicks: number } | null = null;

    if (mode === "pattern") {
      let currentDoc = doc;
      // A queued launch whose boundary we already passed (e.g. after a seek)
      // commits immediately.
      if (this.pendingLaunch && this.pendingLaunch.atTick <= windowStart) {
        this.deps.applyPatternLaunch(this.pendingLaunch.patternId);
        this.pendingLaunch = null;
        this.notify();
        currentDoc = this.deps.getProject();
      }
      const pattern = getActivePattern(currentDoc);
      const patternTicks = STEP_TICKS * pattern.stepCount;
      const pending = this.pendingLaunch;
      const boundary =
        pending && pending.atTick > windowStart && pending.atTick <= windowEnd ? pending.atTick : null;

      this.schedulePatternWindow(pattern, 0, patternTicks, windowStart, boundary ?? windowEnd);
      automationCtx = { base: 0, patternTicks };

      if (boundary !== null && pending) {
        // Split the window at the launch boundary: old pattern before it,
        // new pattern after — the switch lands exactly on the quantized tick.
        this.deps.applyPatternLaunch(pending.patternId);
        this.pendingLaunch = null;
        this.notify();
      }
      // In pattern mode, the active scene's intensity is fed from the static
      // value (no curve is meaningful inside a one-bar loop).
      const activeScene = currentDoc.scenes.find((s) => s.id === currentDoc.activePatternId) ??
        currentDoc.scenes.find((s) => s.patternId === currentDoc.activePatternId);
      this.deps.setSceneIntensity?.(activeScene ? Math.max(0, Math.min(1, activeScene.intensity)) : 0.7);
    } else {
      const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
      // Find the active scene (whose clip contains the playhead) for intensity
      // computation and the marker-firing loop.
      let activeScene: typeof doc.scenes[number] | null = null;
      let activeClipStart = 0;
      for (const clip of clips) {
        const clipStart = clip.startBar * BAR_TICKS;
        const clipEnd = clipStart + clip.lengthBars * BAR_TICKS;
        if (windowStart >= clipStart && windowStart < clipEnd) {
          const scene = doc.scenes.find((sc) => sc.id === clip.sceneId);
          if (scene) {
            activeScene = scene;
            activeClipStart = clipStart;
          }
          break;
        }
      }
      if (this.deps.setSceneIntensity) {
        if (activeScene) {
          const offset = Math.max(0, windowStart - activeClipStart);
          const v = activeScene.intensity;
          const curve = activeScene.intensityCurve;
          let intensity = v;
          if (curve && curve.length > 0) {
            if (offset <= curve[0].offset) intensity = curve[0].value;
            else if (offset >= curve[curve.length - 1].offset) intensity = curve[curve.length - 1].value;
            else {
              for (let i = 0; i < curve.length - 1; i++) {
                const a = curve[i];
                const b = curve[i + 1];
                if (offset >= a.offset && offset <= b.offset) {
                  const span = b.offset - a.offset;
                  if (span > 0) {
                    const t = (offset - a.offset) / span;
                    intensity = a.value + (b.value - a.value) * t;
                  } else {
                    intensity = a.value;
                  }
                  break;
                }
              }
            }
          }
          this.deps.setSceneIntensity(Math.max(0, Math.min(1, intensity)));
        } else {
          this.deps.setSceneIntensity(0.7);
        }
      }
      for (const clip of clips) {
        const clipStart = clip.startBar * BAR_TICKS;
        const clipEnd = clipStart + clip.lengthBars * BAR_TICKS;
        const s = Math.max(windowStart, clipStart);
        const e = Math.min(windowEnd, clipEnd);
        if (e <= s) continue;
        const scene = doc.scenes.find((sc) => sc.id === clip.sceneId);
        if (!scene) continue;
        const pattern = doc.patterns.find((p) => p.id === scene.patternId);
        if (!pattern) continue;
        const patternTicks = STEP_TICKS * pattern.stepCount;
        this.schedulePatternWindow(pattern, clipStart, patternTicks, s, e);
        if (!automationCtx && windowStart >= clipStart) {
          automationCtx = { base: clipStart, patternTicks };
        }
      }
      if (!automationCtx) {
        const covering = clips.find((c) => {
          const cs = c.startBar * BAR_TICKS;
          return windowStart >= cs && windowStart < cs + c.lengthBars * BAR_TICKS;
        });
        if (covering) {
          const scene = doc.scenes.find((sc) => sc.id === covering.sceneId);
          const pattern = scene ? doc.patterns.find((p) => p.id === scene.patternId) : undefined;
          const patternTicks = pattern ? STEP_TICKS * pattern.stepCount : STEP_TICKS * 16;
          automationCtx = { base: covering.startBar * BAR_TICKS, patternTicks };
        }
      }
      // Marker firing: queue cues for any marker whose tick falls within the
      // current window. Dedupe via firedMarkerIds so each marker triggers once
      // per playback session.
      for (const marker of doc.markers) {
        if (marker.tick < windowStart || marker.tick > windowEnd) continue;
        if (this.firedMarkerIds.has(marker.id)) continue;
        this.firedMarkerIds.add(marker.id);
        const assetId = mapMarkerTypeToAsset(marker.type);
        const when = transport.timeAtTick(marker.tick) + 0.005;
        this.deps.triggerMarker?.(assetId, when, marker.linkedClipId);
      }
      // Scene automation: invoke applySceneAutomation per active clip window.
      if (activeScene) {
        for (const lane of doc.sceneAutomation) {
          if (lane.sceneId !== activeScene.id) continue;
          this.applySceneAutomation(lane, windowStart, windowEnd, activeClipStart, transport);
        }
      }
    }

    if (automationCtx) {
      const { base, patternTicks } = automationCtx;
      this.deps.applyAutomation(windowStart, windowEnd, (tick) => mod(tick - base, patternTicks));
    }

    this.windowStartTick = windowEnd;
    this.stats.lastHorizonTick = windowEnd;
    this.stats.windows += 1;
  }

  private schedulePatternWindow(
    pattern: Pattern,
    base: number,
    patternTicks: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    const transport = this.deps.getTransport();
    const doc = this.deps.getProject();
    const now = this.deps.getAudioTime();
    const timeAt = (tick: number) => transport.timeAtTick(tick);
    const audible = (when: number) => when >= now - 0.002;

    for (const hit of drumHitsInWindow(doc, pattern, base, windowStart, windowEnd)) {
      const when = timeAt(hit.tick);
      if (!audible(when)) continue;
      this.deps.trigger(hit.trackId, hit.pad, when, hit.velocity);
      // MIDI output for drum tracks
      if (this.deps.midiNoteOn) {
        const track = doc.tracks.find((t) => t.id === hit.trackId);
        if (track?.kind === "instrument" && track.midiOutput?.enabled) {
          const ch = (track.midiOutput.channel || 1) - 1;
          const padIndex = 0; // GM map would need pad→note lookup
          this.deps.midiNoteOn(hit.trackId, ch, 36 + padIndex, Math.round(hit.velocity * 127), when);
          if (this.deps.midiNoteOff) {
            const noteOffWhen = when + 0.1;
            this.deps.midiNoteOff(hit.trackId, ch, 36 + padIndex, noteOffWhen);
          }
        }
      }
      this.stats.scheduledEvents += 1;
    }

    const relStart = mod(windowStart - base, patternTicks);
    for (const track of doc.tracks) {
      if (track.kind !== "instrument") continue;
      const notes = pattern.notes?.[track.id];
      if (!notes || notes.length === 0) continue;
      for (const note of notes) {
        let occ = windowStart + mod(note.start - relStart, patternTicks);
        for (; occ < windowEnd; occ += patternTicks) {
          const when = timeAt(occ);
          if (!audible(when)) continue;
          this.deps.noteOn(track.id, note.pitch, note.velocity, when, note.duration * transport.secondsPerTick);
          // MIDI output for instrument tracks
          if (this.deps.midiNoteOn && track.midiOutput?.enabled) {
            const ch = (track.midiOutput.channel || 1) - 1;
            this.deps.midiNoteOn(track.id, ch, note.pitch, Math.round(note.velocity * 127), when);
            if (this.deps.midiNoteOff) {
              const noteOffWhen = when + note.duration * transport.secondsPerTick;
              this.deps.midiNoteOff(track.id, ch, note.pitch, noteOffWhen);
            }
          }
          this.stats.scheduledEvents += 1;
        }
      }
    }
  }

  /**
   * Apply a per-scene automation lane within the current scheduler window. The
   * scene's start is the offset origin (0 ticks). Forwards to the engine's
   * `applySceneAutomationLane` (which handles track gain / FX / instrument
   * params and smooths with setTargetAtTime).
   */
  private applySceneAutomation(
    lane: import("../project-model/types").SceneAutomation,
    windowStart: number,
    windowEnd: number,
    sceneStartTick: number,
    _transport: Transport,
  ): void {
    if (lane.points.length === 0) return;
    this.deps.applySceneAutomationLane?.(lane, windowStart, windowEnd, sceneStartTick);
  }
}

/** Map a marker type to its auto-trigger asset (or null for no cue). */
function mapMarkerTypeToAsset(type: import("../project-model/types").Marker["type"]): string | null {
  switch (type) {
    case "drop":
    case "impact":
      return "factory.fx.impact";
    case "buildup":
    case "riser":
      return "factory.fx.riser";
    case "cue":
    case "custom":
      return null;
  }
}
