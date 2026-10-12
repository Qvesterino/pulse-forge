import { test, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { clickPanelAction, panelOpen } from "./_helpers";

const SAMPLE_RATE = 48_000;
const MAX_SOAK_SECONDS = 7_200;
const MAX_CAPTURE_LAG_SECONDS = 6;
const STORAGE_HEADROOM_BYTES = 64 * 1024 * 1024;

interface RecordingSnapshot {
  sessionId: string;
  sampleRate: number;
  channels: number;
  totalFrames: number;
  chunkCount: number;
  newFrames: number;
  newChunks: number;
  peak: number;
}

async function installSyntheticMonoInput(page: Page): Promise<void> {
  await page.addInitScript(
    ({ sampleRate }: { sampleRate: number }) => {
      const streams = new WeakSet<MediaStream>();
      const tracks = new WeakSet<MediaStreamTrack>();
      const nativeCreateMediaStreamSource = AudioContext.prototype.createMediaStreamSource;
      const nativeGetSettings = MediaStreamTrack.prototype.getSettings;

      AudioContext.prototype.createMediaStreamSource = function (stream: MediaStream): MediaStreamAudioSourceNode {
        if (!streams.has(stream)) return nativeCreateMediaStreamSource.call(this, stream);
        const merger = this.createChannelMerger(1);
        const oscillator = this.createOscillator();
        const gain = this.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = 220;
        gain.gain.value = 0.2;
        oscillator.connect(gain).connect(merger, 0, 0);
        oscillator.start();
        return merger as unknown as MediaStreamAudioSourceNode;
      };

      MediaStreamTrack.prototype.getSettings = function (): MediaTrackSettings {
        const settings = nativeGetSettings.call(this);
        return tracks.has(this) ? { ...settings, channelCount: 1, sampleRate } : settings;
      };

      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          const streamContext = new AudioContext({ sampleRate });
          const stream = streamContext.createMediaStreamDestination().stream;
          streams.add(stream);
          for (const track of stream.getAudioTracks()) tracks.add(track);
          return stream;
        },
      });
    },
    { sampleRate: SAMPLE_RATE },
  );
}

async function ensureArrangementVisible(page: Page): Promise<void> {
  const timeline = page.locator(".arr-timeline");
  if (await timeline.isVisible().catch(() => false)) return;
  if (!(await panelOpen(page, "ARR"))) await clickPanelAction(page, "ARR");
  await expect(timeline).toBeVisible({ timeout: 20_000 });
}

async function openEmptyProject(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pf-onboarded", "1");
      localStorage.setItem("pf-intent-opened", "1");
    } catch {
      /* storage blocked — the E2E app will show its first-run flow */
    }
  });
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForSelector(".project-browser", { timeout: 180_000 });
  await page.getByRole("button", { name: /^EMPTY/ }).click();
  await page.waitForSelector(".topbar", { timeout: 180_000 });
  await page.waitForSelector(".sequencer", { timeout: 180_000 });
  const skipTour = page.getByRole("button", { name: "Skip tour" });
  if (await skipTour.isVisible().catch(() => false)) await skipTour.click();
}

async function openRecordingInspectorPage(page: Page): Promise<Page> {
  const inspector = await page.context().newPage();
  await inspector.route("**/__recording-soak-inspector", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html><head><title>Recording inspector</title></head><body>ready</body></html>",
    }),
  );
  await inspector.goto("/__recording-soak-inspector");
  await expect(inspector.locator("body")).toHaveText("ready");
  return inspector;
}

async function readHeapUsedBytes(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    return typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null;
  });
}

