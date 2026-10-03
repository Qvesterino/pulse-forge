/**
 * EAR-PASS LISTENING RENDERER — user-facing ABX pairs for the new/re-voiced
 * bank assets (sound audit gap waves). For each lane it renders the SAME
 * two-bar beat twice: once with the reference (nearest-neighbor) sample,
 * once with the new sample — the only variable is the sound under test.
 *
 * The ABX generator (npm run listening:abx) level-matches the pairs by
 * integrated LUFS before the page is built, so the listener judges
 * timbre, not loudness.
 *
 * Output: listening/abx/pairs/*.wav + listening/abx/lanes.json
 * Then:   npm run listening:abx && npm run listening:serve
 *
 * Run: npm run sound:earpass
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeWav } from "../.sound-audit/lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const samplesDir = path.join(root, "public", "samples");
const outDir = path.join(root, "listening", "abx", "pairs");
mkdirSync(outDir, { recursive: true });

const SR = 44100;
const BPM = 120;
const SIXTEENTH = 60 / BPM / 4;
const BARS = 2;
const TAIL = 1.2 * SR;

const sampleCache = new Map();
const LEGACY_COMMIT = "378ab368"; // last pre-campaign mastering state (old bank)
const legacyCache = new Map();
function sample(id) {
  if (id.startsWith("legacy.")) {
    const bankId = `factory.${id.slice("legacy.".length)}`;
    if (!legacyCache.has(bankId)) {
      // Extract the PRE-CAMPAIGN artifact straight from git history — the
      // shipped bank has long been overwritten by the mastering re-render.
      const wav = decodeWav(
        execSync(`git show ${LEGACY_COMMIT}:public/samples/${bankId}.wav`, {
          cwd: path.join(here, ".."),
          maxBuffer: 32 * 1024 * 1024,
        }),
      );
      legacyCache.set(bankId, wav.channels[0]);
    }
    return legacyCache.get(bankId);
  }
  if (!sampleCache.has(id)) {
    const wav = decodeWav(readFileSync(path.join(samplesDir, `factory.${id}.wav`)));
    sampleCache.set(id, wav.channels[0]); // mono voice
  }
  return sampleCache.get(id);
}

/** events: [id, step(0-based sixteenth, absolute), gain] → mixed Float32Array */
function renderBeat(events) {
  const total = Math.ceil(BARS * 16 * SIXTEENTH * SR + TAIL);
  const mix = new Float64Array(total);
  for (const [id, step, gain] of events) {
    const ch = sample(id);
    const at = Math.floor(step * SIXTEENTH * SR);
    for (let i = 0; i < ch.length && at + i < total; i++) mix[at + i] += ch[i] * gain;
  }
  return mix;
}

/** bed shared by every lane so the tested family sits in a real context */
const bed = [
  ["kick.punch", 0, 0.9],
  ["kick.punch", 8, 0.9],
  ["kick.punch", 16, 0.9],
  ["kick.punch", 24, 0.9],
  ["hat.closed", 2, 0.4],
  ["hat.closed", 6, 0.4],
  ["hat.closed", 10, 0.4],
  ["hat.closed", 14, 0.4],
  ["hat.closed", 18, 0.4],
  ["hat.closed", 22, 0.4],
  ["hat.closed", 26, 0.4],
  ["hat.closed", 30, 0.4],
  ["kick.808pure", 0, 0.55],
  ["kick.808pure", 16, 0.5],
];

function mixPair(events) {
  const mix = renderBeat(events);
  let peak = 0;
  for (const v of mix) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0.95 ? 0.95 / peak : 1; // anti-clip only; ABX level-matches by LUFS anyway
  const out = new Int16Array(mix.length);
  for (let i = 0; i < mix.length; i++) {
    const v = Math.max(-1, Math.min(1, mix[i] * scale));
    out[i] = Math.round(v * 32767);
  }
  return out;
}

function writeWavStereo(pcm, file) {
  const dataBytes = pcm.length * 2 * 2; // stereo, 16-bit
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // stereo
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2 * 2, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i];
    buf.writeInt16LE(v, o);
    buf.writeInt16LE(v, o + 2);
    o += 4;
  }
  writeFileSync(path.join(outDir, file), buf);
}

const OFFBEATS = [3, 7, 11, 15, 19, 23, 27, 31];
const BACKBEATS = [4, 12, 20, 28];

