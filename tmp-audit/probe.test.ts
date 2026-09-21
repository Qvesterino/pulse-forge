import { it } from "vitest";
const SR = 48000;
const registry = new Map<string, unknown>();
class FakeP { port = { onmessage: null as unknown, postMessage: (m: unknown) => console.log("PORT:", JSON.stringify(m)) }; }
it("probe", async () => {
  (globalThis as any).sampleRate = SR;
  (globalThis as any).AudioWorkletProcessor = FakeP;
  (globalThis as any).registerProcessor = (name: string, cls: unknown) => registry.set(name, cls);
  await import("../src/audio-worklets/gate-processor.js");
  console.log("registered:", [...registry.keys()]);
  const Ctor = registry.get("gate-processor") as any;
  const proc = new Ctor();
  const input = [new Float32Array(128).fill(0.5), new Float32Array(128).fill(0.5)];
  const output = [new Float32Array(128), new Float32Array(128)];
  const params = { threshold: new Float32Array([-36]), attack: new Float32Array([0.002]), hysteresis: new Float32Array([0.15]), lookahead: new Float32Array([1]), hold: new Float32Array([0.02]), release: new Float32Array([0.08]), range: new Float32Array([-48]), mix: new Float32Array([1]) };
  const ok = proc.process([input], [output], params);
  console.log("ok:", ok, "out[0..3]:", [...output[0].slice(0, 4)], "out[127]:", output[0][127]);
});
