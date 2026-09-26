import { test, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { clickPanelAction, openHouseTemplate } from "./_helpers";

async function ensureArrangementVisible(page: Page): Promise<void> {
  const timeline = page.locator(".arr-timeline");
  if (await timeline.isVisible().catch(() => false)) return;

  // ArrangementPanel is lazy-loaded. After a project reload the timeline may
  // not have mounted yet even though ARR is already the active dock panel; a
  // blind toggle in that window closes it before the chunk can render.
  const directToggle = page.locator('.topbar button[aria-label="Toggle arrangement and scenes"]').first();
  if (await directToggle.isVisible().catch(() => false)) {
    if ((await directToggle.getAttribute("aria-pressed")) !== "true") await directToggle.click();
  } else {
    await clickPanelAction(page, "ARR");
  }
  await expect(timeline).toBeVisible({ timeout: 15_000 });
}

async function installSyntheticInput(page: Page, channels = 2): Promise<void> {
  // Distinct tones exercise the real AudioWorklet/PCM path without opening a
  // physical microphone or audio interface. Chromium's MediaStreamDestination
  // is stereo-only, so the test seam supplies its synthetic channels at the
  // app's MediaStreamAudioSourceNode boundary.
  await page.addInitScript((channelCount: number) => {
    const syntheticStreams = new WeakSet<MediaStream>();
    const syntheticTracks = new WeakSet<MediaStreamTrack>();
    const nativeCreateMediaStreamSource = AudioContext.prototype.createMediaStreamSource;
    const nativeGetSettings = MediaStreamTrack.prototype.getSettings;
    AudioContext.prototype.createMediaStreamSource = function (stream: MediaStream): MediaStreamAudioSourceNode {
      if (!syntheticStreams.has(stream)) return nativeCreateMediaStreamSource.call(this, stream);
      const merger = this.createChannelMerger(channelCount);
      const frequencies = [220, 330, 440, 550, 660, 770, 880, 990];
      for (let channel = 0; channel < channelCount; channel++) {
        const oscillator = this.createOscillator();
        const gain = this.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequencies[channel] ?? 220 + channel * 110;
        gain.gain.value = 0.2;
        oscillator.connect(gain).connect(merger, 0, channel);
        oscillator.start();
      }
      return merger as unknown as MediaStreamAudioSourceNode;
    };
    MediaStreamTrack.prototype.getSettings = function (): MediaTrackSettings {
      const settings = nativeGetSettings.call(this);
      return syntheticTracks.has(this) ? { ...settings, channelCount } : settings;
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const streamContext = new AudioContext({ sampleRate: 48_000 });
        const stream = streamContext.createMediaStreamDestination().stream;
        syntheticStreams.add(stream);
        for (const track of stream.getAudioTracks()) syntheticTracks.add(track);
        return stream;
      },
    });
  }, channels);
}

