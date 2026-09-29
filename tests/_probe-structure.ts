import { energyCurve, sectionsFromEnergy } from "../src/reference/structure";
import { FIXTURE_SR } from "./reference/_fixtures";

function sig(seconds = 20, sr = FIXTURE_SR): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sr));
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const loud = t >= 4 && t < 16;
    out[i] = (loud ? 0.7 : 0.06) * Math.sin(2 * Math.PI * 110 * t);
  }
  return out;
}

const curve = energyCurve(sig(), 20);
console.log("curve points:", curve.length);
console.log("energies:", curve.map((p) => p.energy.toFixed(3)).join(" "));
const energies = curve.map((p) => p.energy);
const sorted = [...energies].sort((a, b) => a - b);
const mid = sorted[Math.floor(sorted.length / 2)];
console.log("median:", mid.toFixed(4), "lowCut(0.4*max(median,0.1)):", (0.4 * Math.max(mid, 0.1)).toFixed(4));
console.log("labels:", curve.map((p) => (p.energy < 0.4 * Math.max(mid, 0.1) ? "low" : p.energy > 0.7 ? "high" : "mid")).join(" "));
const sections = sectionsFromEnergy(curve, { durationSeconds: 20, beatTimes: [], bpm: null });
console.log("\nsections:");
for (const s of sections) {
  console.log(`  ${s.role.padEnd(12)} ${s.startSec.toFixed(2)}..${s.endSec.toFixed(2)}  energy=${s.energy.toFixed(3)}`);
}
