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

async function installSyntheticInput(page: Page, channels = 2, captureFrequencies: number[][] = []): Promise<void> {
  // Distinct tones exercise the real AudioWorklet/PCM path without opening a
  // physical microphone or audio interface. Chromium's MediaStreamDestination
  // is stereo-only, so the test seam supplies its synthetic channels at the
  // app's MediaStreamAudioSourceNode boundary.
  await page.addInitScript(
    ({ channelCount, frequencySets }: { channelCount: number; frequencySets: number[][] }) => {
      const syntheticStreams = new WeakMap<MediaStream, number>();
      const syntheticTracks = new WeakSet<MediaStreamTrack>();
      let nextCaptureIndex = 0;
      const nativeCreateMediaStreamSource = AudioContext.prototype.createMediaStreamSource;
      const nativeGetSettings = MediaStreamTrack.prototype.getSettings;
      AudioContext.prototype.createMediaStreamSource = function (stream: MediaStream): MediaStreamAudioSourceNode {
        const captureIndex = syntheticStreams.get(stream);
        if (captureIndex === undefined) return nativeCreateMediaStreamSource.call(this, stream);
        const merger = this.createChannelMerger(channelCount);
        const frequencies = frequencySets[captureIndex] ?? [220, 330, 440, 550, 660, 770, 880, 990];
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
          const captureIndex = nextCaptureIndex++;
          const streamContext = new AudioContext({ sampleRate: 48_000 });
          const stream = streamContext.createMediaStreamDestination().stream;
          syntheticStreams.set(stream, captureIndex);
          for (const track of stream.getAudioTracks()) syntheticTracks.add(track);
          return stream;
        },
      });
    },
    { channelCount: channels, frequencySets: captureFrequencies },
  );
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

  test("records alternate PCM takes, comps them with undo and preserves the export after reload", async ({ page }) => {
    test.setTimeout(180_000);
    await installSyntheticInput(page, 2, [
      [220, 330],
      [440, 550],
    ]);
    await openHouseTemplate(page);
    const initialContinueCard = page.locator(".pb-continue-card").first();
    if (await initialContinueCard.isVisible().catch(() => false)) await initialContinueCard.click();
    await expect(page.locator(".sequencer")).toBeVisible({ timeout: 30_000 });
    await ensureArrangementVisible(page);
    await page.getByLabel("Arm track for recording").selectOption({ index: 1 });
    const takeMode = page.getByLabel("Recording take mode");
    await takeMode.selectOption("new");

    const recordPass = async (): Promise<void> => {
      await page.getByRole("button", { name: /REC$/ }).click();
      await expect(page.getByRole("button", { name: /STOP/ })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("meter", { name: "Audio input level" })).toHaveAttribute(
        "aria-valuenow",
        /^(?!0(?:\.0+)?$)/,
      );
      await page.waitForTimeout(1_400);
      await page.getByRole("button", { name: /STOP/ }).click();
      await expect(page.getByRole("button", { name: /REC$/ })).toBeEnabled({ timeout: 15_000 });
    };

    // Two distinct synthetic performances traverse the real worklet capture,
    // durable PCM staging and take-group placement path; no hardware is opened.
    await recordPass();
    const groupId = await takeMode.inputValue();
    expect(groupId).not.toBe("new");
    await expect(takeMode.locator("option").filter({ hasText: "1 pass" })).toHaveCount(1);
    await recordPass();
    await expect(takeMode.locator("option").filter({ hasText: "2 passes" })).toHaveCount(1);
    await expect(page.locator(".arr-audio-clip")).toHaveCount(2);

    // Reload before editing so the source passes and their PCM are recovered
    // from IndexedDB, rather than relying on the still-live capture buffers.
    await page.waitForTimeout(1_500);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(page.locator(".project-browser")).toBeVisible({ timeout: 30_000 });
    const capturedProjectCard = page.locator(".pb-continue-card").first();
    if ((await capturedProjectCard.count()) > 0) await capturedProjectCard.click();
    else await page.locator(".pb-row button:has-text(OPEN)").first().click();
    await expect(page.locator(".sequencer")).toBeVisible({ timeout: 30_000 });
    await ensureArrangementVisible(page);
    await expect(page.locator(".arr-audio-clip")).toHaveCount(2, { timeout: 20_000 });
    // The two source passes are aligned, so the second clip visually covers
    // the first; select the topmost waveform to reach the take-group controls.
    await page.locator(".arr-audio-clip").last().click();
    await page.getByRole("button", { name: "Show audio take lanes" }).click();

    const takeOneLane = page.getByLabel("TAKE 1 timeline segments");
    const takeTwoLane = page.getByLabel("TAKE 2 timeline segments");
    await takeOneLane.scrollIntoViewIfNeeded();
    const takeOneSegment = takeOneLane.locator(".arr-audio-take-lane-segment").first();
    const takeOneBox = await takeOneSegment.boundingBox();
    const takeOneLaneBox = await takeOneLane.boundingBox();
    const takeOneBarWidth = await takeOneLane.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).backgroundSize),
    );
    if (!takeOneBox || !takeOneLaneBox || !Number.isFinite(takeOneBarWidth) || takeOneBarWidth <= 0) {
      throw new Error("The first persisted PCM take lane is not visible");
    }
    const compStartX = takeOneBox.x + 1;
    const seamX = takeOneBox.x + takeOneBox.width / 2;
    const seamTick = ((seamX - takeOneLaneBox.x) / takeOneBarWidth) * 1_920;
    const dragRange = async (lane: typeof takeOneLane, fromX: number, toX: number): Promise<void> => {
      const laneBox = await lane.boundingBox();
      if (!laneBox) throw new Error("The take-lane timeline is not visible");
      const y = laneBox.y + laneBox.height / 2;
      await page.mouse.move(fromX, y);
      await page.mouse.down();
      await page.mouse.move(toX, y, { steps: 5 });
      await page.mouse.up();
    };

    await page.getByLabel("Comp crossfade duration").selectOption("0");
    await dragRange(takeOneLane, compStartX, seamX);
    await expect(page.getByLabel("Selected comp range from TAKE 1")).toBeVisible();
    await expect(page.getByRole("button", { name: "Comp selected take-lane range" })).toBeVisible();
    await page.getByRole("button", { name: "Comp selected take-lane range" }).click();
    const compLane = page.getByLabel("COMP timeline segments");
    await expect(compLane).toBeVisible();
    const firstCompSegmentCount = await compLane.locator(".arr-audio-take-lane-segment").count();
    expect(firstCompSegmentCount).toBeGreaterThan(0);

    await page.getByLabel("Comp crossfade duration").selectOption("120");
    await takeTwoLane.scrollIntoViewIfNeeded();
    const takeTwoBox = await takeTwoLane.locator(".arr-audio-take-lane-segment").first().boundingBox();
    const takeTwoLaneBox = await takeTwoLane.boundingBox();
    const takeTwoBarWidth = await takeTwoLane.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).backgroundSize),
    );
    if (!takeTwoBox || !takeTwoLaneBox || !Number.isFinite(takeTwoBarWidth) || takeTwoBarWidth <= 0) {
      throw new Error("The second persisted PCM take lane is not visible");
    }
    const secondSeamX = takeTwoLaneBox.x + (seamTick / 1_920) * takeTwoBarWidth;
    const compEndX = takeTwoBox.x + takeTwoBox.width - 2;
    await dragRange(takeTwoLane, secondSeamX, compEndX);
    await expect(page.getByLabel("Selected comp range from TAKE 2")).toBeVisible();
    await expect(page.getByRole("button", { name: "Comp selected take-lane range" })).toBeVisible();
    await page.getByRole("button", { name: "Comp selected take-lane range" }).click();
    await expect(compLane).toBeVisible();
    const secondCompSegmentCount = await compLane.locator(".arr-audio-take-lane-segment").count();
    expect(secondCompSegmentCount).toBeGreaterThan(firstCompSegmentCount);

    // Exercise the actual project undo stack, then redo the comp before saving.
    await page.locator('button[aria-label="Undo"]').click();
    await expect(compLane.locator(".arr-audio-take-lane-segment")).toHaveCount(firstCompSegmentCount);
    await page.locator('button[aria-label="Undo"]').click();
    await expect(compLane).toHaveCount(0);
    await page.locator('button[aria-label="Redo"]').click();
    await expect(compLane.locator(".arr-audio-take-lane-segment")).toHaveCount(firstCompSegmentCount);
    await page.locator('button[aria-label="Redo"]').click();
    await expect(compLane.locator(".arr-audio-take-lane-segment")).toHaveCount(secondCompSegmentCount);

    const renderSavedTakeExport = async (): Promise<{
      groupId: string;
      compTakeId: string;
      activeTakeId: string;
      sourceTakeIds: string[];
      compSourceTakeIds: string[];
      bufferIds: string[];
      buffersRestored: boolean;
      sourcePcmSha256: string[];
      frames: number;
      peak: number;
      wavSha256: string;
    }> => {
      return page.evaluate(async (expectedGroupId: string) => {
        const load = (specifier: string) => import(/* @vite-ignore */ specifier);
        const [projectRepoModule, sampleModule, userRepoModule, rendererModule, wavModule] = await Promise.all([
          load("/src/persistence/ProjectRepository.ts"),
          load("/src/sample-library/factory.ts"),
          load("/src/persistence/UserSampleRepository.ts"),
          load("/src/rendering/renderer.ts"),
          load("/src/rendering/wav.ts"),
        ]);
        const { ProjectRepository } = projectRepoModule;
        const { SampleBank } = sampleModule;
        const { restoreUserSampleAudio } = userRepoModule;
        const { renderProject } = rendererModule;
        const { encodeWavAsync } = wavModule;
        const project = await new ProjectRepository().loadMostRecent();
        if (!project) throw new Error("The captured take project did not reopen from IndexedDB");
        const group = project.arrangement.takeGroups?.find(
          (candidate: { id: string }) => candidate.id === expectedGroupId,
        );
        if (!group?.compTakeId || group.activeTakeId !== group.compTakeId) {
          throw new Error("The saved take group has no active comp");
        }
        const groupClips = (project.arrangement.audioClips ?? []).filter(
          (clip: { takeGroupId?: string }) => clip.takeGroupId === expectedGroupId,
        );
        const sourceTakeIds = Array.from(
          new Set(
            groupClips
              .map((clip: { takeId?: string }) => clip.takeId)
              .filter((takeId: string | undefined) => takeId && takeId !== group.compTakeId),
          ),
        ) as string[];
        const compClips = groupClips.filter((clip: { takeId?: string }) => clip.takeId === group.compTakeId);
        const compSourceTakeIds = Array.from(
          new Set(compClips.map((clip: { compSourceTakeId?: string }) => clip.compSourceTakeId).filter(Boolean)),
        ) as string[];
        const bufferIds: string[] = Array.from(
          new Set<string>(groupClips.map((clip: { bufferId: string }) => clip.bufferId)),
        );
        const bank = new SampleBank();
        await restoreUserSampleAudio(bank);
        const sourcePcmSha256 = await Promise.all(
          bufferIds.map(async (bufferId: string) => {
            const buffer = bank.get(bufferId);
            if (!buffer) throw new Error(`Recorded PCM buffer ${bufferId} was not restored`);
            const channelDigests: string[] = [];
            for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
              const samples = buffer.getChannelData(channel);
              const sampleBytes = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength);
              const digest = await crypto.subtle.digest("SHA-256", sampleBytes);
              channelDigests.push(
                Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
              );
            }
            return channelDigests.join(":");
          }),
        );
        const renderScene = project.scenes[0];
        if (!renderScene) throw new Error("The captured-take project has no scene for an isolated render window");
        const renderLengthBars = Math.max(
          1,
          Math.ceil(
            Math.max(
              ...groupClips.map((clip: { startBar: number; lengthBars: number }) => clip.startBar + clip.lengthBars),
            ),
          ),
        );
        const renderDoc = {
          ...project,
          patterns: project.patterns.map(
            (pattern: { rows: Record<string, number[]>; notes: Record<string, unknown[]> }) => ({
              ...pattern,
              rows: {},
              notes: {},
            }),
          ),
          automation: [],
          sceneAutomation: [],
          arrangement: {
            ...project.arrangement,
            // An empty song arrangement intentionally falls back to the
            // active pattern. Keep one blank scene window instead so the
            // export witness contains only the recorded takes.
            clips: [
              {
                id: `e2e-export-${expectedGroupId}`,
                sceneId: renderScene.id,
                startBar: 0,
                lengthBars: renderLengthBars,
              },
            ],
            audioClips: groupClips,
            transitions: [],
          },
        };
        const rendered = await renderProject(renderDoc, bank, {
          mode: "song",
          sampleRate: 48_000,
          tailSeconds: 0,
        });
        const wav = await encodeWavAsync(rendered, 32);
        const digest = await crypto.subtle.digest("SHA-256", wav);
        const wavSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        let peak = 0;
        for (let channel = 0; channel < rendered.numberOfChannels; channel++) {
          for (const sample of rendered.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample));
        }
        return {
          groupId: group.id,
          compTakeId: group.compTakeId,
          activeTakeId: group.activeTakeId,
          sourceTakeIds,
          compSourceTakeIds,
          bufferIds,
          buffersRestored: bufferIds.every((bufferId: string) => bank.has(bufferId)),
          sourcePcmSha256,
          frames: rendered.length,
          peak,
          wavSha256,
        };
      }, groupId);
    };

    // Wait for the autosave to commit the redo state before measuring the
    // export. A second real app boot below then verifies durable reopen.
    await expect
      .poll(
        async () =>
          page.evaluate(async (expectedGroupId: string) => {
            const load = (specifier: string) => import(/* @vite-ignore */ specifier);
            const { ProjectRepository } = await load("/src/persistence/ProjectRepository.ts");
            const project = await new ProjectRepository().loadMostRecent();
            const group = project?.arrangement.takeGroups?.find(
              (candidate: { id: string }) => candidate.id === expectedGroupId,
            );
            if (!group?.compTakeId || group.activeTakeId !== group.compTakeId) return false;
            const clips = (project?.arrangement.audioClips ?? []).filter(
              (clip: { takeGroupId?: string }) => clip.takeGroupId === expectedGroupId,
            );
            const sourceTakeIds = Array.from(
              new Set(
                clips
                  .map((clip: { takeId?: string }) => clip.takeId)
                  .filter((takeId: string | undefined) => takeId && takeId !== group.compTakeId),
              ),
            ) as string[];
            const compSourceTakeIds = new Set(
              clips
                .filter((clip: { takeId?: string }) => clip.takeId === group.compTakeId)
                .map((clip: { compSourceTakeId?: string }) => clip.compSourceTakeId),
            );
            return sourceTakeIds.length === 2 && sourceTakeIds.every((takeId) => compSourceTakeIds.has(takeId));
          }, groupId),
        { timeout: 20_000, intervals: [250, 500, 1_000] },
      )
      .toBe(true);
    const beforeReloadExport = await renderSavedTakeExport();
    expect(beforeReloadExport.sourceTakeIds).toHaveLength(2);
    expect(beforeReloadExport.compSourceTakeIds).toEqual(expect.arrayContaining(beforeReloadExport.sourceTakeIds));
    expect(beforeReloadExport.bufferIds).toHaveLength(2);
    expect(beforeReloadExport.buffersRestored).toBe(true);
    expect(beforeReloadExport.frames).toBeGreaterThan(48_000);
    expect(beforeReloadExport.peak).toBeGreaterThan(0.01);

    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(page.locator(".project-browser")).toBeVisible({ timeout: 30_000 });
    const reopenedCard = page.locator(".pb-continue-card").first();
    if ((await reopenedCard.count()) > 0) await reopenedCard.click();
    else await page.locator(".pb-row button:has-text(OPEN)").first().click();
    await expect(page.locator(".sequencer")).toBeVisible({ timeout: 30_000 });
    await ensureArrangementVisible(page);
    await expect(page.locator(".arr-audio-clip.comp").first()).toBeVisible({ timeout: 20_000 });
    const afterReloadExport = await renderSavedTakeExport();
    expect(afterReloadExport).toMatchObject({
      groupId: beforeReloadExport.groupId,
      compTakeId: beforeReloadExport.compTakeId,
      activeTakeId: beforeReloadExport.activeTakeId,
      sourceTakeIds: beforeReloadExport.sourceTakeIds,
      compSourceTakeIds: beforeReloadExport.compSourceTakeIds,
      bufferIds: beforeReloadExport.bufferIds,
      buffersRestored: true,
      sourcePcmSha256: beforeReloadExport.sourcePcmSha256,
      frames: beforeReloadExport.frames,
      peak: beforeReloadExport.peak,
      wavSha256: beforeReloadExport.wavSha256,
    });
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
