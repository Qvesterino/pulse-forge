import { describe, expect, it } from "vitest";
import { defaultInstrumentParams, INSTRUMENT_DEFS } from "../src/instruments/registry";
import type { InstrumentKind, InstrumentTrack, NoteExpression } from "../src/project-model/types";
import { GraphAudioContext } from "./helpers/graphAudioContext";

const FILTER_MOD_KINDS: readonly InstrumentKind[] = [
  "sampler",
  "analog",
  "bass",
  "808",
  "texture",
  "keys",
  "organ",
  "strings",
  "bell",
  "reese",
  "acid",
  "brass",
  "pluck",
  "flute",
  "logdrum",
  "spectral",
];

const RELEASE_KINDS: readonly InstrumentKind[] = [
  "sampler",
  "analog",
  "bass",
  "808",
  "texture",
  "wavetable",
  "granular",
  "fm",
  "keys",
  "organ",
  "strings",
  "reese",
  "clav",
  "acid",
  "brass",
  "pluck",
  "flute",
  "spectral",
  "vocalchop",
];

function trackFor(kind: InstrumentKind, overrides: Record<string, number> = {}): InstrumentTrack {
  return {
    id: `note-filter-mod-${kind}`,
    kind: "instrument",
    instrument: kind,
    name: kind,
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sampleId: "factory.tonal.pluck",
    params: { ...defaultInstrumentParams(kind), ...overrides },
    effects: [],
    sends: {},
  } as unknown as InstrumentTrack;
}

function voiceFilterState(
  kind: InstrumentKind,
  expression?: NoteExpression,
  overrides: Record<string, number> = {},
): Array<{ frequency: number; q: number }> {
  const ctx = new GraphAudioContext();
  const runtime = INSTRUMENT_DEFS[kind].factory(ctx as never, trackFor(kind, overrides), {
    bpm: 120,
    getSample: () => ctx.createBuffer(2, 48000) as never,
  });

  runtime.noteOn(52, 0.8, 0.05, 0.4, undefined, expression);
  const state = ctx.nodes
    .filter((node) => node.kind === "biquad")
    .map((node) => {
      const filter = node as unknown as { frequency: { value: number }; Q: { value: number } };
      return { frequency: filter.frequency.value, q: filter.Q.value };
    });
  runtime.dispose();
  return state;
}

function voiceReleaseTaus(kind: InstrumentKind, releaseVelocity?: number): number[] {
  const ctx = new GraphAudioContext();
  const runtime = INSTRUMENT_DEFS[kind].factory(ctx as never, trackFor(kind), {
    bpm: 120,
    getSample: () => ctx.createBuffer(2, 48000) as never,
  });

  runtime.noteOn(52, 0.8, 0.05, 0.4, undefined, releaseVelocity === undefined ? undefined : { releaseVelocity });
  const taus = ctx.nodes
    .filter((node) => node.kind === "gain")
    .map((node) => (node as unknown as { gain: { lastTargetTimeConstant: number | null } }).gain.lastTargetTimeConstant)
    .filter((value): value is number => value !== null);
  runtime.dispose();
  return taus;
}

function differs(
  a: readonly { frequency: number; q: number }[],
  b: readonly { frequency: number; q: number }[],
  key: "frequency" | "q",
): boolean {
  return a.length === b.length && a.some((value, index) => Math.abs(value[key] - b[index]![key]) > 1e-6);
}

describe("per-note filter modulation routing", () => {
  it("declares release velocity only for runtimes with note-off envelopes", () => {
    const declared = Object.values(INSTRUMENT_DEFS)
      .filter((definition) => definition.noteExpressionTargets?.includes("releaseVelocity"))
      .map((definition) => definition.kind)
      .sort();

    expect(declared).toEqual([...RELEASE_KINDS].sort());
  });

  it.each(RELEASE_KINDS)("keeps neutral release velocity unchanged and scales the note-off envelope for %s", (kind) => {
    const baseline = voiceReleaseTaus(kind);
    const neutral = voiceReleaseTaus(kind, 0.5);
    const soft = voiceReleaseTaus(kind, 0);
    const hard = voiceReleaseTaus(kind, 1);
    const hasDifferentTau = (candidate: readonly number[]) =>
      baseline.length === candidate.length &&
      baseline.some((value, index) => Math.abs(value - candidate[index]!) > 1e-6);

    expect(neutral).toEqual(baseline);
    expect(hasDifferentTau(soft)).toBe(true);
    expect(hasDifferentTau(hard)).toBe(true);
  });

  it("declares all filter event lanes only for instruments with a per-voice filter route", () => {
    for (const target of ["filterCutoffHz", "filterResonance", "modX", "modY"] as const) {
      const declared = Object.values(INSTRUMENT_DEFS)
        .filter((definition) => definition.noteExpressionTargets?.includes(target))
        .map((definition) => definition.kind)
        .sort();

      expect(declared).toEqual([...FILTER_MOD_KINDS].sort());
    }
  });

  it.each(FILTER_MOD_KINDS)("keeps neutral Mod X/Y unchanged and routes both lanes for %s", (kind) => {
    const baseline = voiceFilterState(kind);
    const neutral = voiceFilterState(kind, { modX: 0.5, modY: 0.5 });
    const modX = voiceFilterState(kind, { modX: 0.95, modY: 0.5 });
    const modY = voiceFilterState(kind, { modX: 0.5, modY: 0.95 });

    expect(neutral).toEqual(baseline);
    expect(differs(baseline, modX, "frequency")).toBe(true);
    expect(differs(baseline, modY, "q")).toBe(true);
  });

  it.each(FILTER_MOD_KINDS)("routes direct cutoff/resonance and gives them precedence on %s", (kind) => {
    const baseline = voiceFilterState(kind);
    const direct = voiceFilterState(kind, { filterCutoffHz: 300, filterResonance: 0 });
    const directAndMod = voiceFilterState(kind, {
      filterCutoffHz: 300,
      filterResonance: 0,
      modX: 0.95,
      modY: 0.95,
    });

    expect(differs(baseline, direct, "frequency")).toBe(true);
    expect(differs(baseline, direct, "q")).toBe(true);
    expect(directAndMod).toEqual(direct);
  });

  it("preserves out-of-range base filter values when Mod X/Y is centered", () => {
    const overrides = { cutoff: 20000, resonance: 12 };
    const baseline = voiceFilterState("pluck", undefined, overrides);
    const neutral = voiceFilterState("pluck", { modX: 0.5, modY: 0.5 }, overrides);

    expect(neutral).toEqual(baseline);
  });
});
