/**
 * Phase 1 native triangulation — which property of the bare graph flips?
 *
 *   cycle      feedback loop connected (control — known to flip)
 *   nocycle    feedback gain present but disconnected
 *   integer    cycle + delayTime exactly 4410 samples (0.1 s)
 *   quantum    cycle + delayTime exactly 128 samples
 *   frac       cycle + fractional delayTime 0.2419 s (musical 1/8)
 *   order      cycle, but feedback connection made BEFORE source connects
 */
import { createServer } from "vite";
import { chromium } from "playwright";

const mode = process.argv[2] ?? "cycle";
const N = Number(process.argv[3] ?? 6);
const PORT = 5287;
const SR = 44100;

const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });

const out = await page.evaluate(
  async ([mode, N, SR]) => {
    const makeBuf = (ctx) => {
      const buf = ctx.createBuffer(2, SR, SR);
      for (let k = 0; k < SR; k++) {
        const t = k / SR;
        const env = k < SR / 4 ? Math.exp((-6 * k) / SR) : 0;
        const v = 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.4 * env * Math.sin(2 * Math.PI * 110 * t);
        buf.getChannelData(0)[k] = v;
        buf.getChannelData(1)[k] = v;
      }
      return buf;
    };
    const build = (ctx) => {
      const input = ctx.createGain();
      const out = ctx.createGain();
      const delay = ctx.createDelay(8);
      const delayTime =
        mode === "integer" ? 4410 / SR : mode === "quantum" ? 128 / SR : mode === "frac" ? 0.24193548387096774 : 0.4838709677419355;
      delay.delayTime.value = delayTime;
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = 4500;
      const fb = ctx.createGain();
      fb.gain.value = 0.85;
      input.connect(delay).connect(tone);
      if (mode === "order") {
        tone.connect(fb).connect(input); // loop FIRST
        const src = ctx.createBufferSource();
        src.buffer = makeBuf(ctx);
        src.connect(input);
        input.connect(out);
        tone.connect(out);
        src.connect(out); // dry reference through own path
        return { src, out };
      }
      tone.connect(fb);
      if (mode !== "nocycle") fb.connect(input);
      const src = ctx.createBufferSource();
      src.buffer = makeBuf(ctx);
      src.connect(input);
      input.connect(out);
      tone.connect(out);
      return { src, out };
    };
    const stamps = [];
    const bufs = [];
    for (let i = 0; i < N; i++) {
      const ctx = new OfflineAudioContext(2, SR * 2, SR);
      const { src, out } = build(ctx);
      out.connect(ctx.destination);
      src.start(0);
      const buf = await ctx.startRendering();
      bufs.push(buf);
      const d = buf.getChannelData(0);
      let s = 0;
      const start = Math.floor(d.length / 8);
      for (let k = start; k < d.length; k++) s += d[k] * d[k];
      stamps.push(Math.round(Math.sqrt(s / (d.length - start)) * 1e6) / 1e6);
    }
    const fd = (a, b) => {
      const da = a.getChannelData(0);
      const db = b.getChannelData(0);
      for (let k = 0; k < Math.min(da.length, db.length); k++) if (Math.abs(da[k] - db[k]) > 1e-6) return k;
      return -1;
    };
    return {
      mode,
      stamps,
      unique: [...new Set(stamps)].length,
      diffsVsFirst: bufs.slice(1).map((b) => {
        const k = fd(bufs[0], b);
        return k < 0 ? "same" : (k / SR).toFixed(4) + "s";
      }),
    };
  },
  [mode, N, SR],
);

console.log(JSON.stringify(out));
await browser.close();
await server.close();
