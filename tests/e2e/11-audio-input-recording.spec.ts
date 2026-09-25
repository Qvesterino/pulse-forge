import { test, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { clickPanelAction, openHouseTemplate } from "./_helpers";

async function installSyntheticStereoInput(page: Page): Promise<void> {
  // Distinct tones let the test detect a mono fold-down or swapped/missing
  // channel. This never accesses a physical microphone or audio interface.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const context = new AudioContext({ sampleRate: 48_000 });
        const destination = context.createMediaStreamDestination();
        const merger = context.createChannelMerger(2);
        const left = context.createOscillator();
        const right = context.createOscillator();
        const leftGain = context.createGain();
        const rightGain = context.createGain();
        left.type = "sine";
        left.frequency.value = 220;
        right.type = "sine";
        right.frequency.value = 550;
        leftGain.gain.value = 0.2;
        rightGain.gain.value = 0.2;
        left.connect(leftGain).connect(merger, 0, 0);
        right.connect(rightGain).connect(merger, 0, 1);
        merger.connect(destination);
        left.start();
        right.start();
        await context.resume();
        return destination.stream;
      },
    });
  });
}

test.describe("11 — audio-input recording", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "WebKit on Windows has no Web Audio media stack");

  test("captures distinct stereo PCM, splits it across tracks and restores both routes after reload", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await installSyntheticStereoInput(page);
    await openHouseTemplate(page);
    await clickPanelAction(page, "ARR");
    await expect(page.locator(".arr-timeline")).toBeVisible();
    await page.getByLabel("Arm track for recording").selectOption({ index: 1 });
    await page.getByLabel("Captured channel 2 destination").selectOption({ index: 1 });
    await page.getByRole("button", { name: /REC$/ }).click();
    await expect(page.getByRole("button", { name: /STOP/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("meter", { name: "Audio input level" })).toHaveAttribute(
      "aria-valuenow",
      /^(?!0(?:\.0+)?$)/,
    );

    // Ensure more than one durable half-second PCM block is committed.
    await page.waitForTimeout(1_400);
    await page.getByRole("button", { name: /STOP/ }).click();
    const captureReport = page.getByRole("status", { name: "Observed audio input capture format" });
    await expect(captureReport).toContainText("2 ch");
    await expect(page.locator(".arr-audio-clip")).toHaveCount(2);

    const storedTake = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("pulse-forge");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const audio = await new Promise<any>((resolve, reject) => {
        const request = db.transaction("user-sample-audio", "readonly").objectStore("user-sample-audio").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const entry = audio.find((item: any) => item.data?.kind === "pcm-f32-planar-v1");
      if (!entry) throw new Error("No durable PCM recording reference was saved");
      const reference = entry.data;
      const chunks = await new Promise<any[]>((resolve, reject) => {
        const store = db.transaction("recording-chunks", "readonly").objectStore("recording-chunks");
        const request = store.index("by-session").getAll(reference.recordingId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      chunks.sort((a, b) => a.sequence - b.sequence);
      const frames = chunks.reduce((sum, chunk) => sum + chunk.frames, 0);
      const first = chunks[0];
      if (!first || first.channels.length !== 2) throw new Error("Expected a two-channel PCM block");
      const left = new Float32Array(first.channels[0]);
      const right = new Float32Array(first.channels[1]);
      let largestChannelDifference = 0;
      for (let index = 0; index < Math.min(left.length, right.length); index++) {
        largestChannelDifference = Math.max(largestChannelDifference, Math.abs(left[index] - right[index]));
      }
      return {
        channels: reference.channels,
        sampleRate: reference.sampleRate,
        frames,
        chunkCount: chunks.length,
        declaredFrames: reference.frames,
        declaredChunks: reference.chunkCount,
        largestChannelDifference,
      };
    });

    expect(storedTake).toMatchObject({ channels: 2, sampleRate: 48_000 });
    expect(storedTake.frames).toBeGreaterThan(48_000);
    expect(storedTake.frames).toBe(storedTake.declaredFrames);
    expect(storedTake.chunkCount).toBe(storedTake.declaredChunks);
    expect(storedTake.largestChannelDifference).toBeGreaterThan(0.05);

    // Project persistence must retain the ordinary audio clip and its user
    // sample reference, both mono source-channel routes and one shared asset.
    await page.waitForTimeout(1_500);
    const routedClips = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("pulse-forge");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const projects = await new Promise<any[]>((resolve, reject) => {
        const request = db.transaction("projects", "readonly").objectStore("projects").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      const project = projects.find((candidate) =>
        candidate?.arrangement?.audioClips?.some((clip: any) => clip.bufferId.startsWith("user.recording-")),
      );
      return project?.arrangement.audioClips
        .filter((clip: any) => clip.bufferId.startsWith("user.recording-"))
        .map((clip: any) => ({ trackId: clip.trackId, sourceChannel: clip.sourceChannel, bufferId: clip.bufferId }));
    });
    expect(routedClips).toHaveLength(2);
    expect(routedClips?.map((clip: any) => clip.sourceChannel).sort()).toEqual([0, 1]);
    expect(new Set(routedClips?.map((clip: any) => clip.trackId)).size).toBe(2);
    expect(new Set(routedClips?.map((clip: any) => clip.bufferId)).size).toBe(1);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(page.locator(".project-browser")).toBeVisible({ timeout: 30_000 });
    const continueCard = page.locator(".pb-continue-card").first();
    if ((await continueCard.count()) > 0) await continueCard.click();
    else await page.locator(".pb-row button:has-text(OPEN)").first().click();
    await expect(page.locator(".sequencer")).toBeVisible({ timeout: 30_000 });
    if (
      !(await page
        .locator(".arr-timeline")
        .isVisible()
        .catch(() => false))
    ) {
      await clickPanelAction(page, "ARR");
    }
    await expect(page.locator(".arr-timeline")).toBeVisible();
    await expect(page.locator(".arr-audio-clip")).toHaveCount(2, { timeout: 20_000 });
  });

  test("restores a stale multichannel session to both saved channel destinations", async ({ page }) => {
    await openHouseTemplate(page);
    const seeded = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("pulse-forge");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const projects = await new Promise<any[]>((resolve, reject) => {
        const request = db.transaction("projects", "readonly").objectStore("projects").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const project = projects.find((candidate) => candidate?.tracks?.some((track: any) => track.kind !== "group"));
      const tracks = project?.tracks.filter((candidate: any) => candidate.kind !== "group");
      const track = tracks?.[0];
      const secondTrack = tracks?.find((candidate: any) => candidate.id !== track?.id);
      if (!project || !track || !secondTrack)
        throw new Error("The open test project has fewer than two persisted audio tracks");

      const sampleRate = 48_000;
      const left = new Float32Array(sampleRate);
      const right = new Float32Array(sampleRate);
      for (let frame = 0; frame < sampleRate; frame++) {
        left[frame] = 0.2 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate);
        right[frame] = 0.2 * Math.sin((2 * Math.PI * 550 * frame) / sampleRate);
      }
      const id = "recording.e2e-interrupted";
      const session = {
        id,
        ownerId: "e2e-crashed-renderer",
        projectId: project.id,
        trackId: track.id,
        trackName: track.name,
        channelDestinations: [
          { channelIndex: 0, trackId: track.id, trackName: track.name },
          { channelIndex: 1, trackId: secondTrack.id, trackName: secondTrack.name },
        ],
        placeOnTimeline: true,
        startBar: 0.25,
        bpm: project.bpm,
        recordingInputOffsetMs: 0,
        leadInSec: 0,
        sampleRate,
        channels: 2,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: Date.now() - 60_000,
        status: "recording",
        totalFrames: sampleRate,
        chunkCount: 1,
      };
      const chunk = {
        sessionId: id,
        sequence: 0,
        frames: sampleRate,
        channels: [left.buffer, right.buffer],
      };
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(["recording-sessions", "recording-chunks"], "readwrite");
        transaction.objectStore("recording-sessions").put(session);
        transaction.objectStore("recording-chunks").put(chunk);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("Could not seed interrupted PCM"));
      });
      db.close();
      return { projectId: project.id, trackId: track.id, secondTrackId: secondTrack.id };
    });
    expect(seeded.projectId).toBeTruthy();
    expect(seeded.trackId).toBeTruthy();

    // Reopening gives the session a new owner ID. Its old owner and stale
    // timestamp model the durable IndexedDB state left by an interrupted tab;
    // this verifies the recovery UI/materializer without claiming to simulate
    // a browser-process crash.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(page.locator(".project-browser")).toBeVisible({ timeout: 30_000 });
    const continueCard = page.locator(".pb-continue-card").first();
    if ((await continueCard.count()) > 0) await continueCard.click();
    else await page.locator(".pb-row button:has-text(OPEN)").first().click();
    await expect(page.locator(".sequencer")).toBeVisible({ timeout: 30_000 });
    if (
      !(await page
        .locator(".arr-timeline")
        .isVisible()
        .catch(() => false))
    )
      await clickPanelAction(page, "ARR");
    await expect(page.getByRole("region", { name: "Recoverable audio recordings" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/interrupted capture/i)).toBeVisible();
    await page.getByRole("button", { name: "RESTORE TO TIMELINE" }).click();
    await expect(page.locator(".arr-audio-clip")).toHaveCount(2, { timeout: 20_000 });

    const restoredAsset = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("pulse-forge");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const assets = await new Promise<any[]>((resolve, reject) => {
        const request = db.transaction("user-samples", "readonly").objectStore("user-samples").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return assets.find((asset) => asset.name.startsWith("RECOVERED ")) ?? null;
    });
    expect(restoredAsset).toMatchObject({ channels: 2, sampleRate: 48_000, duration: 1 });
  });
});
