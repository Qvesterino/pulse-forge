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

describe("worklet-backed per-note release bridge", () => {
  it("forwards wavetable release velocity into the sample-accurate note event", () => {
    const { node, messages } = makeNode();
    const runtime = createWtVoiceRuntime(node, makeTrack("wavetable"), {
      bpm: 120,
      getSample: () => undefined,
    });

    runtime.noteOn(60, 0.8, 1, 0.5, undefined, { releaseVelocity: 0.9 });
    const noteOn = messages.find((message) => message.type === "noteOn");

    expect(noteOn).toMatchObject({ type: "noteOn", pitch: 60, when: 1, releaseVelocity: 0.9 });
    runtime.dispose();
  });

  it("forwards granular release velocity into the sample-accurate note event", () => {
    const { node, messages } = makeNode();
    const runtime = createGrainVoiceRuntime(node, makeTrack("granular"), {
      bpm: 120,
      getSample: () => undefined,
    });

    runtime.noteOn(64, 0.7, 2, 0.25, undefined, { releaseVelocity: 0.1 });
    const noteOn = messages.find((message) => message.type === "noteOn");

    expect(noteOn).toMatchObject({
      type: "noteOn",
      pitch: 64,
      when: 2,
      dur: 0.25,
      releaseVelocity: 0.1,
    });
    runtime.dispose();
  });
});
