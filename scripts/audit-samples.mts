/**
 * SOUND LIBRARY AUDIT (npm run audit:samples) — the re-runnable diagnostic
 * behind the 2026-09-29/30 sound-library campaign, promoted from the
 * .sound-audit scratch tooling.
 *
 * Decodes every curated WAV in public/samples and prints:
 *   - per-category loudness/crest table vs the seed-renderer targets,
 *   - technical flags (clipping, DC, leading silence, dead air, LUFS drift),
 *   - low-end tuning glide for the pitch-anchored families,
 *   - nearest-neighbour redundancy watch (feature distance within category,
 *     time-aware since the 2026-10-04 metric correction - see the block above
 *     the FEATURE_DIMS table for why the old vector could not see a strike),
 *   - a GATE summary mirroring tests/sound-library-gate.test.ts thresholds.
 *
 * Options: --json=<file>, --pairs=<n> closest pairs per category (default 2),
 * --why = per-dimension breakdown of each printed pair, --window=<ms> = attack
 * window for the transient term (default 10 ms; 1-25 ms judges one-shots).
 *
 * Exit 0 = gate summary clean; exit 1 = at least one gate violation (the
 * vitest gate remains the enforcement — this is the human-eye companion).
 *
 * Run: npm run audit:samples
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { CURATED_SAMPLES } from "../src/sample-library/curated";
import { ANALYSIS_BANDS, analyzeTransientProfile } from "../src/analysis/transientProfile";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES_DIR = path.join(ROOT, "public", "samples");
const SR = 44100;

const args = process.argv.slice(2);
const jsonOut = args.find((a) => a.startsWith("--json="))?.slice(7);
const numArg = (flag: string, fallback: number): number => {
  const raw = args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const topPairs = Math.max(1, Math.round(numArg("--pairs", 2)));
/** attack window for the transient term - the 186 ms band average dilutes a sub-ms strike ~23 dB */
const attackWindowMs = numArg("--window", 10);
const why = args.includes("--why");

/* ── category targets: source-grepped from the seed renderer (sync-pin) ── */
function categoryTargets(): Record<string, number> {
  const source = readFileSync(path.join(ROOT, "scripts", "render-curated-seeds.mjs"), "utf8");
  const targets: Record<string, number> = {};
  for (const match of source.matchAll(/(\w+): \{ targetLufs: (-?\d+(?:\.\d+)?)/g)) {
    targets[match[1]] = Number(match[2]);
  }
  return targets;
}

/* ── WAV decode (the seeds are 24-bit PCM by contract; decoder is general) ── */
function decodeWav(buf: Buffer): { channels: Float32Array[]; sampleRate: number } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("not RIFF/WAVE");
  let pos = 12;
  let fmt: { pos: number } | null = null;
  let data: { pos: number; size: number } | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { pos: pos + 8 };
    else if (id === "data") {
      data = { pos: pos + 8, size };
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("missing fmt/data chunk");
  const audioFormat = buf.readUInt16LE(fmt.pos);
  const channels = buf.readUInt16LE(fmt.pos + 2);
  const sampleRate = buf.readUInt32LE(fmt.pos + 4);
  const bits = buf.readUInt16LE(fmt.pos + 14);
  const bytesPer = bits / 8;
  const frames = Math.floor(data.size / bytesPer / channels);
  const out: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(frames));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let f = 0; f < frames; f++) {
    for (let ch = 0; ch < channels; ch++) {
      const i = data.pos + (f * channels + ch) * bytesPer;
      let v = 0;
      if (audioFormat === 3 && bits === 32) v = view.getFloat32(i, true);
      else if (bits === 16) v = view.getInt16(i, true) / 32768;
      else if (bits === 24) v = ((buf[i]! | (buf[i + 1]! << 8) | (buf[i + 2]! << 16)) << 8) / 2147483648;
      else if (bits === 32 && audioFormat === 1) v = view.getInt32(i, true) / 2147483648;
      else throw new Error(`unsupported format ${audioFormat}/${bits}bit`);
      out[ch][f] = v;
    }
  }
  return { channels: out, sampleRate };
}

