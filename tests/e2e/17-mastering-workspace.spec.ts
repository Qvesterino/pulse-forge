import { readFile } from "node:fs/promises";
import { expect, test } from "playwright/test";
import { clickPanelAction, openHouseTemplate } from "./_helpers";

function readMasterWavFacts(bytes: Buffer) {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("The delivered master is not a RIFF/WAVE file.");
  }
  const declaredEnd = bytes.readUInt32LE(4) + 8;
  if (declaredEnd !== bytes.length) throw new Error("The delivered master RIFF length does not match its file size.");

  let formatCode = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataBytes = 0;
  let dataOffset = 0;
  let bextVersion = 0;
  let offset = 12;
  while (offset + 8 <= declaredEnd) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    const end = body + size;
    if (end > declaredEnd) throw new Error(`The delivered master ${id} chunk exceeds the RIFF boundary.`);
    if (id === "fmt ") {
      if (size < 16) throw new Error("The delivered master format chunk is incomplete.");
      formatCode = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bitDepth = bytes.readUInt16LE(body + 14);
    } else if (id === "bext") {
      if (size < 602) throw new Error("The delivered master BWF chunk is incomplete.");
      bextVersion = bytes.readUInt16LE(body + 346);
    } else if (id === "data") {
      dataBytes = size;
      dataOffset = body;
    }
    offset = end + (size % 2);
  }

  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  if (!formatCode || !channels || !sampleRate || !blockAlign || !dataBytes || dataBytes % blockAlign !== 0) {
    throw new Error("The delivered master is missing aligned audio format or sample data.");
  }
  let peak = 0;
  let sumSquares = 0;
  const sampleCount = dataBytes / bytesPerSample;
  for (let index = 0; index < sampleCount; index++) {
    const at = dataOffset + index * bytesPerSample;
    let sample = 0;
    if (formatCode === 3 && bitDepth === 32) sample = bytes.readFloatLE(at);
    else if (formatCode === 1 && bitDepth === 16) sample = bytes.readInt16LE(at) / 0x8000;
    else if (formatCode === 1 && bitDepth === 24) sample = (bytes.readUIntLE(at, 3) << 8) >> 8;
    else throw new Error(`Unsupported delivered master encoding (${formatCode}, ${bitDepth}-bit).`);
    if (bitDepth === 24) sample /= 0x800000;
    if (!Number.isFinite(sample)) throw new Error("The delivered master contains a non-finite sample.");
    peak = Math.max(peak, Math.abs(sample));
    sumSquares += sample * sample;
  }
  return {
    formatCode,
    channels,
    sampleRate,
    bitDepth,
    dataBytes,
    frames: dataBytes / blockAlign,
    bextVersion,
    peak,
    rms: Math.sqrt(sumSquares / sampleCount),
  };
}

