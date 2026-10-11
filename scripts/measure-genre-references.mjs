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
/**
 * Hard clamp mirrored by the song builder's trim computation (regenerated
 * into genre-reference.generated.ts). 9 dB: full-band genres (the promoted
 * rock/jazz render drums + walking bass + comping + lead) legitimately
 * measure ~7 dB above the −14 target pre-trim — the drums-era 6 dB window
 * capped their correction and left them the hottest references in the
 * library.
 */
const TRIM_LIMIT_DB = 9;
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
  "jazz",
  "rock",
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
        async ({ genre, seeds, targetLufs, trimLimitDb }) => {
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
            trimDb: Math.max(-trimLimitDb, Math.min(trimLimitDb, Math.round((targetLufs - integrated) * 10) / 10)),
          };
        },
        { genre, seeds, targetLufs, trimLimitDb: TRIM_LIMIT_DB },
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
const failedGenres = [];
for (const genre of GENRES) {
  if (partial[genre]) {
    console.log(`[resume] ${genre}: cached from a previous run`);
    measurements.push(partial[genre]);
    continue;
  }
  // Under concurrent shared-tree churn a genre's evaluate can burn all its
  // retries (Vite full-reloads mid-evaluate). One genre failing must not
  // kill the run — skip it, keep everything already measured, and the next
  // resume pass picks it up (the partial store is the resume contract).
  try {
    const measured = await measureGenre(genre, SEEDS, TARGET_LUFS);
    measurements.push(measured);
    partial[genre] = measured;
    writeFileSync(partialPath, JSON.stringify(partial, null, 1));
  } catch (error) {
    failedGenres.push(genre);
    console.log(
      `[skip] ${genre}: ${(error instanceof Error ? error.message : String(error)).split(String.fromCharCode(10))[0]}`,
    );
  }
}
console.log(`[genre-reference] wrote ${path.relative(root, outFile)}`);
