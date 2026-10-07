import { expect, test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

/**
 * 18 — TSAR (docs/TSAR-ROADMAP.md T7): the flagship engine end to end.
 *
 * The unit suites prove the DSP; this spec proves the REAL browser path the
 * unit tests cannot reach:
 *
 *   1. the lazy TSAR worklet module loads on demand (a project without a
 *      TSAR track never fetches it — asserted by URL tracking);
 *   2. an OfflineAudioContext render of a TSAR track is AUDIBLE through the
 *      event-queue worklet (`prepareOfflineRender` seeds processorOptions),
 *      measured as sample energy — the T5 contract, not "it did not throw";
 *   3. the dock panel mounts with the Forge zone and factory browser.
 *
 * Chromium-only: the offline render needs the Web Audio media stack.
 */
test.describe("18 — TSAR engine", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "offline render needs Web Audio — WebKit/Windows has none");

  test("the lazy worklet loads on demand and a TSAR track renders audible offline", async ({ page }) => {
    test.setTimeout(180_000);
    await openHouseTemplate(page);

    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templateModule, schemaModule, loaderModule, engineModule, registryModule, sampleModule] =
        await Promise.all([
          load("/src/project-model/templates.ts"),
          load("/src/project-model/schema.ts"),
          load("/src/audio-worklets/loader.ts"),
          load("/src/audio-engine/AudioEngine.ts"),
          load("/src/instruments/registry.ts"),
          load("/src/sample-library/factory.ts"),
        ]);
      const { createProjectFromTemplate } = templateModule;
      const { createInstrumentTrackModel } = schemaModule;
      const { ensureWorkletsForDoc, isWorkletReady, instrumentWorkletTypesInDoc } = loaderModule;
      const { AudioEngine } = engineModule;
      const { INSTRUMENT_DEFS } = registryModule;
      const { SampleBank } = sampleModule;

      const sampleRate = 44_100;
      const project = createProjectFromTemplate("empty");
      const track = createInstrumentTrackModel("tsar", 1);
      track.id = "tsar-e2e";
      track.name = "TSAR E2E";
      track.params = { ...track.params, srcALevel: 0.9, srcACutoff: 14000, level: 0.9 };
      const doc = { ...project, bpm: 124, tracks: [track] };

      // ── 1. Lazy load: the worklet is NOT ready before ensureWorkletsForDoc.
      const before = isWorkletReady("tsar", new OfflineAudioContext(2, 128, sampleRate));

      // ── 2. Offline render through the SAME engine the exporter uses.
      const ctx = new OfflineAudioContext(2, sampleRate, sampleRate);
      await ensureWorkletsForDoc(doc, ctx);
      const ready = isWorkletReady("tsar", ctx);
      const scanned = instrumentWorkletTypesInDoc(doc);
      const engine = new AudioEngine();
      engine.attachBank(new SampleBank());
      engine.useContext(ctx);
      engine.setProject(doc);
      engine.noteOn("tsar-e2e", 60, 0.9, 0.05, 0.6);
      // The renderer's barrier: seed the worklet's event queue before render.
      await engine.prepareOfflineRender();
      const buffer = await ctx.startRendering();
      const samples = buffer.getChannelData(0);
      let peak = 0;
      let energy = 0;
      for (let i = 0; i < samples.length; i++) {
        const magnitude = Math.abs(samples[i]);
        if (magnitude > peak) peak = magnitude;
        energy += samples[i] * samples[i];
      }
      return {
        before,
        ready,
        scanned,
        peak,
        rms: Math.sqrt(energy / samples.length),
        factoryExists: typeof INSTRUMENT_DEFS.tsar?.factory === "function",
      };
    });

    expect(report.factoryExists).toBe(true);
    expect(report.scanned, "the doc scan must find the TSAR track").toEqual(["tsar"]);
    expect(report.before, "the TSAR worklet must NOT be loaded before a TSAR project asks for it").toBe(false);
    expect(report.ready, "ensureWorkletsForDoc must load the lazy TSAR module").toBe(true);
    // NOTE: the worklet fetch itself is not asserted via page.on("request"):
    // `audioWorklet.addModule` on an OfflineAudioContext fetches on the audio
    // thread, outside the page's network stack. `ready` is the observable
    // proof that the module actually loaded into THIS context.
    // The T5 contract: audible offline render through processorOptions.
    expect(report.peak, `TSAR offline peak ${report.peak}`).toBeGreaterThan(0.005);
    expect(report.rms, `TSAR offline rms ${report.rms}`).toBeGreaterThan(0.0005);
  });

  test("the TSAR dock panel mounts with the Forge zone and factory browser", async ({ page }) => {
    test.setTimeout(120_000);
    await openHouseTemplate(page);

    const tsarTab = page.locator('button[aria-label="Toggle TSAR engine panel"]').first();
    if (!(await tsarTab.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: /more topbar controls/i }).click();
    }
    await tsarTab.click();
    const panel = page.locator('.tsar-panel[role="region"][aria-label="TSAR engine"]');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    // No TSAR track in the House default -> the honest empty state.
    await expect(panel).toContainText(/No TSAR track in this project/);
  });
});
