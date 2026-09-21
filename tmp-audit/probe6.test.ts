import { it } from "vitest";
const SR = 48000;
const registry = new Map<string, unknown>();
class FakeAudioWorkletProcessor { port = { onmessage: null as unknown, postMessage: (_m: unknown) => {} }; }
it("probe6", async () => {
  (globalThis as any).sampleRate = SR;
  (globalThis as any).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as any).registerProcessor = (name: string, cls: unknown) => registry.set(name, cls);
  await import("../src/audio-worklets/flanger-processor.js");
  await import("../src/audio-worklets/reverb-processor.js");
  const F: any = new (registry.get("flanger-processor") as any)();
  console.log("F ctor name:", F?.constructor?.name, "has process:", typeof F.process);
  const input = [new Float32Array(128), new Float32Array(128)];
  const output = [new Float32Array(128), new Float32Array(128)];
  input[0][10] = 1; input[1][10] = 1;
  const p: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries({ rate: 0.001, depth: 0, base: 5, feedback: 0, spread: 0, mix: 1, invert: 0 })) {
    p[k] = new Float32Array([v as number]);
  }
  console.log("param keys:", Object.keys(p));
  F.process([input], [output], p);
  console.log("direct: out[10..14]:", [...output[0].slice(10, 15)]);

  // Now via the run helper style
  const out = new Float32Array(960);
  for (let b = 0; b < 8; b++) {
    const bi = [new Float32Array(128), new Float32Array(128)];
    const bo = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 128; i++) { const v = b * 128 + i === 10 ? 1 : 0; bi[0][i] = v; bi[1][i] = v; }
    F.process([bi], [bo], p);
    for (let i = 0; i < 128; i++) { const idx = b * 128 + i; if (idx < 960) out[idx] = bo[0][i]; }
  }
  console.log("run-style nonzero:", out.reduce((acc, v, i) => (v !== 0 ? [...acc, `${i}:${v.toFixed(2)}`] : acc), [] as string[]).slice(0, 5));

  const R: any = new (registry.get("reverb-processor") as any)();
  console.log("R ctor name:", R?.constructor?.name, "has process:", typeof R.process);
  const rin = [new Float32Array(128), new Float32Array(128)];
  const rout = [new Float32Array(128), new Float32Array(128)];
  for (let i = 0; i < 128; i++) { rin[0][i] = 0.5; rin[1][i] = 0.5; }
  R.process([rin], [rout], { decay: new Float32Array([1.5]), damping: new Float32Array([6000]), diffusion: new Float32Array([0.5]), tone: new Float32Array([9000]) });
  let sum = 0; for (let i = 0; i < 128; i++) sum += Math.abs(rout[0][i]);
  console.log("reverb sum:", sum);
});
