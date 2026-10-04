/**
 * Genre song reference measurement (sound-quality pass — per-genre targets
 * from RENDERED SONGS, beyond preset probes).
 *
 * For every genre the script builds a REAL song through the canonical
 * pipeline (buildSong → applySongCommand → renderProject offline, curated
 * bank, studio quality, fixed seeds → deterministic), then measures the
 * render with the shared BS.1770-4 analyzer plus the punch (PLR) and tonal
 * tilt metrics used by measure-preset-loudness.mjs.
 *
 * Writes src/intent/genre-reference.generated.ts: per-genre integrated
 * loudness / punch / tilt medians across the seeds. Consumed by the song
 * builder as a per-genre loudness trim toward SONG_LOUDNESS_TARGET_LUFS, so
 * a drill song and a jersey song EXPORT at the same loudness without the
 * user riding the master fader.
 *
 * The trim is computed against the UNTRIMMED reference — it applies
 * uniformly to the genre, so measured + trim lands on the target with no
 * feedback loop.
 *
 * Usage: npm run references:genres   (PORT=5239 npm run references:genres)
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5239;
const outFile = path.join(root, "src", "intent", "genre-reference.generated.ts");
/** Audio-target table for the candidate sound rerank (audio-feedback.ts). */
const outTargetsFile = path.join(root, "src", "intent", "audio-targets.generated.ts");
/** Export loudness every generated song is trimmed toward. */
const TARGET_LUFS = -14;
/** Hard clamp mirrored by the song builder's trim computation. */
const TRIM_LIMIT_DB = 6;
const GENRES = [
  "house",
  "techno",
  "trap",
  "ambient",
  "drill",
  "phonk",
  "jersey",
  "dnb",
  "hyperpop",
  "ukg",
  "boombap",
  "amapiano",
  "trance",
  "detroit",
  "postrock",
  "chiptune",
  "eurodance",
  "latin",
  "drone",
];
const SEEDS = ["ref-a", "ref-b"];

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();

const isReloadRace = (error) => /context was destroyed|navigation|interrupted|timeout/i.test(String(error));

/**
 * Resume support: the shared dev machine's Vite reloads kill evaluates at
 * random — measured genres land in a partial JSON so a re-run skips them.
 */
const partialPath = path.join(root, "node_modules", ".cache", "genre-reference-partial.json");
const partialDir = path.dirname(partialPath);
if (!existsSync(partialDir)) {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(partialDir, { recursive: true });
}
const partial = existsSync(partialPath) ? JSON.parse(readFileSync(partialPath, "utf8")) : {};

/**
 * BOOTSTRAP: make sure `audio-targets.generated.ts` exists before measuring.
 *
 * `src/intent/audio-feedback.ts` statically imports that table and falls back
 * to its own hardcoded `AUDIO_TARGETS` when a genre is missing
 * (`GENERATED_AUDIO_TARGETS[genre] ?? AUDIO_TARGETS[genre] ?? AUDIO_TARGETS.house`).
 * But measurement itself has to load `src/intent/song.ts` through a live Vite
 * server, `song.ts` reaches `audio-feedback.ts` (even through a type-only
 * import — Vite still resolves the specifier), and `audio-feedback.ts` then
 * needs the generated module. A missing file therefore breaks the very run that
 * would have produced it: a bootstrap cycle the generator cannot escape.
 *
 * Writing an empty table first breaks the cycle. The fallback chain in
 * audio-feedback.ts keeps every genre covered for the duration of the run, and
 * the real measured table overwrites this file at the end. An EMPTY table is a
 * valid, non-crashing starting state — that is the whole point of the `??`
 * chain existing.
 */
if (!existsSync(outTargetsFile)) {
  writeFileSync(
    outTargetsFile,
    `// Bootstrap placeholder written by scripts/measure-genre-references.mjs so the
// generator can load src/intent/song.ts to MEASURE this table. Empty on
// purpose: audio-feedback.ts falls back to its hardcoded AUDIO_TARGETS for every
// genre until the measured table lands. Overwritten by the run that just
// completed — do not commit this placeholder.
//
//   npm run references:genres
export const GENERATED_AUDIO_TARGETS: Record<string, {
  rmsRange: [number, number];
  crestRange: [number, number];
  zcrRange: [number, number];
  bassRange: [number, number];
}> = {};
`,
  );
  console.log(`[genre-reference] bootstrapped missing ${path.relative(root, outTargetsFile)} (empty)`);
}

