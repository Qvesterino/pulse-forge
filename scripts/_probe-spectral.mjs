/**
 * TEMPORARY diagnostic — delete after use.
 *
 * Verifies the two fixes for the Spectral Pad silence:
 *
 *  1) PRODUCT: the voice-release path now holds the envelope value instead of
 *     dropping an in-flight attack ramp to the floor.
 *  2) HARNESS: the audit fixture holds the note until the default ATTACK has
 *     completed (a 0.35 s tap cannot audition a 0.6 s attack).
 *
 * Expected attribution (measured before the fix):
 *   old fixture, old code          3.77e-4   -68.5 dBFS
 *   old fixture, fixed code        ~5.4e-3   ~-45 dBFS   (release fades from the attack)
 *   new fixture, fixed code        ~9.3e-2   ~-21 dBFS   (attack completes)
 *
 * Also checks that cancelAndHoldAtTime survives the live-path call shapes:
 * cancelTime == ctx.currentTime, cancelTime in the past, and a param with no
 * scheduled events at all.
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  logLevel: "error",
  server: { port: 5293, host: "127.0.0.1", strictPort: true, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.route("**/index.html", (route) =>
  route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
);

try {
  await page.goto("http://127.0.0.1:5293/", { waitUntil: "domcontentloaded", timeout: 240_000 });
  const result = await page.evaluate(async () => {
    const SR = 44100;
    const { INSTRUMENT_DEFS } = await import("/src/instruments/registry.ts");
    const { defaultInstrumentParams } = await import("/src/instruments/definitions.ts");

    const def = INSTRUMENT_DEFS.spectral;
    const defaults = defaultInstrumentParams("spectral");

    const analyse = (buf) => {
      const l = buf.getChannelData(0);
      const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
      const start = Math.floor(l.length / 8);
      let full = 0;
      let post = 0;
      let sumSq = 0;
      for (let i = 0; i < l.length; i++) {
        const a = Math.max(Math.abs(l[i]), Math.abs(r[i]));
        if (a > full) full = a;
        if (i >= start) {
          if (a > post) post = a;
          sumSq += l[i] * l[i];
        }
      }
      const n = Math.max(1, l.length - start);
      const buckets = [];
      for (let b = 0; b < 12; b++) {
        const from = Math.floor(b * 0.1 * SR);
        const to = Math.min(l.length, Math.floor((b + 1) * 0.1 * SR));
        let p = 0;
        for (let i = from; i < to; i++) p = Math.max(p, Math.abs(l[i]));
        buckets.push(Number(p.toExponential(2)));
      }
      return { full, post, rms: Math.sqrt(sumSq / n), buckets };
    };

    const render = async (params, noteDuration, noteOffAt) => {
      const ctx = new OfflineAudioContext(2, Math.floor(SR * 2), SR);
      const track = {
        id: "probe",
        kind: "instrument",
        instrument: "spectral",
        name: "Spectral Pad",
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: null,
        params,
        effects: [],
        sends: {},
      };
      const rt = def.factory(ctx, track, { bpm: 124, getSample: () => undefined });
      rt.output.connect(ctx.destination);
      rt.noteOn(45, 0.9, 0.05, noteDuration);
      if (noteOffAt !== null) rt.noteOff?.(45, noteOffAt);
      rt.prepareOfflineRender?.();
      const buf = await ctx.startRendering();
      rt.dispose();
      return analyse(buf);
    };

    const cases = [
      ["OLD fixture (note 0.35, off@0.4)", 0.35, 0.4],
      ["NEW fixture (note 0.75, off@0.80)", 0.75, 0.8],
      ["no note-off (control)", 0.75, null],
    ];

    const out = [];
    for (const [label, dur, off] of cases) {
      out.push({ label, ...(await render(defaults, dur, off)) });
    }

    // Robustness of cancelAndHoldAtTime across the call shapes the live path uses.
    const robustness = [];
    const probe = async (label, fn) => {
      try {
        const value = await fn();
        robustness.push({ label, ok: true, value });
      } catch (e) {
        robustness.push({ label, ok: false, value: String(e).slice(0, 120) });
      }
    };

    await probe("cancelAt == currentTime (live path)", async () => {
      const ctx = new OfflineAudioContext(1, 128, SR);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, 0);
      g.gain.cancelAndHoldAtTime(ctx.currentTime);
      return "no throw";
    });
    await probe("cancelAt in the past", async () => {
      const ctx = new OfflineAudioContext(1, 128, SR);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, 0);
      g.gain.cancelAndHoldAtTime(-1);
      return "no throw";
    });
    await probe("param with no scheduled events", async () => {
      const ctx = new OfflineAudioContext(1, 128, SR);
      const g = ctx.createGain();
      g.gain.cancelAndHoldAtTime(0.5);
      return "no throw";
    });
    await probe("cancelAt before any event", async () => {
      const ctx = new OfflineAudioContext(1, 128, SR);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, 1);
      g.gain.cancelAndHoldAtTime(0.5);
      return "no throw";
    });

    return { rows: out, robustness };
  });

  console.log("case".padEnd(38) + "fullPeak".padEnd(12) + "post1/8".padEnd(12) + "rms".padEnd(12) + "dBFS(post)");
  for (const r of result.rows) {
    const db = r.post > 0 ? (20 * Math.log10(r.post)).toFixed(1) : "-inf";
    console.log(
      r.label.padEnd(38) +
        r.full.toExponential(3).padEnd(12) +
        r.post.toExponential(3).padEnd(12) +
        r.rms.toExponential(3).padEnd(12) +
        db,
    );
  }
  console.log("");
  console.log("peak per 0.1 s bucket (first 1.2 s)");
  for (const r of result.rows) console.log(r.label.padEnd(38) + r.buckets.join(" "));
  console.log("");
  console.log("cancelAndHoldAtTime robustness");
  for (const r of result.robustness) console.log(`  ${r.ok ? "OK  " : "THROW"} ${r.label.padEnd(38)} ${r.value}`);
} finally {
  await browser.close();
  await server.close();
}
