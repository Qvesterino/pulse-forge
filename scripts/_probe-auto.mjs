import { createServer } from "vite";
import { chromium } from "playwright";
const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: 5231, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)));
await page.goto("http://127.0.0.1:5231/", { waitUntil: "domcontentloaded", timeout: 180_000 });
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
  const add = commands.addEffect(store.getDoc(), drumId, "msEq");
  store.execute(add);
  store.execute(commands.setEffectParam(store.getDoc(), drumId, add.effectId, "midLowGain", 15));
  const onDoc = store.getDoc();
  const on = await render(onDoc);
  // auto doc: lane 0 -> 15 on midLowGain, param left at default
  const autoStore = new storeMod.ProjectStore(base);
  const add2 = commands.addEffect(autoStore.getDoc(), drumId, "msEq");
  autoStore.execute(add2);
  const autoDoc = schema.normalizeProject({
    ...autoStore.getDoc(),
    automation: [{ id: "probe-lane", target: { kind: "fxParam", trackId: drumId, fxId: add2.effectId, paramId: "midLowGain" }, points: [{ tick: 0, value: 0 }, { tick: 1920, value: 15 }] }],
  });
  const lanes = autoDoc.automation.length;
  const auto = await render(autoDoc);
  // static-default doc (effect at defaults, no lane)
  const def = await render(autoStore.getDoc());
  return { lanes, rmsOn: rmsOf(on), rmsAuto: rmsOf(auto), rmsDef: rmsOf(def), autoLane: JSON.stringify(autoDoc.automation[0]?.points) };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
