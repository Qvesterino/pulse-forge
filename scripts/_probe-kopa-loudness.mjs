/**
 * TEMPORARY PROBE — KOPA loudness drift: which synthesis does the map describe?
 *
 * The loudness-map drift gate (src/browser-checks.ts, auditFactoryPresetAudio)
 * compares the map against a LIVE measurement. The map was recorded through
 * the KOPA worklet (scripts/measure-preset-loudness.mjs loads the module and
 * seeds the event queue); the gate measures the native fallback, because it
 * never loads the worklet into its OfflineAudioContext.
 *
 * This probe measures every KOPA preset THREE ways in one page:
 *   fallback — no worklet in the context, no prepareOfflineRender (the gate)
 *   worklet  — the module loaded and the queue seeded (the map)
 *   map      — FACTORY_PRESET_LOUDNESS (what the gate compares against)
 *
 * Temporary: deleted once the finding is written down.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5279;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true, hmr: false, watch: null },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/bench-stem.html`, { waitUntil: "domcontentloaded", timeout: 420000 });

const rows = await page.evaluate(async () => {
  const SR = 44100;
  const [registry, loudness, quality, catalog, worklets, loader, generated] = await Promise.all([
    import("/src/instruments/registry.ts"),
    import("/src/audio-engine/kweighting.ts"),
    import("/src/presets/audioQuality.ts"),
    import("/src/presets/catalog.ts"),
    import("/src/audio-worklets/loader.ts"),
    import("/src/presets/factory-loader.ts"),
    import("/src/presets/preset-loudness.generated.ts"),
  ]);
  await loader.warmFactoryPresets();
  const presets = loader.factoryPresets().filter((p) => p.instrument === "kopa");

  const measure = async (preset, mode) => {
    const track = {
      id: `factory-preview-${preset.id}`,
      kind: "instrument",
      instrument: preset.instrument,
      name: preset.name,
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: preset.sampleId ?? null,
      params: { ...registry.defaultInstrumentParams(preset.instrument), ...preset.params },
      effects: [],
      sends: {},
      presetId: preset.id,
    };
    const durationSec = quality.previewNoteDuration(track.params);
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * (durationSec + 0.25)), SR);
    if (mode === "worklet") {
      await worklets.loadInstrumentWorklet(ctx, "kopa");
      if (!worklets.isWorkletReady("kopa", ctx)) throw new Error("worklet did not load");
    }
    const previewGain = ctx.createGain();
    previewGain.gain.value = 0.78;
    let runtime = null;
    try {
      runtime = registry.INSTRUMENT_DEFS[preset.instrument].factory(ctx, track, {
        bpm: 124,
        getSample: () => undefined,
      });
      runtime.output.connect(previewGain).connect(ctx.destination);
      runtime.noteOn(60, 0.82, 0.01, durationSec);
      if (mode === "worklet") runtime.prepareOfflineRender?.();
      const buffer = await ctx.startRendering();
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch));
      const reading = loudness.analyzeLoudnessBuffer(channels, SR);
      return { lufs: reading.integrated, measured: reading.measured, peak: reading.peak };
    } finally {
      runtime?.dispose();
    }
  };

  const out = [];
  for (const preset of presets) {
    const map = generated.FACTORY_PRESET_LOUDNESS[preset.id];
    const family = catalog.getPresetMetadata(preset).useCase;
    let fallback = null;
    let worklet = null;
    let error = null;
    try {
      fallback = await measure(preset, "fallback");
    } catch (e) {
      error = `fallback: ${String(e).slice(0, 120)}`;
    }
    try {
      worklet = await measure(preset, "worklet");
    } catch (e) {
      error = (error ? error + " | " : "") + `worklet: ${String(e).slice(0, 120)}`;
    }
    out.push({
      id: preset.id,
      family,
      map,
      fallback: fallback?.lufs ?? null,
      worklet: worklet?.lufs ?? null,
      mapVsFallback: fallback && map !== undefined ? +(fallback.lufs - map).toFixed(2) : null,
      mapVsWorklet: worklet && map !== undefined ? +(worklet.lufs - map).toFixed(2) : null,
      error,
    });
  }
  return out;
});

console.log(JSON.stringify(rows, null, 1));
const driftGate = (r) => Math.abs(r.mapVsFallback) > 2.5;
console.log(
  "\n=== gate (fallback vs map, tolerance 2.5 LU) ===",
  rows.filter(driftGate).length,
  "of",
  rows.length,
);
console.log("=== map vs worklet (tolerance 2.5 LU) ===", rows.filter((r) => Math.abs(r.mapVsWorklet ?? 0) > 2.5).length, "of", rows.length);

await browser.close();
await server.close();
