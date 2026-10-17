/**
 * Write a provenance-stamped 32-bit float WAV fixture, using the app's real
 * encoder and manifest builder — for the `kyx-verify` acceptance runs
 * (`npx kyx-verify <file>` must say VERIFIED) and for the manual release
 * checklist. Usage: `npm run verify:wav:fixture -- <out.wav>`.
 */
import { writeFileSync } from "node:fs";
import { createDefaultProject } from "../src/project-model/schema";
import { buildRenderManifest, hashPcmChannels, manifestToIxml } from "../src/export/renderManifest";
import { encodeWav } from "../src/rendering/wav";

const sr = 44100;
const length = 4096;
const left = new Float32Array(length);
const right = new Float32Array(length);
for (let i = 0; i < length; i += 1) {
  left[i] = Math.sin(i * 0.01) * 0.5;
  right[i] = Math.cos(i * 0.013) * 0.4;
}
const buffer = {
  numberOfChannels: 2,
  length,
  sampleRate: sr,
  duration: length / sr,
  getChannelData: (channel: number) => (channel === 0 ? left : right),
} as unknown as AudioBuffer;

const doc = createDefaultProject();
const renderHash = await hashPcmChannels([left, right]);
const manifest = buildRenderManifest({
  doc,
  scope: "master",
  mode: "song",
  sampleRate: sr,
  bitDepth: 32,
  durationSec: buffer.duration,
  renderHash,
  date: new Date("2026-10-17T00:00:00.000Z"),
});
const bytes = new Uint8Array(encodeWav(buffer, 32, { ixml: manifestToIxml(manifest) }));
const out = process.argv[2];
if (!out) throw new Error("usage: npm run verify:wav:fixture -- <out.wav>");
writeFileSync(out, bytes);
console.log(`stamped ${out} · hash ${renderHash?.slice(0, 12)}`);
