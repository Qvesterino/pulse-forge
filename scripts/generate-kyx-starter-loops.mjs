#!/usr/bin/env node
/**
 * Generate the first KYX-authored starter loop pack from deterministic DSP.
 * No third-party samples, recordings, or source compositions are used.
 *
 * Output is intentionally small and optional: eight four-bar stereo WAVs and
 * a versioned manifest. Run with `node scripts/generate-kyx-starter-loops.mjs`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SAMPLE_RATE = 22050;
const BARS = 4;
const OUTPUT = resolve("public/samples/kyx-starter-loops");

const loops = [
  {
    id: "kyx.loop.v1.house.midnight-drums",
    file: "house-midnight-drums.wav",
    name: "Midnight House Drums",
    bpm: 124,
    genre: "House",
    mood: "deep",
    instrument: "Drums",
    key: "Any",
    kind: "house-drums",
    seed: 1201,
  },
  {
    id: "kyx.loop.v1.house.afterhours-keys",
    file: "house-afterhours-keys.wav",
    name: "Afterhours Keys",
    bpm: 124,
    genre: "House",
    mood: "warm",
    instrument: "Keys",
    key: "C minor",
    kind: "house-keys",
    seed: 1202,
  },
  {
    id: "kyx.loop.v1.techno.warehouse-drums",
    file: "techno-warehouse-drums.wav",
    name: "Warehouse Drums",
    bpm: 132,
    genre: "Techno",
    mood: "aggressive",
    instrument: "Drums",
    key: "Any",
    kind: "techno-drums",
    seed: 1301,
  },
  {
    id: "kyx.loop.v1.techno.acid-pulse",
    file: "techno-acid-pulse.wav",
    name: "Acid Pulse",
    bpm: 132,
    genre: "Techno",
    mood: "dark",
    instrument: "Bass",
    key: "E minor",
    kind: "acid-bass",
    seed: 1302,
  },
  {
    id: "kyx.loop.v1.ukg.two-step-drums",
    file: "ukg-two-step-drums.wav",
    name: "Two-Step Drums",
    bpm: 132,
    genre: "UK Garage",
    mood: "bright",
    instrument: "Drums",
    key: "Any",
    kind: "ukg-drums",
    seed: 1401,
  },
  {
    id: "kyx.loop.v1.ukg.soul-stabs",
    file: "ukg-soul-stabs.wav",
    name: "Soul Stabs",
    bpm: 132,
    genre: "UK Garage",
    mood: "warm",
    instrument: "Keys",
    key: "F minor",
    kind: "ukg-keys",
    seed: 1402,
  },
  {
    id: "kyx.loop.v1.trap.half-time-drums",
    file: "trap-half-time-drums.wav",
    name: "Half-Time Drums",
    bpm: 140,
    genre: "Trap",
    mood: "dark",
    instrument: "Drums",
    key: "Any",
    kind: "trap-drums",
    seed: 1501,
  },
  {
    id: "kyx.loop.v1.trap.soft-808",
    file: "trap-soft-808.wav",
    name: "Soft 808 Phrase",
    bpm: 140,
    genre: "Trap",
    mood: "deep",
    instrument: "808 Bass",
    key: "C minor",
    kind: "trap-808",
    seed: 1502,
  },
];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function midiHz(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

function synthLoop(loop) {
  const frames = Math.round((60 / loop.bpm) * 4 * BARS * SAMPLE_RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const random = mulberry32(loop.seed);
  const stepSec = 60 / loop.bpm / 4;

  const addVoice = (step, note, duration, level, shape = "saw", pan = 0, cutoff = 1) => {
    const start = Math.round(step * stepSec * SAMPLE_RATE);
    const end = Math.min(frames, start + Math.round(duration * SAMPLE_RATE));
    const frequency = midiHz(note);
    const phaseOffset = random() * Math.PI * 2;
    const panL = Math.sqrt((1 - pan) * 0.5);
    const panR = Math.sqrt((1 + pan) * 0.5);
    let lowpass = 0;
    for (let i = start; i < end; i++) {
      const t = (i - start) / SAMPLE_RATE;
      const age = t / duration;
      const envelope = Math.min(1, t / 0.008) * Math.exp(-t * (shape === "pad" ? 4.2 : 7.5));
      const phase = 2 * Math.PI * frequency * t + phaseOffset;
      let sample =
        shape === "sine"
          ? Math.sin(phase)
          : shape === "square"
            ? Math.tanh(Math.sin(phase) * 2.8)
            : 2 * ((phase / (2 * Math.PI)) % 1) - 1;
      if (shape === "pad")
        sample = Math.sin(phase) * 0.7 + Math.sin(phase * 2.003) * 0.2 + Math.sin(phase * 3.01) * 0.1;
      lowpass += (sample - lowpass) * cutoff;
      const value = lowpass * envelope * level;
      left[i] += value * panL;
      right[i] += value * panR;
      if (age >= 1) break;
    }
  };

  const addKick = (step, velocity = 1, tuned = false) => {
    const start = Math.round(step * stepSec * SAMPLE_RATE);
    const length = Math.round(0.34 * SAMPLE_RATE);
    for (let n = 0; n < length && start + n < frames; n++) {
      const t = n / SAMPLE_RATE;
      const frequency = (tuned ? 58 : 68) * Math.exp(-t * 22) + 37;
      const tone = Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t * 10.5);
      const click = (random() * 2 - 1) * Math.exp(-t * 290) * 0.13;
      const value = (tone + click) * velocity * 0.68;
      left[start + n] += value;
      right[start + n] += value;
    }
  };

  const addSnare = (step, velocity = 0.7, clap = false) => {
    const start = Math.round(step * stepSec * SAMPLE_RATE);
    const length = Math.round((clap ? 0.23 : 0.19) * SAMPLE_RATE);
    let previous = 0;
    for (let n = 0; n < length && start + n < frames; n++) {
      const t = n / SAMPLE_RATE;
      const noise = random() * 2 - 1;
      const high = noise - previous;
      previous = noise;
      const body = Math.sin(2 * Math.PI * (clap ? 240 : 185) * t) * Math.exp(-t * 17) * 0.25;
      let envelope = Math.exp(-t * (clap ? 25 : 19));
      if (clap) envelope *= 0.58 + 0.42 * Math.max(0, Math.sin(t * 2 * Math.PI * 24));
      const value = (high * 0.27 + body) * envelope * velocity;
      left[start + n] += value * 0.73;
      right[start + n] += value * 0.73;
    }
  };

  const addHat = (step, velocity = 0.35, open = false, pan = 0) => {
    const start = Math.round(step * stepSec * SAMPLE_RATE);
    const length = Math.round((open ? 0.26 : 0.065) * SAMPLE_RATE);
    const panL = Math.sqrt((1 - pan) * 0.5);
    const panR = Math.sqrt((1 + pan) * 0.5);
    let previous = 0;
    for (let n = 0; n < length && start + n < frames; n++) {
      const t = n / SAMPLE_RATE;
      const noise = random() * 2 - 1;
      const high = noise - previous;
      previous = noise;
      const envelope = Math.exp(-t * (open ? 14 : 48));
      const metallic = Math.sin(2 * Math.PI * 7900 * t) * 0.13 + Math.sin(2 * Math.PI * 11200 * t) * 0.08;
      const value = (high * 0.3 + metallic) * envelope * velocity;
      left[start + n] += value * panL;
      right[start + n] += value * panR;
    }
  };

  const addBass = (step, note, duration, level = 0.23, glide = 0) => {
    const start = Math.round(step * stepSec * SAMPLE_RATE);
    const length = Math.round(duration * SAMPLE_RATE);
    const frequency = midiHz(note);
    for (let n = 0; n < length && start + n < frames; n++) {
      const t = n / SAMPLE_RATE;
      const bend = glide ? Math.exp(-t * 7) * glide : 0;
      const phase = 2 * Math.PI * (frequency * (1 + bend)) * t;
      const fundamental = Math.sin(phase);
      const harmonic = Math.sin(phase * 2.01) * 0.16;
      const envelope = Math.min(1, t / 0.012) * Math.exp(-t * 2.8);
      const value = Math.tanh((fundamental + harmonic) * 1.35) * envelope * level;
      left[start + n] += value;
      right[start + n] += value;
    }
  };

  const addChord = (step, root, duration = 0.27, level = 0.11, pan = 0) => {
    const notes = [root, root + 3, root + 7, root + 10];
    notes.forEach((note, index) =>
      addVoice(step, note, duration, level / (index === 3 ? 2.2 : 1), "pad", pan + (index - 1.5) * 0.13, 0.24),
    );
  };

  for (let bar = 0; bar < BARS; bar++) {
    const offset = bar * 16;
    switch (loop.kind) {
      case "house-drums":
        [0, 4, 8, 12].forEach((s) => addKick(offset + s, s === 8 && bar % 2 ? 0.84 : 0.95));
        [4, 12].forEach((s) => addSnare(offset + s, bar === 3 && s === 12 ? 0.45 : 0.38, true));
        [2, 6, 10, 14].forEach((s, i) => addHat(offset + s, i === 3 ? 0.42 : 0.31, i === 3, i % 2 ? 0.18 : -0.16));
        [3, 11].forEach((s) => addHat(offset + s, 0.13, false, 0.2));
        [0, 6, 8, 14].forEach((s) => addBass(offset + s, 36, s === 14 ? 0.2 : 0.34, s === 8 ? 0.24 : 0.2));
        break;
      case "house-keys":
        [2, 6, 10, 14].forEach((s, i) =>
          addChord(offset + s, i === 2 ? 60 : 60, 0.3, i === 3 ? 0.095 : 0.12, i % 2 ? 0.18 : -0.18),
        );
        [7, 15].forEach((s) => addVoice(offset + s, 72, 0.12, 0.055, "sine", 0.32));
        break;
      case "techno-drums":
        [0, 4, 8, 12].forEach((s) => addKick(offset + s, 0.92, true));
        [4, 12].forEach((s) => addSnare(offset + s, 0.47, true));
        [2, 6, 10, 14].forEach((s) => addHat(offset + s, 0.39, s === 14, s % 4 === 2 ? 0.14 : -0.11));
        [0, 3, 6, 8, 11, 14].forEach((s) => addBass(offset + s, 40, 0.19, s % 4 === 0 ? 0.26 : 0.17));
        break;
      case "acid-bass":
        [0, 3, 6, 8, 11, 14].forEach((s, i) =>
          addBass(offset + s, [52, 55, 59, 52, 57, 59][i], 0.22, i === 2 ? 0.31 : 0.24, i === 5 ? 0.42 : 0),
        );
        [6, 14].forEach((s) => addVoice(offset + s, 76, 0.08, 0.07, "square", 0.12, 0.2));
        break;
      case "ukg-drums":
        [0, 7, 10].forEach((s, i) => addKick(offset + s, i === 1 ? 0.66 : 0.88));
        [4, 12].forEach((s) => addSnare(offset + s, 0.66, true));
        [2, 6, 10, 14].forEach((s, i) => addHat(offset + s, i === 1 ? 0.28 : 0.36, i === 3, i % 2 ? 0.2 : -0.2));
        [3, 7, 11, 15].forEach((s, i) => addHat(offset + s, i % 2 ? 0.2 : 0.13, false, 0.1));
        break;
      case "ukg-keys":
        [2, 7, 10, 15].forEach((s, i) =>
          addChord(offset + s, i % 2 ? 65 : 65, 0.23, i === 3 ? 0.12 : 0.1, i % 2 ? 0.24 : -0.24),
        );
        [5, 13].forEach((s) => addVoice(offset + s, 77, 0.1, 0.045, "sine", 0.3));
        break;
      case "trap-drums":
        [0, 7, 10].forEach((s, i) => addKick(offset + s, i === 1 ? 0.7 : 0.92, true));
        [8].forEach((s) => addSnare(offset + s, 0.75, true));
        for (let s = 0; s < 16; s += 2)
          addHat(offset + s, s === 14 && bar % 2 === 1 ? 0.2 : 0.3, false, s % 4 ? 0.16 : -0.16);
        [6, 7, 14, 15].forEach((s) => addHat(offset + s, 0.16, false, 0.1));
        break;
      case "trap-808":
        addBass(offset, 36, 0.95, 0.35, 0.26);
        addBass(offset + 6, 36, 0.34, 0.24);
        addBass(offset + 10, 39, 0.62, 0.31, bar % 2 ? 0.18 : 0);
        addBass(offset + 14, 43, 0.29, 0.22, 0.1);
        break;
    }
  }

  // A short end fade keeps the last tail clean when the loop repeats.
  const fadeFrames = Math.round(0.012 * SAMPLE_RATE);
  for (let i = 0; i < fadeFrames; i++) {
    const gain = 1 - i / fadeFrames;
    left[frames - fadeFrames + i] *= gain;
    right[frames - fadeFrames + i] *= gain;
  }

  const bytes = Buffer.allocUnsafe(44 + frames * 4);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 4, 40);
  const softClipNorm = 0.88 / Math.tanh(1.45);
  for (let i = 0; i < frames; i++) {
    const l = Math.tanh(left[i] * 1.45) * softClipNorm;
    const r = Math.tanh(right[i] * 1.45) * softClipNorm;
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l * 32767))), 44 + i * 4);
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r * 32767))), 46 + i * 4);
  }
  return { bytes, duration: frames / SAMPLE_RATE };
}

mkdirSync(OUTPUT, { recursive: true });
const manifest = {
  version: 1,
  pack: { id: "kyx-starter-loops", name: "KYX Starter Loops", license: "kyx-original", creator: "KYX", bars: BARS },
  assets: loops.map((loop) => {
    const { bytes, duration } = synthLoop(loop);
    const path = resolve(OUTPUT, loop.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return {
      id: loop.id,
      name: loop.name,
      fileName: loop.file,
      url: `/samples/kyx-starter-loops/${loop.file}`,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      duration: Number(duration.toFixed(6)),
      bpm: loop.bpm,
      genre: loop.genre,
      mood: loop.mood,
      instrument: loop.instrument,
      key: loop.key,
    };
  }),
};
writeFileSync(resolve(OUTPUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const totalBytes = manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
console.log(
  `[kyx-starter-loops] ${manifest.assets.length} loops · ${(totalBytes / 1048576).toFixed(2)} MB · deterministic WAV output`,
);
