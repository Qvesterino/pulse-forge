/**
 * Mallet-strike probe #2 — after the strike-path fix.
 *
 * Renders the mallet BUILDERS in a headless Chromium and prints, per voice, the
 * 1 ms RMS of the first millisecond against the loudest 1 ms window of the body
 * (8-32 ms) — the metric the library audit used to call the strike "inert"
 * ("every mallet's first millisecond is quieter than its own body, unlike any
 * noise-struck one-shot in the bank"). A real strike leads its own envelope.
 * The conga is the noise-struck reference; the control rows re-run the exact
 * strike recipe mallet() now uses (band-pass loss compensated, 1.2 ms burst).
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 5242;

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
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
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

  /** 1 ms RMS every 1 ms, 40 points = first 40 ms. */
  const envelope = (x) => {
    const out = [];
    for (let t = 0; t + 88 <= Math.round(0.04 * SR); t += 44) {
      let s = 0;
      for (let i = 0; i < 88; i++) s += x[t + i] * x[t + i];
      out.push(10 * Math.log10(Math.max((2 * s) / (88 * 0.375), 1e-30)));
    }
    return out;
  };
  const peakDb = (x) => {
    let p = 0;
    for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
    return 20 * Math.log10(Math.max(p, 1e-9));
  };

  const rows = [];
  const measure = (id, x) => {
    const env = envelope(x);
    const first = env[0];
    const body = Math.max(...env.slice(8, 32));
    let peakAt = 0;
    for (let i = 1; i < env.length; i++) if (env[i] > env[peakAt]) peakAt = i;
    rows.push({
      id,
      peakDb: Math.round(peakDb(x) * 10) / 10,
      firstMs: Math.round(first * 10) / 10,
      bodyMax: Math.round(body * 10) / 10,
      leadDb: Math.round((first - body) * 10) / 10,
      peakAtMs: peakAt,
    });
  };

  for (const [id, duration] of Object.entries(DUR)) {
    const ctx = new OfflineAudioContext(1, Math.ceil(duration * SR), SR);
    factory.BUILDERS[id](ctx, ctx.destination);
    measure(id, (await ctx.startRendering()).getChannelData(0));
  }

  // Control: the exact recipe mallet() now uses, at three levels.
  const control = async (level, hz, q) => {
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
    const bpGain = Math.sqrt((Math.PI * hz) / (2 * q * ctx.sampleRate));
    const g = ctx.createGain();
    g.gain.setValueAtTime(level / bpGain, t0);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.0012);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t0);
    const out = await ctx.startRendering();
    measure(`control strike ${level} @ ${hz}Hz Q${q} (bpGain ${bpGain.toFixed(3)})`, out.getChannelData(0));
  };
  await control(0.5, 2400, 0.8);
  await control(0.8, 2600, 0.9);
  await control(1.2, 2400, 0.8);
  return rows;
});

console.log("\n  voice/control                                    peak   1st-ms  body8-32   lead  envPeak@");
for (const r of report) {
  console.log(
    `  ${r.id.padEnd(48).slice(0, 48)} ${String(r.peakDb).padStart(6)} ${String(r.firstMs).padStart(8)} ${String(
      r.bodyMax,
    ).padStart(9)} ${String(r.leadDb).padStart(6)} ${String(r.peakAtMs + "ms").padStart(9)}`,
  );
}

await browser.close();
await server.close();