test.describe("17 — mastering workspace", () => {
  test.describe.configure({ timeout: 120_000 });

  test("master bus carries an injected tone through its native processing path", async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const facts = await page.evaluate(async () => {
      const audioEngineModulePath = ["/src", "audio-engine", "AudioEngine.ts"].join("/");
      const templatesModulePath = ["/src", "project-model", "templates.ts"].join("/");
      const [{ AudioEngine }, { createProjectFromTemplate }] = await Promise.all([
        import(audioEngineModulePath),
        import(templatesModulePath),
      ]);
      const sampleRate = 44100;
      const renderPath = async (bypassed: boolean) => {
        const context = new OfflineAudioContext(2, sampleRate, sampleRate);
        const engine = new AudioEngine();
        const doc = createProjectFromTemplate("empty");
        doc.master = {
          ...doc.master,
          effects: [],
          glueEnabled: false,
          limiterEnabled: false,
          clipperEnabled: false,
          tapeEnabled: false,
          msEnabled: false,
          bassMonoEnabled: false,
          masterGain: 1,
        };
        engine.useContext(context);
        engine.setProject(doc);
        if (bypassed) engine.setMasterBypassed(true, true);

        const input = (engine as unknown as { masterChain: { input: AudioNode } }).masterChain.input;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 1000;
        gain.gain.value = 0.25;
        oscillator.connect(gain).connect(input);
        oscillator.start(0.02);
        oscillator.stop(0.8);

        const rendered = await context.startRendering();
        let peak = 0;
        let sumSquares = 0;
        let count = 0;
        for (let channel = 0; channel < rendered.numberOfChannels; channel++) {
          const samples = rendered.getChannelData(channel);
          for (const sample of samples) {
            peak = Math.max(peak, Math.abs(sample));
            sumSquares += sample * sample;
            count++;
          }
        }
        return { peak, rms: Math.sqrt(sumSquares / count) };
      };
      return { processed: await renderPath(false), bypassed: await renderPath(true) };
    });
    expect(facts.bypassed.peak, "the dry monitor path must carry a connected source").toBeGreaterThan(0.1);
    expect(facts.processed.peak, "the master output path must not mute a connected source").toBeGreaterThan(0.1);
  });

  test("opens the simple view and follows signal-flow keyboard focus into advanced controls", async ({ page }) => {
    test.setTimeout(150_000);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const workspace = page.getByRole("region", { name: "Mastering workspace" });
    await expect(workspace).toBeVisible();
    await expect(page.getByRole("group", { name: "Master controls view" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Simple" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("slider", { name: "IN", exact: true })).toBeVisible();
    await expect(page.getByRole("slider", { name: "CEIL", exact: true })).toBeVisible();
    await expect(page.getByRole("slider", { name: "TRIM", exact: true })).toBeVisible();
    await expect(page.getByRole("slider", { name: "TILT", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Focus TILT controls" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("slider", { name: "TILT", exact: true })).toBeFocused();

    await page.getByRole("button", { name: "Simple" }).click();
    await expect(page.getByRole("slider", { name: "TILT", exact: true })).toHaveCount(0);
    await expect(page.getByText(/other enabled processors keep their saved state/i)).toBeVisible();

    const mixerTab = page.locator('.dock-tabs button[aria-label="Toggle mixer panel"]');
    const devicesTab = page.locator('.dock-tabs button[aria-label="Toggle track device chain"]');
    const exportTab = page.locator('.dock-tabs button[aria-label="Toggle export panel"]');
    const masterTab = page.locator('.dock-tabs button[aria-label="Toggle mastering panel"]');
    await expect(mixerTab).toBeVisible();
    await expect(mixerTab).toHaveAttribute("title", /Alt\+1/);
    await expect(devicesTab).toBeVisible();
    await expect(devicesTab).toHaveAttribute("title", /Alt\+2/);
    await expect(exportTab).toBeVisible();
    await expect(exportTab).toHaveAttribute("title", /Alt\+5/);

    await page.keyboard.press("Alt+1");
    await expect(mixerTab).toHaveAttribute("aria-selected", "true");
    await mixerTab.focus();
    await page.keyboard.press("Alt+9");
    await expect(workspace).toBeVisible();
    await masterTab.focus();
    await page.keyboard.press("Alt+9");
    await expect(workspace).toHaveCount(0);
    await expect(page.locator(".dock-tabs")).toBeVisible();
  });

  test("keeps mastering controls within a narrow dock viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const workspace = page.locator(".mastering-panel");
    await expect(workspace).toBeVisible();
    const overflow = await workspace.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    expect(overflow, "mastering workspace should scroll vertically without horizontal overflow").toBe(false);
    await expect(page.getByRole("button", { name: "ANALYZE FULL SONG" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Render A/B" })).toBeVisible();
  });

  test("round-trips a local mastering reference through browser IndexedDB", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const facts = await page.evaluate(async () => {
      const repositoryModulePath = ["/src", "mastering", "referenceRepository.ts"].join("/");
      const { MASTERING_REFERENCE_DB, MasteringReferenceRepository } = await import(repositoryModulePath);
      const repository = new MasteringReferenceRepository();
      const projectId = `mastering-reference-e2e-${crypto.randomUUID()}`;
      const bytes = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4];
      const source = new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
      await repository.put({
        projectId,
        fileName: "reference.wav",
        mimeType: "audio/wav",
        byteLength: source.size,
        importedAt: new Date().toISOString(),
        source,
      });

      const loaded = await repository.get(projectId);
      const loadedBytes = loaded ? [...new Uint8Array(await loaded.source.arrayBuffer())] : [];
      await repository.delete(projectId);
      return {
        database: MASTERING_REFERENCE_DB,
        fileName: loaded?.fileName ?? null,
        byteLength: loaded?.byteLength ?? null,
        bytes: loadedBytes,
        removed: (await repository.get(projectId)) === null,
      };
    });

    expect(facts.database).toBe("kyx-mastering-reference");
    expect(facts.fileName).toBe("reference.wav");
    expect(facts.byteLength).toBe(8);
    expect(facts.bytes).toEqual([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    expect(facts.removed).toBe(true);
  });

  test("cancels a mastering render without leaving a report or download", async ({ page }) => {
    test.setTimeout(150_000);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const exportPanel = page.locator(".mastering-render-section");
    const status = page.locator(".export-status");
    await exportPanel.getByRole("button", { name: "EXPORT MASTER" }).click();
    await expect(page.getByRole("button", { name: "Cancel export" })).toBeVisible({ timeout: 15_000 });
    const unexpectedDownload = page
      .waitForEvent("download", { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    await page.getByRole("button", { name: "Cancel export" }).click();

    await expect(status).toHaveClass(/export-cancelled/, { timeout: 30_000 });
    await expect(status).toContainText("Cancelled by user.");
    await expect(page.getByRole("note", { name: "Master render report details" })).toHaveCount(0);
    expect(await unexpectedDownload).toBe(false);
  });

  test("analyzes the full song, invalidates the report after a master edit, and remeasures", async ({ page }) => {
    test.setTimeout(300_000);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const overviewStatus = page.locator(".mastering-overview-status");
    await page.getByRole("button", { name: "ANALYZE FULL SONG" }).click();
    await expect(overviewStatus).toHaveAttribute("data-state", "busy");
    const report = page.getByRole("note", { name: "Master render report details" });
    await expect(report).toBeVisible({ timeout: 120_000 });
    await expect(report).toContainText("FULL SONG");
    await expect(report).toContainText("REPORT V");
    await expect(overviewStatus).not.toHaveText("ANALYZING");

    await page.getByRole("slider", { name: "IN", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(overviewStatus).toHaveText("STALE · ANALYZE AGAIN");
    await expect(page.locator(".export-status .export-policy-warning")).toContainText("STALE REPORT");

    await page.getByRole("button", { name: "ANALYZE FULL SONG" }).click();
    await expect(report).toBeVisible({ timeout: 120_000 });
    await expect(overviewStatus).not.toHaveText("STALE · ANALYZE AGAIN");
    await expect(page.locator(".export-status .export-policy-warning")).toHaveCount(0);

    const exportPanel = page.locator(".mastering-render-section");
    const downloadPromise = page.waitForEvent("download");
    await exportPanel.getByRole("button", { name: "EXPORT MASTER" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.wav$/i);
    const encodedCheck = page.getByRole("region", { name: "Encoded master file check" });
    await expect(encodedCheck).toBeVisible({ timeout: 120_000 });
    await expect(encodedCheck).toContainText("WAV · 16-bit PCM");
    await expect(encodedCheck).toContainText("BWF v2");
    await expect(encodedCheck).toContainText("BWF v2 source PCM");
    await expect(encodedCheck).toContainText("FINAL FILE · DECODED + MEASURED");
    await expect(encodedCheck.getByRole("list", { name: "File check warnings" })).toHaveCount(0);

    const firstPath = await download.path();
    expect(firstPath).toBeTruthy();
    const firstFacts = readMasterWavFacts(await readFile(firstPath!));
    expect(firstFacts).toMatchObject({ formatCode: 1, channels: 2, sampleRate: 44100, bitDepth: 16, bextVersion: 2 });
    expect(firstFacts.peak, "the delivered master must contain audible signal").toBeGreaterThan(0.001);
    expect(firstFacts.rms, "the delivered master must contain sustained audio energy").toBeGreaterThan(0.0001);

    const verifyDepth = async (depth: 24 | 32) => {
      await page.getByLabel("DEPTH").selectOption(String(depth));
      const nextDownload = page.waitForEvent("download");
      await exportPanel.getByRole("button", { name: "EXPORT MASTER" }).click();
      const delivered = await nextDownload;
      expect(delivered.suggestedFilename()).toMatch(/\.wav$/i);

      const expectedLabel = depth === 24 ? "WAV · 24-bit PCM" : "WAV · 32-bit float";
      await expect(encodedCheck).toContainText(expectedLabel, { timeout: 120_000 });
      await expect(encodedCheck).toContainText("BWF v2 source PCM");
      await expect(encodedCheck).toContainText("FINAL FILE · DECODED + MEASURED");
      await expect(encodedCheck.getByRole("list", { name: "File check warnings" })).toHaveCount(0);

      const deliveredPath = await delivered.path();
      expect(deliveredPath).toBeTruthy();
      const facts = readMasterWavFacts(await readFile(deliveredPath!));
      expect(facts).toMatchObject({
        formatCode: depth === 32 ? 3 : 1,
        channels: 2,
        sampleRate: 44100,
        bitDepth: depth,
        bextVersion: 2,
        frames: firstFacts.frames,
      });
      expect(facts.peak, `${depth}-bit master must contain audible signal`).toBeGreaterThan(0.001);
      expect(facts.rms, `${depth}-bit master must contain sustained audio energy`).toBeGreaterThan(0.0001);

      const reportText = await report.innerText();
      const sampleCount = reportText.match(/([\d\s,\.\u00a0\u202f]+)\s+samples/i);
      expect(sampleCount, "the report should expose the exact rendered sample range").toBeTruthy();
      expect(facts.frames).toBe(Number(sampleCount![1].replace(/\D/g, "")));
    };

    await verifyDepth(24);
    await verifyDepth(32);
  });
});
