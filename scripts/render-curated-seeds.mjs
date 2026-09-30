/**
 * Curated seed generator (VISION §5 factory-content pass).
 *
 * Renders the CURATED_SAMPLES slot list (the FULL factory kit) through the
 * app's own synthesis plus a per-category mastering chain in a headless
 * Chromium, then writes 24-bit WAVs into public/samples/.
 *
 * Per-category treatment (the curation pass, 2026-09):
 *  - loudness: every slot is normalized to its category's momentary-max
 *    K-weighted target (shared BS.1770 analyzer) BEFORE mastering, so the kit
 *    sits together like a mixed kit instead of 41 unrelated synth patches;
 *  - glue: tape saturation into the look-ahead limiter — the same processors
 *    the master bus uses — with per-category drive/tone/ceiling.
 *
 * These SEEDS make the curated pipeline work and sound glued from day one —
 * replace the files with real recordings (same names, see public/samples/
 * README.md) when curation happens.
 *
 * Usage: npm run curated:seeds   (PORT=5233 npm run curated:seeds)
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5233;
const outDir = path.join(root, "public", "samples");
const requestedIds = process.env.CURATED_SAMPLE_IDS?.split(",")
  .map((id) => id.trim())
  .filter(Boolean);

/** Curation targets per asset category (manifest.ts categories). */
const CATEGORY_TREATMENT = {
  Kick: { targetLufs: -8, tapeDrive: 0.22, tapeTone: 12000, ceiling: -1.2 },
  Snare: { targetLufs: -9.5, tapeDrive: 0.2, tapeTone: 10500, ceiling: -1.4 },
  Clap: { targetLufs: -10.5, tapeDrive: 0.18, tapeTone: 10000, ceiling: -1.5 },
  Hat: { targetLufs: -15.5, tapeDrive: 0.14, tapeTone: 11000, ceiling: -1.8 },
  Cymbal: { targetLufs: -17, tapeDrive: 0.1, tapeTone: 12000, ceiling: -2 },
  Crash: { targetLufs: -17, tapeDrive: 0.1, tapeTone: 12000, ceiling: -2 },
  Tom: { targetLufs: -11.5, tapeDrive: 0.18, tapeTone: 10000, ceiling: -1.5 },
  Rim: { targetLufs: -13, tapeDrive: 0.15, tapeTone: 10500, ceiling: -1.8 },
  Percussion: { targetLufs: -13.5, tapeDrive: 0.15, tapeTone: 10500, ceiling: -1.8 },
  Tonal: { targetLufs: -16, tapeDrive: 0.16, tapeTone: 9500, ceiling: -1.8 },
  FX: { targetLufs: -13, tapeDrive: 0.16, tapeTone: 10500, ceiling: -1.5 },
};

/**
 * Per-ASSET treatment overrides (sound-library audit 2026-09-29). The tape
 * stage runs driveGain = 1 + drive * 14, so the category kick drive (0.22 →
 * ~4×) squares a sustained sub sine into a near-full-scale wave — correct for
 * the "Distorted, Long" 808drive character, wrong for 808pure whose manifest
 * identity is "Clean, Endless". Low drive keeps its sine body clean while the
 * post-master trim (below) still lands it on the kick loudness target.
 */
const ASSET_TREATMENT_OVERRIDE = {
  "factory.kick.808pure": { tapeDrive: 0.05 },
  // The sub-drop is a sustained falling sine — the FX category drive (~3.2x)
  // would square it into the limiter before the trim ever sees it (same
  // failure the 808pure fix removed). Its own tanh edge (1.6x) is baked in.
  "factory.fx.subdrop": { tapeDrive: 0.04 },
};

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });

