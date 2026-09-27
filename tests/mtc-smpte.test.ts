import { describe, expect, it } from "vitest";
import {
  MtcDecoder,
  formatSmpTe,
  isSmpTeTimecode,
  mtcRateCodeToRate,
  parseSmpTe,
  smpteToSamples,
  smpteToSeconds,
  secondsToSmpTe,
  samplesToSmpTe,
  type SmpTeTimecode,
} from "../src/midi/smpte";

/**
 * SMPTE Wave 1 — MIDI Timecode decode + timecode math.
 *
 * Pinned against spec anchors: one hour of 29.97 drop-frame timecode is
 * EXACTLY 3600.0 s (107892 real frames), minutes divisible by ten keep their
 * frames 0 and 1, and a garbled quarter-frame stream must never fabricate a
 * position.
 */

const tc = (over: Partial<SmpTeTimecode>): SmpTeTimecode => ({
  hours: 1,
  minutes: 2,
  seconds: 3,
  frames: 4,
  rate: 25,
  ...over,
});

describe("SMPTE timecode math", () => {
  it("validates bounds at the boundary", () => {
    expect(isSmpTeTimecode(tc({}))).toBe(true);
    expect(isSmpTeTimecode(tc({ hours: 24 }))).toBe(false);
    expect(isSmpTeTimecode(tc({ minutes: 60 }))).toBe(false);
    expect(isSmpTeTimecode(tc({ frames: 25 }))).toBe(false); // 25 fps has frames 0..24
    expect(isSmpTeTimecode(tc({ rate: 2997, frames: 30 }))).toBe(false);
    expect(isSmpTeTimecode(tc({ frames: 1.5 }))).toBe(false);
  });

  it("converts non-drop timecodes to seconds and back", () => {
    expect(smpteToSeconds(tc({ hours: 0, minutes: 0, seconds: 2, frames: 12, rate: 25 }))).toBeCloseTo(2.48, 9);
    expect(smpteToSeconds(tc({ hours: 0, minutes: 0, seconds: 1, frames: 0, rate: 24 }))).toBeCloseTo(1, 9);
    const back = secondsToSmpTe(2.48, 25)!;
    expect(back).toMatchObject({ hours: 0, minutes: 0, seconds: 2, frames: 12, rate: 25 });
    expect(secondsToSmpTe(-1, 25)).toBeNull();
  });

  it("drop-frame: one labelled hour is exactly 3600.0 real seconds", () => {
    const hour = smpteToSeconds(tc({ hours: 1, minutes: 0, seconds: 0, frames: 0, rate: 2997 }));
    expect(hour).toBeCloseTo(3600, 6);
    // 107892 real frames per DF hour.
    expect(hour * 29.97).toBeCloseTo(107892, 6);
  });

  it("drop-frame: minutes divisible by ten keep frames 0 and 1", () => {
    // 00:01:00;00 — a dropped-minute boundary: 2 real frames less than NDF math.
    const droppedMinute = smpteToSeconds(tc({ hours: 0, minutes: 1, seconds: 0, frames: 0, rate: 2997 }));
    expect(droppedMinute).toBeCloseTo((1800 - 2) / 29.97, 9);
    // 00:10:00;00 — every tenth minute keeps both frames.
    const tenthMinute = smpteToSeconds(tc({ hours: 0, minutes: 10, seconds: 0, frames: 0, rate: 2997 }));
    expect(tenthMinute).toBeCloseTo(600, 9);
  });

  it("round-trips drop-frame through seconds without drift", () => {
    for (const minutes of [0, 1, 9, 10, 11, 59]) {
      for (const seconds of [0, 1, 59]) {
        const label = tc({ hours: 2, minutes, seconds, frames: 15, rate: 2997 });
        const back = secondsToSmpTe(smpteToSeconds(label), 2997)!;
        expect(back).toEqual(label);
      }
    }
  });

  it("bridges samples both ways (BWF timeReference basis)", () => {
    const label = tc({ hours: 0, minutes: 0, seconds: 1, frames: 0, rate: 25 });
    expect(smpteToSamples(label, 48000)).toBe(48000);
    expect(samplesToSmpTe(48000, 48000, 25)).toMatchObject({ seconds: 1, frames: 0 });
    expect(samplesToSmpTe(Number.NaN, 48000, 25)).toBeNull();
  });

  it("formats and parses labels, DF with the ';' convention", () => {
    expect(formatSmpTe(tc({ rate: 25 }))).toBe("01:02:03:04");
    expect(formatSmpTe(tc({ rate: 2997 }))).toBe("01:02:03;04");
    expect(parseSmpTe("01:02:03:04", 25)).toEqual(tc({ rate: 25 }));
    expect(parseSmpTe("01:02:03;04", 2997)).toEqual(tc({ rate: 2997 }));
    expect(parseSmpTe("99:02:03:04", 25)).toBeNull();
    expect(parseSmpTe("garbage", 25)).toBeNull();
  });
});

