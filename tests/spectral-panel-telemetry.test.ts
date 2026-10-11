import { describe, expect, it } from "vitest";

import { SpectralProcessor, SPECTRAL_BANDS } from "../src/effects/spectral-core/dsp/SpectralProcessor";
import { MAX_BLOCK } from "../src/effects/spectral-core/dsp/stft";

/**
 * PORTAL — panel spectrum telemetry (v2, W1).
 *
 * The panel is only trustworthy if the trace it draws is the spectrum the
 * processor actually produced. Three ways that silently breaks, all of them
 * invisible to a test that only checks "the array exists":
 *
 *   1. the trace is re-derived HOST-SIDE from parameters — it would draw the
 *      effect's settings rather than its behaviour, and a resonator that never
 *      rang would still draw a clean hump at FOCUS;
 *   2. the trace is taken BEFORE the mode runs — both traces identical, the
 *      panel shows a pass-through, and the feedback tail is invisible;
 *   3. the trace normalises per frame — every frame reads full-scale, so the
 *      display can never compare one moment to another.
 *
 * So every assertion below reads the PRODUCT: which frequencies carry energy,
 * whether the effect changed them, and whether the scale is stable.
 *
 * Renders are measured in SAMPLES, not blocks. A spectral delay outputs nothing
 * for its whole delay time by construction, so a "long enough to matter"
 * render for a 200 ms delay is 200 ms of audio plus the declared STFT latency.
 * The first version of this file rendered 160 ms and correctly measured
 * silence — a green-looking assertion that was really testing nothing.
 */

const SR = 48000;
const BLOCK = MAX_BLOCK;

/** Render `samples` of audio and return the final meters. */
function renderAndMeter(
  params: Record<string, number>,
  samples: number,
  signal: (i: number) => number,
): { inBands: Uint8Array; outBands: Uint8Array; peak: number } {
  const proc = new SpectralProcessor();
  proc.setParams(params);
  proc.prepare(SR);
  proc.setParams(params);
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  for (let base = 0; base < samples; base += BLOCK) {
    for (let j = 0; j < BLOCK; j++) {
      const s = signal(base + j);
      inL[j] = s;
      inR[j] = s;
    }
    proc.process(inL, inR, outL, outR, BLOCK);
  }
  const m = proc.getMeters();
  return { inBands: m.bandsIn, outBands: m.bandsOut, peak: m.peak };
}

const SEC = (s: number) => Math.round(s * SR);

/** Band index whose log-spaced range contains `hz`. */
const bandFor = (hz: number) => {
  const lo = Math.floor((Math.log(hz / 20) / Math.log(SR / 2 / 20)) * SPECTRAL_BANDS);
  return Math.max(0, Math.min(SPECTRAL_BANDS - 1, lo));
};

const tone =
  (hz: number, amp = 0.5) =>
  (i: number) =>
    Math.sin((i / SR) * 2 * Math.PI * hz) * amp;
const sumOf = (a: Uint8Array) => a.reduce((s, v) => s + v, 0);

