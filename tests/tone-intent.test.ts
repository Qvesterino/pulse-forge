import { describe, expect, it } from "vitest";
import { parseToneIntent } from "../src/intent/toneIntent";

/**
 * Tone intent verb (ADR 0016/0018): "play the tone" / "tune tone to 880" /
 * "stop the tone" — drives the CLAP tone fixture through the shared
 * playback controller. Tone-stem-scoped; bare "ton" (English ton) never
 * matches without a verb.
 */

describe("tone intent detection", () => {
  it("plays with default and explicit frequencies", () => {
    expect(parseToneIntent("play the tone")).toEqual({ kind: "play", freq: 440 });
    expect(parseToneIntent("play the tone at 880 hz")).toEqual({ kind: "play", freq: 880 });
    expect(parseToneIntent("pust ton")).toEqual({ kind: "play", freq: 440 });
  });

  it("tunes to a given frequency, clamped to the param range", () => {
    expect(parseToneIntent("tune tone to 880")).toEqual({ kind: "tune", freq: 880 });
    expect(parseToneIntent("naladuj ton na 660 hz")).toEqual({ kind: "tune", freq: 660 });
    expect(parseToneIntent("tone to 99999")).toEqual({ kind: "tune", freq: 2000 }); // param max
  });

  it("stops the tone", () => {
    expect(parseToneIntent("stop the tone")).toEqual({ kind: "stop", freq: 440 });
    expect(parseToneIntent("zastav ton")).toEqual({ kind: "stop", freq: 440 });
  });

  it("returns null for non-tone sentences", () => {
    expect(parseToneIntent("chase my timecode")).toBeNull();
    expect(parseToneIntent("make the bass deeper")).toBeNull();
    expect(parseToneIntent("a ton of bricks")).toBeNull(); // bare ton, no verb
    expect(parseToneIntent("")).toBeNull();
  });
});
