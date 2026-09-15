// Generates the promo soundtrack: a 4-bar house loop at 124 BPM synthesized
// from scratch (kick / hats / clap / sub bass), written as 16-bit stereo WAV.
// On-brand: the promo's sound is as programmatic as the product.
// Usage: node scripts/make-promo-beat.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SR = 44100;
const BPM = 124;
const BEAT = 60 / BPM;
const BARS = 4;
const DUR = BEAT * 4 * BARS; // ≈ 7.742 s
const N = Math.floor(DUR * SR);

const L = new Float64Array(N);
const R = new Float64Array(N);
const rand = (() => {
  let a = 0x9e3779b9 >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();

const add = (i, v, pan = 0) => {
  const idx = Math.round(i);
  if (idx < 0 || idx >= N) return;
  L[idx] += v * (1 - Math.max(0, pan));
  R[idx] += v * (1 + Math.min(0, pan));
};

/** Pitch-dropping sine kick with a beater click. */
const kick = (startSec, gain = 1) => {
  const start = Math.floor(startSec * SR);
  const len = Math.floor(0.28 * SR);
  const fStart = 160, fEnd = 44, fDrop = 0.045;
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = fEnd + (fStart - fEnd) * Math.exp(-t / fDrop);
    phase += (2 * Math.PI * f) / SR;
    const env = Math.exp(-t / 0.11);
    const click = i < 90 ? (rand() * 2 - 1) * Math.exp(-i / 30) * 0.5 : 0;
    add(start + i, (Math.sin(phase) * env + click) * 0.9 * gain);
  }
};

/** Closed hat: differentiated noise (high-pass-ish), fast decay. */
const hat = (startSec, gain = 1, decay = 0.028) => {
  const start = Math.floor(startSec * SR);
  const len = Math.floor(decay * 4 * SR);
  let prev = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.exp(-t / (decay / 3));
    const n = rand() * 2 - 1;
    const hp = n - prev;
    prev = n;
    const pan = (rand() - 0.5) * 0.5;
    add(start + i, hp * env * 0.32 * gain, pan);
  }
};

/** Clap: three fast pre-bursts then a body tail. */
const clap = (startSec, gain = 1) => {
  const start = Math.floor(startSec * SR);
  const bursts = [0, 0.011, 0.02];
  let prev = 0;
  for (let i = 0; i < Math.floor(0.2 * SR); i++) {
    const t = i / SR;
    let env = 0;
    for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) / 0.008));
    env += Math.exp(-t / 0.06) * 0.5;
    const n = rand() * 2 - 1;
    const hp = n - prev;
    prev = n;
    add(start + i, hp * env * 0.35 * gain, 0.12);
  }
};

/** Sub bass note with a sidechain-style dip right after each kick. */
const bass = (startSec, durSec, freq, gain = 1) => {
  const start = Math.floor(startSec * SR);
  const len = Math.floor(durSec * SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    // 4 kicks per bar → dip period = BEAT
    const phaseInBeat = (t % BEAT) / BEAT;
    const duck = 0.35 + 0.65 * Math.min(1, phaseInBeat * 3.2);
    const env = Math.min(1, t / 0.01) * Math.exp(-t / (durSec * 0.9));
    const v =
      (Math.sin(2 * Math.PI * freq * t) * 0.8 + Math.sin(4 * Math.PI * freq * t) * 0.12) * env * duck * gain;
    add(start + i, v);
  }
};

// ── Score: 4 bars of house at 124 ────────────────────────────────────────────
for (let bar = 0; bar < BARS; bar++) {
  const barStart = bar * 4 * BEAT;
  for (let beat = 0; beat < 4; beat++) kick(barStart + beat * BEAT);
  // offbeat hats (the 8th-note "and" of every beat), alternating shade
  for (let beat = 0; beat < 4; beat++) hat(barStart + beat * BEAT + BEAT / 2, beat % 2 ? 0.8 : 1);
  hat(barStart + 3.75 * BEAT, 0.5, 0.05); // 16th pickup at the bar's end
  clap(barStart + 2 * BEAT, bar === 0 ? 0.7 : 1); // backbeat clap
  // Bass: A1 / A1 / C2 / G1 feel — sub weight with sidechain pump
  const notes = [55, 55, 65.4, 49][bar % 4];
  bass(barStart, 4 * BEAT, notes, bar === 0 ? 0.6 : 1);
  // tiny sparkle: random 16th shaker ghosts in bars 3-4
  if (bar >= 2) for (let k = 0; k < 3; k++) hat(barStart + rand() * 4 * BEAT, 0.35, 0.02);
}

// ── Master: soft clip + normalize to −1 dBFS ────────────────────────────────
let peak = 0;
for (let i = 0; i < N; i++) {
  for (const ch of [L, R]) {
    ch[i] = Math.tanh(ch[i] * 1.2);
    peak = Math.max(peak, Math.abs(ch[i]));
  }
}
const norm = 0.89 / peak;

// ── WAV encode (16-bit PCM stereo) ──────────────────────────────────────────
const dataBytes = N * 4; // 2 ch × 2 bytes
const buf = Buffer.alloc(44 + dataBytes);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(2, 22); // stereo
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(dataBytes, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * norm * 32767))), 44 + i * 4);
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * norm * 32767))), 46 + i * 4);
}

const outDir = path.join(root, "remotion", "public");
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "beat.wav");
writeFileSync(out, buf);
console.log(`beat.wav written: ${DUR.toFixed(2)}s @ ${SR}Hz, normalized to −1 dBFS → ${out}`);
