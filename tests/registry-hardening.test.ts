/**
 * Registry-layer hardening regressions (2026-09-12 hardening pass):
 *
 *  1. Splitter-based effects (utility, haasWidener, msEq, bassBuss) force a
 *     stereo up-mix stage before their ChannelSplitter. A mono source fed a
 *     bare splitter leaves channel 1 silent — the whole right side of those
 *     effects died for mono tracks.
 *  2. mixBus starts wet-silent: the init replay of `mix` smooths from a
 *     dry-only state instead of summing dry+wet (+6 dB transient) on every
 *     insertion / rack rebuild.
 *  3. Pump: re-syncing the transport must not disconnect the running LFO
 *     oscillator synchronously — the disconnect now rides the scheduled
 *     stop (onended), so no modulation dropout / gain jump.
 *  4. clampEffectParam: non-finite values fall back to the default instead
 *     of passing NaN through (setTargetAtTime(NaN) throws in browsers).
 *  5. shimmer dispose severs its full subgraph (lp/fb/exciteGain were left
 *     wired — the feedback loop outlived dispose).
 *  6. ozvenaParamRange: unknown leaves get a FIXED defensive bound, so
 *     clampOzvenaParam is no longer a no-op for positive garbage values.
 */
import { describe, expect, it } from "vitest";
import { EFFECT_DEFS, clampEffectParam } from "../src/effects/registry";
import { clampOzvenaParam } from "../src/effects/ozvena-params";
import type { EffectInstance } from "../src/project-model/types";

// ── Minimal Web Audio mock (wiring + initial values only) ────────────────

interface MockParam {
  value: number;
  setTargetAtTime: (v: number, when: number, tc?: number) => number;
  setValueAtTime: (v: number, when: number) => number;
}
interface MockNode {
  kind: string;
  connections: { dest: MockNode; args: unknown[] }[];
  disconnected: number;
  channelCount: number;
  channelCountMode: string;
  channelInterpretation: string;
  curve?: Float32Array | null;
  oversample?: string;
  type?: string;
  onended?: (() => void) | null;
  startedAt?: number;
  stoppedAt?: number;
  gain: MockParam;
  frequency: MockParam;
  Q: MockParam;
  pan: MockParam;
  delayTime: MockParam;
  threshold: MockParam;
  ratio: MockParam;
  attack: MockParam;
  release: MockParam;
  knee: MockParam;
  connect: (dest: MockNode, ...rest: unknown[]) => MockNode;
  disconnect: (dest?: MockNode) => void;
  start?: (when?: number) => void;
  stop?: (when?: number) => void;
}

function makeParam(initial = 1): MockParam {
  return {
    value: initial,
    setTargetAtTime: (v) => v,
    setValueAtTime: (v) => v,
  };
}

function makeNode(kind: string, created: MockNode[]): MockNode {
  const node: MockNode = {
    kind,
    connections: [],
    disconnected: 0,
    channelCount: kind === "splitter" || kind === "merger" ? 2 : 1,
    channelCountMode: "max",
    channelInterpretation: "speakers",
    gain: makeParam(1),
    frequency: makeParam(350),
    Q: makeParam(1),
    pan: makeParam(0),
    delayTime: makeParam(0),
    threshold: makeParam(-24),
    ratio: makeParam(12),
    attack: makeParam(0.003),
    release: makeParam(0.25),
    knee: makeParam(30),
    connect(dest, ...args) {
      node.connections.push({ dest, args });
      return dest;
    },
    disconnect() {
      node.disconnected++;
    },
  };
  created.push(node);
  return node;
}

function makeCtx() {
  const created: MockNode[] = [];
  const oscillators: MockNode[] = [];
  const ctx = {
    currentTime: 0,
    createGain: () => makeNode("gain", created),
    createBiquadFilter: () => makeNode("biquad", created),
    createChannelSplitter: (n: number) => {
      const node = makeNode("splitter", created);
      node.channelCount = n;
      return node;
    },
    createChannelMerger: (n: number) => {
      const node = makeNode("merger", created);
      node.channelCount = n;
      return node;
    },
    createStereoPanner: () => makeNode("panner", created),
    createDelay: () => makeNode("delay", created),
    createWaveShaper: () => makeNode("shaper", created),
    createDynamicsCompressor: () => makeNode("comp", created),
    createOscillator: () => {
      const osc = makeNode("oscillator", created);
      osc.startedAt = undefined;
      osc.stop = (when?: number) => {
        osc.stoppedAt = when ?? 0;
      };
      osc.start = (when?: number) => {
        osc.startedAt = when ?? 0;
      };
      oscillators.push(osc);
      return osc;
    },
  };
  return { ctx, created, oscillators };
}

function build(type: keyof typeof EFFECT_DEFS, params: Record<string, number> = {}) {
  const { ctx, created, oscillators } = makeCtx();
  const instance = {
    id: "fx-test",
    type,
    bypassed: false,
    params,
  } as unknown as EffectInstance;
  const runtime = EFFECT_DEFS[type].factory(ctx as unknown as BaseAudioContext, instance, { bpm: 120 });
  return { runtime, created, oscillators };
}

