import { createServer } from "vite";
import { chromium } from "playwright";
const PORT = 5307;
const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: 5307, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${PORT}/__probe_blank`, { waitUntil: "commit" });
const out = await page.evaluate(async ([PORT]) => {
  const mod = await import(`/src/plugin-audit-checks.ts?bust=${Date.now()}`);
  await mod.auditSetup();
  const state = window.__kyxPluginAuditState;
  const commands = await import("/src/commands/commands.ts");
  const renderer = await import("/src/rendering/renderer.ts");
  const storeMod = await import("/src/store/ProjectStore.ts");
  const schema = await import("/src/project-model/schema.ts");
  const reg = await import("/src/effects/registry.ts");
  const defsMod = await import("/src/effects/definitions.ts");
  const base = state.baseDoc;
  const drumId = base.tracks.find((t) => t.kind === "drum").id;
  const render = (doc, tag) => renderer.renderProject(doc, state.bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0.6, masterProcessing: false }).then((b) => {
    const d = b.getChannelData(0);
    let s = 0;
    for (let i = Math.floor(d.length/8); i < d.length; i++) s += d[i]*d[i];
    return { tag, rms: Math.round(Math.sqrt(s / (d.length - Math.floor(d.length/8))) * 1e5) / 1e5 };
  });
  const st = new storeMod.ProjectStore(base);
  for (const type of reg.EFFECT_ORDER) {
    const add = commands.addEffect(st.getDoc(), drumId, type);
    st.execute(add);
    if (defsMod.EFFECT_META[type].params.some((p) => p.id === "mix")) {
      st.execute(commands.setEffectParam(st.getDoc(), drumId, add.effectId, "mix", 0.5));
    }
  }
  const doc = st.getDoc();
  const restored = schema.normalizeProject(JSON.parse(JSON.stringify(doc)));
  const sameJson = JSON.stringify(doc) === JSON.stringify(restored);
  const seq = [];
  seq.push(await render(doc, "doc#1"));
  seq.push(await render(restored, "restored"));
  seq.push(await render(doc, "doc#2"));
  seq.push(await render(doc, "doc#3"));
  seq.push(await render(doc, "doc#4"));
  seq.push(await render(restored, "restored#2"));
  seq.push(await render(doc, "doc#5"));
  return { sameJson, seq };
}, [PORT]);
console.log(JSON.stringify(out, null, 1));
await browser.close();
await server.close();
