import { createServer } from "vite";
import { chromium } from "playwright";
const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: 5237, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:5237/", { waitUntil: "domcontentloaded", timeout: 180_000 });
const out = await page.evaluate(async () => {
  const mod = await import("/src/plugin-audit-checks.ts");
  await mod.auditSetup();
  const state = window.__kyxPluginAuditState;
  const schema = await import("/src/project-model/schema.ts");
  const commands = await import("/src/commands/commands.ts");
  const renderer = await import("/src/rendering/renderer.ts");
  const storeMod = await import("/src/store/ProjectStore.ts");
  const base = state.baseDoc;
  const drumId = base.tracks.find((t) => t.kind === "drum").id;
  const render = (doc) => renderer.renderProject(doc, state.bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0.6 });
  const rmsOf = (buf) => { const d = buf.getChannelData(0); let s = 0; for (let i = Math.floor(d.length/8); i < d.length; i++) s += d[i]*d[i]; return Math.sqrt(s / d.length); };
  const store = new storeMod.ProjectStore(base);
  const add = commands.addEffect(store.getDoc(), drumId, "multiTapDelay");
  store.execute(add);
  // fingerprint from sweep: taps? feedback? set the top-2 audit picks
  store.execute(commands.setEffectParam(store.getDoc(), drumId, add.effectId, "mix", 0.3));
  store.execute(commands.setEffectParam(store.getDoc(), drumId, add.effectId, "feedback", 0.85));
  const doc = store.getDoc();
  const before = doc.tracks.find((t) => t.id === drumId).effects.at(-1).params;
  const restored = schema.normalizeProject(JSON.parse(JSON.stringify(doc)));
  const after = restored.tracks.find((t) => t.id === drumId).effects.at(-1).params;
  const paramDiff = {};
  for (const k of Object.keys(before)) if (before[k] !== after[k]) paramDiff[k] = [before[k], after[k]];
  const a = await render(doc);
  const b = await render(restored);
  // sample-level: find first divergence point
  const da = a.getChannelData(0); const db = b.getChannelData(0);
  let firstDiff = -1;
  for (let i = 0; i < Math.min(da.length, db.length); i++) if (Math.abs(da[i]-db[i]) > 1e-5) { firstDiff = i; break; }
  return {
    paramDiff,
    rmsA: rmsOf(a), rmsB: rmsOf(b),
    firstDiffSample: firstDiff, firstDiffSec: firstDiff >= 0 ? firstDiff / 44100 : -1,
    lenA: da.length, lenB: db.length,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
