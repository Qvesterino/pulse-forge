/**
 * Curated seed generator (VISION §5 factory-content pass).
 *
 * Renders the CURATED_SAMPLES slot list through the app's OWN synthesis and
 * its mastering chain (tape saturation + look-ahead limiter — the same
 * processors the master bus uses) in a headless Chromium, then writes 24-bit
 * WAVs into public/samples/. These SEEDS make the curated pipeline work and
 * sound glued from day one — replace the files with real recordings (same
 * names, see public/samples/README.md) when curation happens.
 *
 * Usage: npm run curated:seeds
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5233;
const outDir = path.join(root, "public", "samples");

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

const results = await page.evaluate(async () => {
  const factory = await import("/src/sample-library/factory.ts");
  const curated = await import("/src/sample-library/curated.ts");
  const wav = await import("/src/rendering/wav.ts");
  const loader = await import("/src/audio-worklets/loader.ts");

  const SR = 44100;
  const bank = await factory.generateFactoryBank();

  const out = [];
  for (const sample of curated.CURATED_SAMPLES) {
    const src = bank.get(sample.id);
    if (!src) throw new Error(`factory asset ${sample.id} missing`);
    // Mastering chain per slot: tape saturation into the look-ahead limiter
    // (the same processors the master bus uses) — glue + a controlled
    // ceiling, so the seeds sit together like a mixed kit.
    const render = new OfflineAudioContext(2, Math.ceil((src.duration + 0.4) * SR), SR);
    await loader.loadCoreWorklets(render);

    const tape = new AudioWorkletNode(render, "tape-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelInterpretation: "speakers",
    });
    tape.parameters.get("drive").value = 0.18;
    tape.parameters.get("tone").value = 9000;
    tape.parameters.get("mix").value = 1;

    const limiter = new AudioWorkletNode(render, "limiter-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelInterpretation: "speakers",
    });
    limiter.parameters.get("ceiling").value = -1.5;

    const player = render.createBufferSource();
    player.buffer = src;
    player.connect(tape);
    tape.connect(limiter);
    limiter.connect(render.destination);
    player.start(0);
    const mastered = await render.startRendering();

    const encoded = wav.encodeWav(mastered, 24);
    const bytes = new Uint8Array(encoded);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    out.push({ file: sample.file, b64: btoa(binary) });
  }
  return out;
});

mkdirSync(outDir, { recursive: true });
for (const { file, b64 } of results) {
  const bytes = Buffer.from(b64, "base64");
  writeFileSync(path.join(outDir, file), bytes);
  console.log(`[curated-seeds] ${file} — ${(bytes.length / 1024).toFixed(1)} kB`);
}

await browser.close();
await server.close();
console.log(`[curated-seeds] ${results.length} seed(s) written to public/samples/ (replace with real recordings!)`);
