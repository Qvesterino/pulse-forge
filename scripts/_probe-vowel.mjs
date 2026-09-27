import { createServer } from "vite";
import { chromium } from "playwright";
const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: 5239, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:5239/", { waitUntil: "domcontentloaded", timeout: 180_000 });
const out = await page.evaluate(async () => {
  const loader = await import("/src/audio-worklets/loader.ts");
  const reg = await import("/src/effects/registry.ts");
  const defsMod = await import("/src/effects/definitions.ts");
  const rmsOf = (buf) => { const d = buf.getChannelData(0); let s = 0; for (let i = Math.floor(d.length/8); i < d.length; i++) s += d[i]*d[i]; return Math.sqrt(s / d.length); };
  const SR = 44100;
  const signal = (() => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const b = ctx.createBuffer(2, SR, SR);
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      b.getChannelData(0)[i] = 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 660 * t);
      b.getChannelData(1)[i] = 0.4 * Math.sin(2 * Math.PI * 277 * t);
    }
    return b;
  })();
  const renderVowel = async (params) => {
    const ctx = new OfflineAudioContext(2, signal.length, SR);
    await loader.loadAllWorklets(ctx);
    const rt = reg.EFFECT_DEFS.vowel.factory(ctx, { id: "p", type: "vowel", bypassed: false, params }, { bpm: 124 });
    const src = ctx.createBufferSource();
    src.buffer = signal;
    src.connect(rt.input);
    rt.output.connect(ctx.destination);
    src.start(0);
    const out = await ctx.startRendering();
    rt.dispose();
    return { rms: rmsOf(out), degraded: rt.degraded === true, reason: rt.degradedReason ?? "" };
  };
  const defs = defsMod.defaultParamsOf("vowel");
  const res = {
    defaults: await renderVowel({ ...defs }),
    mix0: await renderVowel({ ...defs, mix: 0 }),
    vowel4: await renderVowel({ ...defs, vowel: 4 }),
    res1: await renderVowel({ ...defs, resonance: 1 }),
  };
  return res;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
