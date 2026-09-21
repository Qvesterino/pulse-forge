import { beforeAll, it } from "vitest";
const SR = 48000;
const registry = new Map<string, unknown>();
class FakeP { port = { onmessage: null as unknown, postMessage: (_m: unknown) => {} }; }
beforeAll(async () => {
  (globalThis as any).sampleRate = SR;
  (globalThis as any).AudioWorkletProcessor = FakeP;
  (globalThis as any).registerProcessor = (n: string, c: unknown) => registry.set(n, c);
  await import("../src/audio-worklets/gate-processor.js");
});
it("gate trace", () => {
  const gen = (i: number) => 0.06 * (0.5 + 0.5 * Math.sin((2 * Math.PI * 8 * i) / SR)) * Math.sin((2 * Math.PI * 440 * i) / SR);
  for (const hyst of [0, 1]) {
    const proc: any = new (registry.get("gate-processor") as any)();
    const input = [new Float32Array(128), new Float32Array(128)];
    const output = [new Float32Array(128), new Float32Array(128)];
    const mk = (v: number) => new Float32Array([v]);
    const p: Record<string, Float32Array> = { threshold: mk(-36), attack: mk(0.002), hold: mk(0.001), release: mk(0.08), range: mk(-60), mix: mk(1), lookahead: mk(0), hysteresis: mk(hyst) };
    const means: string[] = [];
    for (let b = 0; b < 24; b++) {
      for (let i = 0; i < 128; i++) { const v = gen(b * 128 + i); input[0][i] = v; input[1][i] = v; }
      proc.process([input], [output], p);
      let s = 0; for (let i = 0; i < 128; i++) s += Math.abs(output[0][i]);
      if (b % 4 === 0) means.push(`${(b * 128 / SR).toFixed(2)}s:${(s / 128).toFixed(4)}`);
    }
    console.log(`hyst=${hyst}:`, means.join(" "));
  }
});
