import { describe, expect, it } from "vitest";
import { audioClipWaveformWindow } from "../src/audio-engine/audioClipChannels";

/**
 * Recording audit 2026-10-01 — the clip waveform must display the same
 * temporal window playback uses (offsetSec + trimStart → duration − trimEnd),
 * otherwise every recorded take with a count-in head, loop pass or manual
 * trim draws an envelope that does not match what the clip plays.
 */
describe("audioClipWaveformWindow", () => {
  it("defaults to the full buffer", () => {
    expect(audioClipWaveformWindow(10)).toEqual({ startSec: 0, endSec: 10 });
  });

  it("skips a recorded count-in head trimmed via offsetSec", () => {
    expect(audioClipWaveformWindow(24, 8)).toEqual({ startSec: 8, endSec: 24 });
  });

  it("combines offsetSec with manual trims", () => {
    expect(audioClipWaveformWindow(24, 8, 1, 2)).toEqual({ startSec: 9, endSec: 22 });
  });

  it("applies trims without an offset", () => {
    expect(audioClipWaveformWindow(10, 0, 2.5, 1.5)).toEqual({ startSec: 2.5, endSec: 8.5 });
  });

  it("clamps a window that would run past the buffer end", () => {
    const w = audioClipWaveformWindow(10, 8, 5);
    expect(w.startSec).toBeGreaterThanOrEqual(0);
    expect(w.endSec).toBeLessThanOrEqual(10);
    expect(w.endSec).toBeGreaterThan(w.startSec);
  });

  it("still returns a minimal drawable window when trims consume everything", () => {
    const w = audioClipWaveformWindow(10, 0, 9.9995, 0);
    expect(w.endSec).toBeGreaterThan(w.startSec);
    expect(w.endSec).toBeLessThanOrEqual(10);
    expect(w.endSec - w.startSec).toBeGreaterThanOrEqual(0.0009); // float epsilon below 1 ms
  });

  it("treats non-finite inputs as absent", () => {
    expect(audioClipWaveformWindow(10, Number.NaN, Number.POSITIVE_INFINITY, Number.NaN)).toEqual({
      startSec: 0,
      endSec: 10,
    });
  });

  it("returns a degenerate window for a non-positive duration", () => {
    expect(audioClipWaveformWindow(0, 2, 1, 1)).toEqual({ startSec: 0, endSec: 0 });
    expect(audioClipWaveformWindow(Number.NaN)).toEqual({ startSec: 0, endSec: 0 });
  });

  it("never emits a negative or inverted window", () => {
    const w = audioClipWaveformWindow(4, -5, -1, -2);
    expect(w.startSec).toBeGreaterThanOrEqual(0);
    expect(w.endSec).toBeGreaterThan(w.startSec);
    expect(w.endSec).toBeLessThanOrEqual(4);
  });
});