async function gotoStudio() {
  // Direct studio route: bare "/" runs the landing Entry flow, which may
  // client-navigate mid-evaluate and destroy the execution context.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/studio`, { waitUntil: "domcontentloaded", timeout: 240_000 });
      return;
    } catch (error) {
      if (attempt >= 8 || !isReloadRace(error)) throw error;
      console.log(`[retry] goto interrupted — retrying (${attempt}/8)`);
      await page.waitForTimeout(5000);
    }
  }
}

/**
 * One GENRE per evaluate: a concurrent agent saving files mid-run makes Vite
 * full-reload the page (execution context destroyed), and a single evaluate
 * for all 8 genres would lose everything each time. Per-genre calls keep the
 * already-measured genres in the Node process.
 */
async function measureGenre(genre, seeds, targetLufs) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await page.evaluate(
        async ({ genre, seeds, targetLufs }) => {
          const templates = await import("/src/project-model/templates.ts");
          const normalize = await import("/src/intent/normalize.ts");
          const song = await import("/src/intent/song.ts");
          const renderer = await import("/src/rendering/renderer.ts");
          const factory = await import("/src/sample-library/factory.ts");
          const curated = await import("/src/sample-library/curated.ts");
          const loudness = await import("/src/audio-engine/kweighting.ts");
          const audioFeatures = await import("/src/ai/audio-features.ts");

          const SR = 44100;
          // Measure against the bank the app actually plays (synth kit +
          // curated layer) — preloading also skips renderProject's 2 s wait.
          const bank = await factory.generateFactoryBank();
          await curated.loadCuratedLayer(bank);

          // Same one-pole band split as measure-preset-loudness.mjs: low
          // ≤220 Hz vs high ≥4 kHz energy ratio in dB (positive = low-heavy).
          const tiltOf = (channels, sr) => {
            const lpCoef = 1 - Math.exp((-2 * Math.PI * 220) / sr);
            const hpCoef = Math.exp((-2 * Math.PI * 4000) / sr);
            let lowE = 0;
            let highE = 0;
            for (const ch of channels) {
              let lp = 0;
              let hpY = 0;
              let xPrev = 0;
              for (let i = 0; i < ch.length; i++) {
                const x = ch[i];
                lp += (x - lp) * lpCoef;
                const hp = hpCoef * (hpY + x - xPrev);
                xPrev = x;
                hpY = hp;
                lowE += lp * lp;
                highE += hp * hp;
              }
            }
            return 10 * Math.log10((lowE + 1e-12) / (highE + 1e-12));
          };

          const readings = [];
          for (const seed of seeds) {
            const doc = templates.createProjectFromTemplate("house");
            const intent = normalize.normalizeIntent({ genre, seed: `${genre}|${seed}` });
            const build = await song.buildSong(doc, intent);
            const next = song.applySongCommand(doc, build).execute(doc);
            // Strip the genre loudness trim the builder may have written from
            // a STALE generated table — this measurement defines the table.
            const untrimmed = { ...next, master: { ...next.master, loudnessTrimDb: 0 } };
            const buffer = await renderer.renderProject(untrimmed, bank, {
              mode: "song",
              sampleRate: SR,
              quality: "studio",
            });
            const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch));
            const analysis = loudness.analyzeLoudnessBuffer(channels, SR);
            let peak = 0;
            for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
            // Audio-target features: mono downmix at 44100 — the SAME
            // convention as the runtime scoring path (audio-feedback renders
            // candidates as mono Float32Array at 44100).
            const mono = new Float32Array(buffer.length);
            for (let frame = 0; frame < buffer.length; frame++) {
              let acc = 0;
              for (const ch of channels) acc += ch[frame];
              mono[frame] = acc / channels.length;
            }
            const features = audioFeatures.extractAudioFeatures(mono, SR);
            readings.push({
              integrated: analysis.integrated,
              shortTermMax: analysis.shortTermMax,
              peak,
              tiltDb: tiltOf(channels, SR),
              features: {
                rms: features.rms,
                crestFactor: features.crestFactor,
                zeroCrossingRate: features.zeroCrossingRate,
                lowBandRatio: features.lowBandRatio,
              },
              seconds: buffer.duration,
              bars: build.totalBars,
              measured: analysis.measured === true,
            });
            console.log(
              `[genre-reference] ${genre}/${seed}: ${analysis.integrated.toFixed(1)} LUFS · ${build.totalBars} bars · ${buffer.duration.toFixed(0)} s`,
            );
          }
          const medianOf = (key) => {
            const s = readings.map((r) => r[key]).sort((a, b) => a - b);
            return s[Math.floor(s.length / 2)];
          };
          const integrated = medianOf("integrated");
          const peak = medianOf("peak");
          const featMedian = (key) => {
            const s = readings.map((r) => r.features[key]).sort((a, b) => a - b);
            return s[Math.floor(s.length / 2)];
          };
          return {
            genre,
            integrated,
            shortTermMax: medianOf("shortTermMax"),
            punchPlrDb: peak > 1e-6 ? Math.round((20 * Math.log10(peak) - integrated) * 10) / 10 : 0,
            tiltDb: medianOf("tiltDb"),
            features: {
              rms: featMedian("rms"),
              crestFactor: featMedian("crestFactor"),
              zeroCrossingRate: featMedian("zeroCrossingRate"),
              lowBandRatio: featMedian("lowBandRatio"),
            },
            measured: readings.every((r) => r.measured),
            seconds: medianOf("seconds"),
            bars: medianOf("bars"),
            trimDb: Math.max(-6, Math.min(6, Math.round((targetLufs - integrated) * 10) / 10)),
          };
        },
        { genre, seeds, targetLufs },
      );
    } catch (error) {
      if (attempt >= 5 || !isReloadRace(error)) throw error;
      console.log(`[retry] ${genre} evaluate hit a Vite full reload — re-measuring (${attempt}/5)`);
      await gotoStudio();
    }
  }
}

