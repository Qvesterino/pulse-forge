import { createServer } from "vite";
import { chromium } from "playwright";
const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: 5235, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:5235/", { waitUntil: "domcontentloaded", timeout: 180_000 });
const out = await page.evaluate(async () => {
  const reg = await import("/src/instruments/registry.ts");
  const loader = await import("/src/audio-worklets/loader.ts");
  const mk = (kind, id) => ({ id, kind: "instrument", instrument: kind, name: kind, gain: 1, pan: 0, mute: false, solo: false, sampleId: null, params: reg.defaultInstrumentParams(kind), effects: [], sends: {} });
  const liveProbe = async (kind) => {
    const ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    await loader.loadAllWorklets(ctx);
    const rt = reg.INSTRUMENT_DEFS[kind].factory(ctx, mk(kind, "probe"), { bpm: 124, getSample: () => undefined });
    const dest = ctx.createMediaStreamDestination ? null : null;
    // Meter via a ScriptedAnalyser: use an AnalyserNode on the output.
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    rt.output.connect(an);
    rt.noteOn(60, 0.9, ctx.currentTime + 0.05, 0.5);
    await new Promise((r) => setTimeout(r, 400));
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    rt.panic?.();
    rt.dispose?.();
    await ctx.close();
    return peak;
  };
  return {
    wavetable_live_worklet: await liveProbe("wavetable"),
    granular_live_worklet: await liveProbe("granular"),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
