/**
 * Generate a latency-aligned, loudness-matched REZONANS review from the pinned
 * CC0 sung-vocal sample. Decode MP3 and render in Chromium because Node has no
 * bundled MP3 decoder; the production DSP core is bundled unchanged.
 *
 * Run with: npx vite-node scripts/generate-rezonans-singing-review.mts
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "artifacts", "rezonans-singing-review");
const SOURCE_PATH = path.join(OUTPUT_DIR, "source-owstu-cc0.mp3");
const ASSET_NAME = `rezonans-singing-review-${process.pid}.js`;
const ASSET_PATH = path.join(ROOT, "public", ASSET_NAME);
const SAMPLE_RATE = 48_000;
const BLOCK = 128;
const FFT_SIZE = 4096;
const ALIGN_LATENCY = FFT_SIZE - 1;
const PEAK_CEILING = 0.89;
const SOURCE_PAGE = "https://freesound.org/people/owstu/sounds/628817/";
const C_MAJOR = 0b101010110101;

const browserEntry = `
import { RezonansProcessor } from "../src/effects/rezonans-core/dsp/rezonansProcessor.ts";
import { QUALITY_FINE, REZ_PARAM, voiceParamId } from "../src/effects/rezonans-core/contracts/parameters.ts";

const FFT_SIZE = ${FFT_SIZE};
const BLOCK = ${BLOCK};
const SR = ${SAMPLE_RATE};
const ALIGN_LATENCY = ${ALIGN_LATENCY};
const PEAK_CEILING = ${PEAK_CEILING};
const C_MAJOR = ${C_MAJOR};

function rms(values, start, length) {
  let sum = 0;
  for (let i = start; i < start + length; i++) sum += values[i] * values[i];
  return Math.sqrt(sum / Math.max(1, length));
}

function peak(values, start, length) {
  let max = 0;
  for (let i = start; i < start + length; i++) max = Math.max(max, Math.abs(values[i]));
  return max;
}

function render(source, formant, semitones) {
  const frames = source.length + FFT_SIZE * 2;
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  const output = new Float32Array(frames);
  const processor = new RezonansProcessor();
  processor.prepare(SR, 2, BLOCK, 120);
  const params = {
    [REZ_PARAM.quality]: QUALITY_FINE,
    [REZ_PARAM.harmonyMode]: 1,
    [REZ_PARAM.voices]: 1,
    [REZ_PARAM.mix]: 1,
    [REZ_PARAM.bodyGate]: 0.5,
    [REZ_PARAM.clarity]: 0.75,
    [REZ_PARAM.formant]: formant,
    [voiceParamId(0, "enabled")]: 1,
    [voiceParamId(0, "degree")]: semitones,
    [voiceParamId(0, "level")]: 1,
    [voiceParamId(0, "pan")]: 0,
    [voiceParamId(0, "humanize")]: 0,
  };
  for (const [id, value] of Object.entries(params)) processor.setParameter(id, value);
  processor.setHarmonyContext({ keyRootPc: 0, scaleMask: C_MAJOR, chords: [] });
  processor.prepareOfflineRender();
  for (let pos = 0; pos < frames; pos += BLOCK) {
    const n = Math.min(BLOCK, frames - pos);
    for (let i = 0; i < n; i++) {
      const sample = pos + i < source.length ? source[pos + i] : 0;
      left[i] = sample;
      right[i] = sample;
    }
    processor.process([left, right], n);
    output.set(left.subarray(0, n), pos);
  }
  return { samples: output, meters: processor.getMeters() };
}

function encodeStereoPcm16(mono) {
  const dataBytes = mono.length * 4;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset, value) => {
    for (let i = 0; i < value.length; i++) out[offset + i] = value.charCodeAt(i);
  };
  ascii(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, SR, true); view.setUint32(28, SR * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true); ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < mono.length; i++) {
    const x = Math.max(-1, Math.min(1, mono[i]));
    const q = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
    view.setInt16(44 + i * 4, q, true);
    view.setInt16(46 + i * 4, q, true);
  }
  return out;
}

function delayedReference(source, frames) {
  const out = new Float32Array(frames);
  out.set(source.subarray(0, Math.max(0, frames - ALIGN_LATENCY)), ALIGN_LATENCY);
  return out;
}

function rmsMatch(samples, targetRms, start, length) {
  const ownRms = rms(samples, start, length);
  const gain = targetRms / Math.max(ownRms, 1e-12);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return gain;
}

export function renderReview(source, sourceRate) {
  if (sourceRate !== SR) throw new Error("Decoded source did not resample to 48 kHz");
  if (source.length < SR * 2) throw new Error("Singing sample is unexpectedly short");
  const frames = source.length + FFT_SIZE * 2;
  const cases = [
    { file: "00-reference-aligned.wav", label: "Sung source, latency aligned", samples: delayedReference(source, frames), meters: null },
    { file: "01-fine-identity.wav", label: "Fine, unison, neutral formant", ...render(source, 0, 0) },
    { file: "02-fine-fifth.wav", label: "Fine, perfect fifth (+7 st)", ...render(source, 0, 7) },
    { file: "03-fine-fifth-formant-up.wav", label: "Fine, fifth + formant (+6 st)", ...render(source, 6, 7) },
    { file: "04-fine-fifth-formant-down.wav", label: "Fine, fifth + formant (-6 st)", ...render(source, -6, 7) },
  ];
  const targetRms = rms(cases[0].samples, ALIGN_LATENCY, source.length);
  const matchGains = cases.map((item) => rmsMatch(item.samples, targetRms, ALIGN_LATENCY, source.length));
  let highestPeak = 0;
  for (const item of cases) highestPeak = Math.max(highestPeak, peak(item.samples, ALIGN_LATENCY, source.length));
  const sharedGain = Math.min(1, PEAK_CEILING / Math.max(highestPeak, 1e-12));
  const outputs = cases.map((item, index) => {
    for (let i = 0; i < item.samples.length; i++) item.samples[i] *= sharedGain;
    const outputRms = rms(item.samples, ALIGN_LATENCY, source.length);
    const outputPeak = peak(item.samples, ALIGN_LATENCY, source.length);
    return {
      file: item.file,
      label: item.label,
      wav: encodeStereoPcm16(item.samples),
      rms: outputRms,
      peak: outputPeak,
      rmsMatchGain: matchGains[index],
      meters: item.meters && {
        clarity: item.meters.claritySum,
        voicedRatio: item.meters.voicedRatio,
        latencySamples: item.meters.latencySamples,
      },
    };
  });
  return {
    sampleRate: SR,
    sourceFrames: source.length,
    durationSeconds: source.length / SR,
    alignmentSamples: ALIGN_LATENCY,
    alignmentMs: (ALIGN_LATENCY / SR) * 1000,
    sharedPeakGain: sharedGain,
    outputs,
  };
}
`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/") {
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><html><body></body></html>");
    return;
  }
  if (request.method === "GET" && url.pathname === `/${ASSET_NAME}`) {
    response.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(ASSET_PATH));
    return;
  }
  if (request.method === "GET" && url.pathname === "/source.mp3") {
    response.writeHead(200, { "content-type": "audio/mpeg" }).end(await readFile(SOURCE_PATH));
    return;
  }
  const outputMatch = request.method === "POST" && /^\/output\/(\d{2}-[a-z0-9-]+\.wav)$/.exec(url.pathname);
  if (outputMatch) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 16_000_000) {
        response.writeHead(413).end("output too large");
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const wav = Buffer.concat(chunks);
    if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
      response.writeHead(400).end("invalid WAV output");
      return;
    }
    await writeFile(path.join(OUTPUT_DIR, outputMatch[1]!), wav);
    response.writeHead(201).end("saved");
    return;
  }
  response.writeHead(404).end("not found");
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await build({
    stdin: {
      contents: browserEntry,
      resolveDir: path.join(ROOT, "scripts"),
      sourcefile: "rezonans-singing-review.entry.ts",
    },
    bundle: true,
    format: "iife",
    target: "es2022",
    outfile: ASSET_PATH,
    globalName: "RezonansSingingReview",
    minify: true,
    logLevel: "warning",
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Review server did not expose its port");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(
    async ({ assetName, baseUrl }) => {
      const context = new AudioContext({ sampleRate: 48000 });
      if (context.sampleRate !== 48000) throw new Error(`Expected 48 kHz context, got ${context.sampleRate}`);
      const sourceResponse = await fetch(`${baseUrl}/source.mp3`);
      if (!sourceResponse.ok) throw new Error(`Could not load singing source (${sourceResponse.status})`);
      const audio = await context.decodeAudioData(await sourceResponse.arrayBuffer());
      const script = document.createElement("script");
      script.src = `${baseUrl}/${assetName}`;
      await new Promise<void>((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Could not load the REZONANS DSP bundle"));
        document.head.append(script);
      });
      const helper = (
        window as Window & { RezonansSingingReview?: { renderReview: (source: Float32Array, rate: number) => any } }
      ).RezonansSingingReview;
      if (!helper) throw new Error("The REZONANS review renderer did not register");
      const mono = new Float32Array(audio.length);
      const left = audio.getChannelData(0);
      if (audio.numberOfChannels === 1) mono.set(left);
      else {
        const right = audio.getChannelData(1);
        for (let i = 0; i < mono.length; i++) mono[i] = (left[i]! + right[i]!) * 0.5;
      }
      const report = helper.renderReview(mono, audio.sampleRate);
      for (const output of report.outputs) {
        const response = await fetch(`${baseUrl}/output/${output.file}`, {
          method: "POST",
          headers: { "content-type": "audio/wav" },
          body: output.wav,
        });
        if (!response.ok) throw new Error(`Could not save ${output.file} (${response.status})`);
        delete output.wav;
      }
      const decoded = { sampleRate: audio.sampleRate, channels: audio.numberOfChannels, frames: audio.length };
      await context.close();
      return { report, decoded };
    },
    { assetName: ASSET_NAME, baseUrl: `http://127.0.0.1:${address.port}` },
  );

  const rows = result.report.outputs.map((item: any) => {
    const db = 20 * Math.log10(Math.max(item.peak, 1e-12));
    return `| ${item.file} | ${item.label} | ${item.rms.toFixed(4)} | ${db.toFixed(2)} dBFS | ${item.meters?.voicedRatio == null ? "—" : `${(item.meters.voicedRatio * 100).toFixed(1)}%`} |`;
  });
  const manifest = {
    source: {
      file: "source-owstu-cc0.mp3",
      title: "female vocal long.wav",
      creator: "owstu",
      sourcePage: SOURCE_PAGE,
      license: "CC0 1.0 Universal",
      sourceDescription:
        "Female voice singing single-note improvisation; Freesound lists 44.1 kHz, mono, 16-bit WAV. The locally included file is Freesound's high-quality MP3 preview because the original download requires sign-in.",
      sha256: "D13858C476B5A8D9401419682E2A3324539768FF1DDD1541885CFB654AA70C2C",
    },
    decoded: result.decoded,
    render: {
      sampleRate: result.report.sampleRate,
      sourceFrames: result.report.sourceFrames,
      durationSeconds: result.report.durationSeconds,
      fftSize: FFT_SIZE,
      latencySamples: ALIGN_LATENCY,
      latencyMs: result.report.alignmentMs,
      quality: "fine",
      mix: 1,
      clarityThreshold: 0.75,
      bodyGate: 0.5,
      humanize: 0,
      sharedPeakGain: result.report.sharedPeakGain,
      outputs: result.report.outputs.map(({ wav: _wav, ...item }: any) => item),
    },
  };
  await writeFile(path.join(OUTPUT_DIR, "README.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    path.join(OUTPUT_DIR, "README.md"),
    `# REZONANS — sung-vocal review\n\n` +
      `Human listening material, not an automated pass. Source: [${manifest.source.title} by ${manifest.source.creator}](${SOURCE_PAGE}), marked CC0 1.0 on Freesound. The included source is the high-quality MP3 preview; its SHA-256 is pinned in README.json.\n\n` +
      `The mono source was decoded and resampled by Chromium to 48 kHz. Every file is stereo PCM16, aligned to Fine's measured ${ALIGN_LATENCY}-sample (${result.report.alignmentMs.toFixed(2)} ms) path, RMS-matched over the sung phrase, and given the same peak-safe final gain. The processor runs Fine (4096 FFT), 100% wet, clarity 0.75, body gate 0.5, and no humanization.\n\n` +
      `| File | Signal | Phrase RMS | Peak | Voiced frames |\n| --- | --- | ---: | ---: | ---: |\n${rows.join("\n")}\n\n` +
      `## Listen for\n\n` +
      `1. Compare 00 and 01 for tone stability and audible coloration at neutral settings.\n` +
      `2. Compare 02 against 00: does the fifth stay convincing as the singer changes notes?\n` +
      `3. Compare 03 and 04 against 02: do the formant extremes keep a believable vocal identity?\n` +
      `4. Note false note jumps, graininess on held notes, and any unevenness between syllables.\n\n` +
      `This sample contains sung notes but no lyric-rich consonant sequence. Use the separate speech review for intelligibility and consonant-smear checks. A human listening decision is still required.\n`,
  );
  console.log(JSON.stringify({ directory: OUTPUT_DIR, decoded: result.decoded, report: result.report }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(ASSET_PATH, { force: true });
}
