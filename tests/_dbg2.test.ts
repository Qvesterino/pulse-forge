import { describe, it } from "vitest";
import { analyzeArtifacts } from "../src/audio-engine/artifactGate";

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
function resample(src: Float32Array, rate: number, gain: number): Float32Array {
  const length = Math.max(1, Math.round(src.length / rate));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * rate;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = src[i0] ?? 0;
    const b = i0 + 1 < src.length ? src[i0 + 1] : a;
    out[i] = (a + (b - a) * frac) * gain;
  }
  return out;
}

// log-envelope correlation on a common time grid
function logEnvCorr(a: Float32Array, b: Float32Array, points = 96): number {
  const sample = (ch: Float32Array, frac: number): number => {
    const center = Math.max(0, Math.min(ch.length - 1, Math.round(ch.length * frac)));
    const win = 64;
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, center - win); i < Math.min(ch.length, center + win); i++) {
      sum += ch[i] * ch[i];
      n++;
    }
    const rms = n > 0 ? Math.sqrt(sum / n) : 0;
    return Math.log10(Math.max(1e-7, rms));
  };
  const av: number[] = [];
  const bv: number[] = [];
  for (let i = 0; i < points; i++) {
    const frac = i / (points - 1);
    av.push(sample(a, frac));
    bv.push(sample(b, frac));
  }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(av);
  const mb = mean(bv);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < av.length; i++) {
    const x = av[i] - ma;
    const y = bv[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? 1 : num / Math.sqrt(da * db);
}

describe("dbg2", () => {
  it("metrics", () => {
    const base = oneShot(180, 0.15, 0.01);
    const v1 = resample(base, 1.018, 1.04);
    const v2 = resample(base, 0.984, 0.95);
    const diffDecay = oneShot(180, 0.03, 0.005);
    const diffFreq = oneShot(320, 0.15, 0.01);
    const kick = oneShot(60, 0.25, 0.02);
    console.log("M", JSON.stringify({
      self: logEnvCorr(base, base),
      rr1: logEnvCorr(base, v1),
      rr2: logEnvCorr(base, v2),
      diffDecay: logEnvCorr(base, diffDecay),
      diffFreq: logEnvCorr(base, diffFreq),
      kickVsSnare: logEnvCorr(base, kick),
    }));

    const shortFade = oneShot(220, 0.1, 0.002);
    const r = analyzeArtifacts([shortFade]);
    console.log("SF", JSON.stringify({ clicks: r.clickIndices, maxRes: r.maxResidualRatio, attack: r.attackIndex, tail: r.tailStepRatio }));
    for (const idx of r.clickIndices.slice(0, 6)) {
      const lo = Math.max(0, idx - 4);
      console.log("  @", idx, Array.from(shortFade.slice(lo, idx + 5)).map((x) => x.toFixed(6)));
    }
  });
});
