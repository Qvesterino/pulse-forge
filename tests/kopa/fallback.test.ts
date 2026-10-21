import { describe, expect, it } from "vitest";
import { createKopaFallbackRuntime, createKopaRuntime } from "../../src/instruments/kopaNode";
import type { InstrumentTrack } from "../../src/project-model/types";

/**
 * KOPA fallback + runtime bridge (KOPA plan §3.5).
 *
 * The bridge contract: an OFFLINE context without the worklet module renders
 * the fallback AUDIBLY (never a silent graph), live connects a worklet node
 * when one is available, and the offline runtime buffers events until
 * `prepareOfflineRender()` seeds them. jsdom has no AudioContext, so the
 * fake-context harness mirrors `tests/instruments/tsar-node` (if present)
 * and `tests/instrument-graph-reachability` patterns: node stubs register
 * connections, sources start at scheduled times.
 */

type Started = { at: number };

function fakeContext(): {
  ctx: BaseAudioContext;
  started: Started[];
  stopped: number[];
  connections: Array<[number, number]>;
  gains: { value: number; events: { type: string; value: number; time: number }[]; setValueAtTime: (v: number, t: number) => void }[];
} {
  let nodeId = 0;
  const started: Started[] = [];
  const stopped: number[] = [];
  const connections: Array<[number, number]> = [];
  const gains: { value: number; events: { type: string; value: number; time: number }[]; setValueAtTime: (v: number, t: number) => void }[] = [];

  const mkParam = (initial = 0) => {
    const param = {
      value: initial,
      /** Automation timeline — the guard reads the TIMES, not the values. */
      events: [] as { type: string; value: number; time: number }[],
      setValueAtTime: (v: number, t: number) => {
        param.value = v;
        param.events.push({ type: "value", value: v, time: t });
      },
      exponentialRampToValueAtTime: (v: number, t: number) => {
        param.value = v;
        param.events.push({ type: "ramp", value: v, time: t });
      },
      setTargetAtTime: (v: number, t: number) => {
        param.value = v;
        param.events.push({ type: "target", value: v, time: t });
      },
      cancelScheduledValues: () => {},
    };
    return param;
  };

  const mkNode = (): Record<string, unknown> => {
    const id = ++nodeId;
    const node: Record<string, unknown> = {
      __id: id,
      connect(target: { __id?: number } | AudioNode) {
        connections.push([id, (target as { __id?: number }).__id ?? 0]);
        return target;
      },
      disconnect() {},
    };
    return node;
  };

  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    destination: { __id: 0 },
    createGain() {
      const node = mkNode();
      const gain = mkParam(1);
      node.gain = gain;
      gains.push(gain);
      return node;
    },
    createOscillator() {
      const node = mkNode();
      node.frequency = mkParam(65);
      node.detune = mkParam(0);
      node.type = "sine";
      node.start = (when = 0) => started.push({ at: when });
      node.stop = (when = 0) => stopped.push(when);
      return node;
    },
    createBuffer(channels: number, length: number) {
      const data = [Float32Array.from({ length }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5))];
      return {
        numberOfChannels: channels,
        length,
        sampleRate: 48000,
        duration: length / 48000,
        getChannelData: () => data[0]!,
      };
    },
    createBufferSource() {
      const node = mkNode();
      node.buffer = null;
      node.start = (when = 0) => started.push({ at: when });
      node.stop = (when = 0) => stopped.push(when);
      return node;
    },
    createBiquadFilter() {
      const node = mkNode();
      node.frequency = mkParam(1000);
      node.Q = mkParam(0.7);
      node.type = "lowpass";
      return node;
    },
    createWaveShaper() {
      const node = mkNode();
      node.curve = null;
      node.oversample = "none";
      return node;
    },
  };
  return { ctx: ctx as unknown as BaseAudioContext, started, stopped, connections, gains };
}

const track: InstrumentTrack = {
  id: "track-kopa-1",
  kind: "instrument",
  instrument: "kopa",
  name: "Kopa",
  color: null,
  gain: 1,
  pan: 0,
  mute: false,
  solo: false,
  sampleId: null,
  effects: [],
  sends: {},
  params: {},
} as unknown as InstrumentTrack;

