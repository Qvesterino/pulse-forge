import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 5221;
// Cold vite transform of the full app graph can outgrow 60 s on a busy machine — NAV_TIMEOUT_MS overrides.
const navTimeout = Number(process.env.NAV_TIMEOUT_MS) || 60_000;
const instrumentFilter = process.env.PRESET_AUDIT_INSTRUMENT?.trim() || undefined;
const server = await createServer({
  root,
  logLevel: "error",
  server: { port, host: "127.0.0.1", strictPort: true },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: navTimeout });
  const result = await page.evaluate(async (instrumentFilter) => {
    const [
      { generateFactoryBank },
      { auditFactoryPresetAudio },
      { loadCuratedLayer },
      { ensurePianoPackLoaded },
      { ensureVscoPackLoaded },
    ] = await Promise.all([
      import("/src/sample-library/factory.ts"),
      import("/src/browser-checks.ts"),
      import("/src/sample-library/curated.ts"),
      import("/src/presets/piano-pack.ts"),
      import("/src/presets/vsco-pack.ts"),
    ]);
    await (await import("/src/presets/factory-loader.ts")).warmFactoryPresets();
    const presets = (await import("/src/presets/factory-loader.ts")).factoryPresets();
    const selectedPresets = instrumentFilter
      ? presets.filter((preset) => preset.instrument === instrumentFilter)
      : presets;
    if (instrumentFilter && selectedPresets.length === 0) {
      throw new Error(`No factory presets found for instrument ${instrumentFilter}`);
    }
    const sampleIds = [...new Set(selectedPresets.flatMap((preset) => (preset.sampleId ? [preset.sampleId] : [])))];
    // Measure the bank the app actually plays (runChecks parity): sampler/
    // texture probes hit curated overrides, so the synth-only bank would
    // false-positive drift against the curated-based loudness map.
    const bank = await generateFactoryBank(instrumentFilter ? sampleIds : undefined);
    await loadCuratedLayer(bank, instrumentFilter ? { ids: sampleIds } : undefined);
    // Real-instrument packs audition through their samples — the same
    // ensure-on-apply path the studio uses (public/samples, local files).
    // Without this the pack presets measure their silent fallback and the
    // gate fails on peaks of 0.
    if (!instrumentFilter) {
      await ensurePianoPackLoaded(bank);
      await ensureVscoPackLoaded(bank);
    }
    return auditFactoryPresetAudio(bank, instrumentFilter);
  }, instrumentFilter);
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${result.name} — ${result.message}`);
  if (!result.ok) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
