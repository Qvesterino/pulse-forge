/**
 * TEMPORARY diagnostic — delete after use.
 *
 * The plugin audit reports pitchCorrect as "not processing in the host graph"
 * (hostDelta 4.9e-9, hostMixDelta 1.6e-8), while the factory sweep sees a
 * healthy bypassDelta of 0.079 and the browser check "amount 1 corrects
 * toward the scale target" PASSES. The audit's own comment names the open
 * question: the host doc is a DRUM bus, and a drum bus cannot excite a pitch
 * corrector.
 *
 * This probe separates the three candidate causes:
 *   1. the worklet is not ready in the export context -> the factory falls
 *      back to a 1:1 bypass runtime (an honest bypass, silent about it);
 *   2. the drum bus is the wrong material (unpitched transients);
 *   3. the audit's fingerprint sets `amount` to its MIN (0 = no retune), which
 *      makes the effect a passthrough BY DESIGN.
 *
 * Everything is measured on the real export path (renderProject), with the
 * real command path (addEffect / toggleEffectBypass / removeEffect).
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  logLevel: "error",
  server: { port: 5281, host: "127.0.0.1", strictPort: true, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(900_000);
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.route("**/index.html", (route) =>
  route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
);

try {
  await page.goto("http://127.0.0.1:5281/", { waitUntil: "domcontentloaded", timeout: 240_000 });
  const out = await page.evaluate(async () => {
    const { createProjectFromTemplate } = await import("/src/project-model/templates.ts");
    const { ProjectStore } = await import("/src/store/ProjectStore.ts");
    const { addEffect, removeEffect, toggleEffectBypass, setEffectParam } = await import(
      "/src/commands/commands.ts"
    );
    const { renderProject } = await import("/src/rendering/renderer.ts");
    const { generateFactoryBank } = await import("/src/sample-library/factory.ts");
    const { ensureWorkletsForDoc, isWorkletReady } = await import("/src/audio-worklets/loader.ts");

    const base = createProjectFromTemplate("house");
    const tracks = base.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      instrument: t.instrument ?? "-",
      notes: t.notes?.length ?? 0,
      fx: (t.effects ?? []).length,
    }));
    // The drum bus must start clean, like the audit does.
    for (const t of base.tracks) if (t.kind === "drum") t.effects = [];

    const bank = await generateFactoryBank();

    const maxDiff = (a, b) => {
      let d = 0;
      for (let ch = 0; ch < a.numberOfChannels; ch++) {
        const da = a.getChannelData(ch);
        const db = b.getChannelData(ch);
        for (let i = 0; i < da.length; i++) d = Math.max(d, Math.abs(da[i] - db[i]));
      }
      return d;
    };
    const rms = (a) => {
      const d = a.getChannelData(0);
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      return Math.sqrt(s / Math.max(1, d.length));
    };

    const render = (doc) =>
      renderProject(doc, bank, {
        mode: "pattern" as const,
        sampleRate: 44100,
        tailSeconds: 0.6,
        masterProcessing: false,
      });

    // Q1: is the worklet ready in an OFFLINE context the way the export does it?
    const probeCtx = new OfflineAudioContext(2, 128, 44100);
    await ensureWorkletsForDoc(base, probeCtx);
    const workletReady = isWorkletReady("pitchCorrect", probeCtx);

    const drum = base.tracks.find((t) => t.kind === "drum");
    const pitched = base.tracks.find((t) => t.kind === "instrument" && (t.notes?.length ?? 0) > 0);

    const runOn = async (trackId, params) => {
      const store = new ProjectStore(base);
      const add = addEffect(store.getDoc(), trackId, "pitchCorrect");
      store.execute(add);
      for (const p of params) store.execute(setEffectParam(store.getDoc(), trackId, add.effectId, p.id, p.value));
      const on = await render(store.getDoc());

      const bypassStore = new ProjectStore(store.getDoc());
      bypassStore.execute(toggleEffectBypass(store.getDoc(), trackId, add.effectId));
      const bypassed = await render(bypassStore.getDoc());
      return { on, bypassed };
    };

    const result = { tracks, workletReady };

    // Q2/Q3/Q4: drum bus vs a pitched track, defaults vs the audit's fingerprint.
    const drumRun = await runOn(drum.id, []);
    result.drumDefaults = { maxDiff: maxDiff(drumRun.bypassed, drumRun.on), rms: rms(drumRun.on) };

    if (pitched) {
      const pitchedRun = await runOn(pitched.id, []);
      result.pitchedDefaults = {
        track: pitched.id,
        maxDiff: maxDiff(pitchedRun.bypassed, pitchedRun.on),
        rms: rms(pitchedRun.on),
      };
      // The audit's fingerprint for pitchCorrect: amount -> min (0) and speed -> min (0).
      const fingerRun = await runOn(pitched.id, [
        { id: "amount", value: 0 },
        { id: "speed", value: 0 },
      ]);
      result.pitchedFingerprint = {
        maxDiff: maxDiff(fingerRun.bypassed, fingerRun.on),
        rms: rms(fingerRun.on),
      };
      // The audit's MIX probe: mix -> max, everything else at default.
      const mixRun = await runOn(pitched.id, [{ id: "mix", value: 1 }]);
      result.pitchedMixMax = { maxDiff: maxDiff(mixRun.bypassed, mixRun.on), rms: rms(mixRun.on) };
    } else {
      result.pitchedDefaults = "NO pitched track with notes in the house template";
    }

    return result;
  });

  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
  await server.close();
}
