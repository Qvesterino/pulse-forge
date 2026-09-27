import { createServer } from "vite";
import { chromium } from "playwright";
const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: 5233, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:5233/", { waitUntil: "domcontentloaded", timeout: 180_000 });
const out = await page.evaluate(async () => {
  const reg = await import("/src/instruments/registry.ts");
  const loader = await import("/src/audio-worklets/loader.ts");
  const mk = (kind, id) => ({ id, kind: "instrument", instrument: kind, name: kind, gain: 1, pan: 0, mute: false, solo: false, sampleId: null, params: reg.defaultInstrumentParams(kind), effects: [], sends: {} });
  const peakOf = (buf) => { let v = 0; for (const ch of [0,1]) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) v = Math.max(v, Math.abs(d[i])); } return v; };
  const bank = await (await import("/src/sample-library/factory.ts")).generateFactoryBank();
  const run = async (kind, loadWorklets, live) => {
    let ctx;
    if (live) { ctx = new AudioContext(); if (ctx.state === "suspended") await ctx.resume(); }
    else ctx = new OfflineAudioContext(2, 44100, 44100);
    if (loadWorklets) await loader.loadAllWorklets(ctx);
    const track = mk(kind, "p");
    if (kind === "granular") { track.sampleId = "factory.tonal.keys"; track.params = { ...track.params, release: 0.01, rate: 30 }; }
    const rt = reg.INSTRUMENT_DEFS[kind].factory(ctx, track, { bpm: 124, getSample: (id) => bank.get(id) });
    rt.output.connect(ctx.destination);
    if (live) {
      rt.noteOn(60, 0.9, ctx.currentTime + 0.05, 0.5);
      await new Promise((r) => setTimeout(r, 700));
      const an = ctx.createAnalyser ? null : null;
      rt.panic?.();
      await ctx.close();
      return "live-not-metered";
    }
    rt.noteOn(60, 0.9, 0.05, 0.5);
    const buf = await ctx.startRendering();
    rt.dispose?.();
    return peakOf(buf);
  };
  return {
    wavetable_offline_withWorklets: await run("wavetable", true, false),
    wavetable_offline_noWorklets: await run("wavetable", false, false),
    granular_offline_withWorklets: await run("granular", true, false),
    granular_offline_noWorklets: await run("granular", false, false),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
