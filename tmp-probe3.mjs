/**
 * Strike probe #3 — WHERE does the mallet strike die?
 *
 * Builder probe #2 says the strike is present (raising clickLevel moves the
 * builder's first-millisecond envelope), but the seed A/B says it is not: the
 * celesta strike at 0.12 -> 1.1 (+19 dB) changed no band, no envelope point, no
 * peak and no crest in the mastered file. So this probe re-runs the seed
 * renderer's own mastering chain in the page, stage by stage, on
 *   (a) the marimba builder output, and
 *   (b) a raw control click (strike recipe alone, no body),
 * printing the first 6 ms of the 1 ms-RMS envelope after each stage. If (b)
 * arrives intact, the chain is innocent.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 5244;

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
  const loader = await import("/src/audio-worklets/loader.ts");
  const SR = 44100;
  const TONAL = { drive: 0.16, tone: 9500, ceiling: -1.8 };
  const NORM = Math.pow(10, -25.3 / 20);

  const env = (x) => {
    const out = [];
    for (let t = 0; t + 88 <= Math.round(0.006 * SR); t += 44) {
      let s = 0;
      for (let i = 0; i < 88; i++) s += x[t + i] * x[t + i];
      out.push((10 * Math.log10(Math.max((2 * s) / (88 * 0.375), 1e-30))).toFixed(1));
    }
    return out.join(" ");
  };
  const peakDb = (x) => {
    let p = 0;
    for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
    return (20 * Math.log10(Math.max(p, 1e-9))).toFixed(1);
  };
  const firstLoud = (x) => {
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 1e-5) return i;
    return -1;
  };

  const chain = async (buffer, { tape, limiter, gain }) => {
    const ctx = new OfflineAudioContext(2, Math.ceil((buffer.duration + 0.4) * SR), SR);
    await loader.loadCoreWorklets(ctx);
    const norm = ctx.createGain();
    norm.gain.value = gain;
    const player = ctx.createBufferSource();
    player.buffer = buffer;
    player.connect(norm);
    let node = norm;
    if (tape) {
      const t = new AudioWorkletNode(ctx, "tape-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelInterpretation: "speakers",
      });
      t.parameters.get("drive").value = TONAL.drive;
      t.parameters.get("tone").value = TONAL.tone;
      t.parameters.get("mix").value = 1;
      node.connect(t);
      node = t;
    }
    if (limiter) {
      const l = new AudioWorkletNode(ctx, "limiter-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelInterpretation: "speakers",
      });
      l.parameters.get("ceiling").value = TONAL.ceiling;
      node.connect(l);
      node = l;
    }
    node.connect(ctx.destination);
    player.start(0);
    return (await ctx.startRendering()).getChannelData(0);
  };

  const marimbaCtx = new OfflineAudioContext(1, Math.ceil(1.2 * SR), SR);
  factory.BUILDERS["factory.mallet.marimba"](marimbaCtx, marimbaCtx.destination);
  const src = await marimbaCtx.startRendering();

  const clickCtx = new OfflineAudioContext(1, Math.ceil(0.5 * SR), SR);
  {
    const t0 = clickCtx.currentTime;
    const len = Math.floor(0.02 * clickCtx.sampleRate);
    const buf = clickCtx.createBuffer(1, len, clickCtx.sampleRate);
    const d = buf.getChannelData(0);
    let a = 8 >>> 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < len; i++) d[i] = rand() * 2 - 1;
    const s = clickCtx.createBufferSource();
    s.buffer = buf;
    const bp = clickCtx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2400;
    bp.Q.value = 0.8;
    const g = clickCtx.createGain();
    const bpGain = Math.sqrt((Math.PI * 2400) / (2 * 0.8 * clickCtx.sampleRate));
    g.gain.setValueAtTime(2.0 / bpGain, t0);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.0012);
    s.connect(bp).connect(g).connect(clickCtx.destination);
    s.start(t0);
  }
  const click = await clickCtx.startRendering();

  const rows = [];
  const stages = [
    ["raw", { tape: false, limiter: false, gain: 1 }],
    ["norm", { tape: false, limiter: false, gain: NORM }],
    ["norm+tape", { tape: true, limiter: false, gain: NORM }],
    ["norm+tape+lim", { tape: true, limiter: true, gain: NORM }],
  ];
  for (const [label, buffer] of [
    ["marimba", src],
    ["click", click],
  ]) {
    for (const [stage, opts] of stages) {
      const out = await chain(buffer, opts);
      rows.push({ label: `${label} / ${stage}`, peak: peakDb(out), firstLoud: firstLoud(out), first6: env(out) });
    }
  }
  return rows;
});

for (const r of report) {
  console.log(`  ${r.label.padEnd(24)} peak ${String(r.peak).padStart(6)} dBFS  firstLoud ${String(r.firstLoud).padStart(4)}`);
  console.log(`      first 6 ms: ${r.first6}`);
}

await browser.close();
await server.close();
