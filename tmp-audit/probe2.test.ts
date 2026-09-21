import { it } from "vitest";
const SR = 48000;
const registry = new Map<string, unknown>();
class FakeP { port = { onmessage: null as unknown, postMessage: (m: unknown) => {} }; }
it("probe2", async () => {
  (globalThis as any).sampleRate = SR;
  (globalThis as any).AudioWorkletProcessor = FakeP;
  (globalThis as any).registerProcessor = (name: string, cls: unknown) => registry.set(name, cls);
  await import("../src/audio-worklets/flanger-processor.js");
  await import("../src/audio-worklets/reverb-processor.js");
  const F = registry.get("flanger-processor") as any;
  const R = registry.get("reverb-processor") as any;
  console.log("flanger registered:", !!F, "reverb registered:", !!R);

  const f = new F();
  const input = [new Float32Array(128), new Float32Array(128)];
  const output = [new Float32Array(128), new Float32Array(128)];
  // impulse in block 0 at i=10; then a second block containing sample 250
  input[0][10] = 1; input[1][10] = 1;
  const p = { rate: new Float32Array([0.001]), depth: new Float32Array([0]), base: new Float32Array([5]), feedback: new Float32Array([0]), spread: new Float32Array([0]), invert: new Float32Array([0]), mix: new Float32Array([1]) };
  f.process([input], [output], p);
  const input2 = [new Float32Array(128), new Float32Array(128)];
  const output2 = [new Float32Array(128), new Float32Array(128)];
  f.process([input2], [output2], p);
  console.log("flanger blk0 wet@10..14:", [...output[0].slice(10, 15)]);
  // 250 - 128 = 122 in block 2
  console.log("flanger blk1 @122 (echo 250):", output2[0][122]);

  const r = new R();
  const rin = [new Float32Array(128), new Float32Array(128)];
  const rout = [new Float32Array(128), new Float32Array(128)];
  for (let i = 0; i < 128; i++) { rin[0][i] = Math.sin(i * 0.1); rin[1][i] = rin[0][i]; }
  const rp = { decay: new Float32Array([1.5]), damping: new Float32Array([6000]), diffusion: new Float32Array([0.5]), tone: new Float32Array([9000]) };
  r.process([rin], [rout], rp);
  let sum = 0; for (let i = 0; i < 128; i++) sum += Math.abs(rout[0][i]);
  console.log("reverb |out| sum:", sum);
});