describe("KOPA native fallback runtime", () => {
  it("a noteOn builds a live graph with scheduled sources (audible, never silent)", () => {
    const { ctx, started, connections } = fakeContext();
    const runtime = createKopaFallbackRuntime(ctx, track);
    runtime.noteOn(36, 1, 0.01, 0.5);
    expect(started.length).toBeGreaterThan(0);
    expect(connections.length).toBeGreaterThan(0);
    // The fallback output is a real GainNode the engine can connect.
    expect(runtime.output).toBeDefined();
  });

  it("applies velocity once at the complete voice output and treats zero as silence", () => {
    const { ctx, gains } = fakeContext();
    const runtime = createKopaFallbackRuntime(ctx, track);
    const level = Math.pow(10, -6 / 20);
    runtime.noteOn(36, 0.5, 0.01, 0.1);
    // The worklet's voice chain is layers -> velocity -> level -> the
    // processor's 0.5 output factor. The fallback mirrors it: the voice gain
    // carries velocity*level and the RUNTIME OUTPUT carries the 0.5. Before
    // the fix the voice gain had its own 0.9 and no 0.5 anywhere, so the
    // emergency path was 1.8x (+5.1 dB) louder than the production path.
    expect(gains[1]!.value).toBeCloseTo(0.5 * level, 6);
    expect(gains[0]!.value).toBeCloseTo(0.5, 6);

    const silentContext = fakeContext();
    const silentRuntime = createKopaFallbackRuntime(silentContext.ctx, track);
    silentRuntime.noteOn(36, 0, 0.01, 0.1);
    expect(silentContext.started).toHaveLength(0);
    expect(silentContext.gains).toHaveLength(1); // only the runtime output node
  });

  it("never schedules a decay target before the attack ramp it follows ends", () => {
    // A setTargetAtTime scheduled BEFORE the ramp's end event is superseded
    // by that end event: the parameter keeps the ramp's end value and never
    // decays. Measured on the KOPA fallback: the sub layer's ramp ended at
    // when+4 ms while its target was scheduled at `when`, so the sub held its
    // level for the whole voice and the fallback's RMS stayed flat
    // (drill.hardstyle: 0.0975 at 10 ms, still 0.109 at 700 ms) while the
    // worklet decayed to 0.0004.
    const { ctx, gains } = fakeContext();
    const runtime = createKopaFallbackRuntime(ctx, track);
    runtime.noteOn(36, 1, 0.01, 0.1);
    expect(gains.length).toBeGreaterThan(1);
    for (const param of gains) {
      const rampEnd = param.events.filter((e) => e.type === "ramp").map((e) => e.time);
      if (rampEnd.length === 0) continue;
      for (const target of param.events.filter((e) => e.type === "target")) {
        for (const end of rampEnd) {
          expect(target.time).toBeGreaterThanOrEqual(end);
        }
      }
    }
  });

  it("keeps the sine click's short stop time instead of replacing it with voice cleanup", () => {
    const { ctx, started, stopped } = fakeContext();
    const runtime = createKopaFallbackRuntime(ctx, track);
    runtime.setParameter("clickType", 2);
    runtime.setParameter("clickDecay", 3);
    runtime.noteOn(36, 1, 0.01, 0.1);

    // The sine click is explicitly stopped after its own envelope; each
    // remaining source gets the longer one-shot voice-retirement deadline.
    expect(stopped).toHaveLength(started.length);
    expect(stopped[0]).toBeCloseTo(0.072, 6);
  });

  it("a gated noteOff only chokes matching pitches", () => {
    const { ctx, gains } = fakeContext();
    const runtime = createKopaFallbackRuntime(ctx, track);
    runtime.noteOn(36, 1, 0.01, 0.1);
    const firstVoiceGain = gains[1]!;
    const nextGainIndex = gains.length;
    runtime.noteOn(38, 1, 0.02, 0.1);
    const secondVoiceGain = gains[nextGainIndex]!;

    runtime.noteOff!(36, 0.1);
    expect(firstVoiceGain.value).toBe(0);
    expect(secondVoiceGain.value).toBeGreaterThan(0);
  });

  it("ONE SHOT ignores noteOff", () => {
    const { ctx, gains } = fakeContext();
    const runtime = createKopaFallbackRuntime(ctx, { ...track, params: { triggerMode: 0 } });
    runtime.noteOn(36, 1, 0.01, 0.5);
    const voiceGain = gains[1]!;

    runtime.noteOff!(36, 0.1);
    expect(voiceGain.value).toBeGreaterThan(0);
  });

  it("bounds native fallback polyphony to the worklet's 16 voices", () => {
    const { ctx, gains } = fakeContext();
    const runtime = createKopaFallbackRuntime(ctx, track);
    runtime.noteOn(36, 1, 0.01, 0.5);
    const oldestVoiceGain = gains[1]!;
    for (let pitch = 37; pitch <= 52; pitch++) runtime.noteOn(pitch, 0.8, 0.02, 0.5);

    const gainBeforeSeventeenth = gains.length;
    runtime.noteOn(53, 0.8, 0.03, 0.5);
    expect(oldestVoiceGain.value).toBe(0);
    // At least the 17th main voice gain is allocated after the 16 active ones.
    expect(gains.length).toBeGreaterThan(gainBeforeSeventeenth);
  });

  it("noteOff stops the voice; panic clears everything; dispose disconnects", () => {
    const { ctx } = fakeContext();
    const runtime = createKopaFallbackRuntime(ctx, track);
    runtime.noteOn(36, 1, 0, 0.5);
    runtime.noteOn(38, 0.8, 0.1, 0.5);
    expect(() => runtime.noteOff!(36, 0.5)).not.toThrow();
    expect(() => runtime.panic()).not.toThrow();
    expect(() => runtime.dispose()).not.toThrow();
  });

  it("setParameter clamps non-finite values out of the voice graph", () => {
    const { ctx } = fakeContext();
    const runtime = createKopaFallbackRuntime(ctx, track);
    runtime.setParameter("pitchAmount", Number.NaN);
    runtime.setParameter("bodyDecay", Number.POSITIVE_INFINITY);
    expect(() => runtime.noteOn(36, 1, 0, 0.5)).not.toThrow();
  });
});

