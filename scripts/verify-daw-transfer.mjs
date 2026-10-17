import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 5228;
const uiFixtureProjectName = "DAW Transfer UI Acceptance v1";
const server = await createServer({
  root,
  logLevel: "error",
  server: { port, host: "127.0.0.1", strictPort: true },
});
let browser;
let context;
let page;

async function cleanupUiFixture() {
  if (!page || page.isClosed()) return;
  await page
    .evaluate(async (projectName) => {
      const [{ ProjectRepository }, { UserSampleRepository }] = await Promise.all([
        import("/src/persistence/ProjectRepository.ts"),
        import("/src/persistence/UserSampleRepository.ts"),
      ]);
      const projects = new ProjectRepository();
      const samples = new UserSampleRepository();
      const meta = (await projects.listAll()).find((item) => item.name === projectName);
      if (!meta) return;
      const doc = await projects.load(meta.id);
      await projects.delete(meta.id);
      for (const clip of doc?.arrangement.audioClips ?? []) await samples.remove(clip.bufferId);
    }, uiFixtureProjectName)
    .catch(() => undefined);
}

try {
  await server.listen();
  const launchOptions = { headless: true };
  if (process.env.KYX_BROWSER_EXECUTABLE_PATH) launchOptions.executablePath = process.env.KYX_BROWSER_EXECUTABLE_PATH;
  browser = await chromium.launch(launchOptions);
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem("pf-onboarded", "1"));
  page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });

  // Enter through the shipped first-screen Project Browser and transfer dialog.
  await page.getByRole("button", { name: "BRING A SONG FROM ANOTHER DAW" }).click({ timeout: 120_000 });
  await page.getByRole("heading", { name: "BRING A SONG" }).waitFor();
  const uiFixtureFiles = await page.evaluate(async () => {
    const { writeMidiFile } = await import("/src/midi/midiFile.ts");
    const audio = Array.from({ length: 8 }, (_, index) => {
      const sampleRate = 44_100;
      const frames = Math.floor(sampleRate / 4);
      const dataBytes = frames * 2;
      const bytes = new Uint8Array(44 + dataBytes);
      const view = new DataView(bytes.buffer);
      const writeText = (offset, value) => {
        for (let char = 0; char < value.length; char++) view.setUint8(offset + char, value.charCodeAt(char));
      };
      writeText(0, "RIFF");
      view.setUint32(4, 36 + dataBytes, true);
      writeText(8, "WAVE");
      writeText(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeText(36, "data");
      view.setUint32(40, dataBytes, true);
      const frequency = 180 + index * 31;
      for (let frame = 0; frame < frames; frame++) {
        const sample = 0.035 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate + 0.2);
        view.setInt16(44 + frame * 2, Math.round(sample * 32767), true);
      }
      return {
        name: `UI Fixture Stem ${String(index + 1).padStart(2, "0")}.wav`,
        mimeType: "audio/wav",
        buffer: Array.from(bytes),
      };
    });
    const midiBuffer = writeMidiFile({
      bpm: 120,
      timeSignature: { num: 4, den: 4 },
      tracks: Array.from({ length: 4 }, (_, index) => ({
        name: `Fixture MIDI ${index + 1}`,
        channel: index,
        notes: [{ pitch: 60 + index * 3, startTick: 0, endTick: 960, velocity: 0.25 }],
      })),
    });
    return [
      ...audio,
      {
        name: "UI Fixture MIDI.mid",
        mimeType: "audio/midi",
        buffer: Array.from(new Uint8Array(midiBuffer)),
      },
    ];
  });
  await page
    .locator(".kyx-transfer-file-input")
    .setInputFiles(uiFixtureFiles.map((file) => ({ ...file, buffer: Buffer.from(file.buffer) })));
  await page.locator('[aria-label="Selected transfer files"] .kyx-transfer-file-row').first().waitFor();
  await page.locator('[aria-label="MIDI preflight summary"]').waitFor();
  const midiSummary = await page.locator('[aria-label="MIDI preflight summary"]').innerText();
  if (!midiSummary.includes("Fixture MIDI 1") || !midiSummary.includes("Fixture MIDI 4")) {
    throw new Error(`The transfer preflight hid one or more MIDI names: ${midiSummary}`);
  }
  await page.getByLabel("PROJECT NAME").fill(uiFixtureProjectName);
  const uiImportButton = page.getByRole("button", { name: "IMPORT AS NEW KYX PROJECT" });
  if (!(await uiImportButton.isDisabled())) {
    throw new Error("The transfer dialog enabled import before the shared audio alignment confirmation.");
  }
  await page.getByLabel("All audio exports start at the same song origin and cover the intended range.").check();
  const acknowledge = page.getByLabel("I have reviewed the transfer limits above and want to continue.");
  if ((await acknowledge.count()) > 0) await acknowledge.check();
  if (await uiImportButton.isDisabled()) throw new Error("The complete valid transfer remained blocked in the dialog.");
  await uiImportButton.click();
  await page.locator(".kyx-transfer-dialog").waitFor({ state: "detached", timeout: 180_000 });
  const uiFixture = await page.evaluate(async (projectName) => {
    const { ProjectRepository } = await import("/src/persistence/ProjectRepository.ts");
    const repo = new ProjectRepository();
    const meta = (await repo.listAll()).find((item) => item.name === projectName);
    if (!meta) throw new Error("The real transfer UI did not save a new KYX project.");
    const doc = await repo.load(meta.id);
    if (!doc) throw new Error("The real transfer UI project could not be reopened from IndexedDB.");
    const audioClips = doc.arrangement.audioClips ?? [];
    const midiClips = doc.arrangement.midiClips ?? [];
    const expectedNames = ["Fixture MIDI 1", "Fixture MIDI 2", "Fixture MIDI 3", "Fixture MIDI 4"];
    if (audioClips.length !== 8 || midiClips.length !== 4) {
      throw new Error(
        `The real transfer UI saved ${audioClips.length} audio clips and ${midiClips.length} MIDI clips.`,
      );
    }
    if (expectedNames.some((name) => !doc.tracks.some((track) => track.name === name))) {
      throw new Error("The real transfer UI did not retain all MIDI track names.");
    }
    return { projectName: meta.name, audioTracks: audioClips.length, midiTracks: midiClips.length };
  }, uiFixtureProjectName);
  await cleanupUiFixture();

  // The lower-level acceptance then exercises live/offline rendering and meters
  // independently of React so a UI result cannot mask a playback failure.
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
  console.log(
    `[PASS] ${result.fixtureVersion}: ${result.importedAudioTracks} aligned audio lanes + ${result.importedMidiTracks} editable MIDI lanes`,
  );
  console.log(
    `       real Project Browser flow saved/reopened ${uiFixture.audioTracks} audio + ${uiFixture.midiTracks} MIDI lanes (${uiFixture.projectName})`,
  );
  console.log(`       reopened bar-1 starts: ${result.reopenedAudioStartsAtBar.join(", ")}`);
  console.log(
    `       restored ${result.restoredAudioAssets} audio assets; offline render ${result.renderedFrames} frames`,
  );
  console.log(
    `       peak ${result.renderedPeak.toFixed(4)}; first-quarter-second peak ${result.firstQuarterSecondPeak.toFixed(4)}`,
  );
  const liveMidiMeters = Object.entries(result.liveMidiTrackPeaks)
    .map(([name, peak]) => `${name} ${peak.toFixed(4)}`)
    .join(", ");
  console.log(`       live meter peak ${result.livePlaybackPeak.toFixed(4)}; MIDI tracks ${liveMidiMeters}`);
  await context.close();
} catch (error) {
  console.error("[FAIL] DAW transfer browser acceptance:", String(error).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await cleanupUiFixture();
  await browser?.close();
  await server.close();
}
