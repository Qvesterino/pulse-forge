import { describe, expect, it } from "vitest";
import { resolveSlicePlayback } from "../src/audio-engine/AudioEngine";
import { fitSliceFades } from "../src/audio-engine/declick";
import type { DrumPad, DrumTrack } from "../src/project-model/types";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";

const pad = (overrides: Partial<DrumPad> = {}): DrumPad => ({
  id: "pad",
  name: "Pad",
  assetId: "sample",
  gain: 1,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  chokeGroup: null,
  ...overrides,
});

describe("slice playback parameters", () => {
  it("keeps an unsliced pad on the full-buffer path", () => {
    expect(resolveSlicePlayback(pad(), 2)).toMatchObject({
      start: 0,
      end: 2,
      duration: 2,
      offset: 0,
      rate: 1,
      fadeIn: 0,
      fadeOut: 0,
      reverse: false,
    });
  });

  it("clamps a slice to the source and reverses without changing pitch", () => {
    expect(resolveSlicePlayback(pad({ sliceStart: -1, sliceEnd: 4, sliceReverse: true, pitch: 12 }), 2)).toMatchObject({
      start: 0,
      end: 2,
      duration: 2,
      offset: 2,
      rate: -2,
      reverse: true,
    });
  });

  it("scales overlapping fades so the envelope fits the slice", () => {
    const resolved = resolveSlicePlayback(
      pad({ sliceStart: 0.25, sliceEnd: 0.75, sliceFadeIn: 0.4, sliceFadeOut: 0.4 }),
      1,
    );
    expect(resolved.duration).toBeCloseTo(0.5, 6);
    expect(resolved.fadeIn + resolved.fadeOut).toBeCloseTo(0.5, 6);
  });

  it("falls back to the full source for an invalid reversed region", () => {
    expect(resolveSlicePlayback(pad({ sliceStart: 0.8, sliceEnd: 0.2 }), 1)).toMatchObject({ start: 0, end: 1 });
  });

  it("sanitizes persisted slice fields without adding them to untouched pads", () => {
    const doc = createDefaultProject();
    const drum = doc.tracks.find((track): track is DrumTrack => track.kind === "drum")!;
    const dirty = {
      ...doc,
      tracks: doc.tracks.map((track) =>
        track.id === drum.id && track.kind === "drum"
          ? {
              ...track,
              pads: track.pads.map((item, index) =>
                index === 0
                  ? {
                      ...item,
                      sliceStart: -1,
                      sliceEnd: 0,
                      sliceFadeIn: -2,
                      sliceFadeOut: Number.NaN,
                      sliceReverse: "yes" as unknown as boolean,
                    }
                  : item,
              ),
            }
          : track,
      ),
    };
    const normalized = normalizeProject(dirty);
    const normalizedDrum = normalized.tracks.find(
      (track): track is DrumTrack => track.id === drum.id && track.kind === "drum",
    )!;
    expect(normalizedDrum.pads[0].sliceStart).toBeUndefined();
    expect(normalizedDrum.pads[0].sliceEnd).toBeUndefined();
    expect(normalizedDrum.pads[0].sliceFadeIn).toBe(0);
    expect(normalizedDrum.pads[0].sliceFadeOut).toBe(0);
    expect(normalizedDrum.pads[0].sliceReverse).toBe(false);
    expect(normalizedDrum.pads[1].sliceFadeIn).toBeUndefined();
  });
});

describe("fitSliceFades (UI ⇄ engine fade contract)", () => {
  it("passes through a pair that already fits", () => {
    expect(fitSliceFades(0.1, 0.2, 0.5)).toEqual({ fadeIn: 0.1, fadeOut: 0.2 });
  });

  it("caps each fade at the slice duration, then fits the pair", () => {
    // 9 and 1 both cap to 0.5, the pair then scales to fit exactly.
    expect(fitSliceFades(9, 1, 0.5)).toEqual({ fadeIn: 0.25, fadeOut: 0.25 });
    // A single oversized fade with an empty partner caps without scaling.
    expect(fitSliceFades(9, 0, 0.5)).toEqual({ fadeIn: 0.5, fadeOut: 0 });
  });

  it("scales an overlapping pair proportionally so the envelope fits", () => {
    const fitted = fitSliceFades(0.4, 0.4, 0.5);
    expect(fitted.fadeIn + fitted.fadeOut).toBeCloseTo(0.5, 6);
    expect(fitted.fadeIn).toBeCloseTo(fitted.fadeOut, 6);
  });

  it("treats non-finite and negative values as 0", () => {
    expect(fitSliceFades(Number.NaN, -1, 0.5)).toEqual({ fadeIn: 0, fadeOut: 0 });
  });

  it("matches resolveSlicePlayback exactly (single source of truth)", () => {
    for (const [inSec, outSec, dur] of [
      [0.3, 0.3, 0.5],
      [0.05, 0.9, 0.5],
      [0, 0, 0],
      [2, 2, 1],
    ] as const) {
      const resolved = resolveSlicePlayback(
        pad({ sliceStart: 0, sliceEnd: dur, sliceFadeIn: inSec, sliceFadeOut: outSec }),
        dur,
      );
      const fitted = fitSliceFades(inSec, outSec, resolved.duration);
      expect(fitted.fadeIn).toBeCloseTo(resolved.fadeIn, 9);
      expect(fitted.fadeOut).toBeCloseTo(resolved.fadeOut, 9);
    }
  });
});
