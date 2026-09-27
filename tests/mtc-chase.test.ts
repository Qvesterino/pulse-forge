import { describe, expect, it } from "vitest";
import { Transport } from "../src/transport/Transport";
import { CHASE_MIN_INTERVAL_MS, MtcChaser, type SmpTeTimecode } from "../src/midi/smpte";

/**
 * ADR 0017 wave 2 — transport chase over MIDI Timecode.
 *
 * Mapping contract: TC seconds → ticks at the CURRENT project BPM with
 * TC 00:00:00:00 = tick 0 (120 BPM → one TC second = 960 ticks). Policy
 * contract: stopped, every frame moves the pause position; playing, only
 * meaningful drift re-syncs and throttles — except full frames, which are
 * explicit jumps and chase immediately. Disarmed, nothing moves.
 */

const tc = (hours: number, minutes = 0, seconds = 0, frames = 0): SmpTeTimecode => ({
  hours,
  minutes,
  seconds,
  frames,
  rate: 25,
});

/** Transport with a hand-advanced clock so "playing" positions are exact. */
function chasedTransport(bpm: number, opts: { armed?: boolean } = {}) {
  let now = 1000; // clock seconds
  const transport = new Transport({ now: () => now }, bpm);
  const chaser = new MtcChaser(transport, () => bpm);
  chaser.armed = opts.armed ?? true;
  const advance = (seconds: number) => {
    now += seconds;
  };
  return { transport, chaser, advance };
}

describe("MtcChaser policy (ADR 0017 wave 2)", () => {
  it("disarmed: nothing moves", () => {
    const { transport, chaser } = chasedTransport(120, { armed: false });
    expect(chaser.onFrame(tc(0, 0, 10))).toBe("idle");
    expect(transport.position).toBe(0);
  });

  it("stopped: a full frame moves the pause position; play resumes there", () => {
    const { transport, chaser } = chasedTransport(120);
    expect(chaser.onFrame(tc(0, 1, 0), { immediate: true })).toBe("chased");
    // 60 s at 120 BPM = 960 ticks/s → 57 600 ticks.
    expect(transport.position).toBe(57600);
    transport.play();
    expect(transport.playing).toBe(true);
    expect(transport.position).toBeGreaterThanOrEqual(57600);
  });

  it("maps TC seconds through the CURRENT project BPM", () => {
    const { transport, chaser } = chasedTransport(60); // 60 BPM → 480 ticks/s
    chaser.onFrame(tc(0, 0, 3), { immediate: true });
    expect(transport.position).toBe(3 * 480);
  });

  it("garbage positions are skipped and never poison the transport", () => {
    const { transport, chaser } = chasedTransport(120);
    const junk = { hours: -1, minutes: 0, seconds: 0, frames: 0, rate: 25 } as SmpTeTimecode;
    expect(chaser.onFrame(junk)).toBe("skipped");
    expect(transport.position).toBe(0);
  });

  it("playing: meaningful drift re-syncs onto the received timecode", () => {
    const { transport, chaser, advance } = chasedTransport(120);
    transport.play(0);
    advance(100); // we are at 100 s worth of ticks…
    expect(chaser.onFrame(tc(0, 0, 3), { immediate: true })).toBe("chased"); // …TC says 3 s
    expect(Math.abs(transport.position / 960 - 3)).toBeLessThan(1);
  });

  it("playing: small drift does not jitter the playhead", () => {
    const { transport, chaser, advance } = chasedTransport(120);
    transport.play(0);
    advance(100);
    expect(chaser.onFrame(tc(0, 1, 39, 15), { immediate: true })).toBe("skipped"); // 99.6 s: within 0.5 s
    expect(Math.abs(transport.position / 960 - 100)).toBeLessThan(1);
  });

  it("playing: drift re-syncs are throttled except full-frame jumps", () => {
    const { transport, chaser, advance } = chasedTransport(120);
    transport.play(0);
    advance(100);
    const wallStart = 50_000;
    // Quarter-frame drift: first re-sync chases, an immediate second one is
    // throttled by CHASE_MIN_INTERVAL_MS…
    expect(chaser.onFrame(tc(0, 0, 3), { wallNow: wallStart })).toBe("chased");
    expect(chaser.onFrame(tc(0, 0, 30), { wallNow: wallStart + 100 })).toBe("skipped");
    // …but a full frame is an explicit jump and always chases.
    expect(chaser.onFrame(tc(0, 0, 30), { immediate: true, wallNow: wallStart + 100 })).toBe("chased");
    // …and once the interval passes, drift re-sync resumes.
    expect(chaser.onFrame(tc(0, 0, 3), { wallNow: wallStart + 100 + CHASE_MIN_INTERVAL_MS })).toBe("chased");
  });
});
