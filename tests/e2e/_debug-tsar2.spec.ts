import { expect, test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

test("debug tsar worklet direct", async ({ page }) => {
  test.setTimeout(120_000);
  await openHouseTemplate(page);
  const report = await page.evaluate(async () => {
    const load = (specifier: string) => import(/* @vite-ignore */ specifier);
    const loader = await load("/src/audio-worklets/loader.ts");
    const sampleRate = 44100;
    const ctx = new OfflineAudioContext(2, sampleRate, sampleRate);
    await loader.ensureWorkletsForDoc({ tracks: [{ instrument: "tsar" }] }, ctx);
    const node = new AudioWorkletNode(ctx, "tsar-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        params: { srcAEngine: 1, srcALevel: 0.9, level: 0.9, srcACutoff: 14000 },
        events: [{ type: "noteOn", when: 0.05, pitch: 60, velocity: 0.9 }],
      },
    });
    const messages: unknown[] = [];
    node.port.onmessage = (e) => messages.push(e.data);
    node.connect(ctx.destination);
    const buffer = await ctx.startRendering();
    const d = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    return { peak, messages, sampleRate, frames: d.length };
  });
  console.log("DIRECT REPORT:", JSON.stringify(report));
  expect(report.peak).toBeGreaterThan(0.005);
});