/** The explicit-stereo upmix stage inserted before splitter inputs. */
function findUpmix(created: MockNode[]): MockNode | undefined {
  return created.find(
    (n) =>
      n.kind === "gain" &&
      n.channelCount === 2 &&
      n.channelCountMode === "explicit" &&
      n.channelInterpretation === "speakers",
  );
}

describe("registry hardening — mono upmix before splitters", () => {
  for (const type of ["utility", "haasWidener", "msEq", "bassBuss"] as const) {
    it(`${type} forces an explicit-stereo stage into its splitter`, () => {
      const { created } = build(type);
      const upmix = findUpmix(created);
      expect(upmix, `${type} must create an explicit-stereo upmix gain`).toBeTruthy();
      const splitter = created.find((n) => n.kind === "splitter");
      expect(splitter).toBeTruthy();
      // The upmix feeds the splitter (mono → both channels, speakers rules).
      expect(
        upmix!.connections.some((c) => c.dest === splitter),
        `${type}'s upmix must connect into the splitter`,
      ).toBe(true);
    });
  }

  it("utility feeds the upmix from the effect input", () => {
    const { created } = build("utility");
    const upmix = findUpmix(created)!;
    const input = created[0]; // first node created by the factory is `input`
    expect(input.connections.some((c) => c.dest === upmix)).toBe(true);
  });
});

describe("registry hardening — mixBus starts wet-silent", () => {
  it("bassBuss builds with dry=1 / wet=0 (init replay crossfades, no double signal)", () => {
    const { created } = build("bassBuss");
    const input = created.find((n) => n.kind === "gain")!;
    // mixBus wires input → dry → output and input → wet.
    const dries = input.connections.map((c) => c.dest).filter((n) => n.kind === "gain");
    const wet = dries.find((n) => n.gain.value === 0);
    const dry = dries.find((n) => n.gain.value === 1);
    expect(wet, "wet leg must start silent").toBeTruthy();
    expect(dry, "dry leg must start at unity").toBeTruthy();
  });
});

describe("registry hardening — pump transport resync", () => {
  it("restarting the LFO defers the disconnect to the scheduled stop", () => {
    const { oscillators } = build("pump", { amount: 0.5, rate: 2, release: 0.5 });
    expect(oscillators.length).toBe(1);
    const first = oscillators[0];
    const runtime = build("pump", {}).runtime;
    void runtime;

    // Rebuild with the SAME mock set to drive onTransportStarted — simpler:
    // build a fresh pump and resync it.
    const second = build("pump", { amount: 0.5, rate: 2, release: 0.5 });
    const osc = second.oscillators[0];
    second.runtime.onTransportStarted!(0.5, 0.5);
    // The replacement oscillator is created and started at the next beat…
    expect(second.oscillators.length).toBe(2);
    expect(second.oscillators[1].startedAt).toBeGreaterThan(0);
    // …and the OLD oscillator must NOT be disconnected synchronously — the
    // pre-fix behavior collapsed the modulation in one sample (audible jump)
    // and left the pump dead until the new beat.
    expect(osc.disconnected).toBe(0);
    expect(typeof osc.onended).toBe("function");
    // The disconnect rides onended (fires at the scheduled stop time).
    osc.onended!();
    expect(osc.disconnected).toBe(1);
    void first;
  });
});

describe("registry hardening — param validation", () => {
  it("clampEffectParam falls back to the default for non-finite values", () => {
    expect(clampEffectParam("eq", "lowGain", NaN)).toBe(0);
    expect(clampEffectParam("pump", "rate", NaN)).toBe(2);
    expect(clampEffectParam("saturation", "drive", Infinity)).toBe(
      EFFECT_DEFS.saturation.params.find((p) => p.id === "drive")!.default,
    );
    // Finite values still clamp as before.
    expect(clampEffectParam("eq", "lowGain", 99)).toBe(15);
  });

  it("clampOzvenaParam bounds unknown leaves instead of passing garbage", () => {
    // The old value-relative fallback ([0, 4·|value|]) made clamping a no-op
    // for positive values; a corrupt document could push 1e9 through.
    expect(clampOzvenaParam("preDelay.syncNote", 1e9)).toBe(100000);
    expect(clampOzvenaParam("preDelay.syncNote", -1e9)).toBe(-100000);
    expect(clampOzvenaParam("some.unknown.leaf", 5)).toBe(5);
  });
});

describe("registry hardening — dispose hygiene", () => {
  it("shimmer severs its whole subgraph (including the delay feedback loop)", () => {
    const { created, runtime } = build("shimmer", { tone: 0.5, amount: 0.35, decay: 0.35, mix: 0.4 });
    for (const node of created) node.disconnected = 0;
    runtime.dispose();
    // House convention: mixBus legs (input → dry/wet → output) are released
    // by severing mix.input/output; every OTHER node — the delay feedback
    // loop lp/fb and the exciter feed included — must be disconnected.
    const mixLegs = new Set((runtime.input as unknown as MockNode).connections.map((c) => c.dest));
    const exempt = new Set<MockNode>([
      runtime.input as unknown as MockNode,
      runtime.output as unknown as MockNode,
      ...mixLegs,
    ]);
    const leaked = created.filter((n) => n.disconnected === 0 && !exempt.has(n));
    expect(
      leaked,
      `every non-mixBus node must be disconnected on dispose; leaked: ${leaked.map((n) => n.kind).join(", ")}`,
    ).toEqual([]);
  });
});
