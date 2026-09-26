import { expect, test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

test.describe("13 — rendered audio consolidation", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "WebKit on Windows has no Web Audio media stack");

  test("renders, persists, reloads and exports selected clips without changing their sound", async ({ page }) => {
    test.setTimeout(120_000);
    await openHouseTemplate(page);

    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [
        templateModule,
        commandModule,
        sampleModule,
        rendererModule,
        bounceModule,
        wavModule,
        userRepoModule,
        projectRepoModule,
      ] = await Promise.all([
        load("/src/project-model/templates.ts"),
        load("/src/commands/commands.ts"),
        load("/src/sample-library/factory.ts"),
        load("/src/rendering/renderer.ts"),
        load("/src/rendering/bounce.ts"),
        load("/src/rendering/wav.ts"),
        load("/src/persistence/UserSampleRepository.ts"),
        load("/src/persistence/ProjectRepository.ts"),
      ]);
      const { createProjectFromTemplate } = templateModule;
      const { addAudioClip, consolidateAudioClips } = commandModule;
      const { SampleBank } = sampleModule;
      const { renderProject } = rendererModule;
      const { buildAudioClipConsolidationDoc } = bounceModule;
      const { encodeWavAsync } = wavModule;
      const { UserSampleRepository, restoreUserSampleAudio } = userRepoModule;
      const { ProjectRepository } = projectRepoModule;
      const sampleRate = 44_100;
      const makeTone = (frequency: number): AudioBuffer => {
        const buffer = new OfflineAudioContext(1, sampleRate, sampleRate).createBuffer(1, sampleRate, sampleRate);
        const samples = buffer.getChannelData(0);
        for (let frame = 0; frame < samples.length; frame++) {
          samples[frame] = 0.2 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
        }
        return buffer;
      };
      const firstAssetId = `e2e.consolidate-first-${crypto.randomUUID()}`;
      const secondAssetId = `e2e.consolidate-second-${crypto.randomUUID()}`;
      const consolidatedId = `user.consolidated-e2e-${crypto.randomUUID()}`;
      const projectId = `e2e-consolidation-${crypto.randomUUID()}`;
      const bank = new SampleBank();
      bank.add(firstAssetId, makeTone(220));
      bank.add(secondAssetId, makeTone(550));
      const template = createProjectFromTemplate("empty");
      const track = template.tracks.find((candidate: { kind: string }) => candidate.kind !== "group");
      if (!track) throw new Error("empty-project audio track fixture missing");
      const base = {
        ...template,
        id: projectId,
        name: "Consolidation E2E",
        arrangement: { ...template.arrangement, clips: [], audioClips: [] },
      };
      const first = addAudioClip(base, track.id, firstAssetId, 0, 0.5, { fadeIn: 0, fadeOut: 0 }).execute(base);
      const sourceProject = addAudioClip(first, track.id, secondAssetId, 0.5, 0.5, {
        fadeIn: 0,
        fadeOut: 0,
      }).execute(first);
      const selectedIds = sourceProject.arrangement.audioClips.map((clip: { id: string }) => clip.id);
      const plan = buildAudioClipConsolidationDoc(sourceProject, selectedIds);
      const consolidatedBuffer = await renderProject(plan.project, bank, {
        mode: "song",
        sampleRate,
        tailSeconds: 0,
        masterProcessing: false,
      });
      const userSamples = new UserSampleRepository();
      const projects = new ProjectRepository();

      try {
        const audioBytes = await encodeWavAsync(consolidatedBuffer, 32);
        await userSamples.save(
          {
            id: consolidatedId,
            name: "Consolidated E2E",
            fileName: `${consolidatedId}.wav`,
            category: "Custom",
            duration: consolidatedBuffer.duration,
            sampleRate: consolidatedBuffer.sampleRate,
            channels: consolidatedBuffer.numberOfChannels,
            createdAt: new Date().toISOString(),
          },
          audioBytes,
        );
        const committed = consolidateAudioClips(sourceProject, selectedIds, consolidatedId).execute(sourceProject);
        await projects.save(committed);

        // Simulate app reload: use fresh repositories and restore the WAV bytes
        // from IndexedDB into a fresh SampleBank before loading the project.
        const restoredBank = new SampleBank();
        await restoreUserSampleAudio(restoredBank);
        const reopenedProject = await new ProjectRepository().load(projectId);
        if (!reopenedProject) throw new Error("saved project did not reopen");
        const reloadedAudio = await new UserSampleRepository().loadAudio(consolidatedId);
        const before = await renderProject(sourceProject, bank, { mode: "song", sampleRate, tailSeconds: 0 });
        const after = await renderProject(reopenedProject, restoredBank, {
          mode: "song",
          sampleRate,
          tailSeconds: 0,
        });
        const beforeDry = await renderProject(sourceProject, bank, {
          mode: "song",
          sampleRate,
          tailSeconds: 0,
          masterProcessing: false,
        });
        const afterDry = await renderProject(reopenedProject, restoredBank, {
          mode: "song",
          sampleRate,
          tailSeconds: 0,
          masterProcessing: false,
        });
        const amplitudeAt = (buffer: AudioBuffer, frequency: number, startSec: number): number => {
          const samples = buffer.getChannelData(0);
          const start = Math.round(startSec * sampleRate);
          const count = Math.round(sampleRate * 0.25);
          let real = 0;
          let imaginary = 0;
          for (let index = 0; index < count; index++) {
            const sample = samples[start + index] ?? 0;
            const phase = (2 * Math.PI * frequency * index) / sampleRate;
            real += sample * Math.cos(phase);
            imaginary -= sample * Math.sin(phase);
          }
          return (2 * Math.hypot(real, imaginary)) / count;
        };
        const beforeChannels: number[][] = Array.from({ length: before.numberOfChannels }, (_, channel): number[] =>
          Array.from(before.getChannelData(channel)),
        );
        const afterChannels: number[][] = Array.from({ length: after.numberOfChannels }, (_, channel): number[] =>
          Array.from(after.getChannelData(channel)),
        );
        let maxAbsoluteError = 0;
        let maxErrorFrame = -1;
        let maxErrorChannel = -1;
        let maxErrorPair: [number, number] = [0, 0];
        let rmsError = 0;
        let comparedSamples = 0;
        let dryMaxAbsoluteError = 0;
        let rawVsRestoredError = 0;
        const beforeDrySamples = beforeDry.getChannelData(0);
        const afterDrySamples = afterDry.getChannelData(0);
        const persistedBuffer = restoredBank.get(consolidatedId)!;
        const rawSamples = consolidatedBuffer.getChannelData(0);
        const persistedSamples = persistedBuffer.getChannelData(0);
        for (let frame = 0; frame < Math.min(rawSamples.length, persistedSamples.length); frame++) {
          rawVsRestoredError = Math.max(
            rawVsRestoredError,
            Math.abs((rawSamples[frame] ?? 0) - (persistedSamples[frame] ?? 0)),
          );
        }
        for (let frame = 0; frame < Math.min(beforeDry.length, afterDry.length); frame++) {
          dryMaxAbsoluteError = Math.max(
            dryMaxAbsoluteError,
            Math.abs((beforeDrySamples[frame] ?? 0) - (afterDrySamples[frame] ?? 0)),
          );
        }
        let bestLag = 0;
        let bestCorrelation = -Infinity;
        for (let lag = -256; lag <= 256; lag++) {
          let correlation = 0;
          for (let frame = 0; frame < sampleRate / 4; frame++) {
            correlation += (beforeDrySamples[frame] ?? 0) * (afterDrySamples[frame + lag] ?? 0);
          }
          if (correlation > bestCorrelation) {
            bestCorrelation = correlation;
            bestLag = lag;
          }
        }
        for (let channel = 0; channel < Math.min(beforeChannels.length, afterChannels.length); channel++) {
          const original = beforeChannels[channel] ?? [];
          const result = afterChannels[channel] ?? [];
          for (let frame = 0; frame < Math.min(original.length, result.length); frame++) {
            const difference = Math.abs((original[frame] ?? 0) - (result[frame] ?? 0));
            if (difference > maxAbsoluteError) {
              maxAbsoluteError = difference;
              maxErrorFrame = frame;
              maxErrorChannel = channel;
              maxErrorPair = [original[frame] ?? 0, result[frame] ?? 0];
            }
            rmsError += difference * difference;
            comparedSamples++;
          }
        }
        return {
          sourceClipCount: sourceProject.arrangement.audioClips.length,
          reopenedClipCount: reopenedProject.arrangement.audioClips.length,
          reopenedBufferId: reopenedProject.arrangement.audioClips[0]?.bufferId,
          restoredBuffer: restoredBank.has(consolidatedId),
          audioPersisted: reloadedAudio instanceof ArrayBuffer || reloadedAudio instanceof Blob,
          beforeLength: before.length,
          afterLength: after.length,
          before220: amplitudeAt(before, 220, 0.25),
          after220: amplitudeAt(after, 220, 0.25),
          before550: amplitudeAt(before, 550, 1.25),
          after550: amplitudeAt(after, 550, 1.25),
          maxAbsoluteError,
          dryMaxAbsoluteError,
          rawVsRestoredError,
          bestLag,
          trackEffects: track.effects.map((effect: { type: string }) => effect.type),
          groupIds:
            sourceProject.tracks.find((candidate: { id: string }) => candidate.id === track.id)?.groupId ?? null,
          maxErrorAtSeconds: maxErrorFrame / sampleRate,
          maxErrorChannel,
          maxErrorPair,
          samplesAroundMax: {
            before: Array.from(before.getChannelData(maxErrorChannel).slice(maxErrorFrame - 4, maxErrorFrame + 5)),
            after: Array.from(after.getChannelData(maxErrorChannel).slice(maxErrorFrame - 4, maxErrorFrame + 5)),
            consolidated: Array.from(
              consolidatedBuffer.getChannelData(maxErrorChannel).slice(maxErrorFrame - 4, maxErrorFrame + 5),
            ),
            restoredAsset: Array.from(
              (restoredBank.get(consolidatedId)?.getChannelData(maxErrorChannel) ?? new Float32Array()).slice(
                maxErrorFrame - 4,
                maxErrorFrame + 5,
              ),
            ),
          },
          rmsError: comparedSamples > 0 ? Math.sqrt(rmsError / comparedSamples) : Number.POSITIVE_INFINITY,
        };
      } finally {
        await projects.delete(projectId);
        await userSamples.remove(consolidatedId);
      }
    });

    console.log("consolidation report", report);

    expect(report).toMatchObject({
      sourceClipCount: 2,
      reopenedClipCount: 1,
      restoredBuffer: true,
      audioPersisted: true,
    });
    expect(report.reopenedBufferId).toContain("user.consolidated-e2e-");
    expect(report.afterLength).toBe(report.beforeLength);
    expect(report.maxAbsoluteError).toBeLessThan(1e-5);
    expect(report.rmsError).toBeLessThan(1e-6);
  });
});
