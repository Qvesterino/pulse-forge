import type { DrumTrack, Pattern, PlayMode, ProjectDocument } from "../project-model/types";
import { BAR_TICKS, STEP_TICKS } from "../project-model/types";
import { drumHitsInWindow } from "../project-model/groove";
import { noteEventsInWindow } from "../project-model/events";
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
  ): void;
  applyAutomation(fromTick: number, toTick: number, relOf: (tick: number) => number, scheduleOffsetSec?: number): void;
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
  ): void;
  /** Commit a queued (quantized) pattern launch into the project model. */
  applyPatternLaunch(patternId: string): void;
  /** Called once per scheduler window with the absolute tick window. */
  onSongWindow?(fromTick: number, toTick: number, mode: PlayMode): void;
  /** Trigger a marker cue at the absolute project tick (asset id may be null). */
  triggerMarker?(assetId: string | null, when: number, trackId?: string): void;
  /** Update the live scene intensity signal (0..1). */
  setSceneIntensity?(intensity: number): void;
  /** Apply the active scene's tempo (null = follow the project tempo). */
  applySceneTempo?(bpm: number | null): void;
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

/**
 * Resolve a usable pattern for the scheduler when the doc's `activePatternId`
 * is stale (the pattern was deleted, the doc was replaced, or a future
 * schema version wrote an id the local code doesn't know). Returns the
 * first pattern in the doc, or `undefined` if the doc is empty.
 *
 * The scheduler uses this as a defensive fallback — never as a permanent
 * substitute for a healthy project. Callers should normalise the doc as
 * soon as practical (e.g. by writing the missing pattern back, or by
 * re-running the normaliser on the next doc change).
 */
