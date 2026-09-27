import { createServer } from "vite";
import { chromium } from "playwright";
const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: 5243, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:5243/", { waitUntil: "domcontentloaded", timeout: 180_000 });
const out = await page.evaluate(async () => {
  const reg = await import("/src/effects/registry.ts");
  const defsMod = await import("/src/effects/definitions.ts");
  const SR = 44100;
  const signalCtx = new OfflineAudioContext(2, SR, SR);
  const signal = signalCtx.createBuffer(2, SR, SR);
  for (let i = 0; i < signal.length; i++) {
    const t = i / SR;
    signal.getChannelData(0)[i] = 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 55 * t);
    signal.getChannelData(1)[i] = 0.4 * Math.sin(2 * Math.PI * 277 * t);
  }
  const rmsOf = (buf) => { const d = buf.getChannelData(0); let s = 0; for (let i = Math.floor(d.length/8); i < d.length; i++) s += d[i]*d[i]; return Math.sqrt(s / d.length); };
  const renderPhaser = async (constructorParams, applyParams) => {
    const ctx = new OfflineAudioContext(2, signal.length, SR);
    await (await import("/src/audio-worklets/loader.ts")).loadAllWorklets(ctx);
    const params = { ...defsMod.defaultParamsOf("phaser"), ...constructorParams };
    const rt = reg.EFFECT_DEFS.phaser.factory(ctx, { id: "p", type: "phaser", bypassed: false, params }, { bpm: 124 });
    for (const [id, v] of Object.entries(applyParams ?? {})) rt.setParameter(id, v);
    const src = ctx.createBufferSource();
    src.buffer = signal;
    src.connect(rt.input);
    rt.output.connect(ctx.destination);
    src.start(0);
    const buf = await ctx.startRendering();
    rt.dispose();
    return rmsOf(buf);
  };
  const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
  const renderBuf = async (constructorParams, applyParams) => {
    const ctx = new OfflineAudioContext(2, signal.length, SR);
    await (await import("/src/audio-worklets/loader.ts")).loadAllWorklets(ctx);
    const params = { ...defsMod.defaultParamsOf("phaser"), ...constructorParams };
    const rt = reg.EFFECT_DEFS.phaser.factory(ctx, { id: "p", type: "phaser", bypassed: false, params }, { bpm: 124 });
    for (const [id, v] of Object.entries(applyParams ?? {})) rt.setParameter(id, v);
    const src = ctx.createBufferSource();
    src.buffer = signal;
    src.connect(rt.input);
    rt.output.connect(ctx.destination);
    src.start(0);
    const buf = await ctx.startRendering();
    rt.dispose();
    return buf.getChannelData(0).slice(20000, 21000);
  };
  const base = await renderBuf(null, null);
  return {
    diff_rate8: maxDiff(base, await renderBuf({ rate: 8 }, null)),
    diff_depth0: maxDiff(base, await renderBuf({ depth: 0 }, null)),
    diff_mix1: maxDiff(base, await renderBuf({ mix: 1 }, null)),
    diff_center3000: maxDiff(base, await renderBuf({ center: 3000 }, null)),
    diff_stages8: maxDiff(base, await renderBuf({ stages: 3 }, null)),
    diff_feedback0: maxDiff(base, await renderBuf({ feedback: 0 }, null)),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
