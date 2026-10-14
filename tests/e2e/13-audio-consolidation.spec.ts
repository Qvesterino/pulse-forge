import { expect, test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

test.describe("13 — rendered audio consolidation", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "WebKit on Windows has no Web Audio media stack");

  test("a 93-bar arrangement survives reload and exports audio from its final bar", async ({ page }) => {
    test.setTimeout(180_000);
    await openHouseTemplate(page);

    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [
        templateModule,
        commandModule,
        schemaModule,
        typesModule,
        sampleModule,
        rendererModule,
        wavModule,
        projectRepoModule,
      ] = await Promise.all([
        load("/src/project-model/templates.ts"),
        load("/src/commands/commands.ts"),
        load("/src/project-model/schema.ts"),
        load("/src/project-model/types.ts"),
        load("/src/sample-library/factory.ts"),
        load("/src/rendering/renderer.ts"),
        load("/src/rendering/wav.ts"),
        load("/src/persistence/ProjectRepository.ts"),
      ]);
      const { createProjectFromTemplate } = templateModule;
      const { addAudioClip, addMidiClip, addNote, setPatternLength } = commandModule;
      const { createInstrumentTrackModel } = schemaModule;
      const { BAR_TICKS } = typesModule;
      const { SampleBank } = sampleModule;
      const { computeRenderTicks, renderProject } = rendererModule;
      const { encodeWavAsync } = wavModule;
      const { ProjectRepository } = projectRepoModule;
      const sampleRate = 8_000;
      const sampleSeconds = 1.4;
      const source = new OfflineAudioContext(1, sampleRate * sampleSeconds, sampleRate).createBuffer(
        1,
        Math.floor(sampleRate * sampleSeconds),
        sampleRate,
      );
      const sourceSamples = source.getChannelData(0);
      for (let frame = 0; frame < source.length; frame++) {
        sourceSamples[frame] = 0.15 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
      }

      const projectId = `e2e-long-song-${crypto.randomUUID()}`;
      const bufferId = `e2e-long-song-audio-${crypto.randomUUID()}`;
      const template = createProjectFromTemplate("empty");
      const track = template.tracks.find((candidate: { kind: string }) => candidate.kind !== "group");
      if (!track) throw new Error("long-song audio fixture is missing a playable track");
      const instrument = createInstrumentTrackModel("808", 1);
      const base = {
        ...template,
        id: projectId,
        name: "93-Bar Acceptance",
        bpm: 124,
        tracks: [...template.tracks, instrument],
        arrangement: { ...template.arrangement, clips: [], audioClips: [] },
      };
      const expanded = setPatternLength(base, base.activePatternId, 128).execute(base);
      const withNote = addNote(expanded, instrument.id, {
        pitch: 36,
        start: 0,
        duration: 4 * BAR_TICKS,
        velocity: 0.9,
      }).execute(expanded);
      const withMidiClip = addMidiClip(
        withNote,
        instrument.id,
        base.activePatternId,
        89 * BAR_TICKS,
        4 * BAR_TICKS,
      ).execute(withNote);
      const withAudioClip = addAudioClip(withMidiClip, track.id, bufferId, 92, 1, {
        fadeIn: 0,
        fadeOut: 0,
      }).execute(withMidiClip);
      const project = withAudioClip;
      const bank = new SampleBank();
      bank.add(bufferId, source);
      const projects = new ProjectRepository();

      try {
        await projects.save(project);
        const reopened = await new ProjectRepository().load(projectId);
        if (!reopened) throw new Error("93-bar project did not reopen from IndexedDB");
        const rendered = await renderProject(reopened, bank, {
          mode: "song",
          sampleRate,
          tailSeconds: 0,
          masterProcessing: false,
          arrangementOnly: true,
        });
        const wav = await encodeWavAsync(rendered, 16);
        const wavView = new DataView(wav);
        const channel = rendered.getChannelData(0);
        const lastBarStart = Math.floor((92 * 4 * 60 * sampleRate) / reopened.bpm);
        const energyFrames = sampleRate;
        let squareSum = 0;
        for (let frame = lastBarStart; frame < lastBarStart + energyFrames; frame++) {
          const value = channel[frame] ?? 0;
          squareSum += value * value;
        }
        const sustainStart = rendered.length - Math.floor(sampleRate * 0.25);
        let sustainSquareSum = 0;
        for (let frame = sustainStart; frame < rendered.length; frame++) {
          const value = channel[frame] ?? 0;
          sustainSquareSum += value * value;
        }
        const reopenedPattern = reopened.patterns.find(
          (candidate: { id: string }) => candidate.id === base.activePatternId,
        );
        const sustainNote = reopenedPattern?.notes[instrument.id]?.find(
          (note: { pitch: number; duration: number }) => note.pitch === 36 && note.duration === 4 * BAR_TICKS,
        );
        return {
          bpm: reopened.bpm,
          clipStartBar: reopened.arrangement.audioClips?.[0]?.startBar,
          clipLengthBars: reopened.arrangement.audioClips?.[0]?.lengthBars,
          sustainClipStartBar: reopened.arrangement.midiClips?.[0]?.startTick / BAR_TICKS,
          sustainClipLengthBars: reopened.arrangement.midiClips?.[0]?.lengthTicks / BAR_TICKS,
          sustainNoteTicks: sustainNote?.duration,
          renderTicks: computeRenderTicks(reopened, "song"),
          frames: rendered.length,
          durationSeconds: rendered.duration,
          finalBarRms: Math.sqrt(squareSum / energyFrames),
          finalQuarterSecondRms: Math.sqrt(sustainSquareSum / (rendered.length - sustainStart)),
          wavRiff: String.fromCharCode(...new Uint8Array(wav, 0, 4)),
          wavWave: String.fromCharCode(...new Uint8Array(wav, 8, 4)),
          wavSampleRate: wavView.getUint32(24, true),
          wavChannels: wavView.getUint16(22, true),
          wavBitsPerSample: wavView.getUint16(34, true),
          wavDataBytes: wavView.getUint32(40, true),
        };
      } finally {
        await projects.delete(projectId);
      }
    });

    expect(report).toMatchObject({
      bpm: 124,
      clipStartBar: 92,
      clipLengthBars: 1,
      sustainClipStartBar: 89,
      sustainClipLengthBars: 4,
      sustainNoteTicks: 4 * 4 * 480,
      renderTicks: 93 * 4 * 480,
      wavRiff: "RIFF",
      wavWave: "WAVE",
      wavSampleRate: 8_000,
      wavChannels: 2,
      wavBitsPerSample: 16,
    });
    expect(report.durationSeconds).toBeCloseTo(180, 3);
    expect(report.wavDataBytes).toBe(report.frames * 2 * 2);
    expect(report.finalBarRms).toBeGreaterThan(0.02);
    expect(report.finalQuarterSecondRms).toBeGreaterThan(0.01);
  });

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

        // Simulate app reload: restore the WAV bytes from IndexedDB into a
        // fresh bank, then load the project from a new repository instance.
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
        let maxAbsoluteError = 0;
        let rmsError = 0;
        let comparedSamples = 0;
        for (let channel = 0; channel < Math.min(before.numberOfChannels, after.numberOfChannels); channel++) {
          const original = before.getChannelData(channel);
          const result = after.getChannelData(channel);
          for (let frame = 0; frame < Math.min(original.length, result.length); frame++) {
            const difference = Math.abs((original[frame] ?? 0) - (result[frame] ?? 0));
            maxAbsoluteError = Math.max(maxAbsoluteError, difference);
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
          maxAbsoluteError,
          rmsError: comparedSamples > 0 ? Math.sqrt(rmsError / comparedSamples) : Number.POSITIVE_INFINITY,
        };
      } finally {
        await projects.delete(projectId);
        await userSamples.remove(consolidatedId);
      }
    });

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