describe("PORTAL panel spectrum telemetry", () => {
  it("produces one band per SPECTRAL_BANDS, all integers in 0..255", () => {
    const { inBands, outBands } = renderAndMeter({ mode: 0, time: 200, mix: 1 }, SEC(1), tone(440));
    for (const bands of [inBands, outBands]) {
      expect(bands.length).toBe(SPECTRAL_BANDS);
      for (const v of bands) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
    }
  });

  it("silence reads as an empty trace, not a full one", () => {
    const { inBands, outBands } = renderAndMeter({ mode: 0, time: 200, mix: 1 }, SEC(1), () => 0);
    expect(sumOf(inBands), "silence must not paint the spectrum").toBe(0);
    expect(sumOf(outBands)).toBe(0);
  });

  it("mix = 0 produces NO trace - the panel must say bypassed, not draw a flat line", () => {
    // The rack bypasses the whole STFT at mix = 0 so the dry path stays
    // bit-exact. That means no frames run and the bands stay zero. A panel
    // that drew those zeros as a spectrum would show a silent device, which is
    // the one thing it must never do: "bypassed" is the honest answer.
    const bypassed = renderAndMeter({ mode: 0, time: 200, mix: 0 }, SEC(1), tone(440));
    expect(sumOf(bypassed.inBands), "a bypassed device has no spectrum to show").toBe(0);
    expect(sumOf(bypassed.outBands)).toBe(0);

    const engaged = renderAndMeter({ mode: 0, time: 200, mix: 0.5 }, SEC(1), tone(440));
    expect(sumOf(engaged.inBands), "the same input, engaged, must draw something").toBeGreaterThan(0);
  });

  it("a 440 Hz tone lands in the band that spans 440 Hz, and dominates it", () => {
    const { inBands } = renderAndMeter({ mode: 0, time: 200, mix: 0.5 }, SEC(0.5), tone(440));
    const band = bandFor(440);
    // A trace that lit every band equally would pass a "non-empty" check while
    // telling the user nothing.
    expect(inBands[band]!, `440 Hz must read in band ${band}`).toBeGreaterThan(sumOf(inBands) / SPECTRAL_BANDS);
  });

  it("moving the input moves the trace (it tracks audio, not a fixed curve)", () => {
    const low = renderAndMeter({ mode: 0, time: 200, mix: 0.5 }, SEC(0.5), tone(220));
    const high = renderAndMeter({ mode: 0, time: 200, mix: 0.5 }, SEC(0.5), tone(4000));
    expect(low.inBands[bandFor(220)]!).toBeGreaterThan(low.inBands[bandFor(4000)]!);
    expect(high.inBands[bandFor(4000)]!).toBeGreaterThan(high.inBands[bandFor(220)]!);
  });

  it("out differs from in when feedback is engaged - the trace shows the EFFECT", () => {
    // If both traces were taken before the mode ran, or re-derived host-side,
    // these would be identical.
    const r = renderAndMeter({ mode: 0, time: 120, feedback: 0.85, decay: 0.5, mix: 1 }, SEC(1), tone(440));
    expect(Array.from(r.inBands), "the effect must change the spectrum it draws").not.toEqual(Array.from(r.outBands));
  });

  it("feedback raises the output trace above the input - a tail is visible", () => {
    const dry = renderAndMeter({ mode: 0, time: 200, feedback: 0, mix: 1 }, SEC(1.5), tone(440));
    const wet = renderAndMeter({ mode: 0, time: 200, feedback: 0.95, mix: 1 }, SEC(1.5), tone(440));
    expect(sumOf(dry.outBands), "a 200 ms delay must actually repeat by 1.5 s").toBeGreaterThan(0);
    expect(sumOf(wet.outBands), "feedback energy must appear in the trace").toBeGreaterThan(sumOf(dry.outBands));
  });

  it("a RESONATOR swell shows up around FOCUS", () => {
    const focus = 900;
    const r = renderAndMeter({ mode: 1, resonance: 0.9, focus, focusWidth: 0.5, mix: 1 }, SEC(1), tone(700));
    const focusBand = bandFor(focus);
    const farBand = bandFor(focus * 4);
    expect(
      r.outBands[focusBand]! + r.outBands[Math.max(0, focusBand - 1)]!,
      "the resonator must be visible in the trace at FOCUS",
    ).toBeGreaterThan(r.outBands[farBand]!);
  });

  it("the scale is stable across levels - a normalising trace would pass everything above", () => {
    // If the dB window adapted per frame, a quiet input would print as loud as a
    // hot one and the panel could never compare two moments.
    const quiet = renderAndMeter({ mode: 0, time: 200, mix: 0.5 }, SEC(0.5), tone(440, 0.002));
    const loud = renderAndMeter({ mode: 0, time: 200, mix: 0.5 }, SEC(0.5), tone(440));
    expect(loud.inBands[bandFor(440)]!).toBeGreaterThan(quiet.inBands[bandFor(440)]!);
    // And a 0.5-amplitude sine must not clip: the FFT is unnormalised, so an
    // uncalibrated trace reads +48 dB and saturates every loud band.
    expect(loud.inBands[bandFor(440)]!, "a 0.5 sine must sit below the ceiling").toBeLessThan(255);
    expect(loud.inBands[bandFor(440)]!, "and above the display floor").toBeGreaterThan(128);
  });

  it("every rack mode produces a readable trace", () => {
    for (const mode of [0, 1, 2]) {
      const r = renderAndMeter({ mode, time: 200, feedback: 0.6, mix: 1 }, SEC(1.5), tone(440));
      expect(sumOf(r.inBands), `mode ${mode} input trace`).toBeGreaterThan(0);
      expect(sumOf(r.outBands), `mode ${mode} output trace`).toBeGreaterThan(0);
      for (const v of r.outBands) {
        expect(Number.isInteger(v), `mode ${mode} band`).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
    }
  });

  it("stays allocation-free on the frame path (the trace buffers are reused)", () => {
    // The telemetry rides the frame callback, so a per-frame allocation here
    // would be an allocation on the audio thread — the one thing this codebase
    // must never do.
    const proc = new SpectralProcessor();
    proc.setParams({ mode: 0, time: 200, mix: 1 });
    proc.prepare(SR);
    const first = proc.getMeters();
    const inRef = first.bandsIn;
    const outRef = first.bandsOut;
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    for (let base = 0; base < SEC(1); base += BLOCK) {
      for (let j = 0; j < BLOCK; j++) {
        inL[j] = tone(440)(base + j);
        inR[j] = inL[j]!;
      }
      proc.process(inL, inR, outL, outR, BLOCK);
    }
    const later = proc.getMeters();
    expect(later.bandsIn, "bandsIn must be the same buffer, reused").toBe(inRef);
    expect(later.bandsOut, "bandsOut must be the same buffer, reused").toBe(outRef);
    expect(sumOf(later.bandsOut)).toBeGreaterThan(0);
  });
});
