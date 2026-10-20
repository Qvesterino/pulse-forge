/**
 * TEMPORARY diagnostic — delete after use.
 *
 * The plugin audit reports pitchCorrect as "not processing in the host graph"
 * (hostDelta 4.9e-9). Two harness assumptions are suspected:
 *
 *   A) MATERIAL — the host test puts the effect on the house template's DRUM
 *      bus. A pitch corrector needs a pitched note to correct.
 *   B) FINGERPRINT — `fingerprintOf` picks the extreme with the biggest delta
 *      against the DEFAULT render. `amount` defaults to 1 (max), so the
 *      "strongest" extreme is 0 = no retune = passthrough by design.
 *
 * The earlier probe (scripts/_probe-pitchcorrect.mjs) used an EMPTY sample
 * bank, which made the drum bus SILENT — so it could not tell "wrong
 * material" from "no material". This probe uses the real drum samples of the
 * house kit and measures with the audit's OWN metric (metricsOf/deltaVs), not
 * a waveform difference, because the audit's verdict is a metric delta.
 *
 * For every house track and every pitchCorrect parameter extreme:
 *   engagement = delta(bypassed, extreme)   -> does this state process at all?
 *   movement   = delta(default,  extreme)   -> does this parameter move sound?
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  logLevel: "error",
  server: { port: 5282, host: "127.0.0.1", strictPort: true, hmr: false, watch: null },
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
  await page.goto("http://127.0.0.1:5282/", { waitUntil: "domcontentloaded", timeout: 600_000 });
  const out = await page.evaluate(async () => {
    const { createProjectFromTemplate } = await import("/src/project-model/templates.ts");
    const { ProjectStore } = await import("/src/store/ProjectStore.ts");
    const { addEffect, setEffectParam, toggleEffectBypass } = await import("/src/commands/commands.ts");
    const { renderProject } = await import("/src/rendering/renderer.ts");
    const { generateFactoryBank } = await import("/src/sample-library/factory.ts");
    const { metricsOf, deltaVs } = await import("/src/plugin-audit-checks.ts");
    const { EFFECT_META } = await import("/src/effects/definitions.ts");

    const base = createProjectFromTemplate("house");
    for (const t of base.tracks) if (t.kind === "drum") t.effects = [];

    // The REAL drum samples of the house kit — an empty bank makes the drum
    // bus silent and every drum measurement meaningless.
    const drumTrack = base.tracks.find((t) => t.kind === "drum");
    const assetIds = drumTrack.pads.map((p) => p.assetId);
    const bank = await generateFactoryBank(assetIds);

    const render = (doc) =>
      renderProject(doc, bank, {
        mode: "pattern",
        sampleRate: 44100,
        tailSeconds: 0.6,
        masterProcessing: false,
      });

    const maxDiff = (a, b) => {
      let d = 0;
      for (let ch = 0; ch < a.numberOfChannels; ch++) {
        const da = a.getChannelData(ch);
        const db = b.getChannelData(ch);
        for (let i = 0; i < da.length; i++) d = Math.max(d, Math.abs(da[i] - db[i]));
      }
      return d;
    };

    const params = EFFECT_META.pitchCorrect.params;

    const buildDoc = (trackId, paramsToSet) => {
      const store = new ProjectStore(base);
      const add = addEffect(store.getDoc(), trackId, "pitchCorrect");
      store.execute(add);
      for (const p of paramsToSet) {
        store.execute(setEffectParam(store.getDoc(), trackId, add.effectId, p.id, p.value));
      }
      return { store, fxId: add.effectId };
    };

    const measure = async (trackId) => {
      // bypassed == the material with the effect removed (a 1:1 pass-through)
      const { store, fxId } = buildDoc(trackId, []);
      const bypassStore = new ProjectStore(store.getDoc());
      bypassStore.execute(toggleEffectBypass(store.getDoc(), trackId, fxId));
      const bypassed = await render(bypassStore.getDoc());
      const defaultRender = await render(store.getDoc());
      const bypassMetrics = metricsOf(bypassed);
      const defaultMetrics = metricsOf(defaultRender);

      const rows = [];
      for (const p of params) {
        for (const extreme of ["min", "max"]) {
          const value = p[extreme];
          const { store: s2 } = buildDoc(trackId, [{ id: p.id, value }]);
          const r = await render(s2.getDoc());
          const m = metricsOf(r);
          const eng = deltaVs(bypassMetrics, m);
          const mov = deltaVs(defaultMetrics, m);
          rows.push({
            param: p.id,
            extreme,
            value,
            engagement: eng.delta,
            engagementMetric: eng.metric,
            movement: mov.delta,
            movementMetric: mov.metric,
            maxDiff: maxDiff(bypassed, r),
          });
        }
      }
      // The audit's CURRENT fingerprint for pitchCorrect (amount@min, speed@min)
      // and a few candidate replacements.
      const combos = {
        "current fingerprint (amount=0,speed=0)": [
          { id: "amount", value: 0 },
          { id: "speed", value: 0 },
        ],
        "speed=0 only": [{ id: "speed", value: 0 }],
        "root=11 only": [{ id: "root", value: 11 }],
        "root=11 + speed=0": [
          { id: "root", value: 11 },
          { id: "speed", value: 0 },
        ],
        "root=1 + speed=0": [
          { id: "root", value: 1 },
          { id: "speed", value: 0 },
        ],
      };
      const comboRows = [];
      for (const [label, ps] of Object.entries(combos)) {
        const { store: s3 } = buildDoc(trackId, ps);
        const r = await render(s3.getDoc());
        const m = metricsOf(r);
        const eng = deltaVs(bypassMetrics, m);
        const mov = deltaVs(defaultMetrics, m);
        comboRows.push({
          label,
          engagement: eng.delta,
          engagementMetric: eng.metric,
          movement: mov.delta,
          maxDiff: maxDiff(bypassed, r),
        });
      }
      return {
        track: trackId,
        materialRms: defaultMetrics.rms,
        materialPeak: defaultMetrics.peak,
        defaultEngagement: deltaVs(bypassMetrics, defaultMetrics).delta,
        defaultEngagementMetric: deltaVs(bypassMetrics, defaultMetrics).metric,
        rows,
        combos: comboRows,
      };
    };

    const tracks = base.tracks.map((t) => ({ id: t.id, kind: t.kind, instrument: t.instrument ?? "-" }));
    const results = [];
    for (const t of base.tracks) {
      results.push(await measure(t.id));
    }
    return { tracks, assetIds, results };
  });

  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
  await server.close();
}
