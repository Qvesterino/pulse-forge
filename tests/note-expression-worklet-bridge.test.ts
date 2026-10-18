import { describe, expect, it } from "vitest";
import type { InstrumentTrack } from "../src/project-model/types";
import { createGrainVoiceRuntime } from "../src/instruments/granularNode";
import { createWtVoiceRuntime } from "../src/instruments/wtvoiceNode";

function makeNode(): { node: AudioWorkletNode; messages: Array<Record<string, unknown>> } {
  const messages: Array<Record<string, unknown>> = [];
  const node = {
    port: { postMessage: (message: Record<string, unknown>) => messages.push(message) },
    disconnect: () => undefined,
  } as unknown as AudioWorkletNode;
  return { node, messages };
}

function makeOfflineNodeCapture() {
  const output = { disconnect: () => undefined } as unknown as GainNode;
  let processorOptions: Record<string, unknown> | null = null;
  let connected = false;
  const createNode = (options: Record<string, unknown>) => {
    processorOptions = options;
    return {
      port: { postMessage: () => undefined },
      connect: () => {
        connected = true;
      },
      disconnect: () => undefined,
    } as unknown as AudioWorkletNode;
  };
  return { output, createNode, getProcessorOptions: () => processorOptions, isConnected: () => connected };
}

const makeTrack = (kind: "wavetable" | "granular"): InstrumentTrack =>
  ({
    id: `note-expression-${kind}`,
    kind: "instrument",
    instrument: kind,
    name: kind,
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sampleId: null,
    params: { release: 0.4 },
    effects: [],
    sends: {},
  }) as InstrumentTrack;

describe("worklet-backed per-note pan and release bridge", () => {
  it("forwards wavetable release velocity into the sample-accurate note event", () => {
    const { node, messages } = makeNode();
    const runtime = createWtVoiceRuntime(node, makeTrack("wavetable"), {
      bpm: 120,
      getSample: () => undefined,
    });

    runtime.noteOn(60, 0.8, 1, 0.5, undefined, { releaseVelocity: 0.9, pan: -0.75 });
    const noteOn = messages.find((message) => message.type === "noteOn");

    expect(noteOn).toMatchObject({ type: "noteOn", pitch: 60, when: 1, releaseVelocity: 0.9, pan: -0.75 });
    runtime.dispose();
  });

  it("forwards granular release velocity into the sample-accurate note event", () => {
    const { node, messages } = makeNode();
    const runtime = createGrainVoiceRuntime(node, makeTrack("granular"), {
      bpm: 120,
      getSample: () => undefined,
    });

    runtime.noteOn(64, 0.7, 2, 0.25, undefined, { releaseVelocity: 0.1, pan: 0.6 });
    const noteOn = messages.find((message) => message.type === "noteOn");

    expect(noteOn).toMatchObject({
      type: "noteOn",
      pitch: 64,
      when: 2,
      dur: 0.25,
      releaseVelocity: 0.1,
      pan: 0.6,
    });
    runtime.dispose();
  });

  it.each(["wavetable", "granular"] as const)("seeds %s pan and release events before offline rendering", (kind) => {
    const offline = makeOfflineNodeCapture();
    const env = { bpm: 120, getSample: () => undefined };
    const runtime =
      kind === "wavetable"
        ? createWtVoiceRuntime(null, makeTrack(kind), env, offline)
        : createGrainVoiceRuntime(null, makeTrack(kind), env, offline);
    runtime.noteOn(60, 0.8, 0.5, 0.25, undefined, { pan: -0.75, releaseVelocity: 0.9 });
    runtime.noteOff?.(60, 0.75);
    runtime.prepareOfflineRender?.();

    const options = offline.getProcessorOptions();
    expect(options).toMatchObject({
      params: { release: 0.4 },
      events: [
        { type: "noteOn", pitch: 60, when: 0.5, pan: -0.75, releaseVelocity: 0.9 },
        { type: "noteOff", pitch: 60, when: 0.75 },
      ],
    });
    expect(offline.isConnected()).toBe(true);
  });
});
