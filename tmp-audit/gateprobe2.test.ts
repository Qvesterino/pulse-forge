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
it("trace2", () => {
  const cycle = Math.floor(0.13 * SR);
  const highLen = Math.floor(0.05 * SR);
  const gen = (i: number) => {
    const inCycle = i % cycle;
    const a = inCycle < highLen ? 0.0316 : 0.01;
    return a * Math.sin((2 * Math.PI * 440 * i) / SR);
  };
  for (const hyst of [0, 1]) {
    const proc: any = new (registry.get("gate-processor") as any)();
    const mk = (v: number) => new Float32Array([v]);
    const p: Record<string, Float32Array> = { threshold: mk(-36), attack: mk(0.002), hold: mk(0.001), release: mk(0.08), range: mk(-60), mix: mk(1), lookahead: mk(0), hysteresis: mk(hyst) };
    const input = [new Float32Array(128), new Float32Array(128)];
    const output = [new Float32Array(128), new Float32Array(128)];
    const gains: string[] = [];
    for (let b = 0; b < 49; b++) {
      for (let i = 0; i < 128; i++) { const v = gen(b * 128 + i); input[0][i] = v; input[1][i] = v; }
      proc.process([input], [output], p);
      // applied gain estimate during the HIGH segment (input known 0.0316):
      const inCycle = (b * 128) % cycle;
      if (inCycle < 128 && b > 2) {
        const g = output[0][0] / (input[0][0] || 1);
        gains.push(`${(b * 128 / SR).toFixed(2)}s:g=${g.toFixed(2)}`);
      }
    }
    console.log(`hyst=${hyst}:`, gains.join(" "));
  }
});
