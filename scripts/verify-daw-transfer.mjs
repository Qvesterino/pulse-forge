import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 5228;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port, host: "127.0.0.1", strictPort: true },
});
let browser;
let context;

try {
  await server.listen();
  const launchOptions = { headless: true };
  if (process.env.KYX_BROWSER_EXECUTABLE_PATH) launchOptions.executablePath = process.env.KYX_BROWSER_EXECUTABLE_PATH;
  browser = await chromium.launch(launchOptions);
  context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("[browser pageerror]", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("[browser console error]", message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.evaluate(async () => {
    const checks = await import("/src/browser-checks-transfer.ts");
    const button = document.createElement("button");
    button.id = "run-daw-transfer-acceptance";
    button.textContent = "Run DAW transfer acceptance";
    button.addEventListener(
      "click",
      () => {
        void checks.runDawTransferAcceptance().then(
          (result) => {
            window.__dawTransferResult = result;
          },
          (error) => {
            window.__dawTransferError = error instanceof Error ? error.message : String(error);
          },
        );
      },
      { once: true },
    );
    document.body.append(button);
  });
  await page.locator("#run-daw-transfer-acceptance").click();
  await page.waitForFunction(
    () => window.__dawTransferResult !== undefined || window.__dawTransferError !== undefined,
    undefined,
    { timeout: 180_000 },
  );
  const outcome = await page.evaluate(() => ({ result: window.__dawTransferResult, error: window.__dawTransferError }));
  if (outcome.error) throw new Error(outcome.error);
  const result = outcome.result;
  if (result.importedAutomationClips < 2 || result.sustainedMidiNoteDuration !== 1440) {
    throw new Error("MIDI controller/sustain conversion did not survive the browser transfer acceptance.");
  }
  console.log(
    `[PASS] ${result.fixtureVersion}: ${result.importedAudioTracks} aligned audio lanes + ${result.importedMidiTracks} editable MIDI lanes`,
  );
  console.log(
    `       project ${JSON.stringify(result.reopenedProjectMetadata.name)} · ${result.reopenedProjectMetadata.bpm} BPM · ${result.reopenedProjectMetadata.timeSignature.numerator}/${result.reopenedProjectMetadata.timeSignature.denominator} · source ${result.reopenedProjectMetadata.sourceDaw}`,
  );
  console.log(`       audio mapping: ${result.reopenedAudioTrackNames.join(", ")}`);
  console.log(`       reopened bar-1 starts: ${result.reopenedAudioStartsAtBar.join(", ")}`);
  console.log(
    `       restored ${result.restoredAudioAssets} audio assets; offline render ${result.renderedFrames} frames`,
  );
  console.log(
    `       MIDI conversion: ${result.importedAutomationClips} automation clips; CC64 sustained note ${result.sustainedMidiNoteDuration} ticks`,
  );
  console.log(
    `       peak ${result.renderedPeak.toFixed(4)}; first-quarter-second peak ${result.firstQuarterSecondPeak.toFixed(4)}`,
  );
  const liveMidiMeters = Object.entries(result.liveMidiTrackPeaks)
    .map(([name, peak]) => `${name} ${peak.toFixed(4)}`)
    .join(", ");
  console.log(`       live meter peak ${result.livePlaybackPeak.toFixed(4)}; MIDI tracks ${liveMidiMeters}`);
} catch (error) {
  console.error("[FAIL] DAW transfer browser acceptance:", String(error).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => undefined);
  await browser?.close();
  await server.close();
}
