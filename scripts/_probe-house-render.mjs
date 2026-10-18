/**
 * TEMPORARY diagnostic — delete after use.
 * Boots the audit's own Vite config (hmr off) and asks the page, in order:
 *   1. does the worklet manifest resolve, and what URL does the loader build?
 *   2. do the core worklet modules actually register?
 *   3. does the house template render, and what is in it?
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5299;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true, hmr: false, watch: null },
});
await server.listen();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
const console_ = [];
page.on("console", (m) => console_.push(`${m.type()}: ${m.text().slice(0, 200)}`));
page.on("pageerror", (e) => console_.push(`pageerror: ${String(e).slice(0, 200)}`));

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });

  const probe = await page.evaluate(async () => {
    const out = {};
    try {
      const wm = await import("/src/audio-worklets/workletManifest.ts");
      const m = await wm.loadWorkletManifest();
      out.manifest = m ? `${Object.keys(m.assets).length} assets` : "null (unversioned fallback)";
      out.coreUrl = wm.workletFileUrl("/core-worklet.js", m);
    } catch (e) {
      out.manifestErr = String(e).slice(0, 200);
    }
    for (const p of ["/worklets-manifest.json", "/core-worklet.js?v=deadbeef", "/core-worklet.js"]) {
      try {
        const r = await fetch(p);
        const t = await r.text();
        out[`fetch ${p}`] = `${r.status} ${r.headers.get("content-type")} bytes=${t.length}`;
      } catch (e) {
        out[`fetch ${p}`] = String(e).slice(0, 120);
      }
    }
    try {
      const loader = await import("/src/audio-worklets/loader.ts");
      const ctx = new OfflineAudioContext(2, 4800, 48000);
      try {
        await loader.loadCoreWorklets(ctx);
        out.coreWorklets = "loaded";
      } catch (e) {
        out.coreWorklets = `THREW: ${String(e).slice(0, 300)}`;
      }
    } catch (e) {
      out.coreWorklets = `IMPORT THREW: ${String(e).slice(0, 300)}`;
    }
    return out;
  });

  const house = await page.evaluate(async () => {
    const out = {};
    try {
      const t = await import("/src/project-model/templates.ts");
      const doc = t.createProjectFromTemplate("house");
      out.tracks = doc.tracks.map((x) => `${x.kind}:${x.name}:clips=${x.clips ? x.clips.length : "n/a"}`);
      out.arrangementClips = doc.arrangement?.clips?.length ?? "none";
      out.scenes = doc.scenes?.length ?? "none";
      out.patterns = doc.patterns?.length ?? "none";
      const drum = doc.tracks.find((t) => t.kind === "drum");
      out.drumFound = Boolean(drum);
      if (drum) {
        out.drumClipCount = drum.clips?.length ?? 0;
        out.drumClips = (drum.clips ?? []).slice(0, 4).map((c) => JSON.stringify(c).slice(0, 200));
        out.drumVol = drum.volume ?? "n/a";
        out.drumMuted = drum.muted ?? "n/a";
      }
    } catch (e) {
      out.docErr = String(e).slice(0, 300);
    }
    return out;
  });

  console.log(JSON.stringify({ probe, house }, null, 2));
  console.log("--- console ---");
  for (const c of console_.slice(0, 25)) console.log(c);
} finally {
  await browser.close();
  await server.close();
}