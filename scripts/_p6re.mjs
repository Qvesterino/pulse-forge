import { createServer } from "vite";
import { chromium } from "playwright";
const PORT = 5327;
const server = await createServer({ root: process.cwd(), logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)));
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
  const cases = [
    ["gate", [{ id: "threshold", value: -30 }, { id: "release", value: 0.5 }]],
    ["distortion", [{ id: "drive", value: 0.7 }]],
    ["utility", [{ id: "gain", value: -6 }]],
    ["phaser", [{ id: "mix", value: 0.5 }]],
    ["eq", [{ id: "lowMidGain", value: 6 }]],
  ];
  const results = {};
  for (const [type, params] of cases) {
    // two independent rounds: byp/rem rendered in BOTH orders to detect order-dependence
    const byp1 = await render(mk(type, params, "bypassed"));
    const rem1 = await render(mk(type, params, "removed"));
    const byp2 = await render(mk(type, params, "bypassed"));
    const rem2 = await render(mk(type, params, "removed"));
    const maxd = (a, b) => { let m = 0; const da = a.getChannelData(0), db = b.getChannelData(0); for (let i = 0; i < Math.min(da.length, db.length); i++) m = Math.max(m, Math.abs(da[i] - db[i])); return m; };
    results[type] = {
      byp1_vs_rem1: Math.round(maxd(byp1, rem1) * 1e7) / 1e7,
      byp2_vs_rem2: Math.round(maxd(byp2, rem2) * 1e7) / 1e7,
      byp1_vs_byp2: Math.round(maxd(byp1, byp2) * 1e7) / 1e7,
      rem1_vs_rem2: Math.round(maxd(rem1, rem2) * 1e7) / 1e7,
    };
  }
  return results;
}, [PORT]);
console.log(JSON.stringify(out, null, 1));
await browser.close();
await server.close();