function findUsablePattern(doc: ProjectDocument): Pattern | undefined {
  if (doc.patterns.length === 0) return undefined;
  const active = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (active) return active;
  console.warn(`[scheduler] active pattern ${doc.activePatternId} not in doc; falling back to ${doc.patterns[0].id}`);
  return doc.patterns[0];
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
    return STEP_TICKS * (findUsablePattern(doc)?.stepCount ?? 16);
  }
  return Math.max(0, ...doc.arrangement.clips.map((c) => (c.startBar + c.lengthBars) * BAR_TICKS));
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private windowStartTick = 0;
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
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
    this.tick();
  }

  stop(): void {
    // Playback ended — hand tempo control back to the project BPM.
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
      const position = transport.position;
      if (position >= loopEnd || position < loopStart) {
        transport.seek(loopStart);
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
    const windowStart = this.windowStartTick;
    if (windowEnd <= windowStart) {
      this.stats.windows += 1;
      return;
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
    if (this.lastContextState !== "running") {
      this.windowStartTick = Math.max(0, transport.position);
      this.lastContextState = "running";
    }
    try {
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

    // Pre-roll + count-in metronome: clicks fire on bar boundaries inside the
    // pre-roll region only. Content scheduling is untouched (starts on time).
    if (transport.preRollBars > 0 && this.deps.metronomeClick && windowStart < transport.anchorTickBeforePreRoll()) {
      const bar = transport.preRollBars * BAR_TICKS;
      for (
        let t = Math.ceil(windowStart / BAR_TICKS) * BAR_TICKS;
        t < Math.min(windowEnd, transport.anchorTickBeforePreRoll());
        t += BAR_TICKS
      ) {
        const when = transport.timeAtTick(t) + this.scheduleOffsetSec() + 0.005;
        if (!audibleClick(when, now)) continue;
        this.deps.metronomeClick(when, (t / bar) % 1 === 0);
      }
    }

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
      if (this.pendingLaunch && this.pendingLaunch.atTick <= windowStart) {
        this.deps.applyPatternLaunch(this.pendingLaunch.patternId);
        this.pendingLaunch = null;
        this.notify();
        currentDoc = this.deps.getProject();
      }
      // Defect 2.1 (recovery): if the active pattern id is stale, fall
      // back to a usable pattern instead of throwing. The pattern is
      // re-resolved on every window so a doc change heals the scheduler
      // as soon as the user fixes the project.
      const pattern = findUsablePattern(currentDoc);
      if (!pattern) {
        // Empty doc — nothing to schedule this window; advance the
        // window so the scheduler doesn't get stuck on a phantom gap.
        this.windowStartTick = windowEnd;
        this.stats.lastHorizonTick = windowEnd;
        this.stats.windows += 1;
        return;
      }
      const patternTicks = STEP_TICKS * pattern.stepCount;
      const pending = this.pendingLaunch;
      const boundary = pending && pending.atTick > windowStart && pending.atTick <= windowEnd ? pending.atTick : null;

      this.schedulePatternWindow(pattern, 0, windowStart, boundary ?? windowEnd);
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
      const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
      // Defect A05.D1 (beat engine stress audit): every song-mode
      // window used to look up scenes and patterns via
      // `doc.scenes.find((sc) => sc.id === clip.sceneId)` inside the
      // per-clip loop. With 50+ clips and 5–10 scenes that becomes
      // O(clips × scenes) per window, i.e. per 25 ms tick. Build the
      // id → entity Maps once per window for O(1) lookup.
      const scenesById = new Map(doc.scenes.map((s) => [s.id, s] as const));
      const patternsById = new Map(doc.patterns.map((p) => [p.id, p] as const));
      // Find the active scene (whose clip contains the playhead) for intensity
      // computation and the marker-firing loop.
      let activeScene: (typeof doc.scenes)[number] | null = null;
      let activeClipStart = 0;
      for (const clip of clips) {
        const clipStart = clip.startBar * BAR_TICKS;
        const clipEnd = clipStart + clip.lengthBars * BAR_TICKS;
        if (windowStart >= clipStart && windowStart < clipEnd) {
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
      // Scene tempo: while inside a clip whose scene pins a BPM, the
      // transport runs there (guarded — only actual changes re-anchor).
      const wantedTempo = activeScene?.bpm ?? null;
      this.applyTempo(wantedTempo);
      for (const clip of clips) {
        const clipStart = clip.startBar * BAR_TICKS;
        const clipEnd = clipStart + clip.lengthBars * BAR_TICKS;
        const s = Math.max(windowStart, clipStart);
        const e = Math.min(windowEnd, clipEnd);
        if (e <= s) continue;
        const scene = scenesById.get(clip.sceneId);
        if (!scene) continue;
        const pattern = patternsById.get(scene.patternId);
        if (!pattern) continue;
        const patternTicks = STEP_TICKS * pattern.stepCount;
        this.schedulePatternWindow(pattern, clipStart, s, e);
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
        if (marker.tick < windowStart || marker.tick > windowEnd) continue;
        if (this.firedMarkerIds.has(marker.id)) continue;
        this.firedMarkerIds.add(marker.id);
        const assetId = mapMarkerTypeToAsset(marker.type);
        const when = transport.timeAtTick(marker.tick) + this.scheduleOffsetSec() + 0.005;
        this.deps.triggerMarker?.(assetId, when, marker.linkedClipId);
      }
      // Scene automation: invoke applySceneAutomation per active clip window.
      if (activeScene) {
        for (const lane of doc.sceneAutomation) {
          if (lane.sceneId !== activeScene.id) continue;
          this.applySceneAutomation(lane, windowStart, windowEnd, activeClipStart, transport, this.scheduleOffsetSec());
        }
      }
      // AudioClips: fire any clip whose start tick falls inside the current window
      if (this.deps.triggerAudioClip && doc.arrangement.audioClips) {
        for (const clip of doc.arrangement.audioClips) {
          const clipStart = clip.startBar * BAR_TICKS;
          if (clipStart < windowStart || clipStart >= windowEnd) continue;
          const when = transport.timeAtTick(clipStart) + this.scheduleOffsetSec() + 0.005;
          const durationSec = clip.lengthBars * BAR_TICKS * transport.secondsPerTick;
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
          windowStart,
          windowEnd,
          (tick) => mod(tick - base, patternTicks),
          this.scheduleOffsetSec(),
        );
      }
    }

    // Track modulators share the window — boundaries map through the transport
    // clock the same way marker cues do, so live and offline grids agree.
    if (this.deps.applyModulators) {
      const transport = this.deps.getTransport();
      const offsetSec = this.scheduleOffsetSec() + 0.005;
      this.deps.applyModulators(windowStart, windowEnd, (tick) => transport.timeAtTick(tick) + offsetSec);
    }

    // Poll envFollower modulators targeting FX/inst params (control rate).
    this.deps.applyEnvFollowers?.();
  }

  private schedulePatternWindow(pattern: Pattern, base: number, windowStart: number, windowEnd: number): void {
    const transport = this.deps.getTransport();
    const doc = this.deps.getProject();
    const now = this.deps.getAudioTime();
    const scheduleOffsetSec = this.scheduleOffsetSec();
    const timeAt = (tick: number) => transport.timeAtTick(tick);
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

    for (const event of noteEventsInWindow(pattern, base, windowStart, windowEnd)) {
      const track = doc.tracks.find((candidate) => candidate.id === event.trackId);
      if (!track || track.kind !== "instrument") continue;
      const when = timeAt(event.tick) + scheduleOffsetSec;
      if (!audible(when)) continue;
      // FL slide note: glide from the previous non-slide note's end
      const slideFrom = event.slideFrom ? { tick: event.slideFrom.tick, pitch: event.slideFrom.pitch } : undefined;
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
        event.note.duration * transport.secondsPerTick,
        slideFrom?.tick,
        slideFrom?.pitch,
        locks,
      );
      // Passive capture ring (Ableton) — note events with pitch info
      this.deps.recordCapturedEvent?.({
        trackId: track.id,
        pitch: event.note.pitch,
        velocity: event.note.velocity,
        tick: event.tick,
        duration: event.note.duration * transport.secondsPerTick,
      });
      // MIDI output for instrument tracks
      if (this.deps.midiNoteOn && track.midiOutput?.enabled) {
        const ch = (track.midiOutput.channel || 1) - 1;
        this.deps.midiNoteOn(track.id, ch, event.note.pitch, Math.round(event.note.velocity * 127), when);
        if (this.deps.midiNoteOff) {
          const noteOffWhen = when + event.note.duration * transport.secondsPerTick;
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
  ): void {
    if (lane.points.length === 0) return;
    this.deps.applySceneAutomationLane?.(lane, windowStart, windowEnd, sceneStartTick, scheduleOffsetSec);
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