await gotoStudio();
const measurements = [];
for (const genre of GENRES) {
  if (partial[genre]) {
    console.log(`[resume] ${genre}: cached from a previous run`);
    measurements.push(partial[genre]);
    continue;
  }
  const measured = await measureGenre(genre, SEEDS, TARGET_LUFS);
  measurements.push(measured);
  partial[genre] = measured;
  writeFileSync(partialPath, JSON.stringify(partial, null, 1));
}

await browser.close();
await server.close();

const measured = measurements.filter((m) => m.measured);
if (measured.length === 0) {
  console.error("[genre-reference] no genre produced a measurable render");
  process.exit(1);
}

const round1 = (v) => Math.round(v * 10) / 10;
const refLines = measurements
  .map(
    (m) =>
      `  ${m.genre}: { integrated: ${round1(m.integrated)}, punchPlrDb: ${round1(m.punchPlrDb)}, tiltDb: ${round1(m.tiltDb)}, bars: ${m.bars} },`,
  )
  .join("\n");

const file = `/**
 * GENERATED by scripts/measure-genre-references.mjs — do not edit by hand.
 * Re-run \`npm run references:genres\` after changing generation content
 * (grooves, kits, song forms, curated layer, master chain).
 *
 * Reference: full RENDERED SONGS per genre (buildSong → applySongCommand →
 * renderProject, curated bank, studio quality, fixed seeds, medians of
 * ${SEEDS.length} seeds each). These are UNTRIMMED levels — the song builder
 * trims toward the target using these numbers.
 */

/** Every generated song exports at roughly this integrated loudness. */
export const SONG_LOUDNESS_TARGET_LUFS = ${TARGET_LUFS};

/** Builder clamp — keep in sync with scripts/measure-genre-references.mjs. */
export const SONG_LOUDNESS_TRIM_LIMIT_DB = ${TRIM_LIMIT_DB};

export interface GenreSongReference {
  /** Integrated loudness (LUFS) of the untrimmed reference render. */
  integrated: number;
  /** Peak-to-loudness ratio (dB) — transient headroom of the full mix. */
  punchPlrDb: number;
  /** Tonal tilt (dB): 10·log10(low≤220Hz / high≥4kHz), positive = low-heavy. */
  tiltDb: number;
  /** Reference song length in bars. */
  bars: number;
}

export const GENRE_REFERENCE: Record<string, GenreSongReference> = {
${refLines}
};
`;

