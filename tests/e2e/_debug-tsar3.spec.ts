import { expect, test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

test("debug minimal worklet", async ({ page }) => {
  test.setTimeout(120_000);
  await openHouseTemplate(page);
  const report = await page.evaluate(async () => {
    // Register a trivial inline processor that writes a constant 0.5.
    const src = `
      class Blip extends AudioWorkletProcessor {
        constructor() { super(); this.n = 0; }
        process(_i, outputs) {
          const out = outputs[0];
          for (let c = 0; c < out.length; c++) out[c].fill(0.5);
          this.n++;
          return true;
        }
      }
      registerProcessor("blip", Blip);
    `;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const ctx = new OfflineAudioContext(2, 4410, 44100);
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, "blip", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(ctx.destination);
    const buffer = await ctx.startRendering();
    const d = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    return { peak };
  });
  console.log("MINIMAL REPORT:", JSON.stringify(report));
  expect(report.peak).toBeGreaterThan(0.4);
});
