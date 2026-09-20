import { createServer } from "vite";
import { chromium } from "playwright";

const server = await createServer({
  root: process.cwd(),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 5198, strictPort: true },
});
await server.listen();

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("[browser page error]", error));
  await page.goto("http://127.0.0.1:5198/", { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const [{ SampleBank }, { createProjectFromTemplate }, { renderProject }] = await Promise.all([
      import("/src/sample-library/factory.ts"),
      import("/src/project-model/templates.ts"),
      import("/src/rendering/renderer.ts"),
    ]);
    const base = createProjectFromTemplate("techno");
    const rumble = base.tracks.find((track) => track.name === "Rumble");
    if (!rumble) throw new Error("Techno template has no Rumble track");
    const scene = base.scenes[0];
    const doc = {
      ...base,
      tracks: [rumble],
      arrangement: {
        ...base.arrangement,
        clips: Array.from({ length: 8 }, (_, bar) => ({
          id: `profile-${bar}`,
          sceneId: scene.id,
          startBar: bar,
          lengthBars: 1,
        })),
      },
    };
    const bank = new SampleBank();
    const original = OfflineAudioContext.prototype.createWaveShaper;
    async function run(oversample) {
      OfflineAudioContext.prototype.createWaveShaper = function (...args) {
        const node = original.apply(this, args);
        node.oversample = oversample;
        return node;
      };
      const start = performance.now();
      try {
        const buffer = await renderProject(doc, bank, { mode: "song", sampleRate: 44100, tailSeconds: 0.2 });
        const left = buffer.getChannelData(0);
        let square = 0;
        let peak = 0;
        for (let i = 0; i < left.length; i++) {
          square += left[i] * left[i];
          peak = Math.max(peak, Math.abs(left[i]));
        }
        return { buffer, ms: performance.now() - start, rms: Math.sqrt(square / left.length), peak };
      } finally {
        OfflineAudioContext.prototype.createWaveShaper = original;
      }
    }

    const reference = await run("4x");
    const candidate = await run("2x");
    const a = reference.buffer.getChannelData(0);
    const b = candidate.buffer.getChannelData(0);
    let dot = 0;
    let a2 = 0;
    let b2 = 0;
    let diff2 = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dot += a[i] * b[i];
      a2 += a[i] * a[i];
      b2 += b[i] * b[i];
      const difference = a[i] - b[i];
      diff2 += difference * difference;
    }
    return {
      sampleRate: reference.buffer.sampleRate,
      durationSec: reference.buffer.duration,
      reference4x: { ms: reference.ms, rms: reference.rms, peak: reference.peak },
      candidate2x: { ms: candidate.ms, rms: candidate.rms, peak: candidate.peak },
      relativeDiffRms: Math.sqrt(diff2 / a2),
      correlation: dot / Math.sqrt(a2 * b2),
    };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
