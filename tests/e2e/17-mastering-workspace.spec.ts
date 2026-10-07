import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "playwright/test";
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

function makeStereoTestWav(durationSeconds = 1): Buffer {
  const sampleRate = 44_100;
  const channels = 2;
  const bitsPerSample = 16;
  const frames = sampleRate * durationSeconds;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataBytes = frames * blockAlign;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * blockAlign, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame++) {
    const left = Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 0.12 * 0x7fff);
    const right = Math.round(Math.sin((2 * Math.PI * 443 * frame) / sampleRate) * 0.1 * 0x7fff);
    wav.writeInt16LE(left, 44 + frame * blockAlign);
    wav.writeInt16LE(right, 44 + frame * blockAlign + 2);
  }
  return wav;
}

async function installMasteringDecodeGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type DecodeGate = {
      armed: boolean;
      waitForStart: () => Promise<void>;
      arm: (byteLength: number) => void;
      release: () => void;
    };
    let expectedByteLength = 0;
    let startedResolve: (() => void) | null = null;
    let started = Promise.resolve();
    let releaseDecode: (() => void) | null = null;
    const gate: DecodeGate = {
      armed: false,
      waitForStart: () => started,
      arm: (byteLength) => {
        started = new Promise<void>((resolve) => {
          startedResolve = resolve;
        });
        expectedByteLength = byteLength;
        gate.armed = true;
      },
      release: () => releaseDecode?.(),
    };
    Object.defineProperty(window, "__masteringDecodeGate", { configurable: true, value: gate });

    const prototype = OfflineAudioContext.prototype;
    const originalDecode = prototype.decodeAudioData;
    Object.defineProperty(prototype, "decodeAudioData", {
      configurable: true,
      writable: true,
      value: function (this: OfflineAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
        if (!gate.armed || bytes.byteLength !== expectedByteLength) return originalDecode.call(this, bytes);
        gate.armed = false;
        const decode = originalDecode.call(this, bytes);
        return new Promise<AudioBuffer>((resolve, reject) => {
          releaseDecode = () => {
            releaseDecode = null;
            void decode.then(resolve, reject);
          };
          startedResolve?.();
          startedResolve = null;
        });
      },
    });
  });
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

  test("cancels a master export during WAV encoding without a report or download", async ({ page }) => {
    test.setTimeout(180_000);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");
    await page.getByLabel("Analysis scope").selectOption("pattern");
    await page.evaluate(() => {
      const marker = window as Window & {
        __masteringEncodeStarted?: boolean;
        __masteringEncodeYieldDelayed?: boolean;
      };
      marker.__masteringEncodeStarted = false;
      marker.__masteringEncodeYieldDelayed = false;
      const originalSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (marker.__masteringEncodeStarted && timeout === 0 && !marker.__masteringEncodeYieldDelayed) {
          marker.__masteringEncodeYieldDelayed = true;
          return originalSetTimeout(handler, 10_000, ...args);
        }
        return originalSetTimeout(handler, timeout, ...args);
      }) as typeof window.setTimeout;

      const checkStatus = () => {
        if (document.querySelector(".export-status")?.textContent?.includes("Encoding WAV")) {
          marker.__masteringEncodeStarted = true;
        }
      };
      new MutationObserver(checkStatus).observe(document.body, { childList: true, subtree: true, characterData: true });
      checkStatus();
    });

    const exportPanel = page.locator(".mastering-render-section");
    const status = page.locator(".export-status");
    await exportPanel.getByRole("button", { name: "EXPORT MASTER" }).click();
    await expect(status).toContainText("Encoding WAV", { timeout: 150_000 });
    await page.waitForFunction(
      () => (window as Window & { __masteringEncodeYieldDelayed?: boolean }).__masteringEncodeYieldDelayed === true,
      undefined,
      { timeout: 150_000 },
    );

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

  test("cancels a master export during post-encode decode without a report or download", async ({ page }) => {
    test.setTimeout(180_000);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");
    await page.getByLabel("Analysis scope").selectOption("pattern");
    await page.evaluate(() => {
      const marker = window as Window & { __masteringWavDecodePending?: boolean };
      marker.__masteringWavDecodePending = false;
      const prototype = OfflineAudioContext.prototype;
      const originalDecode = prototype.decodeAudioData;
      Object.defineProperty(prototype, "decodeAudioData", {
        configurable: true,
        writable: true,
        value: function (this: OfflineAudioContext, encodedBytes: ArrayBuffer): Promise<AudioBuffer> {
          const bytes = new Uint8Array(encodedBytes);
          const isBwfMaster =
            bytes.length > 700 &&
            bytes[0] === 0x52 &&
            bytes[1] === 0x49 &&
            bytes[2] === 0x46 &&
            bytes[3] === 0x46 &&
            bytes[8] === 0x57 &&
            bytes[9] === 0x41 &&
            bytes[10] === 0x56 &&
            bytes[11] === 0x45 &&
            bytes[36] === 0x62 &&
            bytes[37] === 0x65 &&
            bytes[38] === 0x78 &&
            bytes[39] === 0x74;
          const decoded = originalDecode.call(this, encodedBytes);
          if (!isBwfMaster) return decoded;
          marker.__masteringWavDecodePending = true;
          return decoded.then(
            (audio) => new Promise<AudioBuffer>((resolve) => setTimeout(() => resolve(audio), 15_000)),
          );
        },
      });
    });

    const exportPanel = page.locator(".mastering-render-section");
    const status = page.locator(".export-status");
    await exportPanel.getByRole("button", { name: "EXPORT MASTER" }).click();
    await page.waitForFunction(
      () => (window as Window & { __masteringWavDecodePending?: boolean }).__masteringWavDecodePending === true,
      undefined,
      { timeout: 150_000 },
    );
    await expect(status).toContainText("Checking encoded WAV");

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

  test("inspects a large MP3 in a real worker or reports unsupported browser decoding", async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const inspection = await page.evaluate(async () => {
      const mp3ModulePath = ["/src", "export", "mp3.ts"].join("/");
      const inspectionModulePath = ["/src", "mastering", "encodedInspection.ts"].join("/");
      const profilesModulePath = ["/src", "mastering", "profiles.ts"].join("/");
      const analysisModulePath = ["/src", "mastering", "analysis.ts"].join("/");
      const [mp3Module, inspectionModule, profilesModule, analysisModule] = await Promise.all([
        import(mp3ModulePath),
        import(inspectionModulePath),
        import(profilesModulePath),
        import(analysisModulePath),
      ]);
      const sampleRate = 44100;
      const frameCount = sampleRate * 4;
      const buffer = new AudioBuffer({ length: frameCount, numberOfChannels: 2, sampleRate });
      const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
      for (let frame = 0; frame < frameCount; frame++) {
        channels[0][frame] = 0.24 * Math.sin((2 * Math.PI * 221 * frame) / sampleRate);
        channels[1][frame] = 0.19 * Math.sin((2 * Math.PI * 223 * frame) / sampleRate);
      }
      const profile = profilesModule.MASTER_PROFILES.find((candidate: { id: string }) => candidate.id === "streaming");
      if (!profile) throw new Error("The streaming mastering profile is unavailable.");
      const sourceAnalysis = analysisModule.analyzeMasterPcm(channels, sampleRate, profile);
      const encoded = await mp3Module.encodeMp3(buffer, { kbps: 320 });

      // A valid ID3v2 padding tag takes the file over the 12 MiB inspection
      // threshold while leaving only the real MP3 frames for the decoder worker.
      const paddingBytes = 12 * 1024 * 1024 + 1;
      const header = new Uint8Array(10);
      header.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
      header[6] = (paddingBytes >>> 21) & 0x7f;
      header[7] = (paddingBytes >>> 14) & 0x7f;
      header[8] = (paddingBytes >>> 7) & 0x7f;
      header[9] = paddingBytes & 0x7f;
      const padding = new Uint8Array(paddingBytes);
      const largeFile = new Blob([header, padding, encoded], { type: "audio/mpeg" });
      let firstDecodeProgress: number | null = null;
      const result = await inspectionModule.inspectEncodedMaster({
        format: "mp3",
        bytes: largeFile,
        expectedDurationSeconds: buffer.duration,
        sourceMeasurements: sourceAnalysis.measurements,
        profile,
        onProgress: ({ progress, stage }: { progress: number; stage: string }) => {
          if (stage.startsWith("Decoding and analyzing MP3 frames") && firstDecodeProgress === null) {
            firstDecodeProgress = progress;
          }
        },
      });
      let cancellationRequested = false;
      const controller = new AbortController();
      const cancellationErrorName = await inspectionModule
        .inspectEncodedMaster({
          format: "mp3",
          bytes: largeFile,
          expectedDurationSeconds: buffer.duration,
          sourceMeasurements: sourceAnalysis.measurements,
          profile,
          signal: controller.signal,
          onProgress: ({ stage }: { progress: number; stage: string }) => {
            if (stage.startsWith("Decoding and analyzing MP3 frames")) {
              cancellationRequested = true;
              controller.abort();
            }
          },
        })
        .then(() => null)
        .catch((error: unknown) => (error instanceof Error ? error.name : "unknown"));
      return {
        fileSize: result.byteLength,
        fileDurationAccuracy: result.file.durationAccuracy,
        status: result.decode.status,
        decoder: result.decode.decoder,
        reason: result.decode.reason ?? null,
        sampleRate: result.decode.sampleRate ?? null,
        channels: result.decode.channels ?? null,
        durationSeconds: result.decode.durationSeconds ?? null,
        rmsDb: result.decode.measurements?.rmsDb ?? null,
        truePeakDb: result.decode.measurements?.truePeakDb ?? null,
        firstDecodeProgress,
        cancellationRequested,
        cancellationErrorName,
      };
    });

    expect(inspection.fileSize).toBeGreaterThan(12 * 1024 * 1024);
    if (inspection.status === "measured") {
      expect(inspection.decoder).toBe("WebCodecs MP3 worker");
      expect(inspection.fileDurationAccuracy).toBe("exact");
      expect(inspection.sampleRate).toBe(44100);
      expect(inspection.channels).toBe(2);
      expect(inspection.durationSeconds).toBeGreaterThan(3.5);
      expect(inspection.durationSeconds).toBeLessThan(4.5);
      expect(Number.isFinite(inspection.rmsDb)).toBe(true);
      expect(Number.isFinite(inspection.truePeakDb)).toBe(true);
      expect(inspection.firstDecodeProgress).toBeGreaterThan(0);
      expect(inspection.firstDecodeProgress).toBeLessThan(0.75);
      expect(inspection.cancellationRequested).toBe(true);
      expect(inspection.cancellationErrorName).toBe("AbortError");
    } else {
      expect(inspection.status).toBe("not-measured");
      expect(inspection.decoder).toBe("WebCodecs MP3 worker");
      expect(inspection.fileDurationAccuracy).toBe("estimated");
      expect(inspection.reason).toMatch(
        /does not expose|does not support MP3|capability check failed|cannot run a background|could not start the background MP3 worker|could not configure its MP3 decoder/i,
      );
      expect(inspection.cancellationRequested).toBe(false);
      expect(inspection.cancellationErrorName).toBeNull();
    }
  });

  test("rejects a corrupted MP3 instead of presenting measurements", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const errorMessage = await page.evaluate(async () => {
      const inspectionModulePath = ["/src", "mastering", "encodedInspection.ts"].join("/");
      const profilesModulePath = ["/src", "mastering", "profiles.ts"].join("/");
      const [inspectionModule, profilesModule] = await Promise.all([
        import(inspectionModulePath),
        import(profilesModulePath),
      ]);
      const profile = profilesModule.MASTER_PROFILES.find((candidate: { id: string }) => candidate.id === "streaming");
      if (!profile) throw new Error("The streaming mastering profile is unavailable.");
      try {
        await inspectionModule.inspectEncodedMaster({
          format: "mp3",
          bytes: new Blob([Uint8Array.of(0x00, 0x13, 0x7f, 0x2a)], { type: "audio/mpeg" }),
          expectedDurationSeconds: 1,
          sourceMeasurements: {},
          profile,
        });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "unknown error";
      }
    });
    expect(errorMessage).toMatch(/No valid MPEG Layer III frame/);
  });

  test("streams a WAV larger than 96 MiB through the real analyzer worker and aborts during chunking", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const inspection = await page.evaluate(async () => {
      const inspectionModulePath = ["/src", "mastering", "encodedInspection.ts"].join("/");
      const profilesModulePath = ["/src", "mastering", "profiles.ts"].join("/");
      const [inspectionModule, profilesModule] = await Promise.all([
        import(inspectionModulePath),
        import(profilesModulePath),
      ]);

      const sampleRate = 44_100;
      const thresholdBytes = 96 * 1024 * 1024;
      const dataBytes = thresholdBytes + 4;
      const frameCount = dataBytes / 4;
      const wav = new ArrayBuffer(44 + dataBytes);
      const view = new DataView(wav);
      const writeText = (offset: number, value: string) => {
        for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
      };
      writeText(0, "RIFF");
      view.setUint32(4, wav.byteLength - 8, true);
      writeText(8, "WAVE");
      writeText(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 2, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 4, true);
      view.setUint16(32, 4, true);
      view.setUint16(34, 16, true);
      writeText(36, "data");
      view.setUint32(40, dataBytes, true);

      const patternFrames = 441;
      const pattern = new Int16Array(patternFrames * 2);
      for (let frame = 0; frame < patternFrames; frame++) {
        pattern[frame * 2] = Math.round(9_000 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate));
        pattern[frame * 2 + 1] = Math.round(7_500 * Math.sin((2 * Math.PI * 223 * frame) / sampleRate));
      }
      const pcm = new Int16Array(wav, 44, dataBytes / 2);
      for (let sample = 0; sample < pcm.length; sample++) pcm[sample] = pattern[sample % pattern.length]!;

      const profile = profilesModule.MASTER_PROFILES.find((candidate: { id: string }) => candidate.id === "streaming");
      if (!profile) throw new Error("The streaming mastering profile is unavailable.");
      const prototype = OfflineAudioContext.prototype;
      const originalDecode = prototype.decodeAudioData;
      let oversizedBrowserDecodeCalls = 0;
      Object.defineProperty(prototype, "decodeAudioData", {
        configurable: true,
        writable: true,
        value: function (this: OfflineAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
          if (bytes.byteLength > thresholdBytes) oversizedBrowserDecodeCalls++;
          return originalDecode.call(this, bytes);
        },
      });

      try {
        let progressEvents = 0;
        let lastProgress = 0;
        const result = await inspectionModule.inspectEncodedMaster({
          format: "wav",
          bytes: wav,
          expectedDurationSeconds: frameCount / sampleRate,
          sourceMeasurements: {},
          profile,
          onProgress: ({ progress }: { progress: number; stage: string }) => {
            progressEvents++;
            lastProgress = progress;
          },
        });
        const controller = new AbortController();
        let abortedAtProgress: number | null = null;
        const cancelErrorName = await inspectionModule
          .inspectEncodedMaster({
            format: "wav",
            bytes: wav,
            expectedDurationSeconds: frameCount / sampleRate,
            sourceMeasurements: {},
            profile,
            signal: controller.signal,
            onProgress: ({ progress, stage }: { progress: number; stage: string }) => {
              if (stage === "Analyzing audio in bounded worker chunks" && progress > 0) {
                abortedAtProgress = progress;
                controller.abort();
              }
            },
          })
          .then(() => null)
          .catch((error: unknown) => (error instanceof Error ? error.name : "unknown"));

        return {
          byteLength: result.byteLength,
          sourceDurationSeconds: result.file.durationSeconds,
          sourceDurationAccuracy: result.file.durationAccuracy,
          status: result.decode.status,
          decoder: result.decode.decoder,
          reason: result.decode.reason ?? null,
          sampleRate: result.decode.sampleRate ?? null,
          channels: result.decode.channels ?? null,
          durationSeconds: result.decode.durationSeconds ?? null,
          rmsDb: result.decode.measurements?.rmsDb ?? null,
          truePeakDb: result.decode.measurements?.truePeakDb ?? null,
          progressEvents,
          lastProgress,
          oversizedBrowserDecodeCalls,
          abortedAtProgress,
          cancelErrorName,
        };
      } finally {
        Object.defineProperty(prototype, "decodeAudioData", {
          configurable: true,
          writable: true,
          value: originalDecode,
        });
      }
    });

    expect(inspection.byteLength).toBeGreaterThan(96 * 1024 * 1024);
    expect(inspection.sourceDurationAccuracy).toBe("exact");
    expect(inspection.sourceDurationSeconds).toBeGreaterThan(570);
    expect(inspection.status, JSON.stringify({ reason: inspection.reason })).toBe("measured");
    expect(inspection.decoder).toBe("KYX WAV PCM reader");
    expect(inspection.sampleRate).toBe(44_100);
    expect(inspection.channels).toBe(2);
    expect(inspection.durationSeconds).toBeCloseTo(inspection.sourceDurationSeconds, 6);
    expect(Number.isFinite(inspection.rmsDb)).toBe(true);
    expect(Number.isFinite(inspection.truePeakDb)).toBe(true);
    expect(inspection.progressEvents).toBeGreaterThan(100);
    expect(inspection.lastProgress).toBeGreaterThan(0.8);
    expect(inspection.oversizedBrowserDecodeCalls).toBe(0);
    expect(inspection.abortedAtProgress).toBeGreaterThan(0);
    expect(inspection.abortedAtProgress).toBeLessThan(0.1);
    expect(inspection.cancelErrorName).toBe("AbortError");
  });

  test("renders an external source through an isolated copy of the project master chain", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    const result = await page.evaluate(async () => {
      const sessionRenderPath = ["/src", "mastering", "sessionRender.ts"].join("/");
      const sampleBankPath = ["/src", "sample-library", "factory.ts"].join("/");
      const schemaPath = ["/src", "project-model", "schema.ts"].join("/");
      const [sessionRenderModule, sampleBankModule, schemaModule] = await Promise.all([
        import(sessionRenderPath),
        import(sampleBankPath),
        import(schemaPath),
      ]);
      const source = new AudioBuffer({ length: 44_100, numberOfChannels: 2, sampleRate: 44_100 });
      const left = source.getChannelData(0);
      const right = source.getChannelData(1);
      for (let frame = 0; frame < source.length; frame++) {
        left[frame] = 0.2 * Math.sin((2 * Math.PI * 440 * frame) / source.sampleRate);
        right[frame] = 0.15 * Math.sin((2 * Math.PI * 443 * frame) / source.sampleRate);
      }
      const originalSample = left[1_000];
      const master = schemaModule.defaultMasterConfig();
      master.masterGain = 0;
      master.loudnessTrimDb = 0;
      const bank = new sampleBankModule.SampleBank();
      const revisionBeforeRender = bank.revision;
      const output = await sessionRenderModule.renderMasteringSessionSource(source, master, bank, {
        sampleRate: 44_100,
        quality: "live",
      });
      let peak = 0;
      for (let channel = 0; channel < output.numberOfChannels; channel++) {
        const samples = output.getChannelData(channel);
        for (let frame = 0; frame < samples.length; frame++) peak = Math.max(peak, Math.abs(samples[frame]));
      }
      return {
        outputDurationSeconds: output.duration,
        outputSampleRate: output.sampleRate,
        outputChannels: output.numberOfChannels,
        peak,
        sourceSampleAfterRender: left[1_000],
        originalSample,
        masterGainAfterRender: master.masterGain,
        bankSizeAfterRender: bank.size,
        revisionAfterRender: bank.revision,
        revisionBeforeRender,
      };
    });

    expect(result.outputDurationSeconds).toBeCloseTo(3, 4);
    expect(result.outputSampleRate).toBe(44_100);
    expect(result.outputChannels).toBe(2);
    expect(result.peak).toBeLessThan(1e-6);
    expect(result.sourceSampleAfterRender).toBe(result.originalSample);
    expect(result.masterGainAfterRender).toBe(0);
    expect(result.bankSizeAfterRender).toBe(0);
    expect(result.revisionAfterRender).toBe(result.revisionBeforeRender);
  });

  test("cancels an external source import while browser decoding is pending", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await installMasteringDecodeGate(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    const decodeStarted = page.evaluate(() => {
      const gate = (
        window as Window & {
          __masteringDecodeGate?: { arm: (byteLength: number) => void; waitForStart: () => Promise<void> };
        }
      ).__masteringDecodeGate;
      if (!gate) throw new Error("Mastering decode gate was not installed.");
      gate.arm(44 + 44_100 * 4);
      return gate.waitForStart();
    });
    await session.getByLabel("Import WAV or MP3 mixdown").setInputFiles({
      name: "cancelled-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await decodeStarted;
    await expect(session.locator(".mastering-file-session-status")).toContainText("Decoding source audio…");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      session.getByText(/Source import cancelled\. The selected session was left unchanged\./),
    ).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { __masteringDecodeGate?: { release: () => void } }).__masteringDecodeGate?.release();
    });
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
  });

  test("cancels an external source import during cooperative decoded-audio inspection", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await page.addInitScript(() => {
      const marker = window as Window & { __holdMasteringAudit?: boolean };
      const originalSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (marker.__holdMasteringAudit && timeout === 0) return originalSetTimeout(handler, 250, ...args);
        return originalSetTimeout(handler, timeout, ...args);
      }) as typeof window.setTimeout;
    });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await page.evaluate(() => {
      (window as Window & { __holdMasteringAudit?: boolean }).__holdMasteringAudit = true;
    });
    await session.getByLabel("Import WAV or MP3 mixdown").setInputFiles({
      name: "inspection-cancel-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(12),
    });
    await expect(session.locator(".mastering-file-session-status")).toContainText("Inspecting decoded source audio…");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      session.getByText(/Source import cancelled\. The selected session was left unchanged\./),
    ).toBeVisible();
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
  });

  test("cancels a comparison reference import before it is saved", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await installMasteringDecodeGate(page);
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV or MP3 mixdown").setInputFiles({
      name: "reference-cancel-source.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
    const decodeStarted = page.evaluate(() => {
      const gate = (
        window as Window & {
          __masteringDecodeGate?: { arm: (byteLength: number) => void; waitForStart: () => Promise<void> };
        }
      ).__masteringDecodeGate;
      if (!gate) throw new Error("Mastering decode gate was not installed.");
      gate.arm(44 + 44_100 * 4);
      return gate.waitForStart();
    });
    await session.getByLabel("Import external mastering reference WAV or MP3").setInputFiles({
      name: "cancelled-reference.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await decodeStarted;
    await expect(session.locator(".mastering-file-session-status")).toContainText("Decoding comparison reference…");
    await session.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(session.getByText("Reference import cancelled.", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { __masteringDecodeGate?: { release: () => void } }).__masteringDecodeGate?.release();
    });

    const savedSessions = session.getByLabel("Saved mastering sessions");
    const savedSessionId = await savedSessions.locator("option").nth(1).getAttribute("value");
    expect(savedSessionId).toBeTruthy();
    await savedSessions.selectOption("");
    await savedSessions.selectOption(savedSessionId!);
    await expect(session.getByText(/Loaded reference-cancel-source\.wav/)).toBeVisible({ timeout: 30_000 });
    await expect(session.getByRole("button", { name: "Listen to reference" })).toHaveCount(0);
    await expect(session.getByText("cancelled-reference.wav", { exact: true })).toHaveCount(0);
  });

  test("shows a clear message when browser storage quota blocks a source import", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await page.addInitScript(() => {
      const originalPut = IDBObjectStore.prototype.put;
      Object.defineProperty(IDBObjectStore.prototype, "put", {
        configurable: true,
        writable: true,
        value: function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
          if (this.transaction.db.name === "kyx-mastering-sessions" && this.name === "sessions") {
            throw new DOMException("Simulated browser quota reached", "QuotaExceededError");
          }
          if (arguments.length > 1) return originalPut.call(this, value, key);
          return originalPut.call(this, value);
        },
      });
    });
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV or MP3 mixdown").setInputFiles({
      name: "quota-limited.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByRole("alert")).toContainText("Browser storage is full", { timeout: 30_000 });
    await expect(session.getByText(/Original saved locally/)).toHaveCount(0);
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
  });

  test("rejects a malformed external WAV header without creating a session", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    const corruptedWav = makeStereoTestWav();
    corruptedWav.write("NOPE", 0, "ascii");
    await session.getByLabel("Import WAV or MP3 mixdown").setInputFiles({
      name: "damaged-source.wav",
      mimeType: "audio/wav",
      buffer: corruptedWav,
    });
    await expect(session.getByRole("alert")).toContainText("RIFF/WAVE header");
    await expect(session.getByLabel("Saved mastering sessions").locator("option")).toHaveCount(1);
  });

  test("external file inserts are editable, undoable, and isolated from the open project", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const workspace = page.getByRole("region", { name: "Mastering workspace" });
    const projectMaster = workspace.locator("#master-insert-controls");
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    const projectRack = projectMaster.getByRole("region", { name: "Master effects" });
    await expect(projectRack.locator(".device-chain-item")).toHaveCount(0);

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV or MP3 mixdown").setInputFiles({
      name: "isolated-session.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
    const sessionRack = session.getByRole("region", { name: "Master effects" });
    await expect(session.getByRole("group", { name: "MASTER INSERT CHAIN" })).toBeVisible();
    await sessionRack.getByRole("combobox", { name: "Add effect to the track" }).selectOption("eq");
    await expect(sessionRack.locator("button.device-chain-item")).toHaveCount(1);
    await expect(session.getByRole("button", { name: "Apply settings" })).toBeEnabled();

    await session.getByRole("button", { name: "Apply settings" }).click();
    await expect(session.getByRole("button", { name: "Undo" })).toBeEnabled();
    await session.getByRole("button", { name: "Undo" }).click();
    await expect(sessionRack.locator(".device-chain-item")).toHaveCount(0);
    await expect(session.getByRole("button", { name: "Redo" })).toBeEnabled();
    await session.getByRole("button", { name: "Redo" }).click();
    await expect(sessionRack.locator("button.device-chain-item")).toHaveCount(1);

    await expect(projectRack.locator(".device-chain-item")).toHaveCount(0);

    await session.getByLabel("Import external mastering reference WAV or MP3").setInputFiles({
      name: "reference.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Reference saved locally · reference\.wav/)).toBeVisible({ timeout: 30_000 });
    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByRole("button", { name: "Listen to session master" })).toBeEnabled({ timeout: 90_000 });
    await session.getByRole("button", { name: "Listen to session master" }).click();
    await expect(session.getByRole("button", { name: "Stop audition" })).toBeVisible();
    await session.getByRole("button", { name: "Stop audition" }).click();
    await session.getByRole("button", { name: "Listen to reference" }).click();
    await expect(session.getByRole("button", { name: "Stop audition" })).toBeVisible();
    await session.getByRole("button", { name: "Stop audition" }).click();
    const savedSessions = session.getByLabel("Saved mastering sessions");
    const savedSessionId = await savedSessions.locator("option").nth(1).getAttribute("value");
    expect(savedSessionId).toBeTruthy();
    await savedSessions.selectOption("");
    await savedSessions.selectOption(savedSessionId!);
    await expect(session.getByText("reference.wav", { exact: true })).toBeVisible({ timeout: 30_000 });

    await session.getByLabel("Name for version A").fill("EQ draft");
    await session.getByRole("button", { name: "Save current to A" }).click();
    await expect(session.getByRole("button", { name: "Load A into session" })).toBeVisible();
    await sessionRack.locator("select.devices-add-effect").selectOption("compressor");
    await session.getByRole("button", { name: "Apply settings" }).click();
    await session.getByLabel("Name for version B").fill("EQ + compressor");
    await session.getByRole("button", { name: "Save current to B" }).click();

    await session.getByRole("button", { name: "Render A/B versions" }).click();
    await expect(session.getByText(/A\/B render · 44\.1 kHz · Studio HQ/)).toBeVisible({ timeout: 90_000 });
    await expect(session.getByRole("button", { name: "Listen to A" })).toBeEnabled();
    await expect(session.getByRole("button", { name: "Listen to B" })).toBeEnabled();
    await session.getByRole("button", { name: "Listen to A" }).click();
    await expect(session.getByRole("button", { name: "Stop audition" })).toBeVisible();
  });

  test("renders, encodes, checks, and re-imports a mastering-session WAV", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(testInfo.project.name !== "chromium", "External mastering import requires browser Web Audio decoding.");
    await openHouseTemplate(page, { timeoutMs: 120_000 });
    await clickPanelAction(page, "MASTER");

    const session = page.getByRole("region", { name: "External file mastering session" });
    await session.getByLabel("Import WAV or MP3 mixdown").setInputFiles({
      name: "pre-master.wav",
      mimeType: "audio/wav",
      buffer: makeStereoTestWav(),
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });

    await session.getByRole("button", { name: "Render & analyze" }).click();
    await expect(session.getByRole("button", { name: "Encode & export WAV" })).toBeEnabled({ timeout: 90_000 });
    await expect(session.locator(".mastering-file-session-report")).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await session.getByRole("button", { name: "Encode & export WAV" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^pre-master-mastered-44100Hz-24bit\.wav$/);
    const downloadPath = testInfo.outputPath("pre-master-mastered.wav");
    await download.saveAs(downloadPath);
    const delivered = await readFile(downloadPath);
    const facts = readMasterWavFacts(delivered);
    expect(facts.formatCode).toBe(1);
    expect(facts.channels).toBe(2);
    expect(facts.sampleRate).toBe(44_100);
    expect(facts.bitDepth).toBe(24);
    expect(facts.bextVersion).toBeGreaterThanOrEqual(2);
    expect(facts.frames).toBeGreaterThan(44_100);
    expect(facts.peak).toBeGreaterThan(0.01);
    await expect(session.getByText(/decoded audio measured/)).toBeVisible({ timeout: 30_000 });

    await session.getByLabel("Import WAV or MP3 mixdown").setInputFiles({
      name: "re-imported-master.wav",
      mimeType: "audio/wav",
      buffer: delivered,
    });
    await expect(session.getByText(/Original saved locally/)).toBeVisible({ timeout: 30_000 });
    await expect(session.locator(".mastering-file-session-source")).toContainText("re-imported-master.wav");
  });
});
