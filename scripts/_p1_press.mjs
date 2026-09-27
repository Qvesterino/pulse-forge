import { createServer } from "vite";
import { chromium } from "playwright";
const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: 5295, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)));
await page.goto("http://127.0.0.1:5295/", { waitUntil: "domcontentloaded", timeout: 180_000 });
const out = await page.evaluate(async () => {
  const mod = await import(`/src/plugin-audit-checks.ts?bust=${Date.now()}`);
  await mod.auditSetup();
  const state = window.__kyxPluginAuditState;
  const commands = await import("/src/commands/commands.ts");
  const renderer = await import("/src/rendering/renderer.ts");
  const storeMod = await import("/src/store/ProjectStore.ts");
  const reg = await import("/src/effects/registry.ts");
  const defsMod = await import("/src/effects/definitions.ts");
  const base = state.baseDoc;
  const drumId = base.tracks.find((t) => t.kind === "drum").id;
  const render = (doc) => renderer.renderProject(doc, state.bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0.6, masterProcessing: false });
  const rmsOf = (buf) => { const d = buf.getChannelData(0); let s = 0; for (let i = Math.floor(d.length/8); i < d.length; i++) s += d[i]*d[i]; return Math.sqrt(s / d.length); };
  const st = new storeMod.ProjectStore(base);
  for (const type of reg.EFFECT_ORDER) {
    const add = commands.addEffect(st.getDoc(), drumId, type);
    st.execute(add);
    if (defsMod.EFFECT_META[type].params.some((p) => p.id === "mix")) {
      st.execute(commands.setEffectParam(st.getDoc(), drumId, add.effectId, "mix", 0.5));
    }
  }
  const doc = st.getDoc();
  const stamps = [];
  stamps.push(Math.round(rmsOf(await render(doc)) * 1e5) / 1e5);
  // pressure: 400 throwaway offline contexts (like a full audit sweep)
  for (let i = 0; i < 400; i++) {
    const c = new OfflineAudioContext(2, 4096, 44100);
    await c.startRendering().catch(() => {});
  }
  stamps.push("...400 contexts...");
  for (let i = 0; i < 4; i++) stamps.push(Math.round(rmsOf(await render(doc)) * 1e5) / 1e5);
  return stamps;
});
console.log(JSON.stringify(out));
await browser.close();
await server.close();
