import { describe, it } from "vitest";

const SR = 44100;
function oneShot(freq: number, seconds: number, fadeSeconds: number, amp = 0.8): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const fadeStart = n - Math.floor(fadeSeconds * SR);
  for (let i = 0; i < n; i++) {
    const fade = i >= fadeStart ? 1 - (i - fadeStart) / (n - fadeStart) : 1;
    out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp * fade;
  }
  return out;
}
function kick(withSilence: boolean): Float32Array {
  const n = Math.floor((withSilence ? 0.35 : 0.25) * SR);
  const out = new Float32Array(n);
  const body = Math.floor(0.25 * SR);
  for (let i = 0; i < Math.min(n, body); i++) {
    const t = i / SR;
    out[i] = Math.sin(2 * Math.PI * (150 * Math.exp(-t * 30) + 45) * t) * Math.exp(-t * 22);
  }
  return out;
}
function pad(): Float32Array {
  // Sustained, never silent.
  const n = SR;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
  return out;
}

/** Candidate: mean of the region AFTER the last sample above `floor`. */
function postSignalDc(sig: Float32Array, floorRatio = 0.05, minRegion = 441): number {
  let peak = 0;
  for (let i = 0; i < sig.length; i++) peak = Math.max(peak, Math.abs(sig[i]));
  if (peak <= 0) return 0;
  const floor = peak * floorRatio;
  let last = -1;
  for (let i = sig.length - 1; i >= 0; i--) {
    if (Math.abs(sig[i]) > floor) {
      last = i;
      break;
    }
  }
  const from = last + 1;
  const regionLen = sig.length - from;
  if (regionLen < minRegion) return 0;
  let sum = 0;
  for (let i = from; i < sig.length; i++) sum += sig[i];
  return Math.abs(sum / regionLen) / peak;
}

/** Candidate: mean of the last 25 %, only if that region is quiet. */
function quietTailDc(sig: Float32Array, quietRatio = 0.05, minRegion = 441): number {
  let peak = 0;
  for (let i = 0; i < sig.length; i++) peak = Math.max(peak, Math.abs(sig[i]));
  if (peak <= 0) return 0;
  const start = Math.floor(sig.length * 0.75);
  const regionLen = sig.length - start;
  if (regionLen < minRegion) return 0;
  let regionPeak = 0;
  let sum = 0;
  for (let i = start; i < sig.length; i++) {
    regionPeak = Math.max(regionPeak, Math.abs(sig[i]));
    sum += sig[i];
  }
  if (regionPeak > peak * quietRatio) return 0; // not quiet — unmeasurable
  return Math.abs(sum / regionLen) / peak;
}

const db = (v: number) => (v <= 1e-12 ? "-inf" : (20 * Math.log10(v)).toFixed(1));

describe("dbg4", () => {
  it("compare dc candidates", () => {
    const cases: Record<string, Float32Array> = {
      cleanSnare: oneShot(220, 0.3, 0.02),
      cleanShort: oneShot(180, 0.03, 0.005),
      partialCycle: oneShot(220, 0.3007, 0.005),
      leaked05: Float32Array.from(oneShot(220, 0.3, 0.02), (v) => v + 0.05),
      leaked02: Float32Array.from(oneShot(220, 0.3, 0.02), (v) => v + 0.02),
      kickNoSilence: kick(false),
      kickWithSilence: kick(true),
      kickLeaked: Float32Array.from(kick(true), (v) => v + 0.05),
      sustainedPad: pad(),
      padLeaked: Float32Array.from(pad(), (v) => v + 0.05),
    };
    const rows: string[] = [];
    for (const [name, sig] of Object.entries(cases)) {
      rows.push(
        `${name.padEnd(15)} post=${db(postSignalDc(sig)).padStart(7)} quiet=${db(quietTailDc(sig)).padStart(7)}`,
      );
    }
    console.log("DCC\n" + rows.join("\n"));
  });
});
