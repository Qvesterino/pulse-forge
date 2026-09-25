/**
 * CPU profile of a ×2-scaled offline render — finds the super-linear hotspot
 * behind the O(n²)-ish render scaling (audit 15 deep-dive).
 */
import { createServer } from "vite";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PORT = Number(process.env.PORT) || 5242;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/studio`, { waitUntil: "domcontentloaded", timeout: 240_000 });

const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.start");

const result = await withReloadRetry(() =>
  page.evaluate(async () => {
    const templates = await import("/src/project-model/templates.ts");
    const normalize = await import("/src/intent/normalize.ts");
    const song = await import("/src/intent/song.ts");
    const renderer = await import("/src/rendering/renderer.ts");
    const factory = await import("/src/sample-library/factory.ts");
    const curated = await import("/src/sample-library/curated.ts");

    const bank = await factory.generateFactoryBank();
    await curated.loadCuratedLayer(bank);
    const doc = templates.createProjectFromTemplate("house");
    const build = await song.buildSong(doc, normalize.normalizeIntent({ genre: "house", seed: "perf-harness" }));
    const base = song.applySongCommand(doc, build).execute(doc);
    const lastClipEnd = Math.max(...base.arrangement.clips.map((c) => c.startBar + c.lengthBars));

    const extraTracks = Array.from({ length: base.tracks.length }, (_, i) => {
      const inst = templates.createProjectFromTemplate("house").tracks.find((t) => t.kind === "instrument");
      return { ...inst, id: `perf-track-2-${i}`, name: `Perf 2-${i}` };
    });
    const extraClips = base.arrangement.clips.map((clip) => ({
      ...clip,
      id: `${clip.id}-x1`,
      startBar: clip.startBar + lastClipEnd,
    }));
    let scaled = {
      ...base,
      tracks: [...base.tracks, ...extraTracks],
      arrangement: { ...base.arrangement, clips: [...base.arrangement.clips, ...extraClips] },
    };
    // Silence probe: same graph, same worklets, zero notes.
    scaled = Object.assign({}, scaled, {
      patterns: scaled.patterns.map((p) => ({ ...p, rows: {}, notes: {} })),
    });

    const t0 = performance.now();
    const buffer = await renderer.renderProject(scaled, bank, { mode: "song", sampleRate: 44100, quality: "studio", tailSeconds: 1 });
    return { renderMs: Math.round(performance.now() - t0), audioSec: Math.round(buffer.duration) };
  }),
  "×2 render");

console.log(`[perf-profile] ×2 render: ${result.renderMs} ms for ${result.audioSec} s audio`);
const { profile } = await cdp.send("Profiler.stop");
// Aggregate self time per function from the CPU profile nodes + timeDeltas.
const selfTime = new Map();
const { nodes, samples = [], timeDeltas = [] } = profile;
const byId = new Map(nodes.map((n) => [n.id, n]));
let total = 0;
for (let i = 0; i < samples.length; i++) {
  const node = byId.get(samples[i]);
  const delta = timeDeltas[i] ?? 0;
  if (!node) continue;
  total += delta;
  const cf = node.callFrame;
  const key = `${cf.functionName || "(anonymous)"} @ ${(cf.url || "").split("/").pop()}:${cf.lineNumber + 1}`;
  selfTime.set(key, (selfTime.get(key) ?? 0) + delta);
}
console.log(`[perf-profile] total sampled: ${(total / 1000).toFixed(0)} ms — top self-time:`);
for (const [key, us] of [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(`  ${(us / 1000).toFixed(0).padStart(6)} ms  ${(100 * (us / total)).toFixed(1).padStart(5)}%  ${key}`);
}

await browser.close();
await server.close();

async function withReloadRetry(fn, label, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !/context was destroyed|navigation|interrupted|timeout/i.test(String(error))) throw error;
      console.log(`[retry] ${label} — retrying (${attempt}/${attempts})`);
      await page.waitForTimeout(8000);
      await page.goto(`http://127.0.0.1:${PORT}/studio`, { waitUntil: "domcontentloaded", timeout: 240_000 });
    }
  }
}
