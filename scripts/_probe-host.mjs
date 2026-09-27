import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: 5229, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)));
await page.goto("http://127.0.0.1:5229/", { waitUntil: "domcontentloaded", timeout: 180_000 });
const out = await page.evaluate(async () => {
  const mod = await import("/src/plugin-audit-checks.ts");
  await mod.auditSetup();
  const state = window.__kyxPluginAuditState;
  const schema = await import("/src/project-model/schema.ts");
  const commands = await import("/src/commands/commands.ts");
  const renderer = await import("/src/rendering/renderer.ts");
  const bankFactory = await import("/src/sample-library/factory.ts");
  const bank = await bankFactory.generateFactoryBank();
  const base = state.baseDoc;
  const drumId = base.tracks.find((t) => t.kind === "drum").id;
  const render = (doc) => renderer.renderProject(doc, bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0.6 });
  const rmsOf = (buf) => { const d = buf.getChannelData(0); let s = 0; for (let i = Math.floor(d.length/8); i < d.length; i++) s += d[i]*d[i]; return Math.sqrt(s / d.length); };
  const results = {};
  for (const type of ["distortion", "eq", "chorus"]) {
    const store = new (await import("/src/store/ProjectStore.ts")).ProjectStore(base);
    const add = commands.addEffect(store.getDoc(), drumId, type);
    store.execute(add);
    // set drive/mix to loud extremes explicitly
    if (type === "distortion") {
      store.execute(commands.setEffectParam(store.getDoc(), drumId, add.effectId, "mix", 1));
      store.execute(commands.setEffectParam(store.getDoc(), drumId, add.effectId, "drive", 1));
    }
    const doc = store.getDoc();
    const fx = doc.tracks.find((t) => t.id === drumId).effects.at(-1);
    const on = await render(doc);
    const bStore = new (await import("/src/store/ProjectStore.ts")).ProjectStore(doc);
    bStore.execute(commands.toggleEffectBypass(doc, drumId, fx.id));
    const bypassed = await render(bStore.getDoc());
    results[type] = {
      fxParams: { drive: fx.params.drive, mix: fx.params.mix, bypassed: fx.bypassed },
      rmsOn: rmsOf(on),
      rmsBypassed: rmsOf(bypassed),
      peakOn: on.getChannelData(0)[1000],
    };
  }
  return results;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
