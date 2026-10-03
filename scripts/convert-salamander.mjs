/**
 * SALAMANDER INGEST — converts the Salamander Grand Piano V3 (44.1kHz/16-bit
 * close mic, CC-BY 3.0) into a KYX on-demand sample pack.
 *
 * Input : D:\sample-sources\salamander\SalamanderGrandPianoV3_44.1khz16bit\44.1khz16bit\{Note}v{N}.wav
 * Output: public/samples/piano/{id}.wav + src/presets/piano-pack.generated.ts
 *
 * Conversion (the standard multisample prep):
 *   - subset: 4 velocity zones per key (evenly spaced across the layers the
 *     key actually ships: pp / mf / f / ff) — 16 raw layers would bloat the
 *     pack for negligible fidelity gain,
 *   - trim: leading silence (−50 dBFS) with 20 ms pre-roll, natural end
 *     (−55 dBFS floor, min 0.5 s) + 120 ms fade-out,
 *   - normalize: each key's LOUDEST layer → −1.5 dBFS peak; the same gain
 *     applies to ALL layers of that key (velocity dynamics preserved),
 *   - stereo → keep (Salamander close is stereo; the sampler plays stereo).
 *
 * Zero dependencies — minimal WAV parse/encode inline (same as the sound
 * gate's decoder). Run: node scripts/convert-salamander.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC = "D:/sample-sources/salamander/SalamanderGrandPianoV3_44.1khz16bit/44.1khz16bit";
const OUT_DIR = "public/samples/piano";
const GENERATED = "src/presets/piano-pack.generated.ts";
const VELOCITY_ZONES = 4;
const TRIM_DB = -50;
const END_DB = -55;
const PEAK_TARGET = Math.pow(10, -1.5 / 20);
const MIN_NOTE = 21; // A0
const MAX_NOTE = 108; // C8

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteToMidi = (name) => {
  const m = /^([A-G]#?)(-?\d+)$/.exec(name);
  if (!m) return null;
  const pc = NOTE_NAMES.indexOf(m[1]);
  if (pc < 0) return null;
  return (Number(m[2]) + 1) * 12 + pc;
};

function decodeWav16(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not RIFF/WAVE");
  }
  let pos = 12;
  let dataStart = -1;
  let dataBytes = 0;
  let channels = 1;
  let bits = 16;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      // fmt chunk body starts at pos+8: [0..1] format, [2..3] channels,
      // [4..7] rate, [8..9] byteRate, [12..13] bits.
      channels = buf.readUInt16LE(pos + 10);
      bits = buf.readUInt16LE(pos + 22);
    } else if (id === "data") {
      dataStart = pos + 8;
      dataBytes = size;
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (dataStart < 0 || bits !== 16) throw new Error(`unsupported WAV (${bits}-bit)`);
  const frames = Math.floor(dataBytes / (2 * channels));
  const left = new Float32Array(frames);
  const right = channels > 1 ? new Float32Array(frames) : null;
  for (let i = 0; i < frames; i++) {
    left[i] = buf.readInt16LE(dataStart + i * 2 * channels) / 32768;
    if (right) right[i] = buf.readInt16LE(dataStart + i * 2 * channels + 2) / 32768;
  }
  return { left, right, frames };
}

function encodeWav16(channels) {
  const frames = channels[0].length;
  const nch = channels.length;
  const bytes = new Buffer.alloc(44 + frames * nch * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + frames * nch * 2, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(nch, 22);
  bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(44100 * nch * 2, 28);
  bytes.writeUInt16LE(nch * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * nch * 2, 40);
  let pos = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of channels) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      bytes.writeInt16LE(Math.round(v * 32767), pos);
      pos += 2;
    }
  }
  return bytes;
}

const dbfsToLinear = (db) => Math.pow(10, db / 20);

/** First sample index above TRIM_DB (with 20 ms pre-roll kept). */
function trimStart(data, sr) {
  const threshold = dbfsToLinear(TRIM_DB);
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > threshold) return Math.max(0, i - Math.round(sr * 0.02));
  }
  return 0;
}

/** Natural end: last index above END_DB + 120 ms fade. */
function trimEnd(data, sr) {
  const threshold = dbfsToLinear(END_DB);
  let last = data.length - 1;
  for (let i = data.length - 1; i >= 0; i--) {
    if (Math.abs(data[i]) > threshold) {
      last = i;
      break;
    }
  }
  const fade = Math.round(sr * 0.12);
  return Math.min(data.length, last + fade);
}

function peakOf(data, from, to) {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(data[i]));
  return peak;
}

