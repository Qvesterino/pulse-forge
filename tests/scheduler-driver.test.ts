import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioTickerSchedulerDriver, TICKER_WATCHDOG_MS } from "../src/scheduler/schedulerDriver";
import type { TickerNodeFactory } from "../src/scheduler/schedulerDriver";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";
import { createProjectFromTemplate } from "../src/project-model/templates";

/**
 * Wave 3 (RT robustness): the scheduler's tick source becomes an audio-
 * clock ticker worklet with a timer watchdog as the stall safety net.
 *
 * The driver seam is the contract: start() routes ticks through the driver
 * (no setInterval), stop() tears it down with playback, and a driver that
 * cannot get its worklet node degrades to pure-timer mode instead of ever
 * leaving the scheduler without a tick source.
 */

// ── Fake ticker node ────────────────────────────────────────────────────

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  postMessage() {}
  close() {
    this.closed = true;
  }
}

class FakeTickerNode {
  port = new FakePort();
  connections: unknown[] = [];
  disconnected = false;
  connect(destination: unknown) {
    this.connections.push(destination);
    return this;
  }
  disconnect() {
    this.disconnected = true;
  }
  /** Test hook: simulate the audio thread posting a tick. */
  emitTick(time: number): void {
    this.port.onmessage?.({ data: { type: "tick", time } });
  }
}

function fakeNodeFactory(node: FakeTickerNode): TickerNodeFactory {
  return () => node as unknown as ReturnType<TickerNodeFactory>;
}

type CtxStub = BaseAudioContext;

function fakeCtx(): CtxStub {
  const gains: { gain: { value: number }; connect: (d: unknown) => void; disconnect: () => void }[] = [];
  const ctx = {
    audioWorklet: {},
    createGain: () => {
      const g = {
        gain: { value: 1 },
        connect: (d: unknown) => {
          ctx.destinationCalls.push(d);
        },
        disconnect: () => {},
      };
      gains.push(g);
      return g;
    },
    destinationCalls: [] as unknown[],
    destination: { fake: true },
  };
  void gains;
  return ctx as unknown as CtxStub;
}

// ── Driver behaviour ────────────────────────────────────────────────────

describe("AudioTickerSchedulerDriver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDriver(node: FakeTickerNode, now: { t: number }) {
    const driver = new AudioTickerSchedulerDriver(fakeCtx(), fakeNodeFactory(node), TICKER_WATCHDOG_MS, () => now.t);
    return driver;
  }

  it("ticker messages drive the callback with the audio-clock time and count stats", () => {
    const node = new FakeTickerNode();
    const now = { t: 0 };
    const driver = makeDriver(node, now);
    const ticks: Array<number | null> = [];
    driver.start((t) => ticks.push(t));

    node.emitTick(1.0);
    node.emitTick(1.0213333333);
    expect(ticks).toEqual([1.0, 1.0213333333]);
    expect(driver.getStats().tickerTicks).toBe(2);
    expect(driver.kind).toBe("audio-ticker");
    // The silent node must be pulled: routed through a zero gain to the
    // destination, otherwise the audio thread never calls process().
    expect(node.connections.length).toBe(1);
    driver.stop();
  });

  it("non-tick and non-finite messages are dropped", () => {
    const node = new FakeTickerNode();
    const now = { t: 0 };
    const driver = makeDriver(node, now);
    const ticks: Array<number | null> = [];
    driver.start((t) => ticks.push(t));
    node.port.onmessage?.({ data: { type: "other", time: 1 } });
    node.port.onmessage?.({ data: { type: "tick", time: Number.NaN } });
    node.port.onmessage?.({ data: null });
    expect(ticks).toEqual([]);
    expect(driver.getStats().tickerTicks).toBe(0);
    driver.stop();
  });

  it("stalled ticker → watchdog bridges at watchdog cadence; resumed ticker silences it", () => {
    // Date.now() under vi.useFakeTimers co-advances with advanceTimersByTime,
    // so the driver's stall math runs against the same fake clock.
    const node = new FakeTickerNode();
    const driver = new AudioTickerSchedulerDriver(fakeCtx(), fakeNodeFactory(node), TICKER_WATCHDOG_MS, () =>
      Date.now(),
    );
    const ticks: Array<number | null> = [];
    driver.start((t) => ticks.push(t));

    node.emitTick(5.0);
    // Ticker stalls: the watchdog bridges playback at watchdog cadence (it
    // must never go silent — that is the safety-net contract).
    vi.advanceTimersByTime(TICKER_WATCHDOG_MS * 2 + 10);
    const stalledWatchdogTicks = driver.getStats().watchdogTicks;
    expect(stalledWatchdogTicks).toBeGreaterThanOrEqual(2);
    // Stalled ticks hand null (no fresh audio time), never a stale figure.
    expect(ticks[ticks.length - 1]).toBe(null);

    // Ticker resumes — the watchdog goes back to observing only, and no
    // further ticks arrive while the (fake) ticker stays silent.
    node.emitTick(5.1);
    const ticksAfterResume = ticks.length;
    const watchdogAfterResume = driver.getStats().watchdogTicks;
    vi.advanceTimersByTime(TICKER_WATCHDOG_MS + 10);
    expect(driver.getStats().watchdogTicks).toBe(watchdogAfterResume);
    expect(ticks.length).toBe(ticksAfterResume);
    driver.stop();
  });

  it("unusable worklet node → degrades to timer-fallback and still delivers ticks", () => {
    const now = { t: 0 };
    const driver = new AudioTickerSchedulerDriver(
      fakeCtx(),
      () => {
        throw new Error("rt-ticker-processor is not registered");
      },
      TICKER_WATCHDOG_MS,
      () => now.t,
    );
    const ticks: Array<number | null> = [];
    driver.start((t) => ticks.push(t));
    expect(driver.kind).toBe("timer-fallback");
    now.t = TICKER_WATCHDOG_MS + 1;
    vi.advanceTimersByTime(TICKER_WATCHDOG_MS + 10);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks.every((t) => t === null)).toBe(true);
    driver.stop();
  });

  it("double start is a no-op and stop releases the node", () => {
    const node = new FakeTickerNode();
    const now = { t: 0 };
    const driver = makeDriver(node, now);
    const ticks: Array<number | null> = [];
    driver.start((t) => ticks.push(t));
    driver.start((t) => ticks.push(t));
    node.emitTick(1);
    expect(ticks.length).toBe(1); // one message → one callback, not two
    driver.stop();
    expect(node.disconnected).toBe(true);
    expect(node.port.closed).toBe(false); // port left for GC with the node
    const before = ticks.length;
    node.emitTick(2); // handler detached — nothing flows after stop
    expect(ticks.length).toBe(before);
    now.t = TICKER_WATCHDOG_MS * 3;
    vi.advanceTimersByTime(TICKER_WATCHDOG_MS * 3 + 10);
    expect(ticks.length).toBe(before); // watchdog cleared too
  });
});

