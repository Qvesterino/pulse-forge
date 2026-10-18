import { describe, expect, it } from "vitest";
import { defaultInstrumentParams, INSTRUMENT_DEFS } from "../src/instruments/registry";
import type { InstrumentKind, InstrumentTrack, NoteExpression } from "../src/project-model/types";
import { GraphAudioContext, type GraphNode } from "./helpers/graphAudioContext";

const PAN_KINDS: readonly InstrumentKind[] = [
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
  "clav",
  "acid",
  "brass",
  "fm",
  "pluck",
  "flute",
  "logdrum",
  "vocalchop",
  "drumsynth",
  "spectral",
  "wavetable",
  "granular",
];

function trackFor(kind: InstrumentKind): InstrumentTrack {
  return {
    id: `per-note-pan-${kind}`,
    kind: "instrument",
    instrument: kind,
    name: kind,
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sampleId: "factory.tonal.pluck",
    params: { ...defaultInstrumentParams(kind), ...(kind === "pluck" ? { width: 0.3 } : {}) },
    effects: [],
    sends: {},
  } as unknown as InstrumentTrack;
}

describe("per-note pan voice routing", () => {
  it("declares only runtimes that route per-note pan", () => {
    const declared = Object.values(INSTRUMENT_DEFS)
      .filter((definition) => definition.noteExpressionTargets?.includes("pan"))
      .map((definition) => definition.kind)
      .sort();

    expect(declared).toEqual([...PAN_KINDS].sort());
  });

  it.each(PAN_KINDS)("routes overlapping %s notes through independent pan values", (kind) => {
    const ctx = new GraphAudioContext();
    const runtime = INSTRUMENT_DEFS[kind].factory(ctx as never, trackFor(kind), {
      bpm: 120,
      getSample: () => ctx.createBuffer(2, 48000) as never,
    });
    const left: NoteExpression = { pan: -0.65 };
    const right: NoteExpression = { pan: 0.7 };

    runtime.noteOn(52, 0.8, 0.05, 0.4, undefined, left);
    runtime.noteOn(65, 0.7, 0.07, 0.4, undefined, right);

    const output = runtime.output as unknown as GraphNode;
    const pannerNodes = ctx.nodes.filter((node) => node.kind === "panner");
    const routedToOutput = pannerNodes.filter((node) => node.outputs.has(output));
    const panNodes = ["texture", "vocalchop", "granular"].includes(kind) ? pannerNodes : routedToOutput;
    const directPanValues = panNodes.map((node) => (node as unknown as { pan: { value: number } }).pan.value);
    const expected = kind === "pluck" ? [-0.5975, 0.655] : [-0.65, 0.7];
    for (const value of expected) {
      expect(directPanValues.some((actual) => Math.abs(actual - value) < 1e-9)).toBe(true);
    }

    runtime.dispose();
  });

  it("NEGATIVE: Drum Synth keeps the default event path unpanned without allocating a panner", () => {
    const ctx = new GraphAudioContext();
    const runtime = INSTRUMENT_DEFS.drumsynth.factory(ctx as never, trackFor("drumsynth"), {
      bpm: 120,
      getSample: () => ctx.createBuffer(2, 48000) as never,
    });

    runtime.noteOn(60, 0.8, 0.05, 0.4);

    expect(ctx.nodes.filter((node) => node.kind === "panner")).toHaveLength(0);
    runtime.dispose();
  });
});
