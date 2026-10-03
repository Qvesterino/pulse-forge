/**
 * Mallet-strike probe (bug #1: "the strike path is inert").
 *
 * Renders the mallet BUILDERS in a headless Chromium and prints the 1 ms RMS
 * envelope of the BUILDERS' OWN OUTPUT (before the seed renderer's tape +
 * limiter + trim chain). The question this answers: does the click noise reach
 * the builder's destination at all?
 *   - click present here  -> the mastering chain / trim is eating it
 *   - click absent here    -> mallet() itself never renders the strike
 * Plus a from-scratch control click (same recipe copied out of mallet()) to
 * prove the technique is capable of showing a 4 ms band-passed burst.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 5241;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
let booted = false;
for (let attempt = 1; attempt <= 3 && !booted; attempt++) {
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    booted = true;
  } catch (error) {
    console.log(`[probe] goto attempt ${attempt} failed: ${String(error).split("\n")[0]}`);
  }
}
if (!booted) throw new Error("could not boot the page");

const report = await page.evaluate(async () => {
  const factory = await import("/src/sample-library/factory.ts");
  const SR = 44100;

  const DUR = {
    "factory.mallet.vibes": 3.2,
    "factory.mallet.marimba": 1.2,
    "factory.mallet.celesta": 1.9,
    "factory.mallet.kalimba": 1.0,
    "factory.mallet.musicbox": 2.2,
    "factory.perc.conga": 0.4,
  };

  /** 1 ms RMS every 1 ms (same metric as tmp-ab.mjs). */
  const envelope = (x, ms) => {
    const out = [];
    for (let t = 0; t + 88 <= Math.round(ms * 0.001 * SR); t += 44) {
      let s = 0;
      for (let i = 0; i < 88; i++) s += x[t + i] * x[t + i];
      out.push(Math.round(10 * Math.log10(Math.max((2 * s) / (88 * 0.375), 1e-30)) * 10) / 10);
    }
    return out;
  };
  const peakDb = (x) => {
    let p = 0;
    for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
    return Math.round(20 * Math.log10(Math.max(p, 1e-9)) * 10) / 10;
  };

  const rows = [];
  for (const [id, duration] of Object.entries(DUR)) {
    const ctx = new OfflineAudioContext(1, Math.ceil(duration * SR), SR);
    factory.BUILDERS[id](ctx, ctx.destination);
    const buffer = await ctx.startRendering();
    const x = buffer.getChannelData(0);
    rows.push({ id, peakDb: peakDb(x), first24ms: envelope(x, 24) });
  }

  // Control: the exact click recipe mallet() uses, built from scratch.
  const controlRow = async (level, hz, q) => {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const t0 = ctx.currentTime;
    const len = Math.max(1, Math.floor(0.02 * ctx.sampleRate));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let a = 8 >>> 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < len; i++) data[i] = rand() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = hz;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t0);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.004);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t0);
    const out = await ctx.startRendering();
    const y = out.getChannelData(0);
    return { id: `control click ${level} @ ${hz}Hz Q${q}`, peakDb: peakDb(y), first24ms: envelope(y, 24) };
  };
  rows.push(await controlRow(0.34, 2400, 0.8));
  rows.push(await controlRow(0.12, 4186, 1));
  return rows;
});

for (const row of report) {
  console.log(`\n=== ${row.id} ===\n  builder peak ${row.peakDb} dBFS`);
  console.log(`  1ms-RMS first 24ms: ${row.first24ms.map((v) => v.toFixed(1)).join(" ")}`);
}

await browser.close();
await server.close();
