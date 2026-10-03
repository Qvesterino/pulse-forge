import { describe, expect, it } from "vitest";
import { INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";
import { GraphAudioContext, classifySources, type GraphNode } from "./helpers/graphAudioContext";
import type { InstrumentDefinition } from "../src/instruments/types";
import type { InstrumentKind, InstrumentTrack } from "../src/project-model/types";

/**
 * AUDIT 2026-10-03 — every instrument must have a live path from a sound source
 * to its output, and must survive its whole runtime lifecycle without throwing.
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
 * node actually able to reach `runtime.output` with a live gain?
 *
 * Defect classes checked:
 *   - no live source at all (the Clavinet class: the chain is built and orphaned)
 *   - a source wired to the output but statically muted with no live sibling
 *   - a source writing straight to `ctx.destination`, escaping track gain, pan,
 *     mute, solo and the entire mixer chain
 *   - a runtime that throws when a parameter is swept, on a second note, or on
 *     noteOff / panic / dispose
 *
 * NOT checked here, deliberately: whether a parameter actually changes the
 * sound. The mock has no time axis, so a gain read after `noteOn` is an
 * automation target, not a level. Parameter ranges are covered by
 * `docs/plugin-audit-2026-09-27.report.json` (`deadParams`), and audibility is
 * covered by the real-browser gate.
 */

function trackFor(kind: InstrumentKind, name: string, overrides: Record<string, number> = {}): InstrumentTrack {
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
    params: { ...defaultInstrumentParams(kind), ...overrides },
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
  crossfade: number;
  silentReferences: number;
  silentVoices: string[];
  leaks: string[];
  dead: string[];
  /** Thrown by the lifecycle sweep (setParameter over every range, 2nd note, …). */
  lifecycle?: string;
  error?: string;
}

function label(nodes: unknown[], ctx: GraphAudioContext): string[] {
  return (nodes as Array<{ kind: string }>).map((n) => `${n.kind}#${ctx.nodes.indexOf(n as never)}`);
}

function probeInstrument(kind: InstrumentKind, def: InstrumentDefinition): Probe {
  const ctx = new GraphAudioContext();
  try {
    const rt = def.factory(ctx as never, trackFor(kind, def.name), {
      bpm: 124,
      getSample: () => ctx.createBuffer(2, 48000) as never,
    });
    // Give the factory's nodes a real endpoint, exactly as the engine does.
    const output = rt.output as unknown as GraphNode;
    output.connect(ctx.destination);
    rt.noteOn(45, 0.9, 0.05, 0.4);

    const c = classifySources(output, ctx.nodes);
    const probe: Probe = {
      kind,
      name: def.name,
      ok: c.audible.length > 0 && c.dead.length === 0 && c.silentVoices.length === 0 && c.leaks.length === 0,
      audible: c.audible.length,
      modulators: c.modulators.length,
      crossfade: c.crossfadeMembers.length,
      silentReferences: c.silentReferences.length,
      silentVoices: label(c.silentVoices, ctx),
      leaks: label(c.leaks, ctx),
      dead: label(c.dead, ctx),
    };

    // ── lifecycle sweep: the parts of the runtime the graph test never touches.
    // Asserted only for "does not throw". `noteOn`, `setParameter`, `panic` and
    // `dispose` are required by `InstrumentRuntime`; noteOff / setParameterAt /
    // syncBpm / polyPressure / polyTimbre are OPTIONAL (src/instruments/types.ts),
    // so each is called only when the runtime actually implements it.
    try {
      for (const p of def.params) {
        for (const v of [p.min, p.max, p.default]) {
          rt.setParameter(p.id, v);
          rt.setParameterAt?.(p.id, v, 0.5);
        }
      }
      rt.noteOn(52, 0.7, 0.2, 0.3);
      rt.noteOn(59, 0.5, 0.25, 0.3);
      rt.polyPressure?.(52, 0.8, 0.3);
      rt.polyTimbre?.(52, 0.7, 0.3);
      rt.setSample?.("factory.tonal.pluck");
      rt.syncBpm?.(90);
      rt.noteOff?.(45, 0.6);
      rt.panic();
      rt.dispose();
    } catch (e) {
      probe.lifecycle = `${(e as Error).name}: ${(e as Error).message}`;
    }
    return probe;
  } catch (error) {
    return {
      kind,
      name: def.name,
      ok: false,
      audible: 0,
      modulators: 0,
      crossfade: 0,
      silentReferences: 0,
      silentVoices: [],
      leaks: [],
      dead: [],
      error: (error as Error).stack ?? String(error),
    };
  }
}

const KINDS = Object.keys(INSTRUMENT_DEFS) as InstrumentKind[];
const results = KINDS.map((k) => probeInstrument(k, INSTRUMENT_DEFS[k]));

function defectLine(p: Probe): string {
  return [
    p.kind,
    p.audible === 0 ? "NO LIVE SOURCE" : null,
    p.silentVoices.length ? `SILENT=[${p.silentVoices.join(", ")}]` : null,
    p.leaks.length ? `LEAK=[${p.leaks.join(", ")}]` : null,
    p.dead.length ? `DEAD=[${p.dead.join(", ")}]` : null,
    p.lifecycle ? `LIFECYCLE=${p.lifecycle}` : null,
    p.error ? `THREW=${p.error.split("\n")[0]}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

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
        `${r.ok && !r.lifecycle ? "OK  " : "FAIL"} ${r.kind.padEnd(12)} ${r.name.padEnd(18)} ` +
          `audible=${r.audible} mod=${r.modulators} xf=${r.crossfade} clock=${r.silentReferences}` +
          (r.dead.length || r.leaks.length || r.silentVoices.length || r.lifecycle ? `  <<< ${defectLine(r)}` : ""),
      );
    }
    expect(results.every((r) => r.audible > 0 || r.error !== undefined)).toBe(true);
  });

  it("no registered instrument builds a voice that cannot make sound", () => {
    expect(
      results.filter((r) => !r.ok).map(defectLine),
      "instruments with a built voice that is orphaned, statically muted, or escaping to ctx.destination",
    ).toEqual([]);
  });

  it("no instrument writes to ctx.destination and bypasses its own output", () => {
    expect(
      results.filter((r) => r.leaks.length > 0).map(defectLine),
      "sources reaching the context destination instead of runtime.output — skips track gain/pan/mute/solo",
    ).toEqual([]);
  });

  it("every runtime survives a full parameter sweep and teardown", () => {
    expect(
      results.filter((r) => r.lifecycle).map((r) => `${r.kind}: ${r.lifecycle}`),
      "setParameter/setParameterAt over every range, three overlapping notes, noteOff, panic, dispose",
    ).toEqual([]);
  });

  it("the ten silent cleanup clocks are recognised as infrastructure, not as voices", () => {
    // pluck, flute, organ, strings, bell, reese, acid, brass, clav, drumsynth
    // each build a 440 Hz oscillator at gain 0 wired to ctx.destination purely so
    // `onended` fires at stopTime in offline rendering (setTimeout does not).
    const withClock = results.filter((r) => r.silentReferences > 0).map((r) => r.kind);
    expect(withClock.sort(), "the set of instruments carrying a silent reference clock").toEqual(
      ["acid", "bell", "brass", "clav", "drumsynth", "flute", "organ", "pluck", "reese", "strings"].sort(),
    );
  });

  it("the Clavinet specifically has a live path (the shipped regression)", () => {
    const clav = results.find((r) => r.kind === "clav");
    expect(clav, "clav must be probed").toBeTruthy();
    expect(clav!.audible, "clav must reach at least one source on the audio path").toBeGreaterThan(0);
    expect(clav!.dead, "clav must have no dead sources").toEqual([]);
  });
});