writeFileSync(outFile, file);

// ── audio-targets.generated.ts — the W0.1 rerank target table ──────────────
// Measured medians widened into RANGES: a reference render is ONE good
// example, but candidates legitimately vary in energy/mood, so a target is
// a corridor, not a point. Widening rules (documented for the reader):
//   rms / zcr / lowBandRatio: log-space ±~1 octave → ×[1/2.5, ×2.5]
//   crestFactor: [max(1.2, m−4), m+8] — crest floors near 1 (sine-ish) and
//     the upper side carries the dynamic candidates.
// The hand-written table in audio-feedback.ts stays as the fallback for
// genres not in this file.
const round4 = (v) => Math.round(v * 10000) / 10000;
const logWiden = (m) => [round4(m / 2.5), round4(m * 2.5)];
const crestWiden = (m) => [Math.max(1.2, Math.round((m - 4) * 10) / 10), Math.round((m + 8) * 10) / 10];
const ratioWiden = (m) => [round4(Math.max(0.05, m - 0.15)), round4(Math.min(0.95, m + 0.15))];

const targetLines = measurements
  .map((m) => {
    const [rmsLo, rmsHi] = logWiden(m.features.rms);
    const [zcrLo, zcrHi] = logWiden(m.features.zeroCrossingRate);
    const [bassLo, bassHi] = ratioWiden(m.features.lowBandRatio);
    const [crestLo, crestHi] = crestWiden(m.features.crestFactor);
    return `  ${m.genre}: {
    rmsRange: [${round4(rmsLo)}, ${round4(rmsHi)}],
    crestRange: [${crestLo}, ${crestHi}],
    zcrRange: [${zcrLo}, ${zcrHi}],
    bassRange: [${bassLo}, ${bassHi}],
  },`;
  })
  .join(String.fromCharCode(10));

const targetsFile = `/**
 * GENERATED by scripts/measure-genre-references.mjs — do not edit by hand.
 * Re-run \`npm run references:genres\` after changing generation content.
 *
 * Per-genre AUDIO TARGETS for the candidate sound rerank
 * (src/intent/audio-feedback.ts scoreAudioFit): RMS / crest / ZCR /
 * low-band ratio measured on FULL RENDERED SONGS per genre (the canonical
 * buildSong pipeline, curated bank, fixed seeds — medians of
 * ${SEEDS.length} seeds), widened into corridors so mood/energy variation
 * inside a genre still lands inside its own target:
 *   rms/zcr/lowBandRatio: measured median ×[1/2.5, ×2.5]
 *   crestFactor: [max(1.2, m−4), m+8]
 * Consumed by audioTargetFor() — the hand-written table stays as the
 * fallback for genres missing from this file.
 */

/** Ranges for scoring candidate audio fit per genre (see audio-feedback.ts). */
export const GENERATED_AUDIO_TARGETS: Record<string, { rmsRange: [number, number]; crestRange: [number, number]; zcrRange: [number, number]; bassRange: [number, number] }> = {
${targetLines}
};
`;

writeFileSync(outTargetsFile, targetsFile);

console.log(`[genre-reference] ${measurements.length}/${GENRES.length} genres measured · target ${TARGET_LUFS} LUFS`);
for (const m of measurements) {
  console.log(
    `  ${m.genre.padEnd(8)} ${String(m.integrated.toFixed(1)).padStart(6)} LUFS · trim ${String(m.trimDb).padStart(5)} dB · PLR ${m.punchPlrDb.toFixed(1)} dB · tilt ${m.tiltDb.toFixed(1)} dB`,
  );
}
console.log(`[genre-reference] wrote ${path.relative(root, outFile)}`);
