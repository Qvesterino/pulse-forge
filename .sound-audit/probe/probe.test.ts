import { it } from "vitest";
import { analyzeMixHealth } from "../src/analysis/mixDoctor";
const SR = 44100;
function sine(freq: number, seconds: number, amp: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}
function mix(layers: Float32Array[]): Float32Array {
  const out = new Float32Array(layers[0].length);
  for (const layer of layers) for (let i = 0; i < out.length; i++) out[i] += layer[i];
  return out;
}
it("probe", () => {
  const seconds = 2;
  const m = mix([sine(220, seconds, 0.06), sine(880, seconds, 0.05), sine(6000, seconds, 0.03)]);
  const hitLen = Math.floor(0.25 * SR);
  for (let at = 0; at + hitLen <= m.length; at += Math.floor(0.5 * SR)) {
    for (let i = 0; i < hitLen; i++) m[at + i] += 0.8 * Math.exp(-i / (0.06 * SR)) * Math.sin((2 * Math.PI * 55 * i) / SR);
  }
  let peak = 0;
  for (const v of m) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < m.length; i++) m[i] *= 0.85 / peak;
  const r = analyzeMixHealth([m], SR);
  console.log("PROBE ok", r.ok, "crest", r.crestDb.toFixed(1), "lowEnd", (r.lowEndShare * 100).toFixed(0) + "%", "peak", r.peak.toFixed(3));
  for (const f of r.flags) console.log("PROBE flag", f.severity, f.check, f.detail);
  console.log("PROBE bands", JSON.stringify(Object.fromEntries(Object.entries(r.bandShares).map(([k,v])=>[k,(v*100).toFixed(1)+"%"]))));
});
