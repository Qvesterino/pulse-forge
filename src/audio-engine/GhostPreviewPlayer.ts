import { Transport } from "../transport/Transport";
import type { AudioEngine } from "./AudioEngine";
import type { SampleBank } from "../sample-library/factory";
import type { DrumPad, Pattern, ProjectDocument } from "../project-model/types";
import { BAR_TICKS, PPQ } from "../project-model/types";
import { drumHitsInWindow } from "../project-model/groove";
import { noteEventsInWindow } from "../project-model/events";

export class GhostPreviewPlayer {
  private transport: Transport | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private windowStart = 0;
  private ghostDoc: ProjectDocument | null = null;
  private pattern: Pattern | null = null;
  private playing = false;
  private loopTicks = BAR_TICKS;

  constructor(
    private engine: AudioEngine,
    _bank: SampleBank,
    private getLiveDoc: () => ProjectDocument,
  ) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  play(pattern: Pattern, opts?: { loopBars?: number; kitAssignments?: Map<string, Partial<DrumPad>> }): void {
    this.stop();
    const live = this.getLiveDoc();
    let tracks = live.tracks;
    if (opts?.kitAssignments && opts.kitAssignments.size > 0) {
      tracks = live.tracks.map((t) => {
        if (t.kind !== "drum") return t;
        const pads = t.pads.map((p) => {
          const patch = opts.kitAssignments!.get(p.id);
          if (!patch) return p;
          return {
            ...p,
            assetId: patch.assetId !== undefined ? patch.assetId : p.assetId,
            synth: patch.synth !== undefined ? patch.synth : p.synth,
            gain: patch.gain !== undefined ? patch.gain! : p.gain,
            pan: patch.pan !== undefined ? patch.pan! : p.pan,
            chokeGroup: patch.chokeGroup !== undefined ? patch.chokeGroup : p.chokeGroup,
          };
        });
        return { ...t, pads };
      });
    }
    this.ghostDoc = {
      ...live,
      tracks,
      patterns: [...live.patterns, pattern],
      activePatternId: pattern.id,
    } as ProjectDocument;
    this.pattern = pattern;
    this.loopTicks = (opts?.loopBars ?? 1) * BAR_TICKS;
    // Ghost transport runs off engine.currentTime
    this.transport = new Transport({ now: () => this.engine.currentTime }, live.bpm);
    this.transport.seek(0);
    this.transport.play();
    const pos = ((this.transport.position % PPQ) + PPQ) % PPQ;
    const beatPhase = pos / PPQ;
    // Audit 12 D5: ensureContext BEFORE mutating player state — if it
    // throws, isPlaying() stayed true with no timer (DiceTray lied) and all
    // tempo-synced FX were re-phased for a preview that never sounds.
    this.engine.ensureContext();
    this.engine.transportStarted(this.engine.currentTime, beatPhase, this.transport.position / PPQ);
    this.windowStart = 0;
    this.playing = true;
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.transport) this.transport.pause();
    this.playing = false;
    this.ghostDoc = null;
    this.pattern = null;
    this.windowStart = 0;
  }

  private tick(): void {
    if (!this.playing || !this.ghostDoc || !this.pattern || !this.transport) return;
    const now = this.engine.currentTime;
    const horizon = now + 0.12;
    // Handle loop wrap
    let ws = this.windowStart;
    let we = this.transport.tickAt(horizon);
    // Loop logic: if we exceeds loopTicks, wrap
    if (we > this.loopTicks) {
      // Schedule up to loop end, then seek and continue
      const firstEnd = this.loopTicks;
      this.scheduleWindow(ws, firstEnd);
      this.transport.seek(0);
      this.windowStart = 0;
      ws = 0;
      we = this.transport.tickAt(horizon);
      // If still beyond loop, clamp
      if (we > this.loopTicks) we = this.loopTicks;
    }
    if (we <= ws) return;
    this.scheduleWindow(ws, we);
    this.windowStart = we;
  }

  private scheduleWindow(ws: number, we: number): void {
    if (!this.ghostDoc || !this.pattern || !this.transport) return;
    const now = this.engine.currentTime;
    const timeAt = (tick: number) => this.transport!.timeAtTick(tick);
    for (const hit of drumHitsInWindow(this.ghostDoc, this.pattern, 0, ws, we)) {
      const when = timeAt(hit.tick) + 0.005;
      if (when < now - 0.002) continue;
      this.engine.trigger(hit.trackId, hit.pad, when, hit.velocity, hit.locks);
    }
    for (const ev of noteEventsInWindow(this.pattern, 0, ws, we)) {
      const when = timeAt(ev.tick) + 0.005;
      if (when < now - 0.002) continue;
      const durSec = ev.note.duration * (60 / (this.ghostDoc!.bpm * PPQ));
      this.engine.noteOn(
        ev.trackId,
        ev.note.pitch,
        ev.note.velocity,
        when,
        durSec,
        ev.slideFrom?.tick,
        ev.slideFrom?.pitch,
      );
    }
  }
}
