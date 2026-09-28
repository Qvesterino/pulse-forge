import { createServer } from "vite";
import { chromium } from "playwright";
const PORT = 5325;
const server = await createServer({ root: process.cwd(), logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
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
  const base = state.baseDoc;
  const drumId = base.tracks.find((t) => t.kind === "drum").id;
  const render = (doc) => renderer.renderProject(doc, state.bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0.6, masterProcessing: false });
  const mk = (type, params, mode) => {
    const st = new storeMod.ProjectStore(base);
    const add = commands.addEffect(st.getDoc(), drumId, type);
    st.execute(add);
    for (const p of params) st.execute(commands.setEffectParam(st.getDoc(), drumId, add.effectId, p.id, p.value));
    if (mode === "bypassed") st.execute(commands.toggleEffectBypass(st.getDoc(), drumId, add.effectId));
    if (mode === "removed") st.execute(commands.removeEffect(st.getDoc(), drumId, add.effectId));
    return st.getDoc();
  };
  const results = {};
  for (const [type, params] of [["reverb", [{ id: "mix", value: 0.3 }]], ["chorus", [{ id: "mix", value: 0.5 }]], ["svFilter", [{ id: "cutoff", value: 800 }, { id: "mix", value: 1 }]]]) {
    const on = await render(mk(type, params, "on"));
    const byp = await render(mk(type, params, "bypassed"));
    const rem = await render(mk(type, params, "removed"));
    const da = on.getChannelData(0), db = byp.getChannelData(0), dr = rem.getChannelData(0);
    let diffBR = 0, firstBR = -1;
    for (let i = 0; i < Math.min(da.length, db.length); i++) {
      const d = Math.abs(db[i] - dr[i]);
      if (d > diffBR) diffBR = d;
      if (firstBR < 0 && d > 1e-6) firstBR = i;
    }
    // on vs bypassed: where does processing diverge?
    let firstOB = -1;
    for (let i = 0; i < Math.min(da.length, db.length); i++) if (Math.abs(da[i] - db[i]) > 1e-6) { firstOB = i; break; }
    results[type] = {
      maxDiffBypassVsRemoved: Math.round(diffBR * 1e6) / 1e6,
      firstBypassRemovedDiffSec: firstBR >= 0 ? Math.round(firstBR / 44.1) / 1000 : "same",
      firstOnVsBypassSec: firstOB >= 0 ? Math.round(firstOB / 44.1) / 1000 : "same",
      rmsOn: (() => { let s = 0; for (let i = Math.floor(da.length/8); i < da.length; i++) s += da[i]*da[i]; return Math.round(Math.sqrt(s/(da.length - Math.floor(da.length/8)))*1e4)/1e4; })(),
      rmsByp: (() => { let s = 0; for (let i = Math.floor(db.length/8); i < db.length; i++) s += db[i]*db[i]; return Math.round(Math.sqrt(s/(db.length - Math.floor(db.length/8)))*1e4)/1e4; })(),
    };
  }
  return results;
}, [PORT]);
console.log(JSON.stringify(out, null, 1));
await browser.close();
await server.close();
