import type { DrumTrack, Pattern, PlayMode, ProjectDocument } from "../project-model/types";
import { BAR_TICKS, PPQ, STEP_TICKS } from "../project-model/types";
import { ticksPerBar, ticksPerBeat } from "../project-model/schema";
import { drumHitsInWindow } from "../project-model/groove";
import { noteEventsInWindow } from "../project-model/events";
import { computeSceneIntensity } from "../project-model/intensity";
import type { Transport } from "../transport/Transport";

export interface SchedulerDeps {
  getProject(): ProjectDocument;
  getTransport(): Transport;
  getAudioTime(): number;
  /** Runtime-only delay applied to project-generated audio events. */
  getScheduleOffsetSec?(): number;
  getMode(): PlayMode;
  /**
   * Live audio context state. Used to gate event scheduling while the
   * context is suspended or closed — otherwise every queued source fires
   * within microseconds on the next resume ("machine gun" burst).
   * Optional for backward compatibility with test harnesses; when
   * absent, the scheduler assumes "running".
   */
  getContextState?(): AudioContextState | "closed";
  trigger(
    trackId: string,
    pad: DrumTrack["pads"][number],
    when: number,
    velocity: number,
    locks?: Partial<Record<import("../project-model/types").StepLockKey, number>>,
  ): void;
  /** Trigger a note; optional slide origin (pitch + absolute when-tick) for FL portamento. */
  noteOn(
    trackId: string,
    pitch: number,
    velocity: number,
    when: number,
    durationSec: number,
    slideFromTick?: number,
    slideFromPitch?: number,
    locks?: Partial<Record<import("../project-model/types").StepLockKey, number>>,
    slideFromWhen?: number,
  ): void;
  applyAutomation(
    fromTick: number,
    toTick: number,
    relOf: (tick: number) => number,
    scheduleOffsetSec?: number,
    timeAt?: (tick: number) => number,
  ): void;
  /**
   * Schedulable track modulators (random S&H / step) for the same window.
   * `whenFor` maps an absolute tick to a precise AudioContext time so event
   * boundaries land sample-aligned.
   */
  applyModulators?(fromTick: number, toTick: number, whenFor: (tick: number) => number): void;
  /** Poll envFollower modulators targeting FX/inst params (control rate ~25 ms). */
  applyEnvFollowers?(): void;
  /** Apply a single per-scene automation lane within a song window. */
  applySceneAutomationLane?(
    lane: import("../project-model/types").SceneAutomation,
    fromTick: number,
    toTick: number,
    sceneStartTick: number,
    scheduleOffsetSec?: number,
    timeAt?: (tick: number) => number,
  ): void;
  /** Commit a queued (quantized) pattern launch into the project model. */
  applyPatternLaunch(patternId: string): void;
  /** Called once per scheduler window with the absolute tick window. */
  onSongWindow?(fromTick: number, toTick: number, mode: PlayMode): void;
  /** Trigger a marker cue at the absolute project tick (asset id may be null). */
  triggerMarker?(assetId: string | null, when: number, trackId?: string): void;
  /** Update the live scene intensity signal (0..1). */
  setSceneIntensity?(intensity: number): void;
  /** Schedule future scene-intensity changes inside the look-ahead window. */
  scheduleSceneIntensity?(points: Array<{ tick: number; value: number }>, timeAt: (tick: number) => number): void;
  /** Apply the active scene's tempo (null = follow the project tempo). */
  applySceneTempo?(bpm: number | null): void;
  /** The transport's tempo actually changed (flip commit) — tempo-synced engine runtimes follow. */
  applyEngineTempo?(bpm: number): void;
  /** Trigger an arrangement AudioClip buffer at an absolute tick. */
  triggerAudioClip?(clip: import("../project-model/types").AudioClip, when: number, durationSec: number): void;
  /** Metronome click for count-in / pre-roll (downbeat = bar start accent). */
  metronomeClick?(when: number, downbeat: boolean): void;
  /** Passive capture ring (Ableton): record every performed hit/note for later "Capture last take". */
  recordCapturedEvent?(event: {
    trackId: string;
    padId?: string;
    pitch?: number;
    velocity: number;
    tick: number;
    duration?: number;
  }): void;
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

/** Click dedup guard — fires only for future (not-yet-played) clicks like `audible`. */
function audibleClick(when: number, now: number): boolean {
  return when >= now - 0.002;
}

/** Resolve only the canonical active pattern. Never silently play another one. */
function findActivePattern(doc: ProjectDocument): Pattern | undefined {
  if (doc.patterns.length === 0) return undefined;
  return doc.patterns.find((p) => p.id === doc.activePatternId);
}

/**
 * Resolve the loop end in absolute ticks. `transport.loopEnd === 0` means
 * "to the end of the current content": the active pattern in pattern mode
 * (step count × STEP_TICKS) or the arrangement end in song mode. Centralised
 * so `start()` and `tick()` can both anchor on the same value (the scheduler
 * precision audit's A01.D1 fix would otherwise drift between the two).
 */
function resolveLoopEnd(transport: Transport, doc: ProjectDocument, mode: PlayMode): number {
  if (transport.loopEnd > 0) return transport.loopEnd;
  if (mode === "pattern") {
    // This is only an emergency transport bound for an invalid/empty
    // document. Content scheduling still refuses to substitute another
    // pattern; the document boundary repairs the invariant.
    return STEP_TICKS * (findActivePattern(doc)?.stepCount ?? 16);
  }
  return Math.max(0, ...doc.arrangement.clips.map((c) => (c.startBar + c.lengthBars) * BAR_TICKS));
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Last invalid active-pattern signature reported by this scheduler. */
  private invalidPatternSignature: string | null = null;
  /**
   * Effective loop end in ticks for the CURRENT window (loop enabled only).
   * Read by the pending-launch commit logic in scheduleWindow — a launch
   * quantized past the loop end must commit at the wrap instead of pending
   * forever.
   */
  private activeLoopEnd: number | null = null;
  /**
   * Scheduled scene-tempo change (release roadmap 2.2) — the tempo seam fix.
   * When the lookahead window reaches a clip boundary whose scene pins a
   * DIFFERENT bpm, the window is split: events before the boundary keep the
   * current (old-anchor) tick→time map, events after it are pre-scheduled on
   * the NEW tempo integrated from the boundary (`boundaryTime + (tick −
   * boundary) · sptNew` — the exact formula `buildTempoMap` uses offline).
   * The transport itself re-anchors (setBpm, position-preserving) only when
   * the playhead actually crosses the boundary, so the old-side map stays
   * exact until that instant. Without this, the flip landed up to one
   * lookahead (~120 ms) early at a non-musical window edge and live diverged
   * from export.
   */
  private pendingTempoFlip: {
    bpm: number;
    atTick: number;
    fromBpm: number;
    /** Old-map wall time of the boundary — the exact re-anchor point. */
    boundaryTime: number;
  } | null = null;
  /**
   * The current window's tick→time map — piecewise across a scheduled tempo
   * boundary, plain `transport.timeAtTick` otherwise. Consumed by the
   * modulator sweep that runs after the song/pattern blocks; song mode sets
   * it, pattern mode and the early returns leave it null.
   */
  private songTimeAt: ((tick: number) => number) | null = null;
  private windowStartTick = 0;
  /**
   * Absolute tick of the next metronome click to schedule. Clicks fire on
   * every beat of the count-in region and (metronome ON) during playback;
   * the cursor persists across windows so a window split at the content
   * boundary neither re-clicks nor skips a beat. Rebased by seeks/loop wraps.
   */
  private clickCursor = 0;
  /** Content boundary for the current play; -1 means no active lead-in. */
  private leadInUntilTick = -1;
  /** Play-start tick used to keep lead-in click spacing stable if preferences change live. */
  private leadInStartTick = -1;
  private stopped = true;
  /** Last BPM handed to applySceneTempo (null = project tempo) — change-guard. */
  private lastAppliedTempo: number | null | undefined = undefined;
  /**
   * Last observed AudioContext state. Used to detect the
   * suspended → running transition (Defect A02.D2, browser audio
   * lifecycle audit): while suspended, tick() skips windows so the
   * transport position effectively freezes. When the context comes
   * back, the live playhead is much further along than
   * `windowStartTick` (the suspended region dropped out of the
   * bookkeeping). Re-anchoring the window origin to the live playhead
   * prevents the next tick from scheduling a massive "machine gun"
   * burst covering the entire suspended gap.
   */
  private lastContextState: AudioContextState | "closed" = "running";
  private pendingLaunch: { patternId: string; atTick: number } | null = null;
  /** Marker ids that have already fired in this playback session. Cleared on stop. */
  private firedMarkerIds = new Set<string>();
  /** Marker ids scheduled to fire in the current window (deferred trigger). */
  private pendingMarkers: { assetId: string | null; when: number; trackId?: string }[] = [];
  /** `failedWindows` = scheduling windows skipped after an exception (see tick). */
  stats = { scheduledEvents: 0, lastHorizonTick: 0, windows: 0, failedWindows: 0 };
  private listeners = new Set<() => void>();
  /**
   * Per-tick allocations in song mode (sorted clips + id → entity
   * Maps for scenes / patterns) used to fire every 25 ms even when
   * the project had not changed. That is fine for a 5-clip demo but
   * adds measurable GC pressure on a long session with 50+ clips.
   * Cache the derived structures and re-derive them only when the
   * `getProject()` reference changes (commands build the next doc
   * immutably, so a stable ref means "no edit since last tick").
   */
  private songCacheProject: ProjectDocument | null = null;
  private songClipsCache: { sceneId: string; startBar: number; lengthBars: number }[] = [];
  private songScenesByIdCache = new Map<string, ProjectDocument["scenes"][number]>();
  private songPatternsByIdCache = new Map<string, ProjectDocument["patterns"][number]>();
  private tracksByIdProject: ProjectDocument | null = null;
  private tracksByIdCache = new Map<string, ProjectDocument["tracks"][number]>();

  /**
   * O(1) track lookup for per-event resolution (quality backlog B6): the
   * per-event `doc.tracks.find` was O(tracks) per scheduled note. Same
   * ref-guard invalidation as the song caches: commands build docs
   * immutably, so a stable ref means "no edit since last tick".
   */
  private tracksById(doc: ProjectDocument): Map<string, ProjectDocument["tracks"][number]> {
    if (this.tracksByIdProject !== doc) {
      this.tracksByIdProject = doc;
      this.tracksByIdCache = new Map(doc.tracks.map((track) => [track.id, track]));
    }
    return this.tracksByIdCache;
  }

  constructor(private deps: SchedulerDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private scheduleOffsetSec(): number {
    const value = this.deps.getScheduleOffsetSec?.() ?? 0;
    return Number.isFinite(value) ? value : 0;
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
    this.leadInUntilTick = transport.leadInBars() > 0 ? transport.anchorTickBeforePreRoll() : -1;
    this.leadInStartTick = this.leadInUntilTick >= 0 ? this.windowStartTick : -1;
    // Re-arm the click cursor: the lead-in count-in must click from the very
    // first beat even when start() is called mid-bar (e.g. play at 0 with a
    // 2-bar count-in starts the transport two bars early).
    this.clickCursor = Math.max(0, transport.position);
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
    this.tick();
  }

  stop(): void {
    // Playback ended — hand tempo control back to the project BPM.
    this.pendingTempoFlip = null;
    this.applyTempo(null);
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
    // The click cursor is per-playback; a new start() re-seeds it.
    this.clickCursor = 0;
    this.leadInUntilTick = -1;
    this.leadInStartTick = -1;
    this.stopped = true;
  }

  /** Re-align the scheduling window to the transport (after a seek while playing). */
  resync(): void {
    // A seek invalidates a scheduled tempo flip — the boundary is re-detected
    // against the new position on the next window.
    this.pendingTempoFlip = null;
    const transport = this.deps.getTransport();
    this.windowStartTick = Math.max(0, transport.position);
    // ...and the metronome cursor: the next beat click belongs to the new
    // position, not the pre-seek stream.
    this.clickCursor = Math.max(0, transport.position);
    // A user seek is an explicit new playback location, so do not replay the
    // old play's lead-in before the newly requested content.
    this.leadInUntilTick = -1;
    this.leadInStartTick = -1;
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

  private applyTempo(bpm: number | null): void {
    if (!this.deps.applySceneTempo) return;
    if (this.lastAppliedTempo === bpm) return;
    this.lastAppliedTempo = bpm;
    this.deps.applySceneTempo(bpm);
  }

  private tick(): void {
    const transport = this.deps.getTransport();
    if (!transport.playing) {
      this.stop();
      return;
    }
    // Tempo-seam flip (roadmap 2.2): the playhead crossed the scheduled
    // boundary — re-anchor the transport now (setBpm is position-preserving,
    // so it lands within one tick quantization of the boundary). The events
    // past the boundary were already pre-scheduled on the new tempo, so this
    // only aligns position()/timeAtTick for everything scheduled from here.
    if (this.pendingTempoFlip && transport.position >= this.pendingTempoFlip.atTick) {
      const flip = this.pendingTempoFlip;
      this.pendingTempoFlip = null;
      // Anchor EXACTLY on the pre-computed boundary point — a position-
      // preserving setBpm() here would quantize the anchor to the tick and
      // skip up to one tick-worth of grid right after the seam.
      transport.setBpmAnchored(flip.bpm, flip.atTick, flip.boundaryTime);
      this.lastAppliedTempo = flip.bpm;
      // Tempo-synced engine runtimes (SYNC delays, LFO syncs) flip at the
      // same instant — otherwise they stay at the project tempo while the
      // transport runs the scene tempo.
      this.deps.applyEngineTempo?.(flip.bpm);
    }
    // Defect A01.D2 (scheduler precision audit): windowEnd is declared
    // before the loop-wrap block so the post-wrap clamp can shorten it
    // to the loop boundary. If a seek fires inside the wrap block, the
    // post-seek value differs from the pre-seek one, so we recompute
    // windowEnd against the new anchor.
    const now = this.deps.getAudioTime();
    const horizon = now + HORIZON_SECONDS;
    let windowEnd = transport.tickAt(horizon);
    if (transport.loopEnabled) {
      const doc = this.deps.getProject();
      const mode = this.deps.getMode();
      const loopStart = transport.loopStart;
      // Defect 2.1 (recovery): the loop end resolution calls
      // getActivePattern(doc), which throws when the active pattern id
      // is stale. Resolve the loop end against the *first available*
      // pattern instead so the transport never wedges mid-loop.
      const loopEnd = resolveLoopEnd(transport, doc, mode);
      this.activeLoopEnd = loopEnd;
      const position = transport.position;
      if (position >= loopEnd || position < loopStart) {
        transport.seek(loopStart);
        // The wrap jumps position — a scheduled flip would fire at the wrong
        // place. Boundary detection re-runs from the wrapped window.
        this.pendingTempoFlip = null;
        this.clickCursor = loopStart;
        this.leadInUntilTick = -1;
        this.windowStartTick = loopStart;
        // transport.seek re-anchored; windowEnd was computed against
        // the old anchor. Recompute against the post-seek anchor so
        // the clamp below sees the correct value.
        windowEnd = transport.tickAt(horizon);
      }
      // Clamp windowEnd to loopEnd so we never schedule events past
      // the loop boundary in the same window. Without the clamp the
      // next loop iteration re-fires those late events because they
      // were committed in this iteration too.
      if (windowEnd > loopEnd) windowEnd = loopEnd;
    }
    // Defect 2.5 (recovery): if the audio context is suspended or closed,
    // every event scheduled in this window would be queued by
    // createBufferSource and fire as a microsecond burst on the next
    // resume. Skip the window — the window still advances so we don't
    // wedge — and let the running transport catch up cleanly when the
    // context resumes.
    const contextState = this.deps.getContextState?.() ?? "running";
    if (contextState !== "running") {
      this.lastContextState = contextState;
      this.windowStartTick = windowEnd;
      this.stats.lastHorizonTick = windowEnd;
      this.stats.windows += 1;
      return;
    }
    // Defect A02.D2 (browser audio lifecycle audit): detect the
    // suspended → running transition. The window origin has drifted
    // arbitrarily far from the live playhead during the suspended
    // region (windowEnd was being walked forward against a frozen
    // engine.currentTime). Re-anchor to the live playhead so the
    // next scheduled window covers only the post-resume region.
    let windowStart = this.windowStartTick;
    if (this.lastContextState !== "running") {
      this.windowStartTick = Math.max(0, transport.position);
      this.lastContextState = "running";
      // Keep the local value in sync with the re-anchored field. Passing the
      // stale pre-suspend origin here would schedule the entire suspended gap
      // in one look-ahead window and recreate the machine-gun burst.
      windowStart = this.windowStartTick;
    }
    if (windowEnd <= windowStart) {
      this.stats.windows += 1;
      return;
    }
    try {
      if (!transport.loopEnabled) this.activeLoopEnd = null;
      this.scheduleWindow(transport, now, windowStart, windowEnd);
    } catch (err) {
      // A scheduling failure must not wedge the transport: without advancing
      // the window, the next tick would re-schedule the same events every
      // 25 ms (machine-gun duplicates + exception spam). Skip the damaged
      // window once, keep the failure observable, keep playing.
      this.stats.failedWindows += 1;
      console.error("[scheduler] scheduling window failed:", err);
    }
    this.windowStartTick = windowEnd;
    this.stats.lastHorizonTick = windowEnd;
    this.stats.windows += 1;
  }

  /** Schedule one lookahead window (pattern/song content, markers, automation, modulators). */
  private scheduleWindow(transport: Transport, now: number, windowStart: number, windowEnd: number): void {
    const doc = this.deps.getProject();
    const mode = this.deps.getMode();
    this.songTimeAt = null;

    // Metronome: clicks fire on every beat of the click lead-in and, when the
    // metronome is enabled, during content playback as well. The cursor
    // persists across windows so a window split at the content boundary
    // neither re-clicks nor skips a beat; it rebases on seeks and loop wraps.
    const contentStart = this.leadInUntilTick;
    const leadInActive = contentStart >= 0;
    if (this.deps.metronomeClick && (leadInActive || transport.metronome)) {
      const beatTicks = ticksPerBeat(doc);
      const barTicks = ticksPerBar(doc);
      // Lead-in clicks are anchored to the transport's play-start so the last
      // click lands exactly on the content start; playback clicks follow the
      // project grid.
      const clickAnchor = leadInActive ? this.leadInStartTick : 0;
      let cursor = this.clickCursor;
      if (cursor < windowStart || cursor > windowEnd) cursor = windowStart;
      cursor = clickAnchor + Math.ceil((cursor - clickAnchor) / beatTicks) * beatTicks;
      while (cursor < windowEnd) {
        const inLeadIn = leadInActive && cursor < contentStart;
        if (inLeadIn || (cursor >= contentStart && transport.metronome)) {
          const when = transport.timeAtTick(cursor) + this.scheduleOffsetSec() + 0.005;
          const downbeat = inLeadIn
            ? Math.abs((((cursor - clickAnchor) % BAR_TICKS) + BAR_TICKS) % BAR_TICKS) < 1e-6
            : Math.abs(((cursor % barTicks) + barTicks) % barTicks) < 1e-6;
          if (audibleClick(when, now)) this.deps.metronomeClick(when, downbeat);
        }
        cursor += beatTicks;
      }
      this.clickCursor = cursor;
    } else {
      // Nothing to click — keep the cursor from walking a dead grid.
      this.clickCursor = windowEnd;
    }

    // The click lead-in is silent on the content side: only the metronome
    // sounds until contentStart, then the window is clamped so content starts
    // exactly on time.
    if (leadInActive) {
      if (windowEnd <= contentStart) return;
      if (windowStart < contentStart) windowStart = contentStart;
    }

    // Count-in/pre-roll is a click-only lead-in. Do not let pattern notes,
    // arrangement clips, markers, automation, or modulators leak into that
    // region. The transport stores this boundary for the current play so
    // changing the preference while already playing cannot move the seam.
    const contentWindowStart = Math.max(windowStart, transport.anchorTickBeforePreRoll());
    if (contentWindowStart >= windowEnd) return;

    let automationCtx: { base: number; patternTicks: number } | null = null;

    if (mode === "pattern") {
      let currentDoc = doc;
      // Defect 2.2 (recovery): a queued launch whose target pattern was
      // deleted from the doc would otherwise cause applyPatternLaunch to
      // write a stale id into activePatternId, throwing on the next
      // tick. Drop the stale launch before it can do harm.
      if (this.pendingLaunch && !currentDoc.patterns.some((p) => p.id === this.pendingLaunch!.patternId)) {
        console.warn(`[scheduler] dropping queued launch for missing pattern ${this.pendingLaunch.patternId}`);
        this.pendingLaunch = null;
        this.notify();
      }
      // A queued launch whose boundary we already passed (e.g. after a seek)
      // commits immediately.
      if (this.pendingLaunch && this.pendingLaunch.atTick <= contentWindowStart) {
        this.deps.applyPatternLaunch(this.pendingLaunch.patternId);
        this.pendingLaunch = null;
        this.notify();
        currentDoc = this.deps.getProject();
      }
      // The project model owns activePatternId. Do not hide a broken
      // document by rendering the first pattern: that produces the wrong
      // music while making the real state corruption invisible.
      const pattern = findActivePattern(currentDoc);
      if (!pattern) {
        const signature = `${currentDoc.activePatternId}|${currentDoc.patterns.map((p) => p.id).join(",")}`;
        if (this.invalidPatternSignature !== signature) {
          this.invalidPatternSignature = signature;
          console.error(
            `[scheduler] cannot schedule pattern mode: active pattern ${currentDoc.activePatternId} is not present in the project`,
          );
        }
        // Invalid/empty doc — advance the window so the scheduler does not
        // wedge, but never emit events from a substitute pattern.
        this.windowStartTick = windowEnd;
        this.stats.lastHorizonTick = windowEnd;
        this.stats.windows += 1;
        return;
      }
      this.invalidPatternSignature = null;
      const patternTicks = STEP_TICKS * pattern.stepCount;
      const pending = this.pendingLaunch;
      let boundary =
        pending && pending.atTick > contentWindowStart && pending.atTick <= windowEnd ? pending.atTick : null;
      // A launch quantized to a bar boundary BEYOND the loop end can never
      // reach its boundary before the loop wraps — it used to pend forever
      // (badge stuck; only stop() committed it). Commit at the loop edge:
      // the switch lands exactly on the wrap, which is the next bar
      // boundary the user's gesture could reach.
      if (
        pending &&
        boundary === null &&
        this.activeLoopEnd !== null &&
        windowEnd >= this.activeLoopEnd &&
        contentWindowStart < this.activeLoopEnd &&
        pending.atTick > this.activeLoopEnd
      ) {
        boundary = this.activeLoopEnd;
      }

      this.schedulePatternWindow(pattern, 0, contentWindowStart, boundary ?? windowEnd);
      automationCtx = { base: 0, patternTicks };

      if (boundary !== null && pending) {
        // Split the window at the launch boundary: old pattern before it,
        // new pattern after — the switch lands exactly on the quantized tick.
        this.deps.applyPatternLaunch(pending.patternId);
        this.pendingLaunch = null;
        this.notify();
        // Schedule the launched pattern for the remainder of this window.
        // Without this, events between boundary and windowEnd would never be
        // scheduled (the next tick resumes from windowEnd) and the first hits
        // of the launch would be silently dropped.
        const nextDoc = this.deps.getProject();
        const nextPattern = nextDoc.patterns.find((p) => p.id === pending.patternId);
        currentDoc = nextDoc;
        if (nextPattern) {
          this.schedulePatternWindow(nextPattern, 0, boundary, windowEnd);
          automationCtx = { base: 0, patternTicks: STEP_TICKS * nextPattern.stepCount };
        }
      }
      // In pattern mode, the active scene's intensity is fed from the static
      // value (no curve is meaningful inside a one-bar loop).
      const activeScene =
        currentDoc.scenes.find((s) => s.id === currentDoc.activePatternId) ??
        currentDoc.scenes.find((s) => s.patternId === currentDoc.activePatternId);
      this.deps.setSceneIntensity?.(activeScene ? Math.max(0, Math.min(1, activeScene.intensity)) : 0.7);
      // Pattern mode has no arrangement context — follow the project tempo.
      this.applyTempo(null);
    } else {
      // Performance: rebuild the song-mode derived structures only
      // when the project reference has changed since the last tick.
      // Commands build the next doc immutably, so identity equality
      // here is a strong "no edit" signal — the previous tick's
      // sorted clips + id Maps are still valid. This turns a 25 ms
      // allocation triplet (array + spread + sort + 2 new Map) into
      // a 25 ms no-op on a stable project.
      let clips: { sceneId: string; startBar: number; lengthBars: number }[];
      let scenesById: Map<string, ProjectDocument["scenes"][number]>;
      let patternsById: Map<string, ProjectDocument["patterns"][number]>;
      if (this.songCacheProject === doc) {
        clips = this.songClipsCache;
        scenesById = this.songScenesByIdCache;
        patternsById = this.songPatternsByIdCache;
      } else {
        clips = doc.arrangement.clips.slice().sort((a, b) => a.startBar - b.startBar);
        // Defect A05.D1 (beat engine stress audit): every song-mode
        // window used to look up scenes and patterns via
        // `doc.scenes.find((sc) => sc.id === clip.sceneId)` inside the
        // per-clip loop. With 50+ clips and 5–10 scenes that becomes
        // O(clips × scenes) per window, i.e. per 25 ms tick. Build the
        // id → entity Maps once per (stable) window for O(1) lookup.
        scenesById = new Map(doc.scenes.map((s) => [s.id, s] as const));
        patternsById = new Map(doc.patterns.map((p) => [p.id, p] as const));
        this.songClipsCache = clips;
        this.songScenesByIdCache = scenesById;
        this.songPatternsByIdCache = patternsById;
        this.songCacheProject = doc;
      }
      // Find the active scene (whose clip contains the playhead) for intensity
      // computation and the marker-firing loop.
      let activeScene: (typeof doc.scenes)[number] | null = null;
      let activeClipStart = 0;
      for (const clip of clips) {
        const clipStart = clip.startBar * BAR_TICKS;
        const clipEnd = clipStart + clip.lengthBars * BAR_TICKS;
        if (contentWindowStart >= clipStart && contentWindowStart < clipEnd) {
          const scene = scenesById.get(clip.sceneId);
          if (scene) {
            activeScene = scene;
            activeClipStart = clipStart;
          }
          break;
        }
      }
      if (this.deps.setSceneIntensity) {
        if (activeScene) {
          this.deps.setSceneIntensity(computeSceneIntensity(activeScene, activeClipStart, contentWindowStart));
        } else {
          this.deps.setSceneIntensity(0.7);
        }
      }
      // Scene tempo (release roadmap 2.2): while inside a clip whose scene
      // pins a BPM, the transport runs there. With a SCHEDULED flip the
      // apply is suppressed — the flip fires from tick() when the playhead
      // crosses the boundary; applying it here would land up to one lookahead
      // early (the original seam bug).
      if (!this.pendingTempoFlip) {
        this.applyTempo(activeScene?.bpm ?? null);
      }
      // Build the window's tick→time map: piecewise when a scene-tempo change
      // sits inside (or is already scheduled for) this window.
      let tempoSplit: { atTick: number; sptNew: number; timeAt: (tick: number) => number } | null = null;
      // Snapshot the old-tempo line (anchor + slope) once per window so the
      // returned maps are PURE: evaluating them later (after a flip re-anchored
      // the transport) reproduces the exact times the engine saw at scheduling.
      const sptOld = transport.secondsPerTick;
      const baseTimeOld = transport.timeAtTick(0);
      const buildSplit = (atTick: number, bpmNew: number) => {
        const sptNew = 60 / (bpmNew * PPQ);
        const boundaryTime = baseTimeOld + atTick * sptOld;
        return {
          atTick,
          sptNew,
          timeAt: (tick: number) =>
            tick < atTick ? baseTimeOld + tick * sptOld : boundaryTime + (tick - atTick) * sptNew,
        };
      };
      if (this.pendingTempoFlip) {
        // A flip scheduled in a previous window whose boundary this window
        // still spans — reuse it (same formula the offline buildTempoMap uses).
        const pending = this.pendingTempoFlip;
        tempoSplit = buildSplit(pending.atTick, pending.bpm);
      } else {
        // Detect the first clip boundary inside the window whose scene pins a
        // DIFFERENT bpm than the one currently applied, and schedule the flip.
        const currentBpm = transport.bpm;
        for (const clip of clips) {
          const boundaryTick = clip.startBar * BAR_TICKS;
          if (boundaryTick <= contentWindowStart || boundaryTick > windowEnd) continue;
          const scene = scenesById.get(clip.sceneId);
          if (!scene) continue;
          const boundaryBpm = scene.bpm ?? doc.bpm;
          if (boundaryBpm === currentBpm) continue;
          this.pendingTempoFlip = {
            bpm: boundaryBpm,
            atTick: boundaryTick,
            fromBpm: currentBpm,
            boundaryTime: transport.timeAtTick(boundaryTick),
          };
          tempoSplit = buildSplit(boundaryTick, boundaryBpm);
          break; // one flip per window — further changes land in later windows
        }
      }
      const timeAtForWindow = tempoSplit ? tempoSplit.timeAt : (tick: number) => baseTimeOld + tick * sptOld;
      this.songTimeAt = timeAtForWindow;
      this.deps.scheduleSceneIntensity?.(
        sceneIntensityPointsForWindow(clips, scenesById, contentWindowStart, windowEnd),
        timeAtForWindow,
      );
      for (const clip of clips) {
        const clipStart = clip.startBar * BAR_TICKS;
        const clipEnd = clipStart + clip.lengthBars * BAR_TICKS;
        const s = Math.max(contentWindowStart, clipStart);
        const e = Math.min(windowEnd, clipEnd);
        if (e <= s) continue;
        const scene = scenesById.get(clip.sceneId);
        if (!scene) continue;
        const pattern = patternsById.get(scene.patternId);
        if (!pattern) continue;
        const patternTicks = STEP_TICKS * pattern.stepCount;
        this.schedulePatternWindow(pattern, clipStart, s, e, tempoSplit ? timeAtForWindow : undefined);
        if (!automationCtx && contentWindowStart >= clipStart) {
          automationCtx = { base: clipStart, patternTicks };
        }
      }
      if (!automationCtx) {
        const covering = clips.find((c) => {
          const cs = c.startBar * BAR_TICKS;
          return contentWindowStart >= cs && contentWindowStart < cs + c.lengthBars * BAR_TICKS;
        });
        if (covering) {
          const scene = scenesById.get(covering.sceneId);
          const pattern = scene ? patternsById.get(scene.patternId) : undefined;
          const patternTicks = pattern ? STEP_TICKS * pattern.stepCount : STEP_TICKS * 16;
          automationCtx = { base: covering.startBar * BAR_TICKS, patternTicks };
        }
      }
      // Marker firing: queue cues for any marker whose tick falls within the
      // current window. Dedupe via firedMarkerIds so each marker triggers once
      // per playback session.
      for (const marker of doc.markers) {
        if (marker.tick < contentWindowStart || marker.tick > windowEnd) continue;
        if (this.firedMarkerIds.has(marker.id)) continue;
        this.firedMarkerIds.add(marker.id);
        const assetId = mapMarkerTypeToAsset(marker.type);
        const when = timeAtForWindow(marker.tick) + this.scheduleOffsetSec() + 0.005;
        // linkedClipId is a CLIP id (Audit 08 D5) — resolve the clip's TRACK
        // so the cue previews in the right track context instead of always
        // falling back to the global preview bus.
        const linkedClipTrackId = marker.linkedClipId
          ? doc.arrangement.audioClips?.find((c) => c.id === marker.linkedClipId)?.trackId
          : undefined;
        this.deps.triggerMarker?.(assetId, when, linkedClipTrackId);
      }
      // Scene automation: invoke applySceneAutomation per active clip window.
      if (activeScene) {
        for (const lane of doc.sceneAutomation) {
          if (lane.sceneId !== activeScene.id) continue;
          this.applySceneAutomation(
            lane,
            contentWindowStart,
            windowEnd,
            activeClipStart,
            transport,
            this.scheduleOffsetSec(),
            timeAtForWindow,
          );
        }
      }
      // AudioClips: fire any clip whose start tick falls inside the current window
      if (this.deps.triggerAudioClip && doc.arrangement.audioClips) {
        for (const clip of doc.arrangement.audioClips) {
          const clipStart = clip.startBar * BAR_TICKS;
          if (clipStart < contentWindowStart || clipStart >= windowEnd) continue;
          const when = timeAtForWindow(clipStart) + this.scheduleOffsetSec() + 0.005;
          // A clip starting past the tempo boundary runs at the NEW tempo.
          const spt = tempoSplit && clipStart >= tempoSplit.atTick ? tempoSplit.sptNew : transport.secondsPerTick;
          const durationSec = clip.lengthBars * BAR_TICKS * spt;
          this.deps.triggerAudioClip(clip, when, durationSec);
        }
      }
    }

    if (automationCtx) {
      const { base, patternTicks } = automationCtx;
      // Defect A01.D3 (scheduler precision audit): a pattern with
      // stepCount === 0 (corrupted doc, collab peer pre-normalisation,
      // future schema) would make patternTicks === 0 and
      // mod(tick - base, 0) === NaN, poisoning the engine's
      // automation parameters for the rest of the session. Skip the
      // automation for this window — no useful loop length to wrap
      // against anyway. A non-finite guard catches future bugs where
      // patternTicks is also negative or NaN.
      if (Number.isFinite(patternTicks) && patternTicks > 0) {
        this.deps.applyAutomation(
          contentWindowStart,
          windowEnd,
          (tick) => mod(tick - base, patternTicks),
          this.scheduleOffsetSec(),
          // Tick-mapped writes (roadmap 2.3): the lane endpoints land on the
          // events' musical times — in tempo-split windows this is the
          // piecewise map, so the seam stays exact for automation too.
          this.songTimeAt ?? ((tick: number) => transport.timeAtTick(tick)),
        );
      }
    }

    // Track modulators share the window — boundaries map through the transport
    // clock the same way marker cues do, so live and offline grids agree.
    if (this.deps.applyModulators) {
      const transport = this.deps.getTransport();
      const offsetSec = this.scheduleOffsetSec() + 0.005;
      const timeAtMod = this.songTimeAt ?? ((tick: number) => transport.timeAtTick(tick));
      this.deps.applyModulators(contentWindowStart, windowEnd, (tick) => timeAtMod(tick) + offsetSec);
    }

    // Poll envFollower modulators targeting FX/inst params (control rate).
    this.deps.applyEnvFollowers?.();
  }

  private schedulePatternWindow(
    pattern: Pattern,
    base: number,
    windowStart: number,
    windowEnd: number,
    timeAtOverride?: (tick: number) => number,
  ): void {
    const transport = this.deps.getTransport();
    const doc = this.deps.getProject();
    const now = this.deps.getAudioTime();
    const scheduleOffsetSec = this.scheduleOffsetSec();
    // A tempo split overrides the transport map for the post-boundary part of
    // the window (release roadmap 2.2 — the events past the boundary must run
    // on the NEW tempo integrated from the boundary, not on the not-yet-
    // re-anchored transport map).
    const timeAt = timeAtOverride ?? ((tick: number) => transport.timeAtTick(tick));
    // Local seconds-per-tick from the SAME map that schedules the note's
    // `when`: in a tempo-split window the transport still runs the OLD tempo
    // until the flip, so `transport.secondsPerTick` gave notes started on the
    // far side of the boundary (and its 1-tick neighbourhood) wrong LIVE
    // durations while the offline render (per-clip windows) used the new
    // tempo. A 1-tick delta of a piecewise-linear map is its exact local spt.
    const sptAt = (tick: number) => timeAt(tick + 1) - timeAt(tick);
    const audible = (when: number) => when >= now - 0.002;

    for (const hit of drumHitsInWindow(doc, pattern, base, windowStart, windowEnd)) {
      const when = timeAt(hit.tick) + scheduleOffsetSec;
      if (!audible(when)) continue;
      this.deps.trigger(hit.trackId, hit.pad, when, hit.velocity, hit.locks);
      // Passive capture ring (Ableton) — always rolling, cheap ring push
      this.deps.recordCapturedEvent?.({
        trackId: hit.trackId,
        padId: hit.pad.id,
        velocity: hit.velocity,
        tick: hit.tick,
      });
      // MIDI output for drum tracks
      if (this.deps.midiNoteOn) {
        const track = this.tracksById(doc).get(hit.trackId);
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

    for (const event of noteEventsInWindow(pattern, base, windowStart, windowEnd)) {
      const track = this.tracksById(doc).get(event.trackId);
      if (!track || track.kind !== "instrument") continue;
      const when = timeAt(event.tick) + scheduleOffsetSec;
      if (!audible(when)) continue;
      // FL slide note: glide from the previous non-slide note's end
      const slideFrom = event.slideFrom ? { tick: event.slideFrom.tick, pitch: event.slideFrom.pitch } : undefined;
      // The glide ORIGIN time must come from the same tick→time map as `when`
      // (transport-anchored, scene-tempo aware) — deriving it from doc.bpm in
      // the engine desynced the glide after any pause/seek/tempo change.
      const slideFromWhen = slideFrom ? timeAt(slideFrom.tick) + scheduleOffsetSec : undefined;
      // Ratio p-lock: support per-note locks (event.note.locks) and legacy stepMeta[trackId][step] (Elektron-style)
      const step = Math.floor((event.tick - base) / STEP_TICKS);
      const metaLocks = (pattern as any).stepMeta?.[track.id]?.[step]?.locks as
        Partial<Record<import("../project-model/types").StepLockKey, number>> | undefined;
      const noteLocks = (event.note as any).locks as
        Partial<Record<import("../project-model/types").StepLockKey, number>> | undefined;
      const locks = noteLocks ?? metaLocks;
      this.deps.noteOn(
        track.id,
        event.note.pitch,
        event.note.velocity,
        when,
        event.note.duration * sptAt(event.tick),
        slideFrom?.tick,
        slideFrom?.pitch,
        locks,
        slideFromWhen,
      );
      // Passive capture ring (Ableton) — note events with pitch info
      this.deps.recordCapturedEvent?.({
        trackId: track.id,
        pitch: event.note.pitch,
        velocity: event.note.velocity,
        tick: event.tick,
        duration: event.note.duration * sptAt(event.tick),
      });
      // MIDI output for instrument tracks
      if (this.deps.midiNoteOn && track.midiOutput?.enabled) {
        const ch = (track.midiOutput.channel || 1) - 1;
        this.deps.midiNoteOn(track.id, ch, event.note.pitch, Math.round(event.note.velocity * 127), when);
        if (this.deps.midiNoteOff) {
          const noteOffWhen = when + event.note.duration * sptAt(event.tick);
          this.deps.midiNoteOff(track.id, ch, event.note.pitch, noteOffWhen);
        }
      }
      this.stats.scheduledEvents += 1;
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
    scheduleOffsetSec: number,
    timeAt?: (tick: number) => number,
  ): void {
    if (lane.points.length === 0) return;
    this.deps.applySceneAutomationLane?.(lane, windowStart, windowEnd, sceneStartTick, scheduleOffsetSec, timeAt);
  }
}

function sceneIntensityPointsForWindow(
  clips: { sceneId: string; startBar: number; lengthBars: number }[],
  scenesById: Map<string, ProjectDocument["scenes"][number]>,
  fromTick: number,
  toTick: number,
): Array<{ tick: number; value: number }> {
  const points: Array<{ tick: number; value: number }> = [];
  let cursor = fromTick;
  for (const clip of clips) {
    const clipStart = clip.startBar * BAR_TICKS;
    const clipEnd = clipStart + clip.lengthBars * BAR_TICKS;
    const from = Math.max(fromTick, clipStart);
    const to = Math.min(toTick, clipEnd);
    if (to <= from) continue;
    if (from > cursor) points.push({ tick: cursor, value: 0.7 }, { tick: from, value: 0.7 });
    const scene = scenesById.get(clip.sceneId);
    if (!scene) {
      points.push({ tick: from, value: 0.7 }, { tick: to, value: 0.7 });
    } else {
      points.push({ tick: from, value: computeSceneIntensity(scene, clipStart, from) });
      for (const curvePoint of scene.intensityCurve ?? []) {
        const tick = clipStart + curvePoint.offset;
        if (tick > from && tick < to) points.push({ tick, value: computeSceneIntensity(scene, clipStart, tick) });
      }
      points.push({ tick: to, value: computeSceneIntensity(scene, clipStart, to) });
    }
    cursor = Math.max(cursor, to);
  }
  if (points.length === 0) points.push({ tick: fromTick, value: 0.7 });
  else if (cursor < toTick) points.push({ tick: cursor, value: 0.7 }, { tick: toTick, value: 0.7 });
  return points;
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
