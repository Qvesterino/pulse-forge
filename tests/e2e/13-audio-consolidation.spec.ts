import { expect, test } from "playwright/test";
import { clickPanelAction, completeOnboardingTourIfPresent, openHouseTemplate } from "./_helpers";

test.describe("13 — rendered audio consolidation", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "WebKit on Windows has no Web Audio media stack");

  test("a 93-bar arrangement with a 12-bar 808 sustain survives reload and export", async ({ page }) => {
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
      const sustainStartBar = 80;
      const sustainBars = 12;
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
        duration: sustainBars * BAR_TICKS,
        velocity: 0.9,
      }).execute(expanded);
      const withMidiClip = addMidiClip(
        withNote,
        instrument.id,
        base.activePatternId,
        sustainStartBar * BAR_TICKS,
        sustainBars * BAR_TICKS,
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
        const lateSustainStart = Math.floor(((sustainStartBar + sustainBars - 1) * 4 * 60 * sampleRate) / reopened.bpm);
        const energyFrames = sampleRate;
        let squareSum = 0;
        for (let frame = lastBarStart; frame < lastBarStart + energyFrames; frame++) {
          const value = channel[frame] ?? 0;
          squareSum += value * value;
        }
        const lateSustainFrames = Math.floor(sampleRate * 0.25);
        let lateSustainSquareSum = 0;
        for (let frame = lateSustainStart; frame < lateSustainStart + lateSustainFrames; frame++) {
          const value = channel[frame] ?? 0;
          lateSustainSquareSum += value * value;
        }
        const finalAudioWindowStart = lastBarStart + Math.floor(sampleRate);
        const finalAudioWindowFrames = Math.floor(sampleRate * 0.25);
        let finalAudioWindowSquareSum = 0;
        for (let frame = finalAudioWindowStart; frame < finalAudioWindowStart + finalAudioWindowFrames; frame++) {
          const value = channel[frame] ?? 0;
          finalAudioWindowSquareSum += value * value;
        }
        const reopenedPattern = reopened.patterns.find(
          (candidate: { id: string }) => candidate.id === base.activePatternId,
        );
        const sustainNote = reopenedPattern?.notes[instrument.id]?.find(
          (note: { pitch: number; duration: number }) => note.pitch === 36 && note.duration === sustainBars * BAR_TICKS,
        );
        return {
          bpm: reopened.bpm,
          clipStartBar: reopened.arrangement.audioClips?.[0]?.startBar,
          clipLengthBars: reopened.arrangement.audioClips?.[0]?.lengthBars,
          sustainClipStartBar: reopened.arrangement.midiClips?.[0]?.startTick / BAR_TICKS,
          sustainClipLengthBars: reopened.arrangement.midiClips?.[0]?.lengthTicks / BAR_TICKS,
          sustainStartBar,
          sustainBars,
          sustainNoteTicks: sustainNote?.duration,
          renderTicks: computeRenderTicks(reopened, "song"),
          frames: rendered.length,
          durationSeconds: rendered.duration,
          finalBarRms: Math.sqrt(squareSum / energyFrames),
          lateSustainRms: Math.sqrt(lateSustainSquareSum / lateSustainFrames),
          finalAudioQuarterSecondRms: Math.sqrt(finalAudioWindowSquareSum / finalAudioWindowFrames),
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
      sustainClipStartBar: 80,
      sustainClipLengthBars: 12,
      sustainStartBar: 80,
      sustainBars: 12,
      sustainNoteTicks: 12 * 4 * 480,
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
    expect(report.lateSustainRms).toBeGreaterThan(0.0001);
    expect(report.finalAudioQuarterSecondRms).toBeGreaterThan(0.01);
  });

  test("edits a future MIDI clip during full 93-bar live playback", async ({ page }) => {
    test.skip(
      process.env.KYX_RUN_REALTIME_SONG_SOAK !== "1",
      "Explicit three-minute AudioContext soak; set KYX_RUN_REALTIME_SONG_SOAK=1 to run",
    );
    test.setTimeout(300_000);
    await page.addInitScript(() => {
      localStorage.setItem("pf-onboarded", "1");
      localStorage.setItem("pf-intent-opened", "1");
      const starts: Array<{ kind: string; when: number; scheduledAt: number; sourceId: number }> = [];
      const stops: Array<{ kind: string; when: number; scheduledAt: number; sourceId: number }> = [];
      const sourceIds = new WeakMap<AudioNode, number>();
      let nextSourceId = 1;
      Object.defineProperty(window, "__kyxRealtimeStarts", { value: starts, configurable: true });
      Object.defineProperty(window, "__kyxRealtimeStops", { value: stops, configurable: true });
      const patchSource = (prototype: object, kind: string) => {
        const sourcePrototype = prototype as { start: (...args: number[]) => void; stop: (...args: number[]) => void };
        const nativeStart = sourcePrototype.start;
        const nativeStop = sourcePrototype.stop;
        sourcePrototype.start = function (this: AudioNode, ...args: number[]) {
          const sourceId = nextSourceId++;
          sourceIds.set(this, sourceId);
          starts.push({
            kind,
            when: args[0] ?? this.context.currentTime,
            scheduledAt: this.context.currentTime,
            sourceId,
          });
          return nativeStart.apply(this, args);
        };
        sourcePrototype.stop = function (this: AudioNode, ...args: number[]) {
          stops.push({
            kind,
            when: args[0] ?? this.context.currentTime,
            scheduledAt: this.context.currentTime,
            sourceId: sourceIds.get(this) ?? -1,
          });
          return nativeStop.apply(this, args);
        };
      };
      patchSource(OscillatorNode.prototype, "oscillator");
      patchSource(AudioBufferSourceNode.prototype, "buffer");
    });
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".project-browser", { timeout: 60_000 });

    const fixture = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templates, commands, schema, types, repository] = await Promise.all([
        load("/src/project-model/templates.ts"),
        load("/src/commands/commands.ts"),
        load("/src/project-model/schema.ts"),
        load("/src/project-model/types.ts"),
        load("/src/persistence/ProjectRepository.ts"),
      ]);
      const { createProjectFromTemplate } = templates;
      const { addMidiClip, addNote, clearPattern, setPatternLength } = commands;
      const { createInstrumentTrackModel } = schema;
      const { BAR_TICKS } = types;
      const { ProjectRepository } = repository;
      const projectId = `e2e-live-93-bar-${crypto.randomUUID()}`;
      const projectName = "Live 93-bar AudioContext acceptance";
      const template = createProjectFromTemplate("empty");
      const instrumentBase = createInstrumentTrackModel("808", 1);
      const instrument = {
        ...instrumentBase,
        params: { ...instrumentBase.params, mono: 0 },
      };
      const base = {
        ...template,
        id: projectId,
        name: projectName,
        bpm: 124,
        tracks: [...template.tracks, instrument],
        arrangement: { ...template.arrangement, clips: [], audioClips: [], midiClips: [], automationClips: [] },
      };
      const patternId = base.activePatternId;
      const expanded = setPatternLength(base, patternId, 128).execute(base);
      const blank = clearPattern(expanded, patternId).execute(expanded);
      const withNote = addNote(blank, instrument.id, {
        pitch: 36,
        start: 0,
        duration: 12 * BAR_TICKS,
        velocity: 0.9,
      }).execute(blank);
      const withMuteTarget = addMidiClip(withNote, instrument.id, patternId, 4 * BAR_TICKS, BAR_TICKS).execute(
        withNote,
      );
      const withMoveTarget = addMidiClip(withMuteTarget, instrument.id, patternId, 8 * BAR_TICKS, BAR_TICKS).execute(
        withMuteTarget,
      );
      const withResizeTarget = addMidiClip(withMoveTarget, instrument.id, patternId, 12 * BAR_TICKS, BAR_TICKS).execute(
        withMoveTarget,
      );
      const withTrimTarget = addMidiClip(
        withResizeTarget,
        instrument.id,
        patternId,
        16 * BAR_TICKS,
        2 * BAR_TICKS,
      ).execute(withResizeTarget);
      const withSustain = addMidiClip(withTrimTarget, instrument.id, patternId, 80 * BAR_TICKS, 12 * BAR_TICKS).execute(
        withTrimTarget,
      );
      const project = addMidiClip(withSustain, instrument.id, patternId, 92 * BAR_TICKS, BAR_TICKS).execute(
        withSustain,
      );
      await new ProjectRepository().save(project);
      return { projectName };
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".project-browser", { timeout: 60_000 });
    await page.locator(".pb-row-name").filter({ hasText: fixture.projectName }).click();
    await page.waitForSelector(".btn-mode", { timeout: 60_000 });
    await completeOnboardingTourIfPresent(page);
    await page.locator(".btn-mode").click();
    await expect(page.locator(".btn-mode")).toHaveText("SONG");
    await expect(page.getByRole("status").filter({ hasText: /ARRANGEMENT EMPTY|NO CLIP AT BAR/ })).toHaveCount(0);
    await clickPanelAction(page, "ARR");
    const muteTarget = page.getByRole("button", { name: /bar 5, shared source pattern used by 6 placements/ });
    const moveTarget = page.getByRole("button", { name: /bar 9, shared source pattern used by 6 placements/ });
    const resizeTarget = page.getByRole("button", { name: /bar 13, shared source pattern used by 6 placements/ });
    const trimTarget = page.getByRole("button", { name: /bar 17, shared source pattern used by 6 placements/ });
    await expect(muteTarget).toBeVisible();
    await expect(moveTarget).toBeVisible();
    await expect(resizeTarget).toBeVisible();
    await expect(trimTarget).toBeVisible();
    await page.locator(".btn-play").click();
    await expect(page.locator(".btn-play")).toContainText("❚❚");

    // Mute a future bar while the actual AudioContext and scheduler are live.
    // The state change must reach the engine before bar 5 is scheduled.
    await muteTarget.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mute / unmute" }).click();
    await expect(muteTarget).toHaveClass(/muted/);

    // Move a second future clip one bar to the right while playback is live.
    // The original bar-9 event must disappear and the new bar-10 event must play.
    const moveBox = await moveTarget.boundingBox();
    expect(moveBox).not.toBeNull();
    if (!moveBox) throw new Error("future MIDI clip has no visible bounds");
    const dragY = moveBox.y + moveBox.height / 2;
    const dragX = moveBox.x + moveBox.width / 2;
    await page.mouse.move(dragX, dragY);
    await page.mouse.down();
    await page.mouse.move(dragX + 30, dragY, { steps: 4 });
    await page.mouse.up();
    await expect(
      page.getByRole("button", { name: /bar 10, shared source pattern used by 6 placements/ }),
    ).toBeVisible();
    await expect(moveTarget).toHaveCount(0);

    // Extend a future clip from one bar to two; its sustained note should now
    // stop at the resized clip end, one bar later than before.
    const resizeBox = await resizeTarget.boundingBox();
    expect(resizeBox).not.toBeNull();
    if (!resizeBox) throw new Error("future MIDI resize target has no visible bounds");
    const resizeY = resizeBox.y + resizeBox.height / 2;
    const resizeX = resizeBox.x + resizeBox.width - 3;
    await page.mouse.move(resizeX, resizeY);
    await page.mouse.down();
    await page.mouse.move(resizeX + 30, resizeY, { steps: 4 });
    await page.mouse.up();
    await expect(resizeTarget).toHaveAttribute("title", /3840 ticks/);

    // Trim one bar from the left of a two-bar clip, preserving its end point
    // and source phase. Its old first note must not be scheduled after trim.
    const trimBox = await trimTarget.boundingBox();
    expect(trimBox).not.toBeNull();
    if (!trimBox) throw new Error("future MIDI trim target has no visible bounds");
    const trimY = trimBox.y + trimBox.height / 2;
    const trimX = trimBox.x + 3;
    await page.mouse.move(trimX, trimY);
    await page.mouse.down();
    await page.mouse.move(trimX + 30, trimY, { steps: 4 });
    await page.mouse.up();
    await expect(
      page.getByRole("button", { name: /bar 18, shared source pattern used by 6 placements/ }),
    ).toHaveAttribute("title", /1920 ticks/);
    await expect(trimTarget).toHaveCount(0);

    // Keep the real app and its AudioContext running for the actual 180-second
    // arrangement duration. This is deliberately opt-in so routine E2E runs
    // do not acquire a three-minute wall-clock cost.
    const requestedSoakMs = Number(process.env.KYX_REALTIME_SONG_SOAK_MS ?? 181_000);
    const soakDurationMs = Number.isFinite(requestedSoakMs)
      ? Math.max(1_000, Math.min(181_000, requestedSoakMs))
      : 181_000;
    await page.waitForTimeout(soakDurationMs);
    const starts = await page.evaluate(
      () =>
        (window as unknown as { __kyxRealtimeStarts: Array<{ when: number; sourceId: number }> }).__kyxRealtimeStarts,
    );
    const stops = await page.evaluate(
      () => (window as unknown as { __kyxRealtimeStops: Array<{ when: number; sourceId: number }> }).__kyxRealtimeStops,
    );
    const barSeconds = (4 * 60) / 124;
    const expectedSustainGap = 12 * barSeconds;
    const uniqueStarts = [...new Set(starts.map((source) => source.when))].sort((a, b) => a - b);
    const movedStart = uniqueStarts.find((start) =>
      uniqueStarts.some((later) => Math.abs(later - start - 3 * barSeconds) < 0.1),
    );
    expect(movedStart).toBeDefined();
    if (movedStart !== undefined) {
      const originalMoveTargetStart = movedStart - barSeconds;
      const resizedStart = movedStart + 3 * barSeconds;
      const originalTrimTargetStart = movedStart + 7 * barSeconds;
      const trimmedClipStart = movedStart + 8 * barSeconds;
      expect(uniqueStarts.some((start) => Math.abs(start - originalMoveTargetStart) < 0.1)).toBe(false);
      expect(uniqueStarts.some((start) => Math.abs(start - originalTrimTargetStart) < 0.1)).toBe(false);
      expect(uniqueStarts.some((start) => Math.abs(start - trimmedClipStart) < 0.1)).toBe(false);

      const movedSource = starts.find((source) => Math.abs(source.when - movedStart) < 0.1);
      const resizedSource = starts.find((source) => Math.abs(source.when - resizedStart) < 0.1);
      expect(movedSource).toBeDefined();
      expect(resizedSource).toBeDefined();
      const movedStop = stops.find((stop) => stop.sourceId === movedSource?.sourceId);
      const resizedStop = stops.find((stop) => stop.sourceId === resizedSource?.sourceId);
      expect(movedStop).toBeDefined();
      expect(resizedStop).toBeDefined();
      if (movedSource && resizedSource && movedStop && resizedStop) {
        const movedGateAndTail = movedStop.when - movedSource.when;
        const resizedGateAndTail = resizedStop.when - resizedSource.when;
        expect(resizedGateAndTail - movedGateAndTail).toBeCloseTo(barSeconds, 1);
      }
    }
    const sustainStart = uniqueStarts.find((start) =>
      uniqueStarts.some((later) => Math.abs(later - start - expectedSustainGap) < 0.1),
    );
    if (soakDurationMs >= 181_000) expect(sustainStart).toBeDefined();
    if (sustainStart !== undefined) {
      const mutedClipStart = sustainStart - 76 * barSeconds;
      expect(uniqueStarts.some((start) => Math.abs(start - mutedClipStart) < 0.1)).toBe(false);
    }
    expect(await page.locator(".btn-play").textContent()).toContain("❚❚");
    await page.locator(".btn-stop").click();
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

  test("measures arrangement viewport response with 300 MIDI clips", async ({ page }) => {
    test.skip(
      process.env.KYX_RUN_ARRANGEMENT_BENCHMARK !== "1",
      "Opt-in 300-clip viewport benchmark; set KYX_RUN_ARRANGEMENT_BENCHMARK=1 to run",
    );
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      localStorage.setItem("pf-onboarded", "1");
      localStorage.setItem("pf-intent-opened", "1");
    });
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".project-browser", { timeout: 60_000 });

    const fixture = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templates, commands, schema, types, repository] = await Promise.all([
        load("/src/project-model/templates.ts"),
        load("/src/commands/commands.ts"),
        load("/src/project-model/schema.ts"),
        load("/src/project-model/types.ts"),
        load("/src/persistence/ProjectRepository.ts"),
      ]);
      const { createProjectFromTemplate } = templates;
      const { addMidiClip } = commands;
      const { createInstrumentTrackModel } = schema;
      const { BAR_TICKS } = types;
      const { ProjectRepository } = repository;
      const projectName = "300 MIDI clip viewport benchmark";
      const base = createProjectFromTemplate("empty");
      const instrument = createInstrumentTrackModel("808", 1);
      let project = {
        ...base,
        id: `e2e-midi-viewport-${crypto.randomUUID()}`,
        name: projectName,
        tracks: [...base.tracks, instrument],
        arrangement: { ...base.arrangement, clips: [], audioClips: [], midiClips: [], automationClips: [] },
      };
      for (let index = 0; index < 300; index++) {
        project = addMidiClip(
          project,
          instrument.id,
          project.activePatternId,
          (index * BAR_TICKS) / 3,
          BAR_TICKS / 3,
        ).execute(project);
      }
      await new ProjectRepository().save(project);
      return { projectName, clipCount: project.arrangement.midiClips?.length ?? 0 };
    });

    expect(fixture.clipCount).toBe(300);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".project-browser", { timeout: 60_000 });
    await page.locator(".pb-row-name").filter({ hasText: fixture.projectName }).click();
    await page.waitForSelector(".btn-mode", { timeout: 60_000 });

    const mountStartedAt = Date.now();
    await clickPanelAction(page, "ARR");
    await page.waitForSelector(".arr-midi-clip", { timeout: 30_000 });
    const mountMs = Date.now() - mountStartedAt;
    const initialViewport = await page.evaluate(() => ({
      rendered: document.querySelectorAll(".arr-midi-clip").length,
      scrollWidth: document.querySelector<HTMLElement>(".arr-lane-scroll")?.scrollWidth ?? 0,
    }));

    const scrollStartedAt = Date.now();
    await page.evaluate(async () => {
      const scroll = document.querySelector<HTMLElement>(".arr-lane-scroll");
      if (!scroll) throw new Error("arrangement lane scroll container is missing");
      scroll.scrollLeft = scroll.scrollWidth;
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await expect(page.locator('.arr-midi-clip[aria-label*="bar 100"]').first()).toBeVisible();
    const scrollMs = Date.now() - scrollStartedAt;
    const endViewport = await page.evaluate(() => document.querySelectorAll(".arr-midi-clip").length);
    const metrics = {
      clips: fixture.clipCount,
      mountMs,
      initialVisible: initialViewport.rendered,
      scrollMs,
      endVisible: endViewport,
    };
    console.info(`[midi-viewport-benchmark] ${JSON.stringify(metrics)}`);

    expect(initialViewport.rendered).toBeGreaterThan(0);
    expect(initialViewport.rendered).toBeLessThan(200);
    expect(initialViewport.scrollWidth).toBeGreaterThan(0);
    expect(endViewport).toBeGreaterThan(0);
    expect(endViewport).toBeLessThan(200);
    expect(mountMs, `arrangement mount took ${mountMs} ms`).toBeLessThan(2_500);
    expect(scrollMs, `scroll-to-end commit took ${scrollMs} ms`).toBeLessThan(1_000);
  });
});