async function readAndValidateNewPcm(
  page: Page,
  expectedSessionId: string | null,
  firstUnseenSequence: number,
  alreadyValidatedFrames: number,
): Promise<RecordingSnapshot> {
  return page.evaluate(
    async ({ expectedSessionId: wantedId, firstSequence, previousFrames }) => {
      type SessionRow = {
        id: string;
        status: string;
        sampleRate: number;
        channels: number;
        totalFrames: number;
        chunkCount: number;
        updatedAt: number;
      };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("pulse-forge");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      try {
        let session: SessionRow | undefined;
        let chunks: Array<{
          sessionId: string;
          sequence: number;
          frames: number;
          channels: ArrayBuffer[];
        }> = [];

        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(["recording-sessions", "recording-chunks"], "readonly");
          const sessionsRequest = transaction.objectStore("recording-sessions").getAll();

          sessionsRequest.onsuccess = () => {
            const sessions = sessionsRequest.result as SessionRow[];
            const candidates = sessions.filter((session) =>
              wantedId ? session.id === wantedId : session.status === "recording",
            );
            session = candidates.sort((left, right) => right.updatedAt - left.updatedAt)[0];
            if (!session) return;
            const range = IDBKeyRange.bound([session.id, firstSequence], [session.id, Number.MAX_SAFE_INTEGER]);
            const chunksRequest = transaction.objectStore("recording-chunks").getAll(range);
            chunksRequest.onsuccess = () => (chunks = chunksRequest.result as typeof chunks);
            chunksRequest.onerror = () =>
              reject(chunksRequest.error ?? new Error("Could not read newly committed PCM blocks"));
          };
          sessionsRequest.onerror = () =>
            reject(sessionsRequest.error ?? new Error("Could not read recording metadata"));
          transaction.oncomplete = () => resolve();
          transaction.onerror = () =>
            reject(transaction.error ?? new Error("Could not inspect durable recording state"));
          transaction.onabort = () =>
            reject(transaction.error ?? new Error("Recording inspection transaction was aborted"));
        });

        if (!session) {
          throw new Error(
            wantedId ? `Recording session ${wantedId} is no longer active` : "No active recording session",
          );
        }
        if (session.status !== "recording") {
          throw new Error(`Recording session ${session.id} stopped early with status ${session.status}`);
        }

        // The read transaction is complete before this CPU-heavy scan starts,
        // so inspection neither holds the recording object stores nor blocks
        // the recorder page's AudioWorklet message/acknowledgement loop.
        let frameDelta = 0;
        let peak = 0;
        for (let index = 0; index < chunks.length; index++) {
          const chunk = chunks[index]!;
          const expectedSequence = firstSequence + index;
          if (chunk.sessionId !== session.id || chunk.sequence !== expectedSequence) {
            throw new Error(`PCM sequence gap: expected block ${expectedSequence}, got ${chunk.sequence}`);
          }
          if (!Number.isSafeInteger(chunk.frames) || chunk.frames <= 0 || chunk.channels.length !== 1) {
            throw new Error(`PCM block ${chunk.sequence} has invalid frame or channel metadata`);
          }
          const channel = chunk.channels[0];
          if (
            !(channel instanceof ArrayBuffer) ||
            channel.byteLength !== chunk.frames * Float32Array.BYTES_PER_ELEMENT
          ) {
            throw new Error(`PCM block ${chunk.sequence} has an invalid mono payload`);
          }
          for (const sample of new Float32Array(channel)) {
            if (!Number.isFinite(sample)) throw new Error(`PCM block ${chunk.sequence} contains a non-finite sample`);
            peak = Math.max(peak, Math.abs(sample));
          }
          frameDelta += chunk.frames;
        }

        const nextSequence = firstSequence + chunks.length;
        const nextFrames = previousFrames + frameDelta;
        if (session.chunkCount !== nextSequence || session.totalFrames !== nextFrames) {
          throw new Error(
            `Session metadata disagrees with durable blocks (session ${session.chunkCount}/${session.totalFrames}, blocks ${nextSequence}/${nextFrames})`,
          );
        }

        return {
          sessionId: session.id,
          sampleRate: session.sampleRate,
          channels: session.channels,
          totalFrames: session.totalFrames,
          chunkCount: session.chunkCount,
          newFrames: frameDelta,
          newChunks: chunks.length,
          peak,
        };
      } finally {
        db.close();
      }
    },
    { expectedSessionId, firstSequence: firstUnseenSequence, previousFrames: alreadyValidatedFrames },
  );
}

test.use({ trace: "off" });

