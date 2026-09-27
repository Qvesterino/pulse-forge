import { describe, expect, it } from "vitest";
import { parseChaseIntent, parseLooseTimecode } from "../src/intent/chaseIntent";
import { Transport } from "../src/transport/Transport";
import { MtcChaser } from "../src/midi/smpte";

/**
 * Chase intent verb (ADR 0017 wave 2 intent surface) — "chase my timecode",
 * "sleduj timecode", "go to 1:23" route to the chase feature instead of the
 * generation pipeline. Detection is deaccented + case-insensitive; explicit
 * go/jump verbs win over arming phrases; non-chase sentences return null so
 * the normal pipeline still runs.
 */

describe("chase intent detection", () => {
  it("detects arming in EN and SK, with and without diacritics", () => {
    expect(parseChaseIntent("chase my timecode")).toEqual({ kind: "arm" });
    expect(parseChaseIntent("Chase the timecode please")).toEqual({ kind: "arm" });
    expect(parseChaseIntent("sync to timecode")).toEqual({ kind: "arm" });
    expect(parseChaseIntent("follow my MTC")).toEqual({ kind: "arm" });
    expect(parseChaseIntent("sleduj timecode")).toEqual({ kind: "arm" });
    expect(parseChaseIntent("Sleduj timecode")).toEqual({ kind: "arm" });
    expect(parseChaseIntent("synchronizuj sa s timecodom")).toEqual({ kind: "arm" });
    expect(parseChaseIntent("chase")).toEqual({ kind: "arm" }); // the feature's own name
    expect(parseChaseIntent("chase mode")).toEqual({ kind: "arm" });
  });

  it("detects disarming in EN and SK", () => {
    expect(parseChaseIntent("stop chasing")).toEqual({ kind: "disarm" });
    expect(parseChaseIntent("disarm timecode chase")).toEqual({ kind: "disarm" });
    expect(parseChaseIntent("turn off timecode sync")).toEqual({ kind: "disarm" });
    expect(parseChaseIntent("prestan sledovat timecode")).toEqual({ kind: "disarm" });
    expect(parseChaseIntent("vypni synchronizaciu s timecodom")).toEqual({ kind: "disarm" });
  });

  it("detects seeks: explicit go/jump verbs win over arming phrases", () => {
    const seek = parseChaseIntent("go to 1:23");
    expect(seek).toEqual({
      kind: "seek",
      tc: expect.objectContaining({ hours: 0, minutes: 1, seconds: 23, frames: 0 }),
    });

    expect(parseChaseIntent("jump to 01:23:12:15")).toEqual({
      kind: "seek",
      tc: expect.objectContaining({ hours: 1, minutes: 23, seconds: 12, frames: 15 }),
    });
    expect(parseChaseIntent("chod na timecode 0:30")).toEqual({
      kind: "seek",
      tc: expect.objectContaining({ minutes: 0, seconds: 30 }),
    });
    expect(parseChaseIntent("skoc na 2:00:00")).toEqual({
      kind: "seek",
      tc: expect.objectContaining({ hours: 2, minutes: 0, seconds: 0 }),
    });
    expect(parseChaseIntent("seek to 01:23:12:15")).toEqual({
      kind: "seek",
      tc: expect.objectContaining({ seconds: 12, frames: 15 }),
    });
  });

  it("returns null for non-chase sentences (generation keeps working)", () => {
    expect(parseChaseIntent("dark wobbly drill")).toBeNull();
    expect(parseChaseIntent("make the bass deeper")).toBeNull();
    expect(parseChaseIntent("16-bar intro with a vinyl break")).toBeNull();
    expect(parseChaseIntent("")).toBeNull();
    expect(parseChaseIntent("go grab coffee")).toBeNull(); // go-verb but no timecode token
  });
});

describe("loose timecode parsing", () => {
  it("reads mm:ss, hh:mm:ss and +frames forms", () => {
    expect(parseLooseTimecode("1:23")).toMatchObject({ hours: 0, minutes: 1, seconds: 23, frames: 0 });
    expect(parseLooseTimecode("01:23:12")).toMatchObject({ hours: 1, minutes: 23, seconds: 12, frames: 0 });
    expect(parseLooseTimecode("01:23:12:15")).toMatchObject({ hours: 1, minutes: 23, seconds: 12, frames: 15 });
    expect(parseLooseTimecode("99:99")).toBeNull(); // out of range
    expect(parseLooseTimecode("garbage")).toBeNull();
  });
});

describe("chaser seek verb (transport integration)", () => {
  it("seeks to the mapped position at the current BPM, armed or not", () => {
    let now = 500;
    const transport = new Transport({ now: () => now }, 120); // 960 ticks per second
    const chaser = new MtcChaser(transport, () => 120);

    expect(chaser.seekToTimecode({ hours: 0, minutes: 1, seconds: 0, frames: 0, rate: 25 })).toBe(true);
    expect(transport.position).toBe(57600);
    expect(chaser.armed).toBe(false); // seek does not arm
    expect(transport.playing).toBe(false); // and does not autoplay
  });

  it("rejects garbage timecodes without touching the transport", () => {
    let now = 500;
    const transport = new Transport({ now: () => now }, 120);
    const chaser = new MtcChaser(transport, () => 120);
    expect(chaser.seekToTimecode({ hours: 99, minutes: 0, seconds: 0, frames: 0, rate: 25 })).toBe(false);
    expect(transport.position).toBe(0);
  });
});