const LANES = [
  {
    lane: "snare-room-vs-main",
    fileA: "pairs/snare-main.wav",
    fileB: "pairs/snare-room.wav",
    label: "NEW snare.room — the only bank snare with a room tail (A = dry snare.main)",
    render: () => [...bed.map((e) => [...e]), ...BACKBEATS.map((s) => ["snare.main", s, 0.8])],
    renderB: () => [...bed.map((e) => [...e]), ...BACKBEATS.map((s) => ["snare.room", s, 0.8])],
  },
  {
    lane: "hat-wash-vs-open",
    fileA: "pairs/hat-open.wav",
    fileB: "pairs/hat-wash.wav",
    label: "NEW hat.wash — long offbeat wash, ping keeps it a HAT (A = hat.open)",
    render: () => [...bed.map((e) => [...e]), ...OFFBEATS.map((s) => ["hat.open", s, 0.55])],
    renderB: () => [...bed.map((e) => [...e]), ...OFFBEATS.map((s) => ["hat.wash", s, 0.55])],
  },
  {
    lane: "hat-open-cup-vs-open",
    fileA: "pairs/hat-open2.wav",
    fileB: "pairs/hat-cup.wav",
    label: "RE-VOICED hat.cup — dark, half-open (A = hat.open; old cup was a near-twin)",
    render: () => [...bed.map((e) => [...e]), ...OFFBEATS.map((s) => ["hat.open", s, 0.5])],
    renderB: () => [...bed.map((e) => [...e]), ...OFFBEATS.map((s) => ["hat.open.cup", s, 0.5])],
  },
  {
    lane: "crash-pop-vs-main",
    fileA: "pairs/crash-main.wav",
    fileB: "pairs/crash-pop.wav",
    label: "RE-VOICED crash.pop — bright splash, defined ping (A = wash-style old twin crash.main)",
    render: () => [...bed.map((e) => [...e]), ["crash.main", 0, 0.6]],
    renderB: () => [...bed.map((e) => [...e]), ["crash.pop", 0, 0.6]],
  },
  {
    lane: "clap-pop-vs-main",
    fileA: "pairs/clap-main.wav",
    fileB: "pairs/clap-pop.wav",
    label: "RE-VOICED clap.pop — gated bright clap, an octave of air (A = clap.main)",
    render: () => [...bed.map((e) => [...e]), ...BACKBEATS.map((s) => ["clap.main", s, 0.85])],
    renderB: () => [...bed.map((e) => [...e]), ...BACKBEATS.map((s) => ["clap.pop", s, 0.85])],
  },
  {
    lane: "fx-subdrop-vs-downlifter",
    fileA: "pairs/fx-downlifter.wav",
    fileB: "pairs/fx-subdrop.wav",
    label: "NEW fx.subdrop — C3→C1 sub drop for transitions (A = fx.downlifter)",
    render: () => [...bed.map((e) => [...e]), ["fx.downlifter", 0, 0.7]],
    renderB: () => [...bed.map((e) => [...e]), ["fx.subdrop", 0, 0.7]],
  },
  {
    lane: "fx-vinyl-bed",
    fileA: "pairs/beat-clean.wav",
    fileB: "pairs/beat-vinyl.wav",
    label: "NEW fx.vinyl — dust texture as a bed (A = clean beat, B = same + vinyl @0.5)",
    render: () => bed.map((e) => [...e]),
    renderB: () => [...bed.map((e) => [...e]), ["fx.vinyl", 0, 0.5]],
  },
  // ── LEGACY PAIRS (mastering wave): the OLD bank extracted from git
  // (commit 378ab368 — before the mastering convergence re-render). A =
  // pre-fix artifact, B = shipped. The exact rows the audit measured:
  // 808pure at −2.4 LUFS pinned on the limiter, off-semitone tuning rests.
  {
    lane: "legacy-kick-808pure",
    fileA: "pairs/legacy-kick-808pure.wav",
    fileB: "pairs/legacy-kick-808pure-new.wav",
    label:
      "MASTERING kick.808pure — OLD shipped at −2.4 LUFS (limiter-pinned) vs NEW on the −8 target. Which is cleaner?",
    render: () => [["legacy.kick.808pure", 0, 1]],
    renderB: () => [["kick.808pure", 0, 1]],
  },
  {
    lane: "legacy-kick-trap",
    fileA: "pairs/legacy-kick-trap.wav",
    fileB: "pairs/legacy-kick-trap-new.wav",
    label:
      "MASTERING + TUNING kick.trap — OLD pre-campaign (off-semitone rest, hot) vs NEW (G1 rest, on-target). Same groove both sides.",
    render: () => [
      ["legacy.kick.trap", 0, 1],
      ["legacy.kick.trap", 16, 0.95],
    ],
    renderB: () => [
      ["kick.trap", 0, 1],
      ["kick.trap", 16, 0.95],
    ],
  },
  {
    lane: "legacy-kick-808drive",
    fileA: "pairs/legacy-kick-808drive.wav",
    fileB: "pairs/legacy-kick-808drive-new.wav",
    label:
      "MASTERING kick.808drive — OLD hot ride vs NEW clean D1 rest. The flagship before/after of the mastering convergence.",
    render: () => [["legacy.kick.808drive", 0, 1]],
    renderB: () => [["kick.808drive", 0, 1]],
  },
];

const lanesJson = { lanes: [] };
for (const spec of LANES) {
  const aName = path.basename(spec.fileA);
  const bName = path.basename(spec.fileB);
  writeWavStereo(mixPair(spec.render()), aName);
  writeWavStereo(mixPair(spec.renderB()), bName);
  lanesJson.lanes.push({ lane: spec.lane, label: spec.label, fileA: spec.fileA, fileB: spec.fileB });
  console.log(`[earpass] ${spec.lane} ✓`);
}

writeFileSync(path.join(root, "listening", "abx", "lanes.json"), JSON.stringify(lanesJson, null, 2));
console.log(`[earpass] wrote ${LANES.length} lanes → listening/abx/lanes.json`);
console.log("[earpass] next: npm run listening:abx && npm run listening:serve");
