import { createServer } from "vite";
import { chromium } from "playwright";
const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: 5245, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:5245/", { waitUntil: "domcontentloaded", timeout: 180_000 });
const out = await page.evaluate(async () => {
  const reg = await import("/src/effects/registry.ts");
  const defsMod = await import("/src/effects/definitions.ts");
  const loader = await import("/src/audio-worklets/loader.ts");
  const SR = 44100;
  const sigCtx = new OfflineAudioContext(2, SR, SR);
  const signal = sigCtx.createBuffer(2, SR, SR);
  for (let i = 0; i < signal.length; i++) {
    const t = i / SR;
    signal.getChannelData(0)[i] = 0.4 * Math.sin(2 * Math.PI * 220 * t);
    signal.getChannelData(1)[i] = 0.4 * Math.sin(2 * Math.PI * 330 * t);
  }
  const rmsOf = (buf) => { const d = buf.getChannelData(0); let s = 0; for (let i = Math.floor(d.length/8); i < d.length; i++) s += d[i]*d[i]; return Math.sqrt(s / d.length); };
  const renderK = async (applyAt) => {
    const ctx = new OfflineAudioContext(2, signal.length, SR);
    await loader.loadAllWorklets(ctx);
    const rt = reg.EFFECT_DEFS.kaskada.factory(ctx, { id: "p", type: "kaskada", bypassed: false, params: defsMod.defaultParamsOf("kaskada") }, { bpm: 124 });
    const src = ctx.createBufferSource();
    src.buffer = signal;
    src.connect(rt.input);
    rt.output.connect(ctx.destination);
    src.start(0);
    if (applyAt === "set") rt.setParameter("level", 6);
    if (applyAt === "at") rt.setParameterAt("level", 6, 0.1);
    const buf = await ctx.startRendering();
    rt.dispose();
    return rmsOf(buf);
  };
  return { defaults: await renderK(null), setNow: await renderK("set"), setAt01: await renderK("at") };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