test.describe("14 — long audio-input recording soak", () => {
  test.describe.configure({ retries: 0 });
  test.skip(({ browserName }) => browserName !== "chromium", "The soak uses Chromium CDP to simulate a renderer crash");

  test("keeps mono PCM durable through the requested duration and exposes it after a renderer crash", async ({
    page,
  }, testInfo) => {
    const rawDuration = process.env.KYX_RECORDING_SOAK_SECONDS;
    test.skip(
      !rawDuration,
      "Opt in with KYX_RECORDING_SOAK_SECONDS (30–7200); this test is intentionally skipped by default",
    );
    const durationSeconds = Number(rawDuration);
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > MAX_SOAK_SECONDS) {
      throw new Error(`KYX_RECORDING_SOAK_SECONDS must be an integer from 30 to ${MAX_SOAK_SECONDS}`);
    }
    test.setTimeout(durationSeconds * 1_000 + 600_000);
    page.setDefaultNavigationTimeout(180_000);

    const report: {
      durationSeconds: number;
      sampleRate: number;
      channels: number;
      storage?: { quotaBytes: number | null; usageBytes: number | null; requiredBytes: number };
      checkpoints: Array<{
        elapsedSeconds: number;
        frameLagSeconds: number;
        validationDurationSeconds: number;
        totalFrames: number;
        chunkCount: number;
        peak: number;
        heapUsedBytes: number | null;
      }>;
      recoveryCardFound: boolean;
      postCrashCommittedChunks?: number;
      failure?: string;
    } = {
      durationSeconds,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      checkpoints: [],
      recoveryCardFound: false,
    };

    try {
      await installSyntheticMonoInput(page);
      // Use the blank template so the capture-soak baseline measures recording
      // and durable storage without a busy backing arrangement masking them.
      await openEmptyProject(page);
      await clickPanelAction(page, "ARR");
      await expect(page.locator(".arr-timeline")).toBeVisible();
      await page.getByLabel("Arm track for recording").selectOption({ index: 1 });
      await page.getByLabel("Capture input channel count").selectOption("1");

      const requiredBytes =
        Math.ceil(durationSeconds * SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT * 1.25) + STORAGE_HEADROOM_BYTES;
      const storage = await page.evaluate(async () => {
        const estimate = await navigator.storage?.estimate?.();
        return {
          quotaBytes: typeof estimate?.quota === "number" ? estimate.quota : null,
          usageBytes: typeof estimate?.usage === "number" ? estimate.usage : null,
        };
      });
      report.storage = { ...storage, requiredBytes };
      if (storage.quotaBytes === null || storage.usageBytes === null) {
        throw new Error(
          "Chromium did not provide a usable origin storage estimate; refusing to start a long recording soak",
        );
      }
      if (storage.quotaBytes - storage.usageBytes < requiredBytes) {
        throw new Error(
          `Insufficient estimated browser storage: need ${requiredBytes} bytes with headroom, have ${storage.quotaBytes - storage.usageBytes}`,
        );
      }

      // Read and inspect PCM in a lightweight same-origin page. Scanning
      // millions of samples on the recording page would block its AudioWorklet
      // message/acknowledgement loop and make the test create its own backlog.
      const inspectorPage = await openRecordingInspectorPage(page);
      await page.getByRole("button", { name: /REC$/ }).click();
      await expect(page.getByRole("button", { name: /STOP/ })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("meter", { name: "Audio input level" })).toHaveAttribute(
        "aria-valuenow",
        /^(?!0(?:\.0+)?$)/,
      );
      await expect(page.getByRole("status", { name: "Observed audio input capture format" })).toContainText("1 ch");

      const startedAt = Date.now();
      const checkpointIntervalMs = Math.min(60_000, Math.max(10_000, Math.floor((durationSeconds * 1_000) / 6)));
      let sessionId: string | null = null;
      let nextSequence = 0;
      let validatedFrames = 0;

      while (Date.now() - startedAt < durationSeconds * 1_000) {
        const remainingMs = durationSeconds * 1_000 - (Date.now() - startedAt);
        await page.waitForTimeout(Math.min(checkpointIntervalMs, remainingMs));
        const checkpointStartedAt = Date.now();
        const heapUsedBytes = await readHeapUsedBytes(page);
        const snapshot = await readAndValidateNewPcm(inspectorPage, sessionId, nextSequence, validatedFrames);
        const validationDurationSeconds = (Date.now() - checkpointStartedAt) / 1_000;

        sessionId ??= snapshot.sessionId;
        expect(snapshot.sessionId).toBe(sessionId);
        expect(snapshot.sampleRate).toBe(SAMPLE_RATE);
        expect(snapshot.channels).toBe(1);
        expect(snapshot.newChunks).toBeGreaterThan(0);
        expect(snapshot.peak).toBeGreaterThan(0.02);
        nextSequence = snapshot.chunkCount;
        validatedFrames = snapshot.totalFrames;
        const elapsedSeconds = (checkpointStartedAt - startedAt) / 1_000;
        const frameLagSeconds = elapsedSeconds - validatedFrames / SAMPLE_RATE;
        report.checkpoints.push({
          elapsedSeconds: Number(elapsedSeconds.toFixed(1)),
          frameLagSeconds: Number(frameLagSeconds.toFixed(2)),
          validationDurationSeconds: Number(validationDurationSeconds.toFixed(2)),
          totalFrames: snapshot.totalFrames,
          chunkCount: snapshot.chunkCount,
          peak: snapshot.peak,
          heapUsedBytes,
        });
        expect(frameLagSeconds, "durable PCM must not trail wall time by a full worklet queue").toBeLessThanOrEqual(
          MAX_CAPTURE_LAG_SECONDS,
        );
        console.log(
          `[recording-soak] ${elapsedSeconds.toFixed(0)} s · ${snapshot.chunkCount} blocks · ${snapshot.totalFrames} frames · lag ${frameLagSeconds.toFixed(2)} s · audit ${validationDurationSeconds.toFixed(2)} s · heap ${heapUsedBytes ?? "unavailable"}`,
        );
        await expect(page.locator(".arr-rec-error")).toHaveCount(0);
        await expect(page.getByRole("button", { name: /STOP/ })).toBeVisible();
      }

      if (!sessionId) throw new Error("No durable recording session was created");
      const finalSnapshotStartedAt = Date.now();
      const finalHeapUsedBytes = await readHeapUsedBytes(page);
      const finalSnapshot = await readAndValidateNewPcm(inspectorPage, sessionId, nextSequence, validatedFrames);
      const finalValidationDurationSeconds = (Date.now() - finalSnapshotStartedAt) / 1_000;
      sessionId = finalSnapshot.sessionId;
      nextSequence = finalSnapshot.chunkCount;
      validatedFrames = finalSnapshot.totalFrames;
      expect(finalSnapshot.sampleRate).toBe(SAMPLE_RATE);
      expect(finalSnapshot.channels).toBe(1);
      expect(finalSnapshot.chunkCount).toBeGreaterThanOrEqual(Math.floor(durationSeconds * 1.5));
      const finalElapsedSeconds = (finalSnapshotStartedAt - startedAt) / 1_000;
      const finalFrameLagSeconds = finalElapsedSeconds - finalSnapshot.totalFrames / SAMPLE_RATE;
      report.checkpoints.push({
        elapsedSeconds: Number(finalElapsedSeconds.toFixed(1)),
        frameLagSeconds: Number(finalFrameLagSeconds.toFixed(2)),
        validationDurationSeconds: Number(finalValidationDurationSeconds.toFixed(2)),
        totalFrames: finalSnapshot.totalFrames,
        chunkCount: finalSnapshot.chunkCount,
        peak: finalSnapshot.peak,
        heapUsedBytes: finalHeapUsedBytes,
      });
      expect(
        finalFrameLagSeconds,
        "final durable PCM must not trail wall time by a full worklet queue",
      ).toBeLessThanOrEqual(MAX_CAPTURE_LAG_SECONDS);
      await inspectorPage.close();

      // Leave the last committed session staged as if the renderer disappeared.
      // The recovery card is verified without materializing the entire take into RAM.
      const cdp = await page.context().newCDPSession(page);
      const rendererCrash = page.waitForEvent("crash", { timeout: 15_000 });
      void cdp.send("Page.crash").catch(() => undefined);
      await rendererCrash;

      const recoveredPage = await page.context().newPage();
      recoveredPage.setDefaultNavigationTimeout(180_000);
      await recoveredPage.goto("/");
      await expect(recoveredPage.locator(".project-browser")).toBeVisible({ timeout: 30_000 });
      const recoveryProject = await recoveredPage.evaluate(async (wantedId) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("pulse-forge");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const session = await new Promise<{ projectId?: string } | undefined>((resolve, reject) => {
            const request = db
              .transaction("recording-sessions", "readonly")
              .objectStore("recording-sessions")
              .get(wantedId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const projectId = session?.projectId;
          if (typeof projectId !== "string") throw new Error("The interrupted recording lost its project id");
          const project = await new Promise<{ name?: string } | undefined>((resolve, reject) => {
            const request = db.transaction("projects", "readonly").objectStore("projects").get(projectId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          if (typeof project?.name !== "string") throw new Error("The interrupted recording's project is missing");
          return { id: projectId, name: project.name };
        } finally {
          db.close();
        }
      }, sessionId);
      await recoveredPage.getByRole("button", { name: recoveryProject.name, exact: true }).click();
      await expect(recoveredPage.locator(".sequencer")).toBeVisible({ timeout: 30_000 });
      await ensureArrangementVisible(recoveredPage);
      const skipRecoveredTour = recoveredPage.getByRole("button", { name: "Skip tour" });
      if (await skipRecoveredTour.isVisible().catch(() => false)) await skipRecoveredTour.click();
      const recoveryRegion = recoveredPage.getByRole("region", { name: "Recoverable audio recordings" });
      await expect(recoveryRegion).toBeVisible({ timeout: 20_000 });
      await expect(recoveryRegion.getByText(/interrupted capture/i)).toBeVisible({ timeout: 20_000 });
      await expect(recoveryRegion.getByRole("button", { name: "RESTORE TO TIMELINE" })).toBeVisible();
      report.recoveryCardFound = true;

      const persistedAfterCrash = await recoveredPage.evaluate(
        async ({ wantedId, previousChunkCount, previousFrames }) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("pulse-forge");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            const transaction = db.transaction(["recording-sessions", "recording-chunks"], "readonly");
            const sessionRequest = transaction.objectStore("recording-sessions").get(wantedId);
            const chunksRequest = transaction
              .objectStore("recording-chunks")
              .getAll(IDBKeyRange.bound([wantedId, previousChunkCount], [wantedId, Number.MAX_SAFE_INTEGER]));
            const transactionDone = new Promise<void>((resolve, reject) => {
              transaction.oncomplete = () => resolve();
              transaction.onerror = () => reject(transaction.error);
              transaction.onabort = () =>
                reject(transaction.error ?? new Error("Could not verify post-crash recording data"));
            });
            const [session, newChunks] = await Promise.all([
              new Promise<any>((resolve, reject) => {
                sessionRequest.onsuccess = () => resolve(sessionRequest.result);
                sessionRequest.onerror = () => reject(sessionRequest.error);
              }),
              new Promise<Array<{ sequence: number; frames: number; channels: ArrayBuffer[] }>>((resolve, reject) => {
                chunksRequest.onsuccess = () => resolve(chunksRequest.result);
                chunksRequest.onerror = () => reject(chunksRequest.error);
              }),
            ]);
            await transactionDone;
            let addedFrames = 0;
            for (let index = 0; index < newChunks.length; index++) {
              const chunk = newChunks[index]!;
              if (chunk.sequence !== previousChunkCount + index || chunk.channels.length !== 1) {
                throw new Error(`Post-crash PCM continuity failed at block ${previousChunkCount + index}`);
              }
              const channel = chunk.channels[0];
              if (
                !(channel instanceof ArrayBuffer) ||
                channel.byteLength !== chunk.frames * Float32Array.BYTES_PER_ELEMENT
              ) {
                throw new Error(`Post-crash PCM block ${chunk.sequence} has an invalid payload`);
              }
              for (const sample of new Float32Array(channel)) {
                if (!Number.isFinite(sample))
                  throw new Error(`Post-crash PCM block ${chunk.sequence} has a non-finite sample`);
              }
              addedFrames += chunk.frames;
            }
            return session
              ? {
                  status: session.status,
                  totalFrames: session.totalFrames,
                  chunkCount: session.chunkCount,
                  storedChunkCount: previousChunkCount + newChunks.length,
                  newChunkCount: newChunks.length,
                  frameTotalsMatch: session.totalFrames === previousFrames + addedFrames,
                }
              : null;
          } finally {
            db.close();
          }
        },
        { wantedId: sessionId, previousChunkCount: nextSequence, previousFrames: validatedFrames },
      );
      if (!persistedAfterCrash) throw new Error("The staged take disappeared after the renderer crash");
      expect(persistedAfterCrash).toMatchObject({
        status: "recording",
        frameTotalsMatch: true,
      });
      expect(persistedAfterCrash.chunkCount).toBe(persistedAfterCrash.storedChunkCount);
      expect(persistedAfterCrash.chunkCount).toBeGreaterThanOrEqual(nextSequence);
      expect(persistedAfterCrash.totalFrames).toBeGreaterThanOrEqual(validatedFrames);
      report.postCrashCommittedChunks = persistedAfterCrash.newChunkCount;
    } catch (error) {
      report.failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await testInfo
        .attach("recording-soak-report.json", {
          body: JSON.stringify(report, null, 2),
          contentType: "application/json",
        })
        .catch(() => undefined);
    }
  });
});
