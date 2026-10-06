(globalThis).sampleRate = 48000;
(globalThis).AudioWorkletProcessor = class { port = { onmessage: null, postMessage() {} } };
(globalThis).registerProcessor = (name, cls) => { registered.set(name, cls); };
const registered = new Map();
await import("file:///D:/pulse-forge/src/audio-worklets/apeks-processor.js");
const cls = registered.get("apeks-processor");
const SR = 48000, BLOCK = 128;
function run(release, blocks) {
  const proc = new cls();
  const params = {};
  for (const d of cls.parameterDescriptors) params[d.name] = Float32Array.of(d.defaultValue);
  params.release = Float32Array.of(release);
  const grs = [];
  for (let b = 0; b < blocks; b++) {
    const inp = [Float32Array.from({length: BLOCK}, (_, i) => (b*BLOCK+i) % 24000 < 12000 ? 0.85*Math.sin(2*Math.PI*220*(b*BLOCK+i)/SR) : 0.0425*Math.sin(2*Math.PI*220*(b*BLOCK+i)/SR)),
                 Float32Array.from({length: BLOCK}, (_, i) => (b*BLOCK+i) % 24000 < 12000 ? 0.8*Math.sin(2*Math.PI*220*(b*BLOCK+i)/SR) : 0.04)];
    const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    proc.process([inp], [out], params);
    grs.push(proc.gr);
  }
  return grs;
}
const a = run(0.05, 96), b = run(0.5, 96);
let maxGrDiff = 0, maxOutDiffIdx = -1;
for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i]-b[i]); if (d > maxGrDiff) { maxGrDiff = d; maxOutDiffIdx = i; } }
console.log("max |gr_a - gr_b| over blocks:", maxGrDiff.toFixed(4), "at block", maxOutDiffIdx);
console.log("gr_a samples [0,20,40,60,80,95]:", [0,20,40,60,80,95].map(i=>a[i].toFixed(3)).join(", "));
console.log("gr_b samples [0,20,40,60,80,95]:", [0,20,40,60,80,95].map(i=>b[i].toFixed(3)).join(", "));
