/**
 * TEMPORARY diagnostic — delete after use.
 *
 * Isolates the Web Audio semantics behind the `spectral` silence, without the
 * instrument in the way: one GainNode, one constant-amplitude oscillator, and
 * the exact automation schedule the spectral voice uses.
 *
 *   setValueAtTime(0.0001, 0.05)
 *   exponentialRampToValueAtTime(0.0926, 0.65)     <- attack, still in flight at 0.4
 *   setTargetAtTime(0.0001, 0.70, 1)               <- release after the note ends
 *
 * Then a note-off at 0.4 does one of:
 *   A) cancelScheduledValues(0.4) + setTargetAtTime(0.0001, 0.4, 1)   [current code]
 *   B) cancelAndHoldAtTime(0.4) + setTargetAtTime(0.0001, 0.4, 1)    [proposed fix]
 *   C) nothing (control: no note-off at all)
 *
 * Expectation if the diagnosis is right:
 *   A) the envelope COLLAPSES to the 0.0001 floor from t=0 (the ramp is dropped)
 *   B) the envelope follows the ramp to 0.65, then decays from the held value
 *   C) identical to B in the ramp region, but with the release curve from 0.70
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  logLevel: "error",
  server: { port: 5294, host: "127.0.0.1", strictPort: true, hmr: false, watch: null },
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
  await page.goto("http://127.0.0.1:5294/", { waitUntil: "domcontentloaded", timeout: 240_000 });
  const out = await page.evaluate(async () => {
    const SR = 44100;
    const hasHold = typeof AudioParam.prototype.cancelAndHoldAtTime === "function";

    const run = async (mode) => {
      const ctx = new OfflineAudioContext(1, SR * 2, SR);
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 100;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0.05);
      g.gain.exponentialRampToValueAtTime(0.0926, 0.65);
      g.gain.setTargetAtTime(0.0001, 0.7, 1);
      osc.connect(g).connect(ctx.destination);
      osc.start(0);

      if (mode === "cancel") {
        g.gain.cancelScheduledValues(0.4);
        g.gain.setTargetAtTime(0.0001, 0.4, 1);
      } else if (mode === "hold") {
        g.gain.cancelAndHoldAtTime(0.4);
        g.gain.setTargetAtTime(0.0001, 0.4, 1);
      }
      osc.stop(2);
      const buf = await ctx.startRendering();
      const d = buf.getChannelData(0);
      const buckets = [];
      for (let b = 0; b < 14; b++) {
        const from = Math.floor(b * 0.1 * SR);
        const to = Math.min(d.length, Math.floor((b + 1) * 0.1 * SR));
        let peak = 0;
        for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(d[i]));
        buckets.push(Number(peak.toExponential(3)));
      }
      return buckets;
    };

    return {
      hasHold,
      cancel: await run("cancel"),
      hold: await run("hold"),
      control: await run("control"),
    };
  });

  console.log("cancelAndHoldAtTime available:", out.hasHold);
  console.log("");
  const labels = ["0.0", "0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7", "0.8", "0.9", "1.0", "1.1", "1.2", "1.3"];
  console.log("t(s)   ".padEnd(8) + "cancel".padEnd(13) + "hold".padEnd(13) + "control");
  for (let i = 0; i < out.cancel.length; i++) {
    console.log(
      labels[i].padEnd(8) +
        String(out.cancel[i]).padEnd(13) +
        String(out.hold[i]).padEnd(13) +
        String(out.control[i]),
    );
  }
} finally {
  await browser.close();
  await server.close();
}
