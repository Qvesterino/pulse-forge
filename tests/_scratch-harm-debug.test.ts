/** Scratch debug — delete after use. */
import { BodyHarmonizer } from "../src/effects/morph-dynamics-core/dsp/harmony";

const SR = 48000;
const harm = new BodyHarmonizer();
harm.prepare(SR);
harm.setParams({
  enabled: true,
  bodyAmount: 1,
  mix: 1,
  fullSignal: false,
  voices: [
    { enabled: true, interval: 7, detune: 0, level: 1, pan: 0 },
    { enabled: false, interval: -5, detune: 0, level: 0.7, pan: 0.25 },
    { enabled: false, interval: 12, detune: 0, level: 0.6, pan: -0.6 },
    { enabled: false, interval: -12, detune: 0, level: 0.6, pan: 0.6 },
  ],
});
const out = { l: 0, r: 0, dry: 1 };
let noiseState = 777;
const noise = () => {
  noiseState = (1103515245 * noiseState + 12345) & 0x7fffffff;
  return 0.8 * (noiseState / 0x3fffffff - 1);
};
const burstLen = Math.round(0.003 * SR);
const period = Math.round(0.25 * SR);
let busPeak = 0;
let busRms = 0;
let count = 0;
const maskLog: number[] = [];
for (let i = 0; i < SR * 1.2; i++) {
  const x = i % period < burstLen ? noise() : 0;
  harm.processFrame(x, x, out);
  busPeak = Math.max(busPeak, Math.abs(out.l));
  busRms += out.l * out.l;
  count++;
  if (i % Math.round(period / 20) === 0 && i < period * 1.5) maskLog.push(harm.getMask());
}
console.log("click-train: busPeak", busPeak.toFixed(5), "busRms", Math.sqrt(busRms / count).toFixed(6));
console.log("mask trace (first 1.5 periods):", maskLog.map((m) => m.toFixed(3)).join(" "));

// Sustained sine control
const harm2 = new BodyHarmonizer();
harm2.prepare(SR);
harm2.setParams({
  enabled: true,
  bodyAmount: 1,
  mix: 1,
  fullSignal: false,
  voices: [{ enabled: true, interval: 7, detune: 0, level: 1, pan: 0 }],
});
const out2 = { l: 0, r: 0, dry: 1 };
let peak2 = 0;
for (let i = 0; i < SR; i++) {
  const x = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  harm2.processFrame(x, x, out2);
  if (i > SR * 0.5) peak2 = Math.max(peak2, Math.abs(out2.l));
}
console.log("sustained: harmony peak after settle", peak2.toFixed(4), "mask", harm2.getMask().toFixed(3));
