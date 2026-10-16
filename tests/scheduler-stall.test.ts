import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { getDrumTrack } from "../src/project-model/types";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";

/**
 * AUDIT 03 RE-RUN (2026-10-06) — main-thread stall behavior.
 *
 * Wave 3's driver claims "a stalled main thread turns into a burst of
 * queued messages absorbed by the scheduler's plan-from-transport-position
 * tick". This suite pins the absorption contract end to end. The hypothesis
 * that a long stall would fire the missed backlog as a simultaneous burst
 * was FALSIFIED: scheduleWindow filters past-time events at the source
 * (`const audible = (when) => when >= now - 0.002; if (!audible(when))
 * continue;` — Scheduler.ts drum/note loops, plus audibleClick for the
 * metronome), so gap content is dropped, never burst. These specs pin that
 * healthy behavior so a future refactor cannot silently reintroduce the
 * burst, double-fires, or off-time events:
 *
 *   1. blackout LONGER than the horizon: zero past-time events, playback
 *      continues from the live playhead, metronome does not back-fill;
 *   2. a burst of queued post-stall ticker ticks is duplicate-free;
 *   3. a blackout SHORTER than the horizon is transparent: events keep
 *      their EXACT musical times (not clamped to "now").
 */

function makeStallHarness(bpm = 120) {
  const doc = createDefaultProject();
  const kick = getDrumTrack(doc).pads[0]!;
  // Dense pattern: kick on EVERY step (120 ticks apart) so the narrow
  // post-jump windows always contain content (the default four-on-the-floor
  // leaves most slots empty).
  const rows = doc.patterns[0]!.rows[kick.id]!;
  for (let step = 0; step < rows.length; step++) rows[step] = 1;
  const events: Array<{ when: number; velocity: number }> = [];
  const clicks: Array<{ when: number; downbeat: boolean }> = [];
  let audioTime = 10;
  const transport = new Transport({ now: () => audioTime }, bpm);
  const scheduler = new Scheduler({
    getProject: () => doc,
    getTransport: () => transport,
    getAudioTime: () => audioTime,
    getMode: () => "pattern",
    trigger: (_trackId: string, _pad: unknown, when: number, velocity: number) => {
      events.push({ when, velocity });
    },
    noteOn: () => {},
    metronomeClick: (when: number, downbeat: boolean) => {
      clicks.push({ when, downbeat });
    },
    applyAutomation: () => {},
    applyPatternLaunch: () => {},
  });
  return { doc, kick, events, clicks, scheduler, transport, at: (t: number) => (audioTime = t), now: () => audioTime };
}

// 120 bpm, PPQ 480: 960 ticks per second.
const TICKS_PER_SEC = 960;
const slotWhen = (audioAnchor: number, tick: number) => audioAnchor + tick / TICKS_PER_SEC;

describe("scheduler blackout handling (audit 03 re-run)", () => {
  it("a blackout LONGER than the horizon drops the backlog: zero past-time events, playback continues", () => {
    const h = makeStallHarness();
    h.transport.play(0);
    h.at(10);
    h.scheduler.tick(); // window [0, 115.2 ticks) — normal lookahead
    const eventsBefore = h.events.length;

    // 1-second main-thread stall: the audio clock runs on while the
    // scheduler cannot (queued ticker messages deliver only after it ends).
    h.at(11);
    h.scheduler.tick();

    // Nothing may be scheduled in the past — the backlog is dropped, not burst.
    const past = h.events.slice(eventsBefore).filter((e) => e.when < 11 - 1e-6);
    expect(past, `past-time events scheduled: ${JSON.stringify(past.slice(0, 4))}`).toEqual([]);
    // …and playback continues into the future from the live playhead.
    const future = h.events.slice(eventsBefore).filter((e) => e.when >= 11);
    expect(future.length).toBeGreaterThan(0);
    // The metronome cursor cannot back-fill the gap either.
    expect(h.clicks.every((c) => c.when >= 11 - 0.002)).toBe(true);
    h.scheduler.stop();
  });

  it("a burst of queued post-stall ticks is duplicate-free (each slot fires once)", () => {
    const h = makeStallHarness();
    h.transport.play(0);
    h.at(10);
    h.scheduler.tick();

    h.at(11);
    // ~24 queued ticker messages deliver back-to-back after the stall ends.
    for (let i = 0; i < 24; i++) {
      h.at(11 + i * 0.001);
      h.scheduler.tick();
    }
    const seen = new Set<string>();
    for (const e of h.events) {
      const key = `${e.when.toFixed(4)}@${e.velocity}`;
      expect(seen.has(key), `duplicate scheduled event ${key}`).toBe(false);
      seen.add(key);
    }
    h.scheduler.stop();
  });

  it("a blackout SHORTER than the horizon is transparent: events keep their exact musical times", () => {
    const h = makeStallHarness();
    h.transport.play(0);
    h.at(10);
    h.scheduler.tick(); // window [0, 115.2 ticks) — covers slot 0 (tick 0) only
    const eventsBefore = h.events.length;

    // 60 ms stall — well inside the 120 ms horizon. The next window
    // [115.2, 172.8) contains slot 1 (tick 120 → when 10.125, still future).
    h.at(10.06);
    h.scheduler.tick();
    const scheduled = h.events.slice(eventsBefore);
    expect(scheduled.length).toBeGreaterThan(0);
    for (const e of scheduled) {
      // On time: `when` equals the slot's exact musical time — the stall
      // introduced NO timing error (windows are anchored to the audio
      // clock through the transport, not to wall-clock timer drift).
      const slotTick = Math.round((e.when - 10) * TICKS_PER_SEC);
      expect(Math.abs(e.when - slotWhen(10, slotTick))).toBeLessThan(1e-6);
      expect(e.when).toBeGreaterThanOrEqual(10.06);
    }
    h.scheduler.stop();
  });
});
