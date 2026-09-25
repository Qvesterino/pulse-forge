/**
 * Performance harness: offline render + project-sync timing vs project size.
 *
 * Measures, in real Chromium over the real app modules:
 *  - setProject() sync time for the built song document
 *  - renderProject() wall time (song mode, studio quality, curated bank)
 * for escalating sizes: the built song as-is, then the same song with the
 * arrangement duplicated ×2 and ×4 (tracks ×2 / ×4 too), i.e. many tracks ×
 * many clips × long project in one sweep.
 *
 * Usage: node scripts/perf-render-project.mjs   (PORT=5241 npm …)
 * Read-only: renders into throwaway contexts, never writes to the project.
 */
import { createServer } from "vite";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PORT = Number(process.env.PORT) || 5241;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/studio`, { waitUntil: "domcontentloaded", timeout: 240_000 });

const isReloadRace = (error) => /context was destroyed|navigation|interrupted|timeout/i.test(String(error));

async function withReloadRetry(fn, label, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isReloadRace(error)) throw error;
      console.log(`[retry] ${label} hit a concurrent-save race — retrying (${attempt}/${attempts})`);
      await page.waitForTimeout(8000);
      await page.goto(`http://127.0.0.1:${PORT}/studio`, { waitUntil: "domcontentloaded", timeout: 240_000 });
    }
  }
}

const results = await withReloadRetry(async () =>
  page.evaluate(async () => {
  const templates = await import("/src/project-model/templates.ts");
  const normalize = await import("/src/intent/normalize.ts");
  const song = await import("/src/intent/song.ts");
  const renderer = await import("/src/rendering/renderer.ts");
  const factory = await import("/src/sample-library/factory.ts");
  const curated = await import("/src/sample-library/curated.ts");

  const bank = await factory.generateFactoryBank();
  await curated.loadCuratedLayer(bank);
  const memoryOf = () => {
    const m = /** @type {{ memory?: { usedJSHeapSize: number } } | undefined} */ (performance).memory;
    return m ? Math.round(m.usedJSHeapSize / 1_048_576) : null;
  };

  const doc = templates.createProjectFromTemplate("house");
  const intent = normalize.normalizeIntent({ genre: "house", seed: "perf-harness" });
  const build = await song.buildSong(doc, intent);
  const base = song.applySongCommand(doc, build).execute(doc);
  const lastClipEnd = Math.max(...base.arrangement.clips.map((c) => c.startBar + c.lengthBars));
  const totalBars = base.arrangement.clips.reduce((sum, c) => sum + c.lengthBars, 0);

  const sizes = [];
  for (const factor of [1, 2, 4]) {
    // Scale: duplicate arrangement clips ×factor and add instrument tracks
    // ×factor (each with its own engine graph nodes) — "many tracks, many
    // clips, long project" in one document.
    let scaled = base;
    if (factor > 1) {
      const extraTracks = Array.from({ length: (factor - 1) * base.tracks.length }, (_, i) => {
        const inst = templates.createProjectFromTemplate("house").tracks.find((t) => t.kind === "instrument");
        return { ...inst, id: `perf-track-${factor}-${i}`, name: `Perf ${factor}-${i}` };
      });
      const extraClips = [];
      for (let k = 1; k < factor; k++) {
        for (const clip of base.arrangement.clips) {
          extraClips.push({ ...clip, id: `${clip.id}-x${k}`, startBar: clip.startBar + k * lastClipEnd });
        }
      }
      scaled = {
        ...base,
        tracks: [...base.tracks, ...extraTracks],
        arrangement: {
          ...base.arrangement,
          clips: [...base.arrangement.clips, ...extraClips],
        },
      };
    }

    const syncT0 = performance.now();
    // setProject through a throwaway engine = the full graph sync path.
    const AudioEngineMod = await import("/src/audio-engine/AudioEngine.ts");
    const ctx = new OfflineAudioContext(2, 128, 44100); // sync-only probe context
    const engine = new AudioEngineMod.AudioEngine();
    engine.attachBank(bank);
    engine.useContext(ctx);
    const syncMs = performance.now() - syncT0;
    const setT0 = performance.now();
    engine.setProject(scaled);
    const setProjectMs = performance.now() - setT0;

    const renderT0 = performance.now();
    const buffer = await renderer.renderProject(scaled, bank, {
      mode: "song",
      sampleRate: 44100,
      quality: "studio",
      tailSeconds: 1,
    });
    const renderMs = Math.round(performance.now() - renderT0);
    const audioSec = buffer.duration;

    sizes.push({
      factor,
      tracks: scaled.tracks.length,
      clips: scaled.arrangement.clips.length,
      totalBars: totalBars * factor,
      syncMs: Math.round(syncMs),
      setProjectMs: Math.round(setProjectMs),
      renderMs,
      audioSec: Math.round(audioSec),
      realtimeFactor: Math.round((renderMs / 1000 / audioSec) * 100) / 100,
      heapMb: memoryOf(),
    });
    console.log(
      `[perf] ×${factor}: ${scaled.tracks.length} tracks · ${scaled.arrangement.clips.length} clips · ${totalBars * factor} bars → setProject ${Math.round(setProjectMs)} ms · render ${renderMs} ms (${audioSec.toFixed(0)} s audio = ${sizes.at(-1).realtimeFactor}× realtime) · heap ${memoryOf()} MB`,
    );
  }
  return sizes;
}, "full sweep"));

await browser.close();
await server.close();
console.log("\n[perf] setProject and render scale linearly if realtimeFactor stays flat — report any super-linear jump.");
console.log(JSON.stringify(results, null, 1));
