import { readFileSync } from "node:fs";
import ort from "onnxruntime-web";

const SR = 44100;
const N = 343980; // 7.8 s
const CHUNK_SEC = Number(process.env.STEM_CHUNK_SEC ?? 7.8);
const N2 = Math.floor(CHUNK_SEC * SR);
const bytes = readFileSync("public/models/stem/htdemucs_ft_drums_fp16.onnx");
console.log("model:", (bytes.length / 1048576).toFixed(1), "MB");

const session = await ort.InferenceSession.create(new Uint8Array(bytes), {
  executionProviders: ["wasm"],
});
console.log("CREATE OK · inputs", JSON.stringify(session.inputNames), "· outputs", JSON.stringify(session.outputNames));

// stereo planar [1, 2, N]
const mix = new Float32Array(N2 * 2);
for (let i = 0; i < N2; i++) {
  const t = i / SR;
  const v = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.02 * (Math.sin(i * 12.9898) * 43758.5453 % 1);
  mix[i] = v;
  mix[N + i] = v;
}
const input = new ort.Tensor("float32", mix, [1, 2, N2]);
const started = Date.now();
const out = await session.run({ mix: input });
const elapsed = (Date.now() - started) / 1000;
const outputName = session.outputNames[0];
const tensor = out[outputName];
console.log("RUN OK ·", elapsed.toFixed(2), "s · dims", JSON.stringify(tensor.dims));
const data = tensor.data as Float32Array;
let energy = 0;
let nonZero = 0;
for (let i = 0; i < Math.min(data.length, 100000); i += 7) {
  energy += data[i] * data[i];
  if (data[i] !== 0) nonZero++;
}
console.log("non-silent:", energy > 0 ? "yes" : "NO", "· rms sample:", Math.sqrt(energy / Math.max(1, Math.floor(100000 / 7))).toFixed(4));
await session.release();