describe("MTC quarter-frame decoder", () => {
  /** Feed a full 8-piece frame: nibbles of 01:02:03;04 at 25 fps. */
  function frame(over: { h?: number; m?: number; s?: number; f?: number; rateCode?: number } = {}): number[] {
    const rateCode = over.rateCode ?? 1; // 25 fps
    const values = [
      (over.f ?? 4) & 0x0f,
      ((over.f ?? 4) >> 4) & 0x01,
      (over.s ?? 3) & 0x0f,
      ((over.s ?? 3) >> 4) & 0x03,
      (over.m ?? 2) & 0x0f,
      ((over.m ?? 2) >> 4) & 0x03,
      (over.h ?? 1) & 0x0f,
      (((over.h ?? 1) >> 4) & 0x01) | (rateCode << 1),
    ];
    return values.map((value, index) => (index << 4) | value);
  }

  it("assembles eight pieces into the encoded timecode", () => {
    const decoder = new MtcDecoder();
    let emitted = null;
    for (const data of frame()) emitted = decoder.feed(data >> 4, data);
    expect(emitted).toMatchObject({ hours: 1, minutes: 2, seconds: 3, frames: 4, rate: 25 });
    // The stream continues: a second frame reuses the same sequence.
    for (const data of frame({ s: 4 })) emitted = decoder.feed(data >> 4, data);
    expect(emitted).toMatchObject({ seconds: 4 });
  });

  it("accepts the spec's caller contract: piece index also inside the data byte", () => {
    const decoder = new MtcDecoder();
    const pieces = frame();
    let emitted = null;
    for (const data of pieces) emitted = decoder.feed(data >> 4, data);
    expect(emitted).not.toBeNull();
  });

  it("drops garbage without fabricating positions", () => {
    const decoder = new MtcDecoder();
    expect(decoder.feed(3, 0x30)).toBeNull(); // out of sequence, not piece 0
    expect(decoder.feed(0, 0x7f)).toBeNull(); // data nibble must match piece index
    expect(decoder.feed(0, -1)).toBeNull();
    let emitted = null;
    for (const data of frame()) emitted = decoder.feed(data >> 4, data);
    expect(emitted).toMatchObject({ minutes: 2 }); // recovered after the noise
  });

  it("resyncs on a fresh piece 0 mid-stream", () => {
    const decoder = new MtcDecoder();
    decoder.feed(0, 0x00);
    decoder.feed(1, 0x10);
    // Device jumps: a new piece 0 always starts a fresh frame.
    let emitted = null;
    for (const data of frame({ h: 5, m: 6, s: 7, f: 8 })) emitted = decoder.feed(data >> 4, data);
    expect(emitted).toMatchObject({ hours: 5, minutes: 6, seconds: 7, frames: 8 });
  });

  it("reads the rate code from piece 7", () => {
    expect(mtcRateCodeToRate(0)).toBe(24);
    expect(mtcRateCodeToRate(1)).toBe(25);
    expect(mtcRateCodeToRate(2)).toBe(2997);
    expect(mtcRateCodeToRate(3)).toBe(30);
    const decoder = new MtcDecoder();
    let emitted = null;
    for (const data of frame({ rateCode: 2 })) emitted = decoder.feed(data >> 4, data);
    expect(emitted?.rate).toBe(2997);
  });
});

describe("MTC full-frame SysEx", () => {
  it("parses the universal realtime full-frame message", () => {
    const bytes = [0xf0, 0x7f, 0x7f, 0x01, 0x01, 0x21, 0x02, 0x03, 0x04, 0xf7];
    expect(MtcDecoder.parseFullFrame(bytes)).toMatchObject({
      hours: 1,
      minutes: 2,
      seconds: 3,
      frames: 4,
      rate: 25,
    });
  });

  it("decodes the rate from the hour byte's high bits", () => {
    // 0x62 = rate code 3 (30 NDF) | hour 2.
    const bytes = [0xf0, 0x7f, 0x7f, 0x01, 0x01, 0x62, 0x00, 0x00, 0x00];
    expect(MtcDecoder.parseFullFrame(bytes)).toMatchObject({ hours: 2, rate: 30 });
  });

  it("rejects non-MTC SysEx and malformed frames", () => {
    expect(MtcDecoder.parseFullFrame([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0x00, 0x00, 0x00, 0x00, 0xf7])).toBeNull(); // GM reset
    expect(MtcDecoder.parseFullFrame([0xf0, 0x7f, 0x7f, 0x01, 0x01, 0x21, 0x02, 0x03])).toBeNull(); // truncated
    expect(MtcDecoder.parseFullFrame([0xf7, 0x7f, 0x7f, 0x01, 0x01, 0x21, 0x02, 0x03, 0x04])).toBeNull();
    expect(MtcDecoder.parseFullFrame([])).toBeNull();
  });
});