/* ── BS.1770 K-weighting + tiled momentary (seed-script convention) ── */
function kWeightingStages() {
  const shelfF0 = 1681.974450955533;
  const shelfGainDb = 3.9998438539736248;
  const shelfQ = 0.7071752369554196;
  const ks = Math.tan((Math.PI * shelfF0) / SR);
  const vh = Math.pow(10, shelfGainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const shelfA0 = 1 + ks / shelfQ + ks * ks;
  const hpF0 = 38.13547087602444;
  const hpQ = 0.5003270373238773;
  const kh = Math.tan((Math.PI * hpF0) / SR);
  const hpA0 = 1 + kh / hpQ + kh * kh;
  return [
    {
      b0: (vh + (vb * ks) / shelfQ + ks * ks) / shelfA0,
      b1: (2 * (ks * ks - vh)) / shelfA0,
      b2: (vh - (vb * ks) / shelfQ + ks * ks) / shelfA0,
      a1: (2 * (ks * ks - 1)) / shelfA0,
      a2: (1 - ks / shelfQ + ks * ks) / shelfA0,
    },
    { b0: 1, b1: -2, b2: 1, a1: (2 * (kh * kh - 1)) / hpA0, a2: (1 - kh / hpQ + kh * kh) / hpA0 },
  ];
}

function momentaryMaxLufs(channels: Float32Array[]): number {
  const minSamples = Math.ceil(0.45 * SR);
  const len = channels[0].length;
  const reps = len >= minSamples ? 1 : Math.max(1, Math.ceil(minSamples / Math.max(1, len)));
  const tiled = channels.map((c) => {
    if (reps === 1) return c;
    const out = new Float32Array(len * reps);
    for (let r = 0; r < reps; r++) out.set(c, r * len);
    return out;
  });
  const stages = kWeightingStages();
  const filtered = tiled.map((c) => {
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0,
      u1 = 0,
      u2 = 0,
      w1 = 0,
      w2 = 0;
    const o = new Float64Array(c.length);
    for (let i = 0; i < c.length; i++) {
      const s1 = stages[0];
      const shelf = s1.b0 * c[i] + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
      x2 = x1;
      x1 = c[i];
      y2 = y1;
      y1 = shelf;
      const s2 = stages[1];
      const hp = s2.b0 * shelf + s2.b1 * u1 + s2.b2 * u2 - s2.a1 * w1 - s2.a2 * w2;
      u2 = u1;
      u1 = shelf;
      w2 = w1;
      w1 = hp;
      o[i] = hp;
    }
    return o;
  });
  const sub = Math.round(0.1 * SR);
  const powers: number[] = [];
  for (let start = 0; start + sub <= filtered[0].length; start += sub) {
    let sum = 0;
    for (const ch of filtered) {
      let acc = 0;
      for (let i = start; i < start + sub; i++) acc += ch[i] * ch[i];
      sum += acc / sub;
    }
    powers.push(sum);
  }
  let maxL = -180;
  for (let k = 0; k + 4 <= powers.length; k++) {
    const ms = (powers[k] + powers[k + 1] + powers[k + 2] + powers[k + 3]) / 4;
    const l = ms > 1e-12 ? -0.691 + 10 * Math.log10(ms) : -180;
    if (l > maxL) maxL = l;
  }
  return maxL;
}

/* ── Welch spectrum + band shares + centroid ── */
function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const BANDS: ReadonlyArray<readonly [string, number, number]> = ANALYSIS_BANDS;

function bandShares(channel: Float32Array): Record<string, number> & { centroid: number } {
  const N = 4096;
  const pad = 8192;
  const hop = 2048;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  let winPow = 0;
  for (let i = 0; i < N; i++) winPow += win[i] * win[i];
  const nWindows = Math.max(1, Math.floor((channel.length - N) / hop) + 1);
  const acc = new Float64Array(pad / 2);
  for (let w = 0; w < nWindows; w++) {
    const start = Math.min(w * hop, Math.max(0, channel.length - N));
    const re = new Float64Array(pad);
    const im = new Float64Array(pad);
    for (let i = 0; i < N; i++) re[i] = (channel[start + i] ?? 0) * win[i];
    fftRadix2(re, im);
    for (let k = 0; k < pad / 2; k++) acc[k] += (re[k] * re[k] + im[k] * im[k]) / winPow;
  }
  const binHz = SR / pad;
  const shares: Record<string, number> = {};
  let total = 0;
  for (const [name, lo, hi] of BANDS) {
    let e = 0;
    for (let k = 0; k < acc.length; k++) {
      const f = k * binHz;
      if (f >= lo && f < hi) e += acc[k];
    }
    shares[name] = e;
    total += e;
  }
  let num = 0;
  for (let k = 0; k < acc.length; k++) num += k * binHz * acc[k];
  return {
    ...Object.fromEntries(
      Object.entries(shares).map(([k, e]) => [k, total > 0 ? 10 * Math.log10(Math.max(e, 1e-24) / total) : -120]),
    ),
    centroid: total > 0 ? num / total : 0,
  } as Record<string, number> & { centroid: number };
}

/* ── low-end tuning glide (parabolic peak) ── */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function lowTuning(
  channel: Float32Array,
  startSec: number,
  lenSec: number,
): { hz: number; note: number; cents: number } | null {
  const start = Math.floor(startSec * SR);
  const N = Math.min(Math.floor(lenSec * SR), channel.length - start);
  if (N < 512) return null;
  const pad = 32768;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(pad);
  const im = new Float64Array(pad);
  for (let i = 0; i < N; i++) re[i] = channel[start + i] * win[i];
  fftRadix2(re, im);
  const binHz = SR / pad;
  const loBin = Math.max(1, Math.floor(25 / binHz));
  const hiBin = Math.floor(130 / binHz);
  let best = loBin;
  let bestMag = 0;
  for (let k = loBin; k <= hiBin; k++) {
    const m = re[k] * re[k] + im[k] * im[k];
    if (m > bestMag) {
      bestMag = m;
      best = k;
    }
  }
  const m1 = re[best - 1] ** 2 + im[best - 1] ** 2;
  const m3 = re[best + 1] ** 2 + im[best + 1] ** 2;
  const denom = m1 + 2 * bestMag + m3;
  const delta = denom > 0 ? (0.5 * (m1 - m3)) / denom : 0;
  const hz = (best + delta) * binHz;
  const midi = 69 + 12 * Math.log2(hz / 440);
  const note = Math.round(midi);
  return { hz: Math.round(hz * 10) / 10, note, cents: Math.round((midi - note) * 100) };
}
const noteName = (midi: number): string => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/* ── per-band leading-window attack (transient term) ───────────────────────
 * The broadband head term is blind to an in-band strike BY CONSTRUCTION: a
 * sub-ms mallet contact at 2.6 kHz is a rounding error against the bar's own
 * low-mid body, so the whole-file ratio moves 0.0-0.1 dB on a strike fix.
 * Measured on the real pre/post pairs of the 2026-10 mallet wave
 * (tmp-old-*.wav): broadband 0.0-0.1 dB vs per-band 2.5-3.7 dB. The math now
 * lives in src/analysis/transientProfile.ts (shared with its vitest lock so
 * the printed table, the feature vector and the test cannot drift).
 */

/* ── per-file analysis ── */
interface Row {
  id: string;
  category: string;
  durationSec: number;
  peakDb: number;
  clipSamples: number;
  dcOffset: number;
  leadSilenceMs: number;
  leadGateMs: number;
  tailSilenceMs: number;
  loudMs: number;
  /* mean power of the first `attackWindowMs` ms after the first loud sample,
     relative to the loud span (dB). 0 dB = flat head, -10 dB = the attack
     carries a tenth of the energy. This is the axis the old vector lacked:
     every strike / click / transient change lives here. */
  attackDb: number;
  /* Per-band head/loud ratio (dB) + the strongest band. The broadband term
     above cannot see an in-band strike (a 2.6 kHz contact is a rounding
     error in broadband power); this one can. maxBand names WHERE the
     transient lives. */
  attackBandDb: Record<string, number>;
  attackBandMaxDb: number;
  attackBandMaxName: string;
  crestDb: number;
  momentaryLufs: number;
  bands: Record<string, number>;
  tuning: Record<string, { hz: number; name: string; cents: number }>;
}

function analyzeFile(file: string, id: string, category: string): Row {
  const { channels } = decodeWav(readFileSync(path.join(SAMPLES_DIR, file)));
  const main = channels[0];
  const frames = main.length;
  let peak = 0;
  let clip = 0;
  let dcSum = 0;
  for (let i = 0; i < frames; i++) {
    const a = Math.abs(main[i]);
    if (a > peak) peak = a;
    if (a >= 0.9995) clip += 1;
    dcSum += main[i];
  }
  const TH = 1e-3;
  let firstLoud = 0;
  while (firstLoud < frames && Math.abs(main[firstLoud]) <= TH) firstLoud++;
  let lastLoud = frames - 1;
  while (lastLoud > 0 && Math.abs(main[lastLoud]) <= TH) lastLoud--;
  let sumSq = 0;
  let cnt = 0;
  for (let i = firstLoud; i <= lastLoud; i++) {
    sumSq += main[i] * main[i];
    cnt++;
  }
  const rms = cnt > 0 ? Math.sqrt(sumSq / cnt) : 0;
  const crest = rms > 0 ? 20 * Math.log10(peak / rms) : 120;

  const attackFrames = Math.max(1, Math.round((attackWindowMs / 1000) * SR));
  const headStart = Math.min(firstLoud, Math.max(frames - 1, 0));
  const headEnd = Math.min(headStart + attackFrames, frames);
  let headSq = 0;
  for (let i = headStart; i < headEnd; i++) headSq += main[i] * main[i];
  const headMean = headEnd > headStart ? headSq / (headEnd - headStart) : 0;
  const loudMean = cnt > 0 ? sumSq / cnt : 0;
  const attackDb = loudMean > 1e-18 ? 10 * Math.log10(Math.max(headMean, 1e-18) / loudMean) : 0;
  const transient = analyzeTransientProfile(main, { windowMs: attackWindowMs, sampleRate: SR });

  const bands = bandShares(main);
  const tuning: Row["tuning"] = {};
  if (/kick|tom|808|sub/.test(id)) {
    const t = lowTuning(main, 0.3, 0.15);
    if (t) tuning.late = { hz: t.hz, name: noteName(t.note), cents: t.cents };
  }

  return {
    id,
    category,
    durationSec: Math.round((frames / SR) * 1000) / 1000,
    peakDb: Math.round(20 * Math.log10(Math.max(peak, 1e-6)) * 10) / 10,
    clipSamples: clip,
    dcOffset: Number((dcSum / frames).toExponential(2)),
    leadSilenceMs: Math.round((firstLoud / SR) * 1000 * 10) / 10,
    // gate-metric lead at the gate test's −100 dBFS floor (report LEAD uses a
    // −60 dB floor, which legitimately flags swell/riser ramps)
    leadGateMs:
      Math.round(
        (((): number => {
          let first = 0;
          while (first < frames && Math.abs(main[first]) <= 1e-5 && Math.abs(channels[1]?.[first] ?? 0) <= 1e-5)
            first++;
          return first;
        })() /
          SR) *
          1000 *
          10,
      ) / 10,
    tailSilenceMs: Math.round(((frames - 1 - lastLoud) / SR) * 1000 * 10) / 10,
    loudMs: Math.round(((lastLoud - firstLoud) / SR) * 1000 * 10) / 10,
    attackDb: Math.round(attackDb * 10) / 10,
    attackBandDb: transient?.bands ?? {},
    attackBandMaxDb: transient?.maxDb ?? 0,
    attackBandMaxName: transient?.maxBand ?? "sub",
    crestDb: Math.round(crest * 10) / 10,
    momentaryLufs: Math.round(momentaryMaxLufs(channels) * 10) / 10,
    bands,
    tuning,
  };
}

/* ── main ── */
const categoryOf = new Map(FACTORY_ASSETS.map((asset) => [asset.id, asset.category]));
const curatedIds = new Set(CURATED_SAMPLES.map((sample) => sample.id));
const files = readdirSync(SAMPLES_DIR)
  .filter((f) => f.endsWith(".wav"))
  .sort();

const rows: Row[] = [];
const loadErrors: string[] = [];
for (const file of files) {
  const id = file.replace(/\.wav$/, "");
  const category = categoryOf.get(id) ?? "unknown";
  try {
    rows.push(analyzeFile(file, id, category));
  } catch (err) {
    loadErrors.push(`${id}: ${(err as Error).message}`);
  }
}

const fmt = (v: number | string, w = 6): string => String(v).padStart(w);
const targets = categoryTargets();

console.log(`SOUND LIBRARY AUDIT — ${rows.length}/${files.length} WAVs (${CURATED_SAMPLES.length} curated slots)`);
if (loadErrors.length > 0) console.log(`LOAD ERRORS:\n  ${loadErrors.join("\n  ")}`);

/* per-category table */
const groups = new Map<string, Row[]>();
for (const row of rows) {
  const list = groups.get(row.category) ?? [];
  list.push(row);
  groups.set(row.category, list);
}
console.log("\n=== CATEGORY SUMMARY (target = seed renderer's targetLufs) ===");
console.log("category   n   target  maxDrift  spread  crestMin  crestMax");
const gateViolations: string[] = [];
for (const [category, list] of [...groups.entries()].sort()) {
  const lu = list.map((r) => r.momentaryLufs);
  const target = targets[category];
  const drift = target === undefined ? 0 : Math.max(...lu.map((v) => Math.abs(v - target)));
  const spread = Math.max(...lu) - Math.min(...lu);
  const cr = list.map((r) => r.crestDb);
  console.log(
    `${category.padEnd(9)} ${fmt(list.length, 3)} ${fmt(target ?? "-", 6)} ${fmt(drift.toFixed(1), 8)} ${fmt(spread.toFixed(1), 6)} ${fmt(Math.min(...cr).toFixed(1), 8)} ${fmt(Math.max(...cr).toFixed(1), 8)}`,
  );
  for (const row of list) {
    if (target !== undefined && Math.abs(row.momentaryLufs - target) > 2.5)
      gateViolations.push(
        `${row.id}: ${row.momentaryLufs} LUFS vs ${target} (drift ${Math.abs(row.momentaryLufs - target).toFixed(1)} dB)`,
      );
  }
}

/* flags */
console.log("\n=== FLAGS ===");
let flagged = 0;
for (const row of rows) {
  const flags: string[] = [];
  if (row.clipSamples > 0) flags.push(`CLIP x${row.clipSamples}`);
  if (Math.abs(row.dcOffset) >= 1e-3) flags.push(`DC ${row.dcOffset}`);
  if (row.leadSilenceMs > 2) flags.push(`LEAD ${row.leadSilenceMs}ms`);
  if (row.leadGateMs > 2) gateViolations.push(`${row.id}: leading silence ${row.leadGateMs} ms (gate floor −100 dBFS)`);
  if (row.tailSilenceMs > 400 && !/riser|sweep|reverse|choir|pad/.test(row.id))
    flags.push(`DEADAIR ${row.tailSilenceMs}ms`);
  if (row.peakDb > -0.3) flags.push(`HOTPEAK ${row.peakDb}`);
  if (flags.length > 0) {
    flagged += 1;
    console.log(`  ${row.id.padEnd(36)} ${flags.join(" | ")}`);
    for (const flag of flags) {
      if (/CLIP|DC/.test(flag)) gateViolations.push(`${row.id}: ${flag}`);
    }
  }
}
if (flagged === 0) console.log("  none");

/* tuning glide (long-sustain families only — short kicks read mid-glide) */
console.log("\n=== TUNING GLIDE (0.3 s window — kicks/toms/808s with long rests) ===");
for (const row of rows) {
  if (row.tuning.late) {
    const t = row.tuning.late;
    console.log(
      `  ${row.id.replace("factory.", "").padEnd(22)} ${t.hz}Hz ${t.name}${t.cents >= 0 ? "+" : ""}${t.cents}c`,
    );
  }
}

/* ── nearest neighbours (redundancy watch) ──────────────────────────────
 * 2026-10-04 metric correction. The old vector was
 *   [7 band shares (dB), crest, min(durationMs, 1000)] / max(|.|)
 * and had two structural faults that made it unusable as a de-dup signal:
 *   1. for a one-shot the render length (400-1000 ms) is the largest
 *      magnitude in the vector, so it became the divisor for *every*
 *      dimension: the distance collapsed to "RMS band delta / 400" and pairs
 *      were not comparable to one another (a 1 s file got 2.5x the headroom
 *      of a 0.4 s one);
 *   2. every term was time- or loudness-blind. `bands` is a whole-file Welch
 *      average of a LUFS-normalized render, so two files built from one
 *      recipe with different decay (hat(0.055) vs hat(0.18)) are
 *      near-identical by construction, and file duration is a render-tail
 *      artifact, not a property of the sound.
 * The vector is now measured per-file features with fixed per-dimension
 * units, so the same distance means the same thing in every category:
 *   bands x7    dB band share                    /60
 *   crest       dB, head to RMS                 /20
 *   loud        ms first-to-last loud sample    /1000  (decay / sustain)
 *   brightness  log2(centroid Hz)               /4     (timbre family)
 *   tilt        (tail - lead) silence ms        /1000  (sweep direction)
 *   attack      strongest PER-BAND head energy  /40    (transient term;
 *               max across the 7 bands, clamped at -30 dB. The broadband
 *               version this replaces could not see an in-band strike - a
 *               2.6 kHz mallet contact vs the bar's low-mid body measured
 *               0.0-0.1 dB broadband but 2.5-3.7 dB per-band on the real
 *               2026-10 pre/post pairs, so every strike fix was invisible.)
 * A pair is only a de-dup candidate when it is close on the axes its
 * category is supposed to vary on - `--why` prints those axes.
 */
const FEATURE_DIMS = [
  "sub",
  "low",
  "lowmid",
  "mid",
  "himid",
  "high",
  "air",
  "crest",
  "loud",
  "brightness",
  "tilt",
  "attack",
] as const;
const FEATURE_SCALE = [60, 60, 60, 60, 60, 60, 60, 20, 1000, 4, 1000, 40] as const;

const feat = (r: Row): number[] => [
  ...BANDS.map(([name]) => r.bands[name]),
  r.crestDb,
  r.loudMs,
  Math.log2(Math.max(r.bands.centroid, 1)),
  (r.tailSilenceMs - r.leadSilenceMs) / 1000,
  Math.max(r.attackBandMaxDb, -30),
];
const scaled = (r: Row): number[] => feat(r).map((x, i) => x / FEATURE_SCALE[i]);

/* 0.15 = one full step on a single axis (e.g. 9 dB of band share, or 150 ms of
   decay). Pairs under it are the de-dup watchlist; pairs over ~0.3 are plainly
   distinct sounds. Thin categories (2-4 samples) always print a "closest
   pair" - read the distance, not the ranking. */
const WATCH_D = 0.15;
console.log("\n=== NEAREST NEIGHBOURS (feature distance within category) ===");
console.log(`  attack window ${attackWindowMs} ms | top ${topPairs}/category | * = under ${WATCH_D} | --why = axes`);
for (const [category, list] of groups) {
  if (list.length < 2) continue;
  const feats = list.map(scaled);
  const pairs: Array<[number, string, string, number[]]> = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const contrib = feats[i].map((v, k) => Math.abs(v - feats[j][k]));
      let d = 0;
      for (const c of contrib) d += c * c;
      pairs.push([Math.sqrt(d), list[i].id, list[j].id, contrib]);
    }
  pairs.sort((a, b) => a[0] - b[0]);
  for (const [d, a, b, contrib] of pairs.slice(0, topPairs)) {
    const pair = `${a.replace("factory.", "")} <-> ${b.replace("factory.", "")}`;
    console.log(`  ${category.padEnd(10)} d=${d.toFixed(3)}${d < WATCH_D ? "*" : " "} ${pair}`);
    if (!why) continue;
    const axes = contrib
      .map((c, k) => [c, FEATURE_DIMS[k]] as const)
      .sort((x, y) => y[0] - x[0])
      .filter(([c]) => c > 1e-6)
      .slice(0, 4)
      .map(([c, name]) => `${name} ${c.toFixed(3)}`);
    console.log(`             ${axes.length > 0 ? axes.join(" | ") : "identical on every axis"}`);
  }
}

/* gate summary */
console.log("\n=== GATE SUMMARY (mirrors tests/sound-library-gate.test.ts) ===");
if (gateViolations.length === 0) {
  console.log(`GATE: PASS — ${rows.length} WAVs on contract`);
} else {
  console.log(`GATE: FAIL — ${gateViolations.length} violation(s):`);
  for (const violation of gateViolations) console.log(`  ${violation}`);
}

if (jsonOut) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.resolve(ROOT, jsonOut), JSON.stringify(rows, null, 1));
  console.log(`\njson written: ${jsonOut}`);
}

process.exitCode = gateViolations.length === 0 && loadErrors.length === 0 ? 0 : 1;
