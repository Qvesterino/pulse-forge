import { expect, test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

test("debug tsar offline", async ({ page }) => {
  test.setTimeout(120_000);
  await openHouseTemplate(page);
  const report = await page.evaluate(async () => {
    const load = (specifier: string) => import(/* @vite-ignore */ specifier);
    const [templates, schema, loader, engineMod, samples] = await Promise.all([
      load("/src/project-model/templates.ts"),
      load("/src/project-model/schema.ts"),
      load("/src/audio-worklets/loader.ts"),
      load("/src/audio-engine/AudioEngine.ts"),
      load("/src/sample-library/factory.ts"),
    ]);
    const base = templates.createProjectFromTemplate("empty");
    const track = schema.createInstrumentTrackModel("tsar", 1);
    track.id = "tsar-e2e";
    track.params = { ...track.params, srcALevel: 0.9, srcACutoff: 14000, level: 0.9 };
    const doc = { ...base, bpm: 124, tracks: [track] };
    const ctx = new OfflineAudioContext(2, 44100, 44100);
    await loader.ensureWorkletsForDoc(doc, ctx);
    const engine = new engineMod.AudioEngine();
    engine.attachBank(new samples.SampleBank());
    engine.useContext(ctx);
    engine.setProject(doc);
    // Introspect: did the instrument runtime get built?
    const anyEngine = engine as unknown as { instruments: Map<string, unknown>; triggerEngine: unknown };
    const hasRuntime = anyEngine.instruments?.has?.("tsar-e2e") ?? "no-map";
    engine.noteOn("tsar-e2e", 60, 0.9, 0.05, 0.6);
    const runtime = anyEngine.instruments?.get?.("tsar-e2e") as {
      runtime?: { prepareOfflineRender?: () => void };
    };
    const hasHook = typeof runtime?.runtime?.prepareOfflineRender === "function";
    await engine.prepareOfflineRender();
    const buffer = await ctx.startRendering();
    const d = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    return { ready: loader.isWorkletReady("tsar", ctx), hasRuntime, hasHook, peak, instruments: anyEngine.instruments?.size };
  });
  console.log("REPORT:", JSON.stringify(report));
  expect(report.peak).toBeGreaterThan(0.005);
});
