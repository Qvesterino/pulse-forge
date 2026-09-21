import { beforeAll, it } from "vitest";
const SR = 48000;
const registry = new Map<string, unknown>();
class FakeAudioWorkletProcessor {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (_msg: unknown) => {},
  };
}
beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: unknown) => {
    registry.set(name, cls);
  };
  await import("../src/audio-worklets/gate-processor.js");
  await import("../src/audio-worklets/stutter-processor.js");
  await import("../src/audio-worklets/flanger-processor.js");
  await import("../src/audio-worklets/reverb-processor.js");
});
function make(name: string): any {
  const Ctor = registry.get(name) as any;
  return new Ctor();
}
it("diag", () => {
  const f = make("flanger-processor");
  console.log("flanger ctor:", f.constructor.name);
  const base = { rate: 0.001, depth: 0, base: 5, feedback: 0, spread: 0, mix: 1, invert: 0 };
  const p: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) p[k] = new Float32Array([v]);
  const input = [new Float32Array(128), new Float32Array(128)];
  const output = [new Float32Array(128), new Float32Array(128)];
  input[0][10] = 1; input[1][10] = 1;
  f.process([input], [output], p);
  console.log("blk0 out[10..14]:", [...output[0].slice(10, 15)]);
  const input2 = [new Float32Array(128), new Float32Array(128)];
  const output2 = [new Float32Array(128), new Float32Array(128)];
  f.process([input2], [output2], p);
  console.log("blk1 out[122]:", output2[0][122]);
  const r = make("reverb-processor");
  console.log("reverb ctor:", r.constructor.name);
});
