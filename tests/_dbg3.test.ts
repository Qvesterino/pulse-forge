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
function kick(): Float32Array {
  const n = Math.floor(0.25 * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = Math.sin(2 * Math.PI * (150 * Math.exp(-t * 30) + 45) * t) * Math.exp(-t * 22);
  }
  return out;
}
function metrics(sig: Float32Array): Record<string, string> {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < sig.length; i++) {
    sum += sig[i];
    peak = Math.max(peak, Math.abs(sig[i]));
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < sig.length; i++) {
    lo = Math.min(lo, sig[i]);
    hi = Math.max(hi, sig[i]);
  }
  // mean over the last 30 %
  let tailSum = 0;
  let tailN = 0;
  for (let i = Math.floor(sig.length * 0.7); i < sig.length; i++) {
    tailSum += sig[i];
    tailN++;
  }
  const db = (v: number) => (v <= 1e-9 ? "-inf" : (20 * Math.log10(v)).toFixed(1));
  return {
    peak: peak.toFixed(3),
    wholeMean: db(Math.abs(sum / sig.length) / peak),
    midpoint: db(Math.abs((hi + lo) / 2) / peak),
    tail30Mean: db(Math.abs(tailSum / Math.max(1, tailN)) / peak),
  };
}

describe("dbg3", () => {
  it("dc metric comparison", () => {
    const clean = oneShot(220, 0.3, 0.02);
    const partial = oneShot(220, 0.3007, 0.005);
    const leaked = Float32Array.from(clean, (v) => v + 0.05);
    const leaked2 = Float32Array.from(clean, (v) => v + 0.02);
    const k = kick();
    const kickLeak = Float32Array.from(k, (v) => v + 0.05);
    const snareShort = oneShot(180, 0.03, 0.005);
    console.log("DC", JSON.stringify({
      clean: metrics(clean),
      partial: metrics(partial),
      leaked05: metrics(leaked),
      leaked02: metrics(leaked2),
      kick: metrics(k),
      kickLeak: metrics(kickLeak),
      snareShort: metrics(snareShort),
    }, null, 1));
  });
});
