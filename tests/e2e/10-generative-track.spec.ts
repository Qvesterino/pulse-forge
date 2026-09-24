import { test, expect, type Page } from "playwright/test";
import { WebSocketServer } from "ws";
import { openHouseTemplate } from "./_helpers";
import {
  encodeMrt2AudioPacket,
  serializeMrt2ControlMessage,
  type Mrt2ControlMessage,
} from "../../src/generative/providers/mrt2/protocol";
import type { AudioClip } from "../../src/project-model/types";

async function openAudioStudioOrSkip(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const hasWebAudio = await page.evaluate(
    () => typeof AudioContext !== "undefined" && typeof OfflineAudioContext !== "undefined",
  );
  if (!hasWebAudio) {
    test.skip(true, "This browser build lacks AudioContext/OfflineAudioContext; audio-engine E2E requires Web Audio.");
  }
  await openHouseTemplate(page);
}

test.describe("10 — MRT2 generative track", () => {
  test("adds the track and exposes the safe localhost companion surface", async ({ page }) => {
    await openAudioStudioOrSkip(page);

    await page.locator('select[aria-label="Add track"]').selectOption("generative");

    const generativeTab = page.getByRole("tab", { name: /Generative 1 \(Generative track\)/ });
    await expect(generativeTab).toBeVisible();
    await generativeTab.click();

    await expect(page.getByRole("heading", { name: "MRT2 GENERATIVE" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "LOCAL MRT2 COMPANION" })).toBeVisible();
    await expect(page.getByText(/LIVE · UNAVAILABLE/)).toBeVisible();
    await expect(page.getByText(/Provider does not support realtime playback/)).toBeVisible();
    await expect(page.locator('input[placeholder="ws://127.0.0.1:8765"]')).toHaveValue("ws://127.0.0.1:8765");

    // The first browser session has no native MRT2 host. The UI must expose
    // that state without attempting to connect or leaking a remote endpoint.
    await expect(page.getByText("mrt2 / mrt2_small")).toBeVisible();
  });

  test("plays, seeks and stops through a localhost companion and the live AudioWorklet", async ({ page }) => {
    await openAudioStudioOrSkip(page);
    const companion = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      companion.once("listening", resolve);
      companion.once("error", reject);
    });
    const address = companion.address();
    if (!address || typeof address === "string") throw new Error("MRT2 test companion did not bind a TCP port");
    const endpoint = `ws://127.0.0.1:${address.port}`;
    const receivedTypes: string[] = [];
    const conditioningStartTicks: number[] = [];
    const makePcmPacket = (sequence: number): ArrayBuffer =>
      encodeMrt2AudioPacket({
        kind: "output",
        sequence,
        sampleRate: 48_000,
        channels: 2,
        frames: 512,
        data: new Float32Array(1024).fill(0.08),
      });
    let streamSequence = 1;
    let providerRunning = false;
    let streamTimer: ReturnType<typeof setInterval> | undefined;
    let streamStartTimer: ReturnType<typeof setTimeout> | undefined;

    companion.on("connection", (socket) => {
      socket.on("message", (raw, isBinary) => {
        if (isBinary) return;
        let message: Mrt2ControlMessage;
        try {
          message = JSON.parse(raw.toString()) as Mrt2ControlMessage;
        } catch {
          return;
        }
        receivedTypes.push(message.type);
        const send = (response: Mrt2ControlMessage): void => socket.send(serializeMrt2ControlMessage(response));
        switch (message.type) {
          case "hello":
            send({
              version: 1,
              type: "hello.ok",
              requestId: message.requestId,
              providerId: "mrt2-e2e",
              modelIds: ["mrt2_small"],
              outputSampleRates: [48_000],
              outputChannels: [2],
              supportsRealtime: true,
              supportsCapture: false,
              supportsTextStyle: true,
              supportsNoteConditioning: true,
              supportsAudioStyle: false,
              supportsDrumsMode: true,
              supportsSeed: false,
              maxCaptureSeconds: 0,
            });
            break;
          case "session.create":
            send({ version: 1, type: "session.ok", requestId: message.requestId, sessionId: "e2e-session" });
            break;
          case "input.update":
            conditioningStartTicks.push(message.input.startTick);
            send({
              version: 1,
              type: "status",
              requestId: message.requestId,
              sessionId: message.sessionId,
              state: providerRunning ? "running" : "ready",
            });
            break;
          case "session.start":
            providerRunning = true;
            send({
              version: 1,
              type: "status",
              requestId: message.requestId,
              sessionId: message.sessionId,
              state: "running",
            });
            socket.send(makePcmPacket(0));
            streamStartTimer = setTimeout(() => {
              streamTimer = setInterval(() => {
                if (socket.readyState === 1) socket.send(makePcmPacket(streamSequence++));
              }, 8);
            }, 250);
            break;
          case "session.stop":
          case "session.close":
            providerRunning = false;
            if (streamStartTimer) clearTimeout(streamStartTimer);
            if (streamTimer) clearInterval(streamTimer);
            streamStartTimer = undefined;
            streamTimer = undefined;
            send({
              version: 1,
              type: "status",
              requestId: message.requestId,
              sessionId: message.sessionId,
              state: "ready",
            });
            break;
          default:
            break;
        }
      });
    });

    try {
      await page.locator('select[aria-label="Add track"]').selectOption("generative");
      const generativeTab = page.getByRole("tab", { name: /Generative 1 \(Generative track\)/ });
      await expect(generativeTab).toBeVisible();
      await generativeTab.click();

      await page.locator('input[placeholder="ws://127.0.0.1:8765"]').fill(endpoint);
      await page.getByRole("button", { name: "USE LOCAL COMPANION" }).click();
      await expect(page.getByText("COMPANION CONFIGURED — PLAY TO CONNECT")).toBeVisible();
      await page.locator('button[title="Play / Pause (Space)"]').click();
      await expect(page.getByText(/LIVE · BUFFERING/u)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/LIVE · RUNNING/u)).toBeVisible({ timeout: 20_000 });
      expect(receivedTypes).toEqual(
        expect.arrayContaining(["hello", "session.create", "input.update", "session.start"]),
      );

      await page.locator('button[title="Play / Pause (Space)"]').click();
      await expect(page.getByText(/LIVE · READY/u)).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => receivedTypes.filter((type) => type === "session.stop").length).toBeGreaterThan(0);
      await page.locator('button[title="Play / Pause (Space)"]').click();
      await expect(page.getByText(/LIVE · RUNNING/u)).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => receivedTypes.filter((type) => type === "session.start").length).toBeGreaterThan(1);

      const ruler = page.getByRole("row", { name: /Step ruler — click to seek/u });
      const rulerBounds = await ruler.boundingBox();
      expect(rulerBounds).not.toBeNull();
      await ruler.click({ position: { x: rulerBounds!.width - 10, y: 10 } });
      await expect
        .poll(() => conditioningStartTicks[conditioningStartTicks.length - 1] ?? 0, { timeout: 10_000 })
        .toBeGreaterThan(1_400);

      await page.locator('button[title="Stop"]').click();
      await expect(page.getByText(/LIVE · READY/u)).toBeVisible({ timeout: 10_000 });
      expect(receivedTypes).toContain("session.stop");
    } finally {
      if (streamStartTimer) clearTimeout(streamStartTimer);
      if (streamTimer) clearInterval(streamTimer);
      for (const client of companion.clients) client.close();
      await new Promise<void>((resolve) => companion.close(() => resolve()));
    }
  });

  test("captures from a capture-only companion without attempting live start", async ({ page }) => {
    await openAudioStudioOrSkip(page);
    const companion = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      companion.once("listening", resolve);
      companion.once("error", reject);
    });
    const address = companion.address();
    if (!address || typeof address === "string") throw new Error("MRT2 capture companion did not bind a TCP port");
    const endpoint = `ws://127.0.0.1:${address.port}`;
    const receivedTypes: string[] = [];
    let captureSocket: import("ws").WebSocket | undefined;

    companion.on("connection", (socket) => {
      captureSocket = socket;
      socket.on("message", (raw, isBinary) => {
        if (isBinary) return;
        let message: Mrt2ControlMessage;
        try {
          message = JSON.parse(raw.toString()) as Mrt2ControlMessage;
        } catch {
          return;
        }
        receivedTypes.push(message.type);
        const send = (response: Mrt2ControlMessage): void => socket.send(serializeMrt2ControlMessage(response));
        switch (message.type) {
          case "hello":
            send({
              version: 1,
              type: "hello.ok",
              requestId: message.requestId,
              providerId: "mrt2-capture-e2e",
              modelIds: ["mrt2_small"],
              outputSampleRates: [48_000],
              outputChannels: [2],
              supportsRealtime: false,
              supportsCapture: true,
              supportsTextStyle: true,
              supportsNoteConditioning: true,
              supportsAudioStyle: false,
              supportsDrumsMode: true,
              supportsSeed: false,
              maxCaptureSeconds: 120,
              runtimeProfile: {
                backendId: "mrt2-capture-e2e",
                executionMode: "capture",
                runtimeVersion: "e2e",
                warning: "capture-only test companion",
              },
            });
            break;
          case "session.create":
            send({ version: 1, type: "session.ok", requestId: message.requestId, sessionId: "capture-session" });
            break;
          case "input.update":
            send({
              version: 1,
              type: "status",
              requestId: message.requestId,
              sessionId: message.sessionId,
              state: "ready",
            });
            break;
          case "capture.start": {
            const frames = Math.round(message.durationSec * 48_000);
            const packetFrames = 48_000;
            for (let offset = 0, sequence = 0; offset < frames; offset += packetFrames, sequence++) {
              const currentFrames = Math.min(packetFrames, frames - offset);
              const pcm = new Float32Array(currentFrames * 2).fill(0.03);
              socket.send(
                Buffer.from(
                  encodeMrt2AudioPacket({
                    kind: "output",
                    sequence,
                    sampleRate: 48_000,
                    channels: 2,
                    frames: currentFrames,
                    data: pcm,
                  }),
                ),
              );
            }
            send({
              version: 1,
              type: "capture.ok",
              requestId: message.requestId,
              sessionId: message.sessionId,
              frames,
              durationSec: frames / 48_000,
              inputHash: "e2e-capture-input",
            });
            break;
          }
          case "session.close":
            send({
              version: 1,
              type: "status",
              requestId: message.requestId,
              sessionId: message.sessionId,
              state: "idle",
            });
            break;
          default:
            break;
        }
      });
    });

    try {
      await page.locator('select[aria-label="Add track"]').selectOption("generative");
      const generativeTab = page.getByRole("tab", { name: /Generative 1 \(Generative track\)/ });
      await expect(generativeTab).toBeVisible();
      await generativeTab.click();
      await page.locator('input[placeholder="ws://127.0.0.1:8765"]').fill(endpoint);
      await page.getByRole("button", { name: "USE LOCAL COMPANION" }).click();
      await expect(page.getByText("COMPANION CONFIGURED — PLAY TO CONNECT")).toBeVisible();
      const captureButton = page.getByRole("button", { name: "CAPTURE 4 BARS" });
      await expect(captureButton).toBeEnabled();
      await captureButton.click();
      await expect.poll(() => receivedTypes.includes("capture.start"), { timeout: 20_000 }).toBe(true);
      await expect.poll(() => receivedTypes.includes("session.start")).toBe(false);
      await expect(page.getByText("CAPTURE FAILED — check provider status")).not.toBeVisible();
    } finally {
      captureSocket?.close();
      for (const client of companion.clients) client.close();
      await new Promise<void>((resolve) => companion.close(() => resolve()));
    }
  });

  test("renders a persisted generative clip after reload and WAV round-trip", async ({ page }) => {
    await openAudioStudioOrSkip(page);
    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [
        templateModule,
        commandModule,
        schemaModule,
        sampleModule,
        captureModule,
        repositoryModule,
        decodeModule,
        rendererModule,
        engineModule,
        wavModule,
        workletLoaderModule,
      ] = await Promise.all([
        load("/src/project-model/templates.ts"),
        load("/src/commands/commands.ts"),
        load("/src/project-model/schema.ts"),
        load("/src/sample-library/factory.ts"),
        load("/src/generative/capture.ts"),
        load("/src/persistence/UserSampleRepository.ts"),
        load("/src/services/audio-decode.ts"),
        load("/src/rendering/renderer.ts"),
        load("/src/audio-engine/AudioEngine.ts"),
        load("/src/rendering/wav.ts"),
        load("/src/audio-worklets/loader.ts"),
      ]);
      const { createProjectFromTemplate } = templateModule;
      const { createGenerativeTrack, addEffect, setMasterConfig } = commandModule;
      const { createGroupTrackModel } = schemaModule;
      const { SampleBank } = sampleModule;
      const { persistGeneratedAudioAsClip } = captureModule;
      const { UserSampleRepository } = repositoryModule;
      const { decodeAudioData } = decodeModule;
      const { renderProject } = rendererModule;
      const { AudioEngine } = engineModule;
      const { encodeWav } = wavModule;
      const { ensureWorkletsForDoc } = workletLoaderModule;
      const sampleRate = 44_100;
      const channels = 2;
      const frames = sampleRate;
      const data = new Float32Array(frames * channels);
      for (let frame = 0; frame < frames; frame++) {
        const sample = 0.3 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
        data[frame * channels] = sample;
        data[frame * channels + 1] = sample;
      }
      const assetId = `user.mrt2-render-e2e-${crypto.randomUUID()}`;
      const repository = new UserSampleRepository();
      const base = createProjectFromTemplate("empty");
      const withTrack = createGenerativeTrack(base).execute(base);
      const track = withTrack.tracks.find((candidate: { kind: string }) => candidate.kind === "generative");
      if (!track) throw new Error("generative track fixture missing");
      const group = { ...createGroupTrackModel("Generated Group"), pan: 1 };
      const withGroup = {
        ...withTrack,
        tracks: [
          ...withTrack.tracks.map((candidate: { id: string }) =>
            candidate.id === track.id ? { ...candidate, groupId: group.id } : candidate,
          ),
          group,
        ],
      };
      const projectWithFx = {
        ...withGroup,
        // Keep only the one-bar pattern window; the audio clip itself defines
        // the two-bar render extent because it starts at bar 1.
        arrangement: { ...withGroup.arrangement, clips: [] },
      };
      const project = addEffect(projectWithFx, track.id, "reverb").execute(projectWithFx);
      const generated = {
        sampleRate,
        channels,
        frames,
        durationSec: frames / sampleRate,
        data,
        providerId: "mrt2",
        modelId: "mrt2_small",
        inputHash: "e2e-input-hash",
        provenance: { prompt: "dark atmospheric accompaniment", providerVersion: "e2e" },
      };

      try {
        const persisted = await persistGeneratedAudioAsClip(repository, project, generated, "MRT2 render E2E", {
          assetId,
          placement: {
            trackId: track.id,
            startBar: 1,
            lengthBars: 1,
            patch: { gain: 1, fadeIn: 0.2, fadeOut: 0.2, loop: true },
          },
        });
        const committed = persisted.command.execute(project);

        // A fresh repository instance models project/sample restoration after
        // reload; the renderer only receives the decoded durable asset.
        const reloadedRepository = new UserSampleRepository();
        const storedBytes = await reloadedRepository.loadAudio(assetId);
        if (
          !storedBytes ||
          (typeof storedBytes === "object" && !ArrayBuffer.isView(storedBytes) && !(storedBytes instanceof ArrayBuffer))
        ) {
          throw new Error("generated WAV asset was not restored from IndexedDB");
        }
        const storedArrayBuffer = storedBytes instanceof ArrayBuffer ? storedBytes : await storedBytes.arrayBuffer();
        const metadata = (await reloadedRepository.list()).find((asset: { id: string }) => asset.id === assetId);
        if (!metadata?.generated || metadata.generated.providerId !== "mrt2") {
          throw new Error("generated provenance metadata did not survive reload");
        }

        const bank = new SampleBank();
        const decodedAsset = await decodeAudioData(storedArrayBuffer.slice(0), sampleRate);
        bank.add(assetId, decodedAsset);
        const clip = committed.arrangement.audioClips?.[0];
        if (!clip) throw new Error("generated AudioClip command did not commit a clip");
        const scheduledAudioClips: Array<{ startBar: number; lengthBars: number; when: number; durationSec?: number }> =
          [];
        const originalTriggerAudioClip = AudioEngine.prototype.triggerAudioClip;
        AudioEngine.prototype.triggerAudioClip = function (
          this: typeof AudioEngine.prototype,
          clip: AudioClip,
          when: number,
          durationSec?: number,
        ) {
          scheduledAudioClips.push({ startBar: clip.startBar, lengthBars: clip.lengthBars, when, durationSec });
          return originalTriggerAudioClip.call(this, clip, when, durationSec);
        };
        let rendered: AudioBuffer;
        try {
          rendered = await renderProject(committed, bank, {
            mode: "song",
            sampleRate,
            tailSeconds: 0,
          });
        } finally {
          AudioEngine.prototype.triggerAudioClip = originalTriggerAudioClip;
        }
        const encoded = encodeWav(rendered, 32);
        const decoded = await decodeAudioData(encoded.slice(0), sampleRate);
        const peak = (buffer: AudioBuffer, from: number, to: number, channel = 0): number => {
          let maximum = 0;
          const samples = buffer.getChannelData(channel);
          for (let frame = from; frame < Math.min(to, samples.length); frame++) {
            maximum = Math.max(maximum, Math.abs(samples[frame] ?? 0));
          }
          return maximum;
        };
        const rms = (buffer: AudioBuffer, from: number, to: number, channel: number): number => {
          const samples = buffer.getChannelData(channel);
          const end = Math.min(to, samples.length);
          let sumSquares = 0;
          for (let frame = from; frame < end; frame++) sumSquares += (samples[frame] ?? 0) ** 2;
          return end > from ? Math.sqrt(sumSquares / (end - from)) : 0;
        };
        const onset = (buffer: AudioBuffer) => {
          const target = 2 * sampleRate; // bar 1 at 120 BPM
          const channel = buffer.numberOfChannels > 1 ? 1 : 0;
          const before = peak(buffer, 0, target, channel);
          const samples = buffer.getChannelData(channel);
          let onsetFrame = -1;
          for (let frame = target; frame < Math.min(samples.length, target + sampleRate); frame++) {
            if (Math.abs(samples[frame] ?? 0) > 1e-5) {
              onsetFrame = frame;
              break;
            }
          }
          const peakAfterStart = peak(buffer, target, target + sampleRate, channel);
          const midRms = rms(buffer, target + sampleRate * 0.5, target + sampleRate * 0.7, channel);
          const fadeInRms = rms(buffer, target + sampleRate * 0.01, target + sampleRate * 0.05, channel);
          const fadeOutRms = rms(buffer, target + sampleRate * 1.98, target + sampleRate * 1.999, channel);
          return { before, onsetFrame, peakAfterStart, fadeInRms, midRms, fadeOutRms };
        };
        const renderClipVariant = (patch: Partial<AudioClip>): Promise<AudioBuffer> =>
          renderProject(
            {
              ...committed,
              arrangement: {
                ...committed.arrangement,
                audioClips: [{ ...clip, ...patch }],
              },
            },
            bank,
            { mode: "song", sampleRate, tailSeconds: 0 },
          );
        const [reverseRender, stretchRender] = await Promise.all([
          renderClipVariant({
            lengthBars: 0.5,
            trimEnd: 0.5,
            reverse: true,
            loop: false,
            fadeIn: 0,
            fadeOut: 0,
          }),
          renderClipVariant({
            stretchMode: "stretch",
            stretchRate: 1.5,
            reverse: false,
            loop: false,
            fadeIn: 0,
            fadeOut: 0,
          }),
        ]);
        const parityClip = { ...clip, fadeIn: 0, fadeOut: 0 };
        const parityProject = {
          ...committed,
          arrangement: { ...committed.arrangement, audioClips: [parityClip] },
        };
        const capturedParityRender = await renderProject(parityProject, bank, {
          mode: "song",
          sampleRate,
          tailSeconds: 0,
        });
        const liveContext = new OfflineAudioContext(2, capturedParityRender.length, sampleRate);
        await ensureWorkletsForDoc(parityProject, liveContext);
        const liveEngine = new AudioEngine();
        liveEngine.attachBank(bank);
        liveEngine.useContext(liveContext);
        liveEngine.setProject(parityProject);
        const liveSource = liveContext.createBufferSource();
        liveSource.buffer = decodedAsset;
        liveSource.loop = parityClip.loop;
        liveEngine.attachGenerativeSource(track.id, liveSource);
        liveSource.start(2);
        const liveSourceRender = await liveContext.startRendering();
        liveEngine.detachGenerativeSource(track.id, liveSource);
        liveEngine.detachBank();
        const relativeRmsError = (reference: AudioBuffer, actual: AudioBuffer, fromFrame: number): number => {
          let errorSquares = 0;
          let referenceSquares = 0;
          for (let channel = 0; channel < Math.min(reference.numberOfChannels, actual.numberOfChannels); channel++) {
            const expected = reference.getChannelData(channel);
            const received = actual.getChannelData(channel);
            for (let frame = fromFrame; frame < Math.min(expected.length, received.length); frame++) {
              const expectedSample = expected[frame] ?? 0;
              const difference = expectedSample - (received[frame] ?? 0);
              errorSquares += difference * difference;
              referenceSquares += expectedSample * expectedSample;
            }
          }
          return referenceSquares > 0 ? Math.sqrt(errorSquares / referenceSquares) : Number.POSITIVE_INFINITY;
        };
        const reducedMasterProject = setMasterConfig(committed, { masterGain: 0.5 }).execute(committed);
        const reducedMasterRender = await renderProject(reducedMasterProject, bank, {
          mode: "song",
          sampleRate,
          tailSeconds: 0,
        });
        const bypassedMasterRender = await renderProject(committed, bank, {
          mode: "song",
          sampleRate,
          tailSeconds: 0,
          masterProcessing: false,
        });
        const stereoPeak = (buffer: AudioBuffer): number =>
          Math.max(peak(buffer, 0, buffer.length, 0), peak(buffer, 0, buffer.length, 1));
        const parityStart = 2 * sampleRate;
        return {
          assetId,
          metadata: metadata.generated,
          clipStartBar: committed.arrangement.audioClips?.[0]?.startBar ?? -1,
          generativeTrackEffects: committed.tracks.find((candidate: { id: string }) => candidate.id === track.id)
            ?.effects,
          scheduledAudioClips,
          renderedStereoPeak: {
            left: peak(rendered, 0, rendered.length, 0),
            right: peak(rendered, 0, rendered.length, 1),
          },
          masterVariants: {
            reducedGainPeak: stereoPeak(reducedMasterRender),
            bypassedPeak: stereoPeak(bypassedMasterRender),
            allFinite: [reducedMasterRender, bypassedMasterRender].every((buffer) =>
              Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)).every(
                (samples) => samples.every(Number.isFinite),
              ),
            ),
          },
          liveCaptureParityRms: relativeRmsError(capturedParityRender, liveSourceRender, parityStart),
          parityReferencePeak: peak(capturedParityRender, parityStart, capturedParityRender.length, 1),
          parityLivePeak: peak(liveSourceRender, parityStart, liveSourceRender.length, 1),
          parityReferenceRms: rms(capturedParityRender, parityStart, capturedParityRender.length, 1),
          parityLiveRms: rms(liveSourceRender, parityStart, liveSourceRender.length, 1),
          reversePeak: peak(reverseRender, 2 * sampleRate, reverseRender.length, 1),
          stretchPeak: peak(stretchRender, 2 * sampleRate, stretchRender.length, 1),
          rendered: onset(rendered),
          reloadedWav: onset(decoded),
        };
      } finally {
        await repository.remove(assetId);
      }
    });

    expect(report.metadata).toMatchObject({ providerId: "mrt2", modelId: "mrt2_small", inputHash: "e2e-input-hash" });
    expect(report.clipStartBar).toBe(1);
    expect(report.generativeTrackEffects).toHaveLength(1);
    expect(report.rendered.before).toBe(0);
    expect(report.rendered.onsetFrame).toBeGreaterThanOrEqual(2 * 44_100);
    expect(report.rendered.onsetFrame).toBeLessThan(2 * 44_100 + 1_024);
    expect(report.rendered.peakAfterStart).toBeGreaterThan(0.05);
    expect(report.rendered.fadeInRms).toBeLessThan(report.rendered.midRms * 0.35);
    expect(report.rendered.fadeOutRms).toBeLessThan(report.rendered.midRms * 0.35);
    expect(report.renderedStereoPeak.left).toBeLessThan(report.renderedStereoPeak.right * 0.15);
    expect(report.masterVariants.reducedGainPeak).toBeGreaterThan(report.renderedStereoPeak.right * 0.4);
    expect(report.masterVariants.reducedGainPeak).toBeLessThan(report.renderedStereoPeak.right * 0.6);
    expect(report.masterVariants.bypassedPeak).toBeGreaterThan(0.05);
    expect(report.masterVariants.allFinite).toBe(true);
    expect(report.liveCaptureParityRms, JSON.stringify(report)).toBeLessThan(0.01);
    expect(report.reversePeak).toBeGreaterThan(0.05);
    expect(report.stretchPeak).toBeGreaterThan(0.05);
    expect(report.reloadedWav.onsetFrame).toBe(report.rendered.onsetFrame);
    expect(report.reloadedWav.peakAfterStart).toBeGreaterThan(0.05);
    expect(report.scheduledAudioClips).toEqual([{ startBar: 1, lengthBars: 1, when: 2, durationSec: 2 }]);
  });
});
