/**
 * UN-SUNO U0 — golden set generator + live estimator report.
 *
 * Renders the deterministic synthetic golden tracks (tests/unsuno/golden-synth.ts)
 * to 16-bit WAV under tests/unsuno/golden-wav/ (gitignored — regenerable by
 * definition, the tests never read these files, they synthesize in memory)
 * and prints the LIVE estimator report the U0 baseline was locked from.
 *
 * Run: npm run unsuno:golden
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateKey, estimateTempo } from "../src/ai/audio-tempo-key";
import { detectTransients } from "../src/audio-workers/onset-detector";
import { transcribeTrack } from "../src/reference/transcribe";
import { GOLDEN_SAMPLE_RATE, goldenTracks, renderGoldenTrack, stepToSample } from "../tests/unsuno/golden-synth";

function encodeWav16(pcm: Float32Array, sampleRate: number): Buffer {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

const outDir = join(process.cwd(), "tests", "unsuno", "golden-wav");
mkdirSync(outDir, { recursive: true });

const rows: string[] = [];
for (const track of goldenTracks()) {
  const pcm = renderGoldenTrack(track);
  writeFileSync(join(outDir, `${track.id}.wav`), encodeWav16(pcm, GOLDEN_SAMPLE_RATE));
  const t = transcribeTrack(pcm, GOLDEN_SAMPLE_RATE);
  const onsets = detectTransients(pcm, GOLDEN_SAMPLE_RATE, 1);
  const tempoError =
    t.tempo === null
      ? "null"
      : String(
          Math.min(
            Math.abs(t.tempo.bpm - track.bpm),
            Math.abs(t.tempo.bpm * 2 - track.bpm),
            Math.abs(t.tempo.bpm / 2 - track.bpm),
          ),
        );
  rows.push(
    [
      track.id,
      `truth ${track.bpm}`,
      `tempo ${t.tempo?.bpm ?? "null"} (err ${tempoError})`,
      `conf ${t.tempo?.confidence.toFixed(2) ?? "-"}`,
      `key ${t.key?.key ?? "null"} vs ${track.key.tonicPc} ${track.key.mode}`,
      `keyConf ${t.key?.confidence.toFixed(3) ?? "-"}`,
      `onsets ${onsets.length}`,
      `${(pcm.length / GOLDEN_SAMPLE_RATE).toFixed(1)}s`,
    ].join("  |  "),
  );
}
console.log(`Golden WAVs → ${outDir}`);
console.log(rows.join("\n"));
void stepToSample;