function main() {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".wav"));
  if (files.length < 100) throw new Error(`expected the extracted Salamander WAVs in ${SRC}, found ${files.length}`);

  // Group: note → sorted velocity layers
  const byNote = new Map();
  for (const file of files) {
    const m = /^([A-G]#?\d)v(\d+)\.wav$/.exec(file);
    if (!m) continue;
    const note = m[1];
    const vel = Number(m[2]);
    if (!byNote.has(note)) byNote.set(note, []);
    byNote.get(note).push({ file, vel });
  }
  const notes = [...byNote.keys()];
  const midiOf = (name) => noteToMidi(name);
  const minMidi = Math.min(...notes.map(midiOf).filter((n) => n !== null));
  const maxMidi = Math.max(...notes.map(midiOf).filter((n) => n !== null));
  console.log(`keys: ${notes.length} (${notes.length * VELOCITY_ZONES} samples planned), midi ${minMidi}..${maxMidi}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const layers = [];
  let written = 0;
  let skippedLowVel = 0;

  for (const [note, layersIn] of [...byNote.entries()].sort((a, b) => noteToMidi(a[0]) - noteToMidi(b[0]))) {
    const midi = midiOf(note);
    if (midi === null || midi < MIN_NOTE || midi > MAX_NOTE) continue;
    layersIn.sort((a, b) => a.vel - b.vel);
    // Evenly spaced subset across the key's actual layer count (pp→ff).
    const count = layersIn.length;
    const picks = new Set();
    for (let z = 0; z < VELOCITY_ZONES; z++) {
      const index = Math.min(count - 1, Math.round((z / (VELOCITY_ZONES - 1)) * (count - 1)));
      picks.add(index);
    }
    const chosen = [...picks].sort((a, b) => a - b).map((i) => layersIn[i]);
    if (chosen.length < 2) {
      skippedLowVel += 1;
      continue;
    }

    // Decode all chosen layers once; find the key's loudest peak for the
    // shared per-key gain (velocity dynamics preserved).
    const decoded = chosen.map(({ file }) => ({ file, wav: decodeWav16(readFileSync(path.join(SRC, file))) }));
    let keyPeak = 0;
    for (const { wav } of decoded) keyPeak = Math.max(keyPeak, peakOf(wav.left, 0, wav.frames));
    if (keyPeak <= 0) continue;
    const gain = Math.min(4, PEAK_TARGET / keyPeak);

    chosen.forEach(({ file }, z) => {
      const { left, right, frames } = decoded[z].wav;
      const sr = 44100;
      const from = trimStart(left, sr);
      const to = trimEnd(left, sr);
      const outFrames = Math.max(to - from, Math.round(sr * 0.1));
      const chL = new Float32Array(outFrames);
      const chR = right ? new Float32Array(outFrames) : null;
      const fadeFrom = Math.max(0, outFrames - Math.round(sr * 0.12));
      for (let i = 0; i < outFrames; i++) {
        const src = Math.min(from + i, left.length - 1);
        const fade = i >= fadeFrom ? 1 - (i - fadeFrom) / (outFrames - fadeFrom) : 1;
        chL[i] = left[src] * gain * fade;
        if (chR) chR[i] = right[src] * gain * fade;
      }
      const pc = ((midi % 12) + 12) % 12;
      const id = `factory.piano.${NOTE_NAMES[pc].replace("#", "s")}${Math.floor(midi / 12) - 1}.z${z + 1}`
        .toLowerCase();
      writeFileSync(path.join(OUT_DIR, `${id}.wav`), encodeWav16(chR ? [chL, chR] : [chL]));
      const velMin = z / VELOCITY_ZONES;
      const velMax = z === VELOCITY_ZONES - 1 ? 1 : (z + 1) / VELOCITY_ZONES;
      layers.push({
        id: `layer.piano.${midi}.z${z + 1}`,
        sampleId: id,
        min: velMin,
        max: velMax,
        minPitch: midi,
        maxPitch: midi,
        root: midi,
      });
      written += 1;
    });
  }

  writeFileSync(
    GENERATED,
    `/**\n * GENERATED by scripts/convert-salamander.mjs — do not edit by hand.\n * Source: Salamander Grand Piano V3 44.1kHz/16-bit close (CC-BY 3.0,\n * Alexander Holm) — see src/sample-library/licenses.ts PACK_CREDITS.\n * ${written} samples: ${notes.length} keys × ${VELOCITY_ZONES} velocity zones.\n */\nimport type { SampleLayer } from "../project-model/types";\n\nexport const PIANO_PACK_LAYERS: SampleLayer[] = ${JSON.stringify(layers, null, 2)};\n`,
  );
  console.log(`written: ${written} wav files → ${OUT_DIR}`);
  console.log(`layers: ${layers.length} → ${GENERATED}`);
  if (skippedLowVel) console.log(`keys skipped (fewer than 2 usable layers): ${skippedLowVel}`);
}

main();
