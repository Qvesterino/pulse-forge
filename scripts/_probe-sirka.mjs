/**
 * TEMPORARY diagnostic — delete after use.
 *
 * The plugin audit reports SPAN (sirka) as "not processing in the host graph"
 * (hostDelta 7.9e-8) while its factory sweep sees the width parameters move
 * the SIDE metric by 32% on the stereo test signal. So the DSP works — on a
 * stereo signal.
 *
 * SPAN is a per-band stereo imager: L' = M + w·S, R' = M − w·S. If the input
 * has no side energy (S = 0), every width is a mathematical no-op. The house
 * template's three tracks are a kit, an 808 and an analog synth, all centred
 * — so the question is whether the house mix has any side energy at all, and
 * if not, WHICH material can give the effect something to act on.
 *
 * Measured here with the audit's OWN metric (metricsOf/deltaVs), because the
 * audit's verdict is a metric delta, not a waveform difference.
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  logLevel: "error",
  server: { port: 5283, host: "127.0.0.1", strictPort: true, hmr: false, watch: null },
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
  await page.goto("http://127.0.0.1:5283/", { waitUntil: "domcontentloaded", timeout: 600_000 });
  const out = await page.evaluate(async () => {
    const { createProjectFromTemplate } = await import("/src/project-model/templates.ts");
    const { ProjectStore } = await import("/src/store/ProjectStore.ts");
    const { addEffect, setEffectParam, toggleEffectBypass } = await import("/src/commands/commands.ts");
    const { renderProject } = await import("/src/rendering/renderer.ts");
    const { generateFactoryBank } = await import("/src/sample-library/factory.ts");
    const { metricsOf, deltaVs } = await import("/src/plugin-audit-checks.ts");
    const { MASTER_EFFECT_OWNER_ID } = await import("/src/project-model/types.ts");

    const makeBase = () => {
      const doc = createProjectFromTemplate("house");
      for (const t of doc.tracks) if (t.kind === "drum") t.effects = [];
      return doc;
    };

    const bank = await generateFactoryBank();

    const render = (doc) =>
      renderProject(doc, bank, {
        mode: "pattern",
        sampleRate: 44100,
        tailSeconds: 0.6,
        masterProcessing: false,
      });

    const sideOf = (buffer) => {
      const l = buffer.getChannelData(0);
      const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
      let sum = 0;
      for (let i = 0; i < l.length; i++) {
        const s = l[i] - r[i];
        sum += s * s;
      }
      return Math.sqrt(sum / Math.max(1, l.length));
    };

    /** Insert sirka with the given params, render on vs bypassed, measure. */
    const measure = async (pickTrack, params, prepare) => {
      const base = makeBase();
      if (prepare) prepare(base);
      // The track ids are per-instance (every template call mints new ids), so
      // the track has to be picked from THIS document.
      const trackId = pickTrack(base);
      const store = new ProjectStore(base);
      const add = addEffect(store.getDoc(), trackId, "sirka");
      store.execute(add);
      for (const p of params) {
        store.execute(setEffectParam(store.getDoc(), trackId, add.effectId, p.id, p.value));
      }
      const on = await render(store.getDoc());
      const bypassStore = new ProjectStore(store.getDoc());
      bypassStore.execute(toggleEffectBypass(store.getDoc(), trackId, add.effectId));
      const bypassed = await render(bypassStore.getDoc());
      const d = deltaVs(metricsOf(bypassed), metricsOf(on));
      return {
        delta: d.delta,
        metric: d.metric,
        sideDry: sideOf(bypassed),
        sideOn: sideOf(on),
        rms: metricsOf(on).rms,
      };
    };

    const base = makeBase();
    const drum = base.tracks.find((t) => t.kind === "drum");
    const chords = base.tracks.find((t) => t.instrument === "analog");
    const bass = base.tracks.find((t) => t.instrument === "808");
    const pickDrum = (doc) => doc.tracks.find((t) => t.kind === "drum").id;
    const pickChords = (doc) => doc.tracks.find((t) => t.instrument === "analog").id;

    const baseMetrics = metricsOf(await render(makeBase()));
    const result = {
      tracks: base.tracks.map((t) => ({ id: t.id, kind: t.kind, instrument: t.instrument ?? "-" })),
      baseMix: { side: baseMetrics.side, rms: baseMetrics.rms, peak: baseMetrics.peak },
    };

    // Per-track side energy: mute the other two.
    const solo = async (kind) => {
      const doc = makeBase();
      const keep = doc.tracks.find((t) => (kind === "drum" ? t.kind === "drum" : t.instrument === kind));
      for (const t of doc.tracks) if (t.id !== keep.id) t.mute = true;
      const m = metricsOf(await render(doc));
      return { side: m.side, rms: m.rms };
    };
    result.solo = {
      drum: await solo("drum"),
      chords: await solo("analog"),
      bass: await solo("808"),
    };

    const FINGERPRINT = [
      { id: "midWidth", value: 0 },
      { id: "lowWidth", value: 2 },
    ];
    const WIDE = [
      { id: "lowWidth", value: 2 },
      { id: "midWidth", value: 2 },
      { id: "highWidth", value: 2 },
    ];

    result.cases = {
      "drum bus / audit fingerprint": await measure(pickDrum, FINGERPRINT),
      "drum bus / all widths 2": await measure(pickDrum, WIDE),
      "chords / audit fingerprint": await measure(pickChords, FINGERPRINT),
      "chords panned left / audit fingerprint": await measure(pickChords, FINGERPRINT, (doc) => {
        doc.tracks.find((x) => x.instrument === "analog").pan = -1;
      }),
      "drum bus with a panned hat / audit fingerprint": await measure(pickDrum, FINGERPRINT, (doc) => {
        doc.tracks.find((x) => x.kind === "drum").pads[8].pan = 0.8; // hat closed
      }),
      "drum bus with a panned hat / all widths 2": await measure(pickDrum, WIDE, (doc) => {
        doc.tracks.find((x) => x.kind === "drum").pads[8].pan = 0.8;
      }),
      "master bus / all widths 2": await measure(() => MASTER_EFFECT_OWNER_ID, WIDE),
    };

    return result;
  });

  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
  await server.close();
}
