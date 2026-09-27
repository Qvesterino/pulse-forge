import { describe, it } from "vitest";
import { analyzeArtifacts, correlationBetween, evaluateArtifacts } from "../src/audio-engine/artifactGate";

const SR = 44100;
function cleanOneShot(freq = 220, seconds = 0.3, fadeSeconds = 0.02): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const fadeStart = n - Math.floor(fadeSeconds * SR);
  for (let i = 0; i < n; i++) {
    const fade = i >= fadeStart ? 1 - (i - fadeStart) / (n - fadeStart) : 1;
    out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.8 * fade;
  }
  return out;
}
function hardCutOneShot(freq = 220, seconds = 0.3): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const cut = n - Math.floor(SR / (freq * 4));
  for (let i = 0; i < cut; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.8;
  return out;
}

describe("debug", () => {
  it("case1 clean", () => {
    const r = analyzeArtifacts([cleanOneShot()]);
    console.log("C1", JSON.stringify({ tail: r.tailStepRatio, clicks: r.clickIndices.length, ok: evaluateArtifacts(r).ok, f: evaluateArtifacts(r).failures }));
  });
  it("case2 kick", () => {
    const n = Math.floor(0.25 * SR);
    const kick = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      kick[i] = Math.sin(2 * Math.PI * (150 * Math.exp(-t * 30) + 45) * t) * Math.exp(-t * 22);
    }
    const r = analyzeArtifacts([kick]);
    console.log("C2", JSON.stringify({ tail: r.tailStepRatio, clicks: r.clickIndices.length, idx: r.clickIndices.slice(0, 5), fail: evaluateArtifacts(r).failures }));
  });
  it("case3 short fade", () => {
    const r = analyzeArtifacts([cleanOneShot(220, 0.1, 0.002)]);
    console.log("C3", JSON.stringify({ clicks: r.clickIndices.length, tail: r.tailStepRatio, ok: evaluateArtifacts(r).ok, fail: evaluateArtifacts(r).failures }));
  });
  it("case4 splice", () => {
    const signal = cleanOneShot(220, 0.4, 0.02);
    const at = Math.floor(0.24 * SR);
    for (let i = at; i < signal.length; i++) signal[i] += 0.4;
    const r = analyzeArtifacts([signal]);
    console.log("C4", JSON.stringify({ clicks: r.clickIndices.length, maxRes: r.maxResidualRatio, tail: r.tailStepRatio }));
  });
  it("case5 correlation", () => {
    const hit = cleanOneShot(180, 0.15, 0.01);
    const variant = new Float32Array(hit.length);
    for (let i = 0; i < hit.length; i++) {
      const pos = i * 1.018;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = hit[i0] ?? 0;
      const b = i0 + 1 < hit.length ? hit[i0 + 1] : a;
      variant[i] = (a + (b - a) * frac) * 1.04;
    }
    console.log("C5", JSON.stringify({ corr: correlationBetween(hit, variant), hitLen: hit.length }));
  });
  it("case6 hard cut", () => {
    const r = analyzeArtifacts([hardCutOneShot()]);
    console.log("C6", JSON.stringify({ tail: r.tailStepRatio, ok: evaluateArtifacts(r).ok, fail: evaluateArtifacts(r).failures }));
  });
});
