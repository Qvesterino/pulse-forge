import { describe, expect, it, vi } from "vitest";
import { defaultInstrumentParams, INSTRUMENT_DEFS } from "../src/instruments/registry";
import { supportsHeldVoiceSlideNote } from "../src/instruments/noteExpressionCapabilities";
import { midiToFreq, type InstrumentTrack } from "../src/project-model/types";
import { GraphAudioContext } from "./helpers/graphAudioContext";

function acidTrack(): InstrumentTrack {
  return {
    id: "acid-slide-test",
    kind: "instrument",
    instrument: "acid",
    name: "Acid 303",
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sampleId: null,
    params: defaultInstrumentParams("acid"),
    effects: [],
    sends: {},
  };
}

describe("held-voice slide notes", () => {
  it("declares only runtimes with a held monophonic pitch path", () => {
    expect(supportsHeldVoiceSlideNote("808")).toBe(true);
    expect(supportsHeldVoiceSlideNote("acid")).toBe(true);
    expect(supportsHeldVoiceSlideNote("keys")).toBe(false);
    expect(supportsHeldVoiceSlideNote(undefined)).toBe(false);
  });

  it("bends Acid 303 without a new voice and applies slide-note expression", () => {
    const ctx = new GraphAudioContext();
    const runtime = INSTRUMENT_DEFS.acid.factory(ctx as never, acidTrack(), {
      bpm: 120,
      getSample: () => undefined,
    });

    runtime.noteOn(45, 0.9, 0.1, 0.5);
    const filter = ctx.nodes.find((node) => node.kind === "biquad")!;
    const oscillator = ctx.nodes.find((node) => node.kind === "oscillator" && node.outputs.has(filter))!;
    const panner = ctx.nodes.find((node) => node.kind === "panner")!;
    const nodeCount = ctx.nodes.length;
    const oscillatorCount = ctx.snapshot().sources.length;

    runtime.noteSlide?.(57, 0.2, 0.8, { pan: 1, filterCutoffHz: 1800, filterResonance: 1 });

    expect(ctx.nodes).toHaveLength(nodeCount);
    expect(ctx.snapshot().sources).toHaveLength(oscillatorCount);
    expect((oscillator as unknown as { frequency: { value: number } }).frequency.value).toBeCloseTo(midiToFreq(57));
    expect((panner as unknown as { pan: { value: number } }).pan.value).toBe(1);
    expect((filter as unknown as { frequency: { value: number } }).frequency.value).toBe(1800);
    expect((filter as unknown as { Q: { value: number } }).Q.value).toBeCloseTo(8);

    runtime.noteOff?.(45, 0.35);
    const amp = [...filter.outputs].find((node) => node.kind === "gain")!;
    expect((amp as unknown as { gain: { lastTargetTimeConstant: number | null } }).gain.lastTargetTimeConstant).toBe(
      0.15 / 4,
    );
    runtime.dispose();
  });

  it("starts a new Acid slide from the instantaneous frequency of an in-flight portamento", () => {
    const ctx = new GraphAudioContext();
    const runtime = INSTRUMENT_DEFS.acid.factory(ctx as never, acidTrack(), {
      bpm: 120,
      getSample: () => undefined,
    });

    runtime.noteOn(45, 0.9, 0.1, 1);
    runtime.noteOn(57, 0.9, 0.4, 0.5);
    const filter = ctx.nodes.filter((node) => node.kind === "biquad").at(-1)!;
    const oscillator = [...ctx.nodes].reverse().find((node) => node.kind === "oscillator" && node.outputs.has(filter))!;
    const frequency = (
      oscillator as unknown as {
        frequency: { setValueAtTime(value: number, when: number): void };
      }
    ).frequency;
    const setValueAtTime = vi.fn(frequency.setValueAtTime.bind(frequency));
    frequency.setValueAtTime = setValueAtTime;

    runtime.noteSlide?.(69, 0.475, 0.2);

    const slideStart = setValueAtTime.mock.calls.at(-1)!;
    expect(slideStart[0]).toBeCloseTo(Math.sqrt(midiToFreq(45) * midiToFreq(57)), 10);
    expect(slideStart[1]).toBe(0.475);
    runtime.dispose();
  });

  it("ignores slide notes without an overlapping held voice", () => {
    const ctx = new GraphAudioContext();
    const runtime = INSTRUMENT_DEFS.acid.factory(ctx as never, acidTrack(), {
      bpm: 120,
      getSample: () => undefined,
    });
    const factoryNodeCount = ctx.nodes.length;

    runtime.noteSlide?.(57, 0.05, 0.1);
    expect(ctx.nodes).toHaveLength(factoryNodeCount);

    runtime.noteOn(45, 0.9, 0.1, 0.3);
    const filter = ctx.nodes.find((node) => node.kind === "biquad")!;
    const oscillator = ctx.nodes.find((node) => node.kind === "oscillator" && node.outputs.has(filter))!;
    runtime.noteSlide?.(57, 0.4, 0.1); // Source gate ended at 0.4 s.

    expect((oscillator as unknown as { frequency: { value: number } }).frequency.value).toBeCloseTo(midiToFreq(45));
    runtime.dispose();
  });
});
