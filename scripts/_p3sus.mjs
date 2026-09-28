import { createServer } from "vite";
import { chromium } from "playwright";
const PORT = 5323;
const server = await createServer({ root: process.cwd(), logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${PORT}/__probe_blank`, { waitUntil: "commit" });
const out = await page.evaluate(async ([PORT]) => {
  const reg = await import("/src/instruments/registry.ts");
  const loader = await import("/src/audio-worklets/loader.ts");
  const SR = 44100;
  const full = async (kind, params) => {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    await loader.loadAllWorklets(ctx);
    const def = reg.INSTRUMENT_DEFS[kind];
    const track = { id: "p", kind: "instrument", instrument: kind, name: kind, gain: 1, pan: 0, mute: false, solo: false, sampleId: "factory.tonal.pluck", params, effects: [], sends: {} };
    const rt = def.factory(ctx, track, { bpm: 124, getSample: (id) => undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(45, 0.9, 0.05, 0.35);
    if (!["808", "logdrum", "drumsynth"].includes(kind)) rt.noteOff?.(45, 0.4);
    const buf = await ctx.startRendering();
    rt.dispose();
    const d = buf.getChannelData(0);
    const rmsWin = (f, t) => { let s = 0; const a = Math.floor(f*SR), b = Math.min(d.length, Math.floor(t*SR)); for (let i = a; i < b; i++) s += d[i]*d[i]; return Math.sqrt(s/Math.max(1, b-a)); };
    // spectral centroid over 0.05-0.4
    let num = 0, den = 0;
    const N = 4096;
    for (let off = Math.floor(0.05*SR); off + N < Math.min(d.length, Math.floor(0.4*SR)); off += N) {
      const re = new Float32Array(N); const im = new Float32Array(N);
      for (let i = 0; i < N; i++) { const w = 0.5 - 0.5*Math.cos((2*Math.PI*i)/(N-1)); re[i] = d[off+i]*w; }
      for (let k = 1; k < N/2; k++) { const mag = Math.hypot(re[k], im[k]); num += (k*SR/N)*mag; den += mag; }
    }
    return { rms: rmsWin(0.05, 0.4), centroid: den > 1e-9 ? Math.round(num/den) : 0 };
  };
  const defs = reg.defaultInstrumentParams;
  return {
    vocalchop_default: await full("vocalchop", defs("vocalchop")),
    vocalchop_shift12: await full("vocalchop", { ...defs("vocalchop"), shift: 12 }),
    wavetable_default: await full("wavetable", defs("wavetable")),
    wavetable_morph1: await full("wavetable", { ...defs("wavetable"), morph: 1 }),
    wavetable_table3: await full("wavetable", { ...defs("wavetable"), table: 3 }),
    clav_default: await full("clav", defs("clav")),
    clav_cutoff16000: await full("clav", { ...defs("clav"), cutoff: 16000 }),
    texture_relMax: await full("texture", { ...defs("texture"), release: 2 }),
  };
}, [PORT]);
console.log(JSON.stringify(out, null, 1));
await browser.close();
await server.close();
