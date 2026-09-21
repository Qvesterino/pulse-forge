/** Scratch debug 2 — full processor arms. Delete after use. */
import { MorphDynamicsProcessor } from "../src/effects/morph-dynamics-core/dsp/morphDynamicsProcessor";
import { buildDefaultParams } from "../src/effects/morph-dynamics-core/contracts/parameterSchema";
import * as P from "../src/effects/morph-dynamics-core/contracts/parameterIds";

const SR = 48000;
const BLOCK = 128;

function state(overrides: Record<string, number>): Record<string, number> {
  return { ...buildDefaultParams(), ...overrides };
}

function makeProc(params: Record<string, number>) {
  const proc = new MorphDynamicsProcessor();
  proc.prepare(SR, 2, BLOCK, 1);
  proc.loadState(params);
  return proc;
}

function render(proc: MorphDynamicsProcessor, seconds: number): Float32Array {
  const total = Math.round(seconds * SR);
  const outL = new Float32Array(total);
  const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  let n = 0;
  while (n < total) {
    const frames = Math.min(BLOCK, total - n);
    for (let i = 0; i < frames; i++) {
      const phase = i + n;
      const v = phase % Math.round(0.25 * SR) < Math.round(0.003 * SR) ? ((phase * 2654435761) % 16007) / 8003 - 1 : 0;
      input[0][i] = v * 0.8;
      input[1][i] = v * 0.8;
    }
    proc.process(input, frames);
    for (let i = 0; i < frames; i++) outL[n + i] = input[0][i];
    n += frames;
  }
  return outL;
}

const SUSTAINED: Record<string, number> = {
  [P.HARM_ENABLED_ID]: 1,
  [P.HARM_MIX_ID]: 100,
  [P.HARM_BODY_AMOUNT_ID]: 100,
  [P.harmVoiceParamId(0, "on")]: 1,
  [P.harmVoiceParamId(0, "interval")]: 7,
  [P.harmVoiceParamId(0, "level")]: 100,
};

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

function diffRms(a: Float32Array, b: Float32Array): number {
  const d = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) d[i] = a[i] - b[i];
  return rms(d);
}

const dry = render(makeProc(state({})), 1.2);
const wet = render(makeProc(state(SUSTAINED)), 1.2);
const mixZero = render(makeProc(state({ ...SUSTAINED, [P.HARM_MIX_ID]: 0 })), 1.2);
const full = render(
  makeProc(state({ ...SUSTAINED, [P.HARM_DEV_FULL_SIGNAL_ID]: 1 })),
  1.2,
);
console.log("BODY vs dry diff rms:", diffRms(wet, dry).toFixed(6));
console.log("MIX0 vs dry diff rms:", diffRms(mixZero, dry).toFixed(6));
console.log("FULL vs dry diff rms:", diffRms(full, dry).toFixed(6));
console.log("dry rms:", rms(dry).toFixed(6), "wet rms:", rms(wet).toFixed(6));
// where is the BODY diff energy? per 0.1s
for (let w = 0; w < 12; w++) {
  const from = w * Math.round(0.1 * SR);
  const to = from + Math.round(0.1 * SR);
  const d = new Float32Array(to - from);
  for (let i = 0; i < d.length; i++) d[i] = wet[from + i] - dry[from + i];
  console.log(`  window ${w}: diffRms ${rms(d).toFixed(6)}`);
}
