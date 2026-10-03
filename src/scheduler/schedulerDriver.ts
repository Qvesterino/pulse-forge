/**
 * Scheduler drivers — Wave 3 (RT robustness).
 *
 * The scheduler planned its 120 ms lookahead windows from a 25 ms
 * setInterval: a main-thread timer that inherits every bit of UI jank and
 * browser timer clamping. A late tick erodes the lookahead and events get
 * scheduled late — audible during exactly the moments a DAW is busiest.
 *
 * `AudioTickerSchedulerDriver` is the hybrid replacement:
 *
 *   audio-clock ticker (primary)      timer watchdog (safety net)
 *   ─────────────────────────────     ───────────────────────────
 *   an `rt-ticker-processor` work-    a plain setInterval at the legacy
 *   let node pulled by the AUDIO      cadence that only fires when the
 *   DEVICE every `intervalBlocks`     ticker stalls (suspended context,
 *   quanta; its messages carry the    dead audio thread, missing work-
 *   audio clock's timestamps          let module) — the union of both
 *                                     sources never goes silent
 *
 * The ticker's cadence and timestamps follow the audio clock instead of
 * wall-clock timer coalescing, and a stalled main thread turns into a
 * burst of queued messages (absorbed by the scheduler's plan-from-
 * transport-position tick) rather than a clamped timer. Construction or
 * registration failures degrade to pure-timer mode — the driver NEVER
 * becomes the reason playback has no scheduler.
 */

export type SchedulerDriverKind = "audio-ticker" | "timer-fallback";

export interface SchedulerDriver {
  /** Begin delivering ticks. A second start() on a running driver is a no-op. */
  start(onTick: (audioTime: number | null) => void): void;
  /** Stop delivering ticks and release the audio nodes. Idempotent. */
  stop(): void;
  readonly kind: SchedulerDriverKind;
  getStats(): SchedulerDriverStats;
}

export interface SchedulerDriverStats {
  kind: SchedulerDriverKind;
  /** Ticks delivered from the audio-clock ticker. */
  tickerTicks: number;
  /** Ticks delivered by the stall watchdog. */
  watchdogTicks: number;
  /** Largest observed gap between ticker messages, in ms (0 until two ticks). */
  maxTickerGapMs: number;
}

interface TickerPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(msg: unknown): void;
  close(): void;
}

interface TickerNode {
  port: TickerPort;
  connect(destination: AudioNode): TickerNode;
  disconnect(): void;
}

/** Dependency seam for tests: the real AudioWorkletNode constructor. */
export type TickerNodeFactory = () => TickerNode;

export const TICKER_INTERVAL_BLOCKS = 8; // ≈ 21.3 ms @48k, inside the 120 ms lookahead
export const TICKER_WATCHDOG_MS = 90; // > 3 missed ticker cadences before the timer steps in

export class AudioTickerSchedulerDriver implements SchedulerDriver {
  private driverKind: SchedulerDriverKind = "audio-ticker";
  private onTick: ((audioTime: number | null) => void) | null = null;
  private node: TickerNode | null = null;
  private mute: GainNode | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastTickerAt = 0;
  private stats: SchedulerDriverStats = {
    kind: "audio-ticker",
    tickerTicks: 0,
    watchdogTicks: 0,
    maxTickerGapMs: 0,
  };

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly createNode: TickerNodeFactory,
    private readonly watchdogMs: number = TICKER_WATCHDOG_MS,
    private readonly now: () => number = () => performance.now(),
    /**
     * Managed gain factory (invariant #7): the mute sink is created ON THE
     * ENGINE's context path and handed in — the scheduler never calls node
     * factories itself. Null factory (or a null gain) degrades to the timer
     * fallback, same as a missing worklet module.
     */
    private readonly createMuteGain: (() => GainNode | null) | null = null,
  ) {}

  start(onTick: (audioTime: number | null) => void): void {
    if (this.onTick) return;
    this.onTick = onTick;
    try {
      this.node = this.createNode();
      this.node.port.onmessage = (event: { data: unknown }) => {
        const msg = event.data as { type?: string; time?: number } | null;
        if (!msg || msg.type !== "tick" || typeof msg.time !== "number" || !Number.isFinite(msg.time)) return;
        const at = this.now();
        if (this.lastTickerAt > 0) {
          const gap = at - this.lastTickerAt;
          if (gap > this.stats.maxTickerGapMs) this.stats.maxTickerGapMs = gap;
        }
        this.lastTickerAt = at;
        this.stats.tickerTicks++;
        this.onTick?.(msg.time);
      };
      // The node must be pulled by the graph to process at all — route its
      // silent output through the engine-managed zero gain into the
      // destination. No managed gain → degrade, a pulled node is useless.
      this.mute = this.createMuteGain ? this.createMuteGain() : null;
      if (!this.mute) throw new Error("no managed gain available");
      this.mute.gain.value = 0;
      this.node.connect(this.mute);
      this.mute.connect(this.ctx.destination);
    } catch {
      // Missing worklet module / no AudioWorklet on this context: degrade to
      // pure timer mode. The scheduler must never lack a driver because of us.
      this.driverKind = "timer-fallback";
      this.stats.kind = "timer-fallback";
    }
    // Watchdog arms in BOTH modes: in audio-ticker mode it only fires when
    // the ticker stalls; in timer-fallback mode it IS the tick source.
    this.lastTickerAt = this.now();
    this.watchdog = setInterval(() => {
      if (!this.onTick) return;
      if (this.driverKind === "audio-ticker" && this.now() - this.lastTickerAt < this.watchdogMs) return;
      this.stats.watchdogTicks++;
      // A stalled ticker has no fresh audio time — hand null (the scheduler
      // reads ctx.currentTime through deps anyway) rather than a stale one.
      this.onTick(null);
    }, this.watchdogMs);
  }

  get kind(): SchedulerDriverKind {
    return this.driverKind;
  }

  stop(): void {
    this.onTick = null;
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.node) {
      this.node.port.onmessage = null;
      try {
        this.node.disconnect();
      } catch {
        /* already torn down with a closed context */
      }
      this.node = null;
    }
    if (this.mute) {
      try {
        this.mute.disconnect();
      } catch {
        /* already torn down with a closed context */
      }
      this.mute = null;
    }
  }

  getStats(): SchedulerDriverStats {
    return { ...this.stats };
  }
}

/** Factory used by services: returns null when there is no usable context.
 * `opts.createGain` is the engine-managed mute-gain factory (invariant #7) —
 * without it the driver degrades to the timer fallback. */
export function createSchedulerDriver(
  ctx: BaseAudioContext | null | undefined,
  opts?: { createGain?: () => GainNode | null },
): AudioTickerSchedulerDriver | null {
  if (!ctx || !ctx.audioWorklet) return null;
  return new AudioTickerSchedulerDriver(
    ctx,
    () => {
      const node = new AudioWorkletNode(ctx, "rt-ticker-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { intervalBlocks: TICKER_INTERVAL_BLOCKS },
      });
      // Satisfy the structural TickerNode contract (AudioWorkletNode.connect
      // returns the destination; the seam type chains like the real one).
      return node as unknown as TickerNode;
    },
    TICKER_WATCHDOG_MS,
    undefined,
    opts?.createGain ?? null,
  );
}