test.describe("11 — audio-input recording", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "WebKit on Windows has no Web Audio media stack");

  test("renders selected source channels as isolated audio in the offline export", async ({ page }) => {
    test.setTimeout(120_000);
    await openHouseTemplate(page);
    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templateModule, commandModule, sampleModule, rendererModule, engineModule, workletModule] =
        await Promise.all([
          load("/src/project-model/templates.ts"),
          load("/src/commands/commands.ts"),
          load("/src/sample-library/factory.ts"),
          load("/src/rendering/renderer.ts"),
          load("/src/audio-engine/AudioEngine.ts"),
          load("/src/audio-worklets/loader.ts"),
        ]);
      const { createProjectFromTemplate } = templateModule;
      const { addAudioClip } = commandModule;
      const { SampleBank } = sampleModule;
      const { renderProject } = rendererModule;
      const { AudioEngine } = engineModule;
      const { ensureWorkletsForDoc } = workletModule;
      const sampleRate = 44_100;
      const frames = sampleRate;
      const source = new OfflineAudioContext(2, frames, sampleRate).createBuffer(2, frames, sampleRate);
      for (let frame = 0; frame < frames; frame++) {
        source.getChannelData(0)[frame] = 0.25 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate);
        source.getChannelData(1)[frame] = 0.25 * Math.sin((2 * Math.PI * 550 * frame) / sampleRate);
      }
      const assetId = `user.channel-routing-e2e-${crypto.randomUUID()}`;
      const bank = new SampleBank();
      bank.add(assetId, source);
      const base = createProjectFromTemplate("empty");
      const track = base.tracks.find((candidate: { kind: string }) => candidate.kind !== "group");
      if (!track) throw new Error("empty-project audio track fixture missing");
      const projectWithoutSceneClips = {
        ...base,
        arrangement: { ...base.arrangement, clips: [], audioClips: [] },
      };
      const leftClipProject = addAudioClip(projectWithoutSceneClips, track.id, assetId, 0, 1, {
        sourceChannel: 0,
        fadeIn: 0,
        fadeOut: 0,
      }).execute(projectWithoutSceneClips);
      const routedProject = addAudioClip(leftClipProject, track.id, assetId, 1, 1, {
        sourceChannel: 1,
        fadeIn: 0,
        fadeOut: 0,
      }).execute(leftClipProject);
      const rendered = await renderProject(routedProject, bank, {
        mode: "song",
        sampleRate,
        tailSeconds: 0,
      });
      const liveContext = new OfflineAudioContext(2, rendered.length, sampleRate);
      await ensureWorkletsForDoc(routedProject, liveContext);
      const liveEngine = new AudioEngine();
      liveEngine.attachBank(bank);
      liveEngine.useContext(liveContext);
      liveEngine.setProject(routedProject);
      for (const clip of routedProject.arrangement.audioClips) {
        liveEngine.triggerAudioClip(clip, clip.startBar * 2, 2);
      }
      const liveRendered = await liveContext.startRendering();
      liveEngine.detachBank();
      const amplitudeAt = (buffer: AudioBuffer, frequency: number, startSec: number): number => {
        const start = Math.round(startSec * sampleRate);
        const count = Math.round(sampleRate / 2);
        let real = 0;
        let imaginary = 0;
        for (let index = 0; index < count; index++) {
          const sample = buffer.getChannelData(0)[start + index] ?? 0;
          const phase = (2 * Math.PI * frequency * index) / sampleRate;
          real += sample * Math.cos(phase);
          imaginary -= sample * Math.sin(phase);
        }
        return (2 * Math.hypot(real, imaginary)) / count;
      };
      const leftRoute = {
        expected: amplitudeAt(rendered, 220, 0.2),
        rejected: amplitudeAt(rendered, 550, 0.2),
      };
      const rightRoute = {
        expected: amplitudeAt(rendered, 550, 2.2),
        rejected: amplitudeAt(rendered, 220, 2.2),
      };
      const liveLeftRoute = {
        expected: amplitudeAt(liveRendered, 220, 0.2),
        rejected: amplitudeAt(liveRendered, 550, 0.2),
      };
      const liveRightRoute = {
        expected: amplitudeAt(liveRendered, 550, 2.2),
        rejected: amplitudeAt(liveRendered, 220, 2.2),
      };
      return { leftRoute, rightRoute, liveLeftRoute, liveRightRoute };
    });

    expect(report.leftRoute.expected).toBeGreaterThan(0.05);
    expect(report.leftRoute.rejected).toBeLessThan(report.leftRoute.expected * 0.05);
    expect(report.rightRoute.expected).toBeGreaterThan(0.05);
    expect(report.rightRoute.rejected).toBeLessThan(report.rightRoute.expected * 0.05);
    expect(report.liveLeftRoute.expected).toBeGreaterThan(0.05);
    expect(report.liveLeftRoute.rejected).toBeLessThan(report.liveLeftRoute.expected * 0.05);
    expect(report.liveRightRoute.expected).toBeGreaterThan(0.05);
    expect(report.liveRightRoute.rejected).toBeLessThan(report.liveRightRoute.expected * 0.05);
    expect(report.liveLeftRoute.expected).toBeCloseTo(report.leftRoute.expected, 2);
    expect(report.liveRightRoute.expected).toBeCloseTo(report.rightRoute.expected, 2);
  });

  test("captures distinct stereo PCM, splits it across tracks and restores both routes after reload", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await installSyntheticInput(page);
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
    await ensureArrangementVisible(page);
    await expect(page.locator(".arr-audio-clip")).toHaveCount(2, { timeout: 20_000 });
  });

  test("captures four requested channels and routes each to a separate track", async ({ page }) => {
    test.setTimeout(120_000);
    await installSyntheticInput(page, 4);
    await openHouseTemplate(page);
    await clickPanelAction(page, "ARR");
    await expect(page.locator(".arr-timeline")).toBeVisible();

    await page.getByLabel("Add track").selectOption("sampler");
    const armTrack = page.getByLabel("Arm track for recording");
    const trackIds = await armTrack.locator("option").evaluateAll((options) =>
      options
        .map((option) => (option as HTMLOptionElement).value)
        .filter(Boolean)
        .slice(0, 4),
    );
    expect(trackIds).toHaveLength(4);
    await armTrack.selectOption(trackIds[0]!);
    await page.getByLabel("Capture input channel count").selectOption("4");
    await page.getByLabel("Captured channel 2 destination").selectOption(trackIds[1]!);
    await page.getByText("INPUT ROUTING · 4 CHANNELS").click();
    await page.getByLabel("Captured channel 3 destination").selectOption(trackIds[2]!);
    await page.getByLabel("Captured channel 4 destination").selectOption(trackIds[3]!);

    await page.getByRole("button", { name: /REC$/ }).click();
    await expect(page.getByRole("button", { name: /STOP/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("meter", { name: "Audio input level" })).toHaveAttribute(
      "aria-valuenow",
      /^(?!0(?:\.0+)?$)/,
    );
    await page.waitForTimeout(1_200);
    await page.getByRole("button", { name: /STOP/ }).click();
    await expect(page.getByRole("status", { name: "Observed audio input capture format" })).toContainText("4 ch");
    await expect(page.locator(".arr-audio-clip")).toHaveCount(4);

    const capture = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("pulse-forge");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const entries = await new Promise<any[]>((resolve, reject) => {
        const request = db.transaction("user-sample-audio", "readonly").objectStore("user-sample-audio").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const reference = entries.find((entry) => entry.data?.kind === "pcm-f32-planar-v1")?.data;
      if (!reference) throw new Error("No durable multichannel PCM recording was saved");
      const chunks = await new Promise<any[]>((resolve, reject) => {
        const request = db
          .transaction("recording-chunks", "readonly")
          .objectStore("recording-chunks")
          .index("by-session")
          .getAll(reference.recordingId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      chunks.sort((left, right) => left.sequence - right.sequence);
      const first = chunks[0];
      if (!first || first.channels.length !== 4) throw new Error("Expected four independent PCM channels");
      const channelPcm = first.channels.map((buffer: ArrayBuffer) => new Float32Array(buffer));
      const rms = channelPcm.map((samples: Float32Array) => {
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        return Math.sqrt(energy / Math.max(1, samples.length));
      });
      const adjacentDifferences = channelPcm.slice(1).map((samples: Float32Array, index: number) => {
        const previous = channelPcm[index]!;
        let difference = 0;
        const count = Math.min(samples.length, previous.length);
        for (let frame = 0; frame < count; frame++)
          difference = Math.max(difference, Math.abs(samples[frame]! - previous[frame]!));
        return difference;
      });
      return { channels: reference.channels, rms, adjacentDifferences };
    });
    expect(capture.channels).toBe(4);
    expect(capture.rms).toHaveLength(4);
    expect(capture.rms.every((level: number) => level > 0.02)).toBe(true);
    expect(capture.adjacentDifferences.every((difference: number) => difference > 0.05)).toBe(true);
  });

  test("punches four captured channels into separate tracks at the same exact locator range", async ({ page }) => {
    test.setTimeout(120_000);
    await installSyntheticInput(page, 4);
    await openHouseTemplate(page);
    await clickPanelAction(page, "ARR");
    await expect(page.locator(".arr-timeline")).toBeVisible();

    // Set a one-bar punch range from beat 3 of bar 1 through beat 3 of bar 2.
    // IN/OUT are transport ticks; LOOP must remain disabled for one-shot punch.
    const loopButton = page.getByRole("button", { name: "Toggle loop region" });
    await loopButton.click();
    await page.getByRole("spinbutton", { name: "OUT", exact: true }).press("Enter");
    await page.getByRole("textbox", { name: "OUT value" }).fill("2880");
    await page.getByRole("textbox", { name: "OUT value" }).press("Enter");
    await page.getByRole("spinbutton", { name: "IN", exact: true }).press("Enter");
    await page.getByRole("textbox", { name: "IN value" }).fill("960");
    await page.getByRole("textbox", { name: "IN value" }).press("Enter");
    await loopButton.click();
    await expect(loopButton).toHaveAttribute("aria-pressed", "false");

    await page.getByLabel("Add track").selectOption("sampler");
    const armTrack = page.getByLabel("Arm track for recording");
    const trackIds = await armTrack.locator("option").evaluateAll((options) =>
      options
        .map((option) => (option as HTMLOptionElement).value)
        .filter(Boolean)
        .slice(0, 4),
    );
    expect(trackIds).toHaveLength(4);
    await armTrack.selectOption(trackIds[0]!);
    await page.getByLabel("Capture input channel count").selectOption("4");
    await page.getByLabel("Captured channel 2 destination").selectOption(trackIds[1]!);
    await page.getByText("INPUT ROUTING · 4 CHANNELS").click();
    await page.getByLabel("Captured channel 3 destination").selectOption(trackIds[2]!);
    await page.getByLabel("Captured channel 4 destination").selectOption(trackIds[3]!);
    await page.getByRole("button", { name: "Arm punch-in and punch-out recording" }).click();
    await page.getByRole("button", { name: /REC$/ }).click();
    await expect(page.getByRole("button", { name: /STOP/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".arr-audio-clip")).toHaveCount(4, { timeout: 15_000 });

    // The in-memory project updates before the debounced IndexedDB row; wait
    // for that durable snapshot before checking the placed locator window.
    await page.waitForTimeout(1_500);
    const clips = await page.evaluate(async () => {
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
        .map((clip: any) => ({
          trackId: clip.trackId,
          sourceChannel: clip.sourceChannel,
          bufferId: clip.bufferId,
          startBar: clip.startBar,
          lengthBars: clip.lengthBars,
          offsetSec: clip.offsetSec,
        }));
    });

    expect(clips).toHaveLength(4);
    expect(clips?.map((clip: any) => clip.sourceChannel).sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(clips?.map((clip: any) => clip.trackId))).toEqual(new Set(trackIds));
    expect(new Set(clips?.map((clip: any) => clip.bufferId)).size).toBe(1);
    for (const clip of clips ?? []) {
      expect(clip.startBar).toBeCloseTo(0.5, 2);
      expect(clip.lengthBars).toBeCloseTo(1, 2);
      expect(clip.offsetSec).toBeGreaterThanOrEqual(0);
    }
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
    await ensureArrangementVisible(page);
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

  test("recovers committed PCM after the Chromium renderer crashes during capture", async ({ page }) => {
    test.setTimeout(120_000);
    await installSyntheticInput(page);
    await openHouseTemplate(page);
    await clickPanelAction(page, "ARR");
    await expect(page.locator(".arr-timeline")).toBeVisible();
    await page.getByLabel("Arm track for recording").selectOption({ index: 1 });
    await page.getByLabel("Captured channel 2 destination").selectOption({ index: 1 });
    await page.getByRole("button", { name: /REC$/ }).click();
    await expect(page.getByRole("button", { name: /STOP/ })).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open("pulse-forge");
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            const sessions = await new Promise<any[]>((resolve, reject) => {
              const request = db
                .transaction("recording-sessions", "readonly")
                .objectStore("recording-sessions")
                .getAll();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            db.close();
            return Math.max(
              0,
              ...sessions.filter((session) => session.status === "recording").map((session) => session.chunkCount),
            );
          }),
        { timeout: 20_000, intervals: [250, 500, 1_000] },
      )
      .toBeGreaterThanOrEqual(2);

    const durableTake = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("pulse-forge");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const sessions = await new Promise<any[]>((resolve, reject) => {
        const request = db.transaction("recording-sessions", "readonly").objectStore("recording-sessions").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const session = sessions
        .filter((candidate) => candidate.status === "recording" && candidate.chunkCount >= 2)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (!session) throw new Error("No active take with multiple committed PCM blocks was found");
      const chunks = await new Promise<any[]>((resolve, reject) => {
        const request = db
          .transaction("recording-chunks", "readonly")
          .objectStore("recording-chunks")
          .index("by-session")
          .getAll(session.id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      const firstChannel = chunks[0]?.channels[0];
      if (!(firstChannel instanceof ArrayBuffer)) throw new Error("The first committed PCM channel was missing");
      const samples = new Float32Array(firstChannel);
      const peak = samples.reduce((value, sample) => Math.max(value, Math.abs(sample)), 0);
      return {
        id: session.id,
        ownerId: session.ownerId,
        trackName: session.trackName,
        sampleRate: session.sampleRate,
        channels: session.channels,
        totalFrames: session.totalFrames,
        chunkCount: session.chunkCount,
        storedChunkCount: chunks.length,
        peak,
      };
    });
    expect(durableTake).toMatchObject({ sampleRate: 48_000, channels: 2 });
    expect(durableTake.storedChunkCount).toBe(durableTake.chunkCount);
    expect(durableTake.totalFrames).toBeGreaterThan(0);
    expect(durableTake.peak).toBeGreaterThan(0.01);

    const cdp = await page.context().newCDPSession(page);
    const rendererCrash = page.waitForEvent("crash", { timeout: 15_000 });
    // Page.crash drops the renderer's CDP target before the command response
    // can be delivered, so observe the page event instead of awaiting send().
    void cdp.send("Page.crash").catch(() => undefined);
    await rendererCrash;

    const recoveredPage = await page.context().newPage();
    await recoveredPage.goto("/");
    await expect(recoveredPage.locator(".project-browser")).toBeVisible({ timeout: 30_000 });
    const continueCard = recoveredPage.locator(".pb-continue-card").first();
    if ((await continueCard.count()) > 0) await continueCard.click();
    else await recoveredPage.locator(".pb-row button:has-text(OPEN)").first().click();
    await expect(recoveredPage.locator(".sequencer")).toBeVisible({ timeout: 30_000 });
    await ensureArrangementVisible(recoveredPage);
    const recoveryRegion = recoveredPage.getByRole("region", { name: "Recoverable audio recordings" });
    await expect(recoveryRegion).toBeVisible({ timeout: 20_000 });
    await expect(recoveryRegion.getByText(/interrupted capture/i)).toBeVisible({ timeout: 20_000 });
    await recoveryRegion.getByRole("button", { name: "RESTORE TO TIMELINE" }).click();
    await expect(recoveredPage.locator(".arr-audio-clip")).toHaveCount(2, { timeout: 20_000 });

    const restoredTake = await recoveredPage.evaluate(
      async ({ sessionId, trackName }: { sessionId: string; trackName: string }) => {
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
        const sessions = await new Promise<any[]>((resolve, reject) => {
          const request = db.transaction("recording-sessions", "readonly").objectStore("recording-sessions").getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        const asset = assets.find((candidate) => candidate.name === `RECOVERED ${trackName}`);
        return {
          asset: asset ? { channels: asset.channels, sampleRate: asset.sampleRate, duration: asset.duration } : null,
          stagingSessionRetained: sessions.some((session) => session.id === sessionId),
        };
      },
      { sessionId: durableTake.id, trackName: durableTake.trackName },
    );
    expect(restoredTake.asset).toMatchObject({ channels: 2, sampleRate: 48_000 });
    expect(restoredTake.asset?.duration).toBeGreaterThan(0);
    expect(restoredTake.stagingSessionRetained).toBe(false);
  });
});