// ── Scheduler seam ──────────────────────────────────────────────────────

describe("Scheduler driver seam (Wave 3)", () => {
  class StubDriver {
    started = 0;
    stopped = 0;
    private cb: ((audioTime: number | null) => void) | null = null;
    readonly kind = "audio-ticker" as const;
    start(cb: (audioTime: number | null) => void): void {
      this.started++;
      this.cb = cb;
    }
    stop(): void {
      this.stopped++;
      this.cb = null;
    }
    fire(audioTime: number): void {
      this.cb?.(audioTime);
    }
    getStats() {
      return { kind: this.kind, tickerTicks: 0, watchdogTicks: 0, maxTickerGapMs: 0 };
    }
  }

  function makeScheduler() {
    const doc = createProjectFromTemplate("house");
    const drum = doc.tracks.find((t) => t.kind === "drum")!;
    const events: number[] = [];
    let audioTime = 10;
    const transport = new Transport({ now: () => audioTime }, doc.bpm);
    const scheduler = new Scheduler({
      getProject: () => doc,
      getTransport: () => transport,
      getAudioTime: () => audioTime,
      getMode: () => "pattern",
      trigger: (_trackId, _pad, when) => {
        events.push(when);
      },
      noteOn: () => {},
      applyAutomation: () => {},
      applyPatternLaunch: () => {},
    });
    return { doc, drum, events, transport, scheduler, bump: (dt: number) => (audioTime += dt) };
  }

  it("start() routes ticks through the driver — no interval, driver-driven windows", () => {
    vi.useFakeTimers();
    try {
      const h = makeScheduler();
      const driver = new StubDriver();
      h.scheduler.setDriver(driver);
      h.transport.play(0, { leadIn: false });
      h.scheduler.start();
      expect(driver.started).toBe(1);
      // The driver's ticks plan windows (events get scheduled as audio time
      // advances); the 25 ms interval must NOT be running (nothing fires
      // without driver.fire()).
      h.bump(0.2);
      driver.fire(10.2);
      expect(h.events.length).toBeGreaterThan(0);
      const countAfterDriverTicks = h.events.length;
      vi.advanceTimersByTime(200);
      expect(h.events.length).toBe(countAfterDriverTicks);
      h.scheduler.stop();
      expect(driver.stopped).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without a driver the scheduler keeps the legacy interval (existing behaviour)", () => {
    vi.useFakeTimers();
    try {
      const h = makeScheduler();
      h.transport.play(0, { leadIn: false });
      h.scheduler.start();
      h.bump(0.2);
      const before = h.events.length;
      vi.advanceTimersByTime(100);
      expect(h.events.length).toBeGreaterThan(before);
      h.scheduler.stop();
      h.bump(1);
      const atStop = h.events.length;
      vi.advanceTimersByTime(100);
      expect(h.events.length).toBe(atStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setDriver while running is refused (live scheduler keeps its driver)", () => {
    vi.useFakeTimers();
    try {
      const h = makeScheduler();
      const first = new StubDriver();
      const second = new StubDriver();
      h.scheduler.setDriver(first);
      h.transport.play(0, { leadIn: false });
      h.scheduler.start();
      h.scheduler.setDriver(second);
      h.bump(0.2);
      first.fire(10.2);
      expect(second.started).toBe(0);
      expect(first.stopped).toBe(0);
      h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
