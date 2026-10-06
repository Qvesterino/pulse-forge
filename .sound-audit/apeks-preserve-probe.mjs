(globalThis).sampleRate = 48000;
(globalThis).AudioWorkletProcessor = class { port = { onmessage: null, postMessage() {} } };
(globalThis).registerProcessor = (name, cls) => { registered.set(name, cls); };
const registered = new Map();
await import("file:///D:/pulse-forge/src/audio-worklets/apeks-processor.js");
const cls = registered.get("apeks-processor");
const SR = 48000, BLOCK = 128;
const input = (i) => {
  const t = i / SR;
  const pad = 0.5 * Math.sin(2 * Math.PI * 110 * t);
  const clickPhase = i % 6000;
  const click = clickPhase < 48 ? 0.45 * (1 - clickPhase / 48) : 0;
  return [pad + click, pad * 0.95 + click];
};
function run(preserve) {
  const proc = new cls();
  const params = {};
  for (const d of cls.parameterDescriptors) params[d.name] = Float32Array.of(d.defaultValue);
  params.preserve = Float32Array.of(preserve);
  const diag = [];
  for (let b = 0; b < 48; b++) {
    const inp = [Float32Array.from({length: BLOCK}, (_, i) => input(b*BLOCK+i)[0]),
                 Float32Array.from({length: BLOCK}, (_, i) => input(b*BLOCK+i)[1])];
    const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    proc.process([inp], [out], params);
    diag.push({ block: b, gr: proc.gr, outPeak: Math.max(...out[0]) });
  }
  return diag;
}
const a = run(0), b = run(1);
console.log("block | gr_a gr_b | outPeak_a outPeak_b");
for (const i of [0, 5, 11, 12, 23, 24, 35, 36, 47]) {
  console.log(String(i).padStart(5), "|", a[i].gr.toFixed(3), b[i].gr.toFixed(3), "|", a[i].outPeak.toFixed(4), b[i].outPeak.toFixed(4));
}
let md = 0;