describe("KOPA worklet runtime bridge (offline parity)", () => {
  function workletNode(): { port: { postMessage: (m: unknown) => void; messages: unknown[] }; connect: () => void } {
    const messages: unknown[] = [];
    return {
      port: {
        postMessage: (m: unknown) => messages.push(m),
        messages,
      },
      connect() {},
    };
  }

  it("live path posts noteOn/noteOff/param through the port", () => {
    const built: unknown[] = [];
    const node = workletNode();
    const { ctx } = fakeContext();
    const runtime = createKopaRuntime({
      createGain: () => ctx.createGain(),
      createNode: (processorOptions) => {
        built.push(processorOptions);
        return node as unknown as AudioWorkletNode;
      },
      offline: false,
      track,
    });
    runtime.noteOn(36, 1, 0.01, 0.5);
    runtime.noteOff!(36, 0.5);
    runtime.setParameter("drive", 0.9);
    expect(built).toHaveLength(1); // live builds immediately
    const types = (node.port.messages as Array<{ type: string }>).map((m) => m.type);
    expect(types).toContain("noteOn");
    expect(types).toContain("noteOff");
    expect(types).toContain("param");
  });

  it("offline path buffers events and seeds them at prepareOfflineRender", () => {
    const built: Array<Record<string, unknown>> = [];
    const node = workletNode();
    const { ctx } = fakeContext();
    const runtime = createKopaRuntime({
      createGain: () => ctx.createGain(),
      createNode: (processorOptions) => {
        built.push(processorOptions);
        return node as unknown as AudioWorkletNode;
      },
      offline: true,
      track,
    });
    runtime.noteOn(36, 1, 0.01, 0.5);
    runtime.noteOn(38, 0.8, 0.4, 0.5);
    runtime.setParameter("drive", 0.8);
    // Nothing built before prepare — the render timeline needs the queue first.
    expect(built).toHaveLength(0);
    runtime.prepareOfflineRender!();
    expect(built).toHaveLength(1);
    const events = built[0]!.events as Array<{ type: string; when: number }>;
    expect(events.map((e) => e.type)).toEqual(["noteOn", "noteOn", "param"]);
    expect(events[0]!.when).toBeCloseTo(0.01, 6);
    // A second call is idempotent.
    runtime.prepareOfflineRender!();
    expect(built).toHaveLength(1);
  });

  it("the seeded queue carries the same param snapshot the track holds", () => {
    const built: Array<Record<string, unknown>> = [];
    const { ctx } = fakeContext();
    const runtime = createKopaRuntime({
      createGain: () => ctx.createGain(),
      createNode: (processorOptions) => {
        built.push(processorOptions);
        return workletNode() as unknown as AudioWorkletNode;
      },
      offline: true,
      track: { ...track, params: { drive: 0.7, bodyDecay: 0.5 } },
    });
    runtime.prepareOfflineRender!();
    expect(built[0]!.params).toEqual({ drive: 0.7, bodyDecay: 0.5 });
  });
});
