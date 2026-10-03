import { describe, expect, it } from "vitest";
import { INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";
import { GraphAudioContext, classifySources, type GraphNode } from "./helpers/graphAudioContext";
import type { InstrumentTrack } from "../src/project-model/types";

/**
 * AUDIT 2026-10-03 — every instrument must have a live path from a sound source
 * to its output.
 *
 * The Clavinet shipped silent for its whole life (`amp.connect(output)` was
 * missing) and nothing caught it: the factory constructs without throwing, the
 * preset auditioning reports peak 0.0000, and the only structural check is the
 * `instrument-voice-reachability` source pin — which is a pattern match and
 * cannot see an intermediate node.
 *
 * This is the systematic version. It instantiates every registered kind against
 * a mock context that records Web Audio edges correctly (see the helper) and
 * asks the only question that matters: after `noteOn`, is any signal-generating
 * node actually able to reach `runtime.output`?
 *
 * A FAIL here means the instrument renders silence no matter what the UI does.
 */

function trackFor(kind: string, name: string): InstrumentTrack {
  return {
    id: `audit-${kind}`,
    kind: "instrument",
    instrument: kind,
    name,
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sampleId: "factory.tonal.pluck",
    params: defaultInstrumentParams(kind),
    effects: [],
    sends: {},
  } as unknown as InstrumentTrack;
}

interface Probe {
  kind: string;
  name: string;
  ok: boolean;
  audible: number;
  modulators: number;
  dead: string[];
  error?: string;
}

function probeInstrument(kind: string, def: (typeof INSTRUMENT_DEFS)[string]): Probe {
  const ctx = new GraphAudioContext();
  try {
    const rt = def.factory(ctx as never, trackFor(kind, def.name), {
      bpm: 124,
      getSample: (id: string) => ctx.createBuffer(2, 48000) as never,
    });
    // Give the factory's nodes a real endpoint, exactly as the engine does.
    rt.output.connect(ctx.destination);
    rt.noteOn(45, 0.9, 0.05, 0.4);
    const output = rt.output as unknown as GraphNode;
    const { audible, modulators, dead } = classifySources(output, ctx.nodes);
    return {
      kind,
      name: def.name,
      ok: audible.length > 0 && dead.length === 0,
      audible: audible.length,
      modulators: modulators.length,
      dead: dead.map((n) => `${n.kind}#${ctx.nodes.indexOf(n)}`),
    };
  } catch (error) {
    return { kind, name: def.name, ok: false, audible: 0, modulators: 0, dead: [], error: (error as Error).stack ?? String(error) };
  }
}

const KINDS = Object.keys(INSTRUMENT_DEFS);
const results = KINDS.map((k) => probeInstrument(k, INSTRUMENT_DEFS[k as keyof typeof INSTRUMENT_DEFS]));

describe("AUDIT: instrument signal reachability (all registered kinds)", () => {
  it("the probe actually covers every registered kind (a shrunken list would pass vacuously)", () => {
    expect(results.length).toBe(Object.keys(INSTRUMENT_DEFS).length);
    expect(results.length).toBeGreaterThanOrEqual(20);
    expect(new Set(results.map((r) => r.kind)).size).toBe(results.length);
  });

  it("records the per-instrument classification", () => {
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(
        `${r.ok ? "OK  " : "FAIL"} ${r.kind.padEnd(12)} ${r.name.padEnd(18)} ` +
          `audible=${r.audible} modulators=${r.modulators}` +
          (r.dead.length ? ` DEAD=[${r.dead.join(", ")}]` : "") +
          (r.error ? ` error=${r.error.split("\n")[0]}` : ""),
      );
    }
    expect(results.every((r) => r.audible > 0 || r.error !== undefined)).toBe(true);
  });

  it("no registered instrument builds a source that reaches nothing at all", () => {
    const broken = results.filter((r) => !r.ok);
    expect(
      broken.map((d) => `${d.kind}: audible=${d.audible} DEAD=[${d.dead.join(", ")}]`),
      "instruments with a built-and-started voice that reaches neither the output nor any param",
    ).toEqual([]);
  });

  it("the Clavinet specifically has a live path (the shipped regression)", () => {
    const clav = results.find((r) => r.kind === "clav");
    expect(clav, "clav must be probed").toBeTruthy();
    expect(clav!.audible, "clav must reach at least one source on the audio path").toBeGreaterThan(0);
    expect(clav!.dead, "clav must have no dead sources").toEqual([]);
  });
});