const results = await page.evaluate(
  async ({ categoryTreatment, assetTreatmentOverride, requestedIds }) => {
    const factory = await import("/src/sample-library/factory.ts");
    const curated = await import("/src/sample-library/curated.ts");
    const manifest = await import("/src/sample-library/manifest.ts");
    const wav = await import("/src/rendering/wav.ts");
    const loader = await import("/src/audio-worklets/loader.ts");
    const loudness = await import("/src/audio-engine/kweighting.ts");

    const SR = 44100;
    const bank = await factory.generateFactoryBank();
    const categoryOf = new Map(manifest.FACTORY_ASSETS.map((asset) => [asset.id, asset.category]));
    const selectedIds = requestedIds ? new Set(requestedIds) : null;
    const samples = selectedIds
      ? curated.CURATED_SAMPLES.filter((sample) => selectedIds.has(sample.id))
      : curated.CURATED_SAMPLES;
    if (selectedIds && samples.length !== selectedIds.size) {
      const found = new Set(samples.map((sample) => sample.id));
      throw new Error(`unknown curated sample id(s): ${[...selectedIds].filter((id) => !found.has(id)).join(", ")}`);
    }

    // Sub-400ms one-shots (ticks, tight hats) cannot feed the 400 ms loudness
    // blocks directly — tile the source into a ≥450 ms window so a click is
    // measured as the loudness of repeated hits, which is how it reads in a
    // groove anyway.
    const measureChannels = (buffer) => {
      const minSamples = Math.ceil(0.45 * SR);
      const reps = buffer.length >= minSamples ? 1 : Math.ceil(minSamples / buffer.length);
      return Array.from({ length: buffer.numberOfChannels }, (_, ch) => {
        const srcData = buffer.getChannelData(ch);
        if (reps === 1) return srcData;
        const out = new Float32Array(buffer.length * reps);
        for (let r = 0; r < reps; r++) out.set(srcData, r * buffer.length);
        return out;
      });
    };

    const out = [];
    for (const sample of samples) {
      const src = bank.get(sample.id);
      if (!src) throw new Error(`factory asset ${sample.id} missing`);
      const category = categoryOf.get(sample.id) ?? "Percussion";
      const treatment = {
        ...(categoryTreatment[category] ?? categoryTreatment.Percussion),
        ...(assetTreatmentOverride[sample.id] ?? {}),
      };

      // Pre-master loudness normalization: measure the synth source with the
      // shared BS.1770 analyzer and lift/lower it to the category target so the
      // kit lands on a designed balance, not 41 unrelated patch levels.
      const sourceChannels = measureChannels(src);
      const reading = loudness.analyzeLoudnessBuffer(sourceChannels, SR);
      let normGain = 1;
      if (reading.measured && reading.momentaryMax > -70) {
        normGain = Math.pow(10, Math.max(-24, Math.min(24, treatment.targetLufs - reading.momentaryMax)) / 20);
      }

      // Mastering chain per slot: tape saturation into the look-ahead limiter
      // (the same processors the master bus uses) — glue + a controlled
      // ceiling, so the seeds sit together like a mixed kit.
      const renderSlot = async (gain) => {
        const render = new OfflineAudioContext(2, Math.ceil((src.duration + 0.4) * SR), SR);
        await loader.loadCoreWorklets(render);

        const norm = render.createGain();
        norm.gain.value = gain;

        const tape = new AudioWorkletNode(render, "tape-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 2,
          channelInterpretation: "speakers",
        });
        tape.parameters.get("drive").value = treatment.tapeDrive;
        tape.parameters.get("tone").value = treatment.tapeTone;
        tape.parameters.get("mix").value = 1;

        const limiter = new AudioWorkletNode(render, "limiter-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 2,
          channelInterpretation: "speakers",
        });
        limiter.parameters.get("ceiling").value = treatment.ceiling;

        const player = render.createBufferSource();
        player.buffer = src;
        player.connect(norm);
        norm.connect(tape);
        tape.connect(limiter);
        limiter.connect(render.destination);
        player.start(0);
        return render.startRendering();
      };

      // Two-pass trim: the limiter reacts to transients, so a single
      // source-level estimate undershoots the target on percussive slots.
      // Pass 1 renders with the measured gain; pass 2 applies the residual.
      let mastered = await renderSlot(normGain);
      for (let pass = 0; pass < 2; pass++) {
        const channels = Array.from({ length: mastered.numberOfChannels }, (_, ch) => mastered.getChannelData(ch));
        const after = loudness.analyzeLoudnessBuffer(channels, SR);
        if (!after.measured || after.momentaryMax <= -70) break;
        const residual = treatment.targetLufs - after.momentaryMax;
        if (Math.abs(residual) < 0.4) break;
        normGain *= Math.pow(10, Math.max(-12, Math.min(12, residual)) / 20);
        mastered = await renderSlot(normGain);
      }

      // Leading-silence trim (sound-library audit 2026-09-29): the limiter's
      // look-ahead delay shifts every render ~5 ms late — the whole kit fired
      // behind the grid. The delay region is exact digital silence (tape
      // hysteresis is idle on zeros); cut to the first sample above -100 dBFS
      // (below any synth content incl. swell/riser ramps, which start at
      // 1e-4) so transients land at sample 0. Runs BEFORE the DC step so the
      // zeros it scans are still zeros.
      let trimDb = 0;
      {
        const LEAD_FLOOR = 1e-5;
        let firstLoud = 0;
        outer: for (let i = 0; i < mastered.length; i++) {
          for (let ch = 0; ch < mastered.numberOfChannels; ch++) {
            if (Math.abs(mastered.getChannelData(ch)[i]) > LEAD_FLOOR) {
              firstLoud = i;
              break outer;
            }
          }
        }
        if (firstLoud > 0) {
          const compact = new AudioBuffer({
            length: mastered.length - firstLoud,
            numberOfChannels: mastered.numberOfChannels,
            sampleRate: mastered.sampleRate,
          });
          for (let ch = 0; ch < mastered.numberOfChannels; ch++) {
            compact.getChannelData(ch).set(mastered.getChannelData(ch).subarray(firstLoud));
          }
          mastered = compact;
        }
      }

      // Trim trailing dead air (the 0.4 s render tail after the sample's own
      // decay): granular position mapping, pad slicing and choke timing all
      // read the file length — dead air shifts them onto silence.
      const TRIM_FLOOR = 1e-3; // ≈ -60 dBFS
      const GUARD_SAMPLES = Math.ceil(0.05 * SR);
      let lastLoud = 0;
      for (let ch = 0; ch < mastered.numberOfChannels; ch++) {
        const data = mastered.getChannelData(ch);
        for (let i = data.length - 1; i >= lastLoud; i--) {
          if (Math.abs(data[i]) > TRIM_FLOOR) {
            lastLoud = Math.max(lastLoud, i);
            break;
          }
        }
      }
      const trimmedLength = Math.max(Math.ceil(0.4 * SR), Math.min(mastered.length, lastLoud + GUARD_SAMPLES));
      if (trimmedLength < mastered.length) {
        const compact = new AudioBuffer({
          length: trimmedLength,
          numberOfChannels: mastered.numberOfChannels,
          sampleRate: mastered.sampleRate,
        });
        for (let ch = 0; ch < mastered.numberOfChannels; ch++) {
          compact.getChannelData(ch).set(mastered.getChannelData(ch).subarray(0, trimmedLength));
        }
        mastered = compact;
      }

      // Post-master exact-target trim + content-DC removal (sound-library
      // audit 2026-09-29). The tape stage (driveGain = 1 + drive*14) squares
      // hot sustained sources — 808s, organ sustains — to near full scale,
      // and the look-ahead limiter pins them at the ceiling: no pre-chain
      // gain can reach the category target from there (808pure shipped at
      // -2.4 LUFS against a -8 target with norm -12.7 dB). A LINEAR post-trim
      // always converges. Measured with the same tiled (repeated-hit)
      // convention as the pre-normalizer, so every slot lands on one
      // definition of its category loudness. Down-trims are clean; up-trims
      // are capped at the limiter ceiling so nothing leaves above it.
      // DC comes from tape hysteresis bias and is subtracted as a CONTENT
      // mean (up to the last loud sample) after the trims — a whole-buffer
      // mean is defeated by the trim steps (padding/guard zeros shift it),
      // and the tape stage is idle on the trailing zeros anyway.
      {
        const tiled = measureChannels(mastered);
        const post = loudness.analyzeLoudnessBuffer(tiled, SR);
        if (post.measured && post.momentaryMax > -70) {
          trimDb = treatment.targetLufs - post.momentaryMax;
          if (trimDb > 0) {
            let peak = 0;
            for (const tiledCh of tiled)
              for (let i = 0; i < tiledCh.length; i++) peak = Math.max(peak, Math.abs(tiledCh[i]));
            const headroomDb = treatment.ceiling - 20 * Math.log10(Math.max(peak, 1e-6));
            trimDb = Math.min(trimDb, Math.max(0, headroomDb));
          }
        }
        const trimGain = Math.pow(10, trimDb / 20);
        const DC_FLOOR = 1e-3; // matches the tail-trim loudness floor
        for (let ch = 0; ch < mastered.numberOfChannels; ch++) {
          const data = mastered.getChannelData(ch);
          let chLastLoud = 0;
          for (let i = data.length - 1; i >= 0; i--) {
            if (Math.abs(data[i]) > DC_FLOOR) {
              chLastLoud = i;
              break;
            }
          }
          let mean = 0;
          for (let i = 0; i <= chLastLoud; i++) mean += data[i];
          mean /= Math.max(1, chLastLoud + 1);
          // Content region: full correction. Past the last loud sample the
          // correction fades out across the guard window so the content→tail
          // boundary has no DC step (a hard step would tick on loop points).
          const fadeEnd = chLastLoud + GUARD_SAMPLES;
          for (let i = 0; i < data.length; i++) {
            const factor = i <= chLastLoud ? 1 : Math.max(0, 1 - (i - chLastLoud) / GUARD_SAMPLES);
            data[i] = (data[i] - mean * factor) * trimGain;
          }
        }
      }

      // Post-master verification read: the limiter ceiling should keep peaks
      // at/below it (within true-peak overshoot) — log, never throw. Measured
      // with the tiled (repeated-hit) convention so the logged momentary is
      // comparable with the category target.
      const masteredChannels = Array.from({ length: mastered.numberOfChannels }, (_, ch) =>
        mastered.getChannelData(ch),
      );
      let peak = 0;
      for (const ch of masteredChannels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
      const after = loudness.analyzeLoudnessBuffer(measureChannels(mastered), SR);

      const encoded = wav.encodeWav(mastered, 24);
      const bytes = new Uint8Array(encoded);
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      out.push({
        file: sample.file,
        b64: btoa(binary),
        report: {
          category,
          peak: Math.round(20 * Math.log10(Math.max(peak, 1e-6)) * 10) / 10,
          momentaryMax: Math.round(after.momentaryMax * 10) / 10,
          normGainDb: Math.round(20 * Math.log10(normGain) * 10) / 10,
          trimDb: Math.round(trimDb * 10) / 10,
        },
      });
    }
    return out;
  },
  {
    categoryTreatment: CATEGORY_TREATMENT,
    assetTreatmentOverride: ASSET_TREATMENT_OVERRIDE,
    requestedIds: requestedIds ?? null,
  },
);

mkdirSync(outDir, { recursive: true });
for (const { file, b64, report } of results) {
  const bytes = Buffer.from(b64, "base64");
  writeFileSync(path.join(outDir, file), bytes);
  console.log(
    `[curated-seeds] ${file} — ${(bytes.length / 1024).toFixed(1)} kB · ${report.category}` +
      ` · norm ${report.normGainDb > 0 ? "+" : ""}${report.normGainDb} dB · trim ${report.trimDb > 0 ? "+" : ""}${report.trimDb} dB` +
      ` · peak ${report.peak} dBFS · momentary ${report.momentaryMax} LUFS`,
  );
}

await browser.close();
await server.close();
console.log(`[curated-seeds] ${results.length} seed(s) written to public/samples/ (replace with real recordings!)`);
