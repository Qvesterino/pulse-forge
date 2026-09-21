import { it } from "vitest";
const SR = 48000;
const registry = new Map<string, unknown>();
class FakeAudioWorkletProcessor { port = { onmessage: null as unknown, postMessage: (_m: unknown) => {} }; }
it("probe3", async () => {
  (globalThis as any).sampleRate = SR;
  (globalThis as any).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as any).registerProcessor = (name: string, cls: unknown) => registry.set(name, cls);
  await import("../src/audio-worklets/gate-processor.js");
  await import("../src/audio-worklets/stutter-processor.js");
  await import("../src/audio-worklets/flanger-processor.js");
  await import("../src/audio-worklets/reverb-processor.js");

  function run(proc: any, params: Record<string, number>, gen: (i: number) => number, seconds: number): Float32Array {
    const out = new Float32Array(Math.ceil(seconds * SR));
    const blocks = Math.ceil(out.length / 128);
    for (let b = 0; b < blocks; b++) {
      const input = [new Float32Array(128), new Float32Array(128)];
      const output = [new Float32Array(128), new Float32Array(128)];
      for (let i = 0; i < 128; i++) { const v = gen(b * 128 + i); input[0][i] = v; input[1][i] = v; }
      const p: Record<string, Float32Array> = {};
      for (const [k, v] of Object.entries(params)) p[k] = new Float32Array([v]);
      proc.process(input, output, p);
      for (let i = 0; i < 128; i++) { const idx = b * 128 + i; if (idx < out.length) out[idx] = output[0][i]; }
    }
    return out;
  }

  const base = { rate: 0.001, depth: 0, base: 5, feedback: 0, spread: 0, mix: 1, invert: 0 };
  const normal = run(new (registry.get("flanger-processor") as any)(), base, (i) => (i === 10 ? 1 : 0), 0.02);
  console.log("normal nonzero:", Array.from(normal).map((v, i) => [i, v.toFixed(2)]).filter(([, v]) => Number(v) !== 0).slice(0, 6));
  console.log("normal[250]:", normal[250]);

  let noiseState = 99;
  const gen = (): number => { noiseState = (1103515245 * noiseState + 12345) & 0x7fffffff; return 0.5 * (noiseState / 0x3fffffff - 1); };
  const r = run(new (registry.get("reverb-processor") as any)(), { decay: 1.5, damping: 6000, diffusion: 0.5, tone: 9000 }, gen, 0.05);
  let sum = 0; for (let i = 0; i < r.length; i++) sum += Math.abs(r[i]);
  console.log("reverb |out| sum:", sum, "first vals:", [...r.slice(0, 5)]);
});
