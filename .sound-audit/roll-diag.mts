import { readFileSync } from "node:fs";
import path from "node:path";
const SR = 44100;
function decodeCurated(file: string): Float32Array {
  const buf = readFileSync(path.resolve(process.cwd(), "public", "samples", file));
  let pos = 12;
  let fmt: { pos: number } | null = null;
  let data: { pos: number; size: number } | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { pos: pos + 8 };
    else if (id === "data") { data = { pos: pos + 8, size }; break; }
    pos += 8 + size + (size % 2);
  }
  const channels = buf.readUInt16LE(fmt!.pos + 2);
  const frames = Math.floor(data!.size / 3 / channels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = data!.pos + f * channels * 3;
    out[f] = ((buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)) << 8) / 2147483648;
  }
  return out;
}
const roll = decodeCurated("factory.crash.roll.wav");
console.log("roll length:", roll.length, "=", (roll.length / SR).toFixed(2), "s");
const rms = (w: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < w.length; i++) sum += w[i] * w[i];
  return Math.sqrt(sum / w.length);
};
for (let t = 0; t < roll.length / SR; t += 0.2) {
  const w = roll.subarray(Math.floor(t * SR), Math.floor((t + 0.2) * SR));
  if (w.length === 0) break;
  console.log(`t=${t.toFixed(1)}s rms=${rms(w).toFixed(5)}`);
}
