import { expect, test } from "playwright/test";
import type { AudioClip, ProjectDocument } from "../../src/project-model/types";
import { openHouseTemplate } from "./_helpers";

test.describe("12 — audio take groups", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "WebKit on Windows has no Web Audio media stack");

  test("only the selected pass reaches live triggering and offline export", async ({ page }) => {
    test.setTimeout(120_000);
    await openHouseTemplate(page);
    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templateModule, commandModule, sampleModule, rendererModule, engineModule, workletModule, takesModule] =
        await Promise.all([
          load("/src/project-model/templates.ts"),
          load("/src/commands/commands.ts"),
          load("/src/sample-library/factory.ts"),
          load("/src/rendering/renderer.ts"),
          load("/src/audio-engine/AudioEngine.ts"),
          load("/src/audio-worklets/loader.ts"),
          load("/src/project-model/audio-takes.ts"),
        ]);
      const { createProjectFromTemplate } = templateModule;
      const { addAudioTakeClip, compAudioTakeRange, setActiveAudioTake } = commandModule;
      const { SampleBank } = sampleModule;
      const { renderProject } = rendererModule;
      const { AudioEngine } = engineModule;
      const { ensureWorkletsForDoc } = workletModule;
      const { audioClipsForPlayback } = takesModule;
      const sampleRate = 44_100;
      const makeTone = (frequency: number): AudioBuffer => {
        const buffer = new OfflineAudioContext(1, sampleRate * 2, sampleRate).createBuffer(
          1,
          sampleRate * 2,
          sampleRate,
        );
        const samples = buffer.getChannelData(0);
        for (let frame = 0; frame < samples.length; frame++) {
          samples[frame] = 0.2 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
        }
        return buffer;
      };
      const bank = new SampleBank();
      bank.add("take.e2e.first", makeTone(220));
      bank.add("take.e2e.second", makeTone(550));
      const template = createProjectFromTemplate("empty");
      const track = template.tracks[0];
      if (!track) throw new Error("empty-project audio track fixture missing");
      const base = { ...template, arrangement: { ...template.arrangement, clips: [], audioClips: [] } };
      const first = addAudioTakeClip(
        base,
        "take.e2e.group",
        "take.e2e.pass-1",
        track.id,
        "take.e2e.first",
        0,
        1,
      ).execute(base);
      const both = addAudioTakeClip(
        first,
        "take.e2e.group",
        "take.e2e.pass-2",
        track.id,
        "take.e2e.second",
        0,
        1,
      ).execute(first);
      const selectedSecond = setActiveAudioTake(both, "take.e2e.group", "take.e2e.pass-2").execute(both);
      const firstCompHalf = compAudioTakeRange(both, "take.e2e.group", "take.e2e.pass-1", 0, 960).execute(both);
      const comped = compAudioTakeRange(firstCompHalf, "take.e2e.group", "take.e2e.pass-2", 960, 1920).execute(
        firstCompHalf,
      );
      const crossfaded = compAudioTakeRange(firstCompHalf, "take.e2e.group", "take.e2e.pass-2", 960, 1920, 120).execute(
        firstCompHalf,
      );
      const projects = [both, selectedSecond, comped, crossfaded];
      const amplitudeAt = (buffer: AudioBuffer, frequency: number, startSec: number, windowSec = 0.35): number => {
        const samples = buffer.getChannelData(0);
        const start = Math.round(sampleRate * startSec);
        const count = Math.round(sampleRate * windowSec);
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
      const results = [];
      for (const project of projects) {
        const offline = await renderProject(project, bank, { mode: "song", sampleRate, tailSeconds: 0 });
        const liveContext = new OfflineAudioContext(2, offline.length, sampleRate);
        await ensureWorkletsForDoc(project, liveContext);
        const engine = new AudioEngine();
        engine.attachBank(bank);
        engine.useContext(liveContext);
        engine.setProject(project);
        for (const clip of audioClipsForPlayback(project.arrangement)) {
          engine.triggerAudioClip(clip, clip.startBar * 2, clip.lengthBars * 2);
        }
        const live = await liveContext.startRendering();
        engine.detachBank();
        let crossfadeMaxAbsDiff = 0;
        if (project === crossfaded) {
          const startFrame = Math.round(sampleRate * 0.9375);
          const endFrame = Math.round(sampleRate * 1.0625);
          const offlineSamples = offline.getChannelData(0);
          const liveSamples = live.getChannelData(0);
          for (let frame = startFrame; frame < endFrame; frame++) {
            crossfadeMaxAbsDiff = Math.max(
              crossfadeMaxAbsDiff,
              Math.abs((offlineSamples[frame] ?? 0) - (liveSamples[frame] ?? 0)),
            );
          }
        }
        results.push({
          selectedBufferId: audioClipsForPlayback(project.arrangement)[0]?.bufferId,
          activeTakeId: project.arrangement.takeGroups?.[0]?.activeTakeId,
          compSources: audioClipsForPlayback(project.arrangement).map(
            (clip: { compSourceTakeId?: string }) => clip.compSourceTakeId ?? null,
          ),
          offlineFirst: amplitudeAt(offline, 220, 0.2),
          offlineSecond: amplitudeAt(offline, 550, 0.2),
          offlineFirstLate: amplitudeAt(offline, 220, 1.2),
          offlineSecondLate: amplitudeAt(offline, 550, 1.2),
          liveFirst: amplitudeAt(live, 220, 0.2),
          liveSecond: amplitudeAt(live, 550, 0.2),
          liveFirstLate: amplitudeAt(live, 220, 1.2),
          liveSecondLate: amplitudeAt(live, 550, 1.2),
          crossfade220Offline: amplitudeAt(offline, 220, 0.95, 0.1),
          crossfade550Offline: amplitudeAt(offline, 550, 0.95, 0.1),
          crossfade220Live: amplitudeAt(live, 220, 0.95, 0.1),
          crossfade550Live: amplitudeAt(live, 550, 0.95, 0.1),
          crossfadeMaxAbsDiff,
          compFades: audioClipsForPlayback(project.arrangement)
            .filter((clip: { compSourceTakeId?: string; fadeIn: number; fadeOut: number }) => clip.compSourceTakeId)
            .map((clip: { fadeIn: number; fadeOut: number }) => [clip.fadeIn, clip.fadeOut]),
        });
      }
      return results;
    });

    expect(report).toHaveLength(4);
    expect(report[0]).toMatchObject({ selectedBufferId: "take.e2e.first" });
    expect(report[0]!.offlineFirst).toBeGreaterThan(0.05);
    expect(report[0]!.offlineSecond).toBeLessThan(0.005);
    expect(report[0]!.liveFirst).toBeGreaterThan(0.05);
    expect(report[0]!.liveSecond).toBeLessThan(0.005);
    expect(report[1]).toMatchObject({ selectedBufferId: "take.e2e.second" });
    expect(report[1]!.offlineSecond).toBeGreaterThan(0.05);
    expect(report[1]!.offlineFirst).toBeLessThan(0.005);
    expect(report[1]!.liveSecond).toBeGreaterThan(0.05);
    expect(report[1]!.liveFirst).toBeLessThan(0.005);
    expect(report[2]!.compSources).toEqual(["take.e2e.pass-1", "take.e2e.pass-2"]);
    expect(report[2]!.offlineFirst).toBeGreaterThan(0.05);
    expect(report[2]!.offlineSecond).toBeLessThan(0.005);
    expect(report[2]!.offlineSecondLate).toBeGreaterThan(0.05);
    expect(report[2]!.offlineFirstLate).toBeLessThan(0.005);
    expect(report[2]!.liveFirst).toBeGreaterThan(0.05);
    expect(report[2]!.liveSecond).toBeLessThan(0.005);
    expect(report[2]!.liveSecondLate).toBeGreaterThan(0.05);
    expect(report[2]!.liveFirstLate).toBeLessThan(0.005);
    expect(report[3]!.compSources).toEqual(["take.e2e.pass-1", "take.e2e.pass-1", "take.e2e.pass-2"]);
    expect(report[3]!.compFades).toContainEqual([0, 0.125]);
    expect(report[3]!.compFades).toContainEqual([0.125, 0]);
    expect(report[3]!.crossfade220Offline).toBeGreaterThan(0.05);
    expect(report[3]!.crossfade550Offline).toBeGreaterThan(0.05);
    expect(report[3]!.crossfade220Live).toBeGreaterThan(0.05);
    expect(report[3]!.crossfade550Live).toBeGreaterThan(0.05);
    const crossfadePower = report[3]!.crossfade220Offline ** 2 + report[3]!.crossfade550Offline ** 2;
    const soloPower = report[0]!.offlineFirst ** 2;
    expect(crossfadePower).toBeGreaterThan(soloPower * 0.8);
    expect(crossfadePower).toBeLessThan(soloPower * 1.2);
    expect(report[3]!.crossfade220Live).toBeCloseTo(report[3]!.crossfade220Offline, 2);
    expect(report[3]!.crossfade550Live).toBeCloseTo(report[3]!.crossfade550Offline, 2);
    expect(report[3]!.crossfadeMaxAbsDiff).toBeLessThan(1e-4);
  });

  test("starts a live linear take audition at its musical playhead source offset", async ({ page }) => {
    await openHouseTemplate(page);
    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templateModule, commandModule, sampleModule, auditionModule, engineModule] = await Promise.all([
        load("/src/project-model/templates.ts"),
        load("/src/commands/commands.ts"),
        load("/src/sample-library/factory.ts"),
        load("/src/rendering/take-audition.ts"),
        load("/src/audio-engine/AudioEngine.ts"),
      ]);
      const { createProjectFromTemplate } = templateModule;
      const { addAudioTakeClip } = commandModule;
      const { SampleBank } = sampleModule;
      const { createLiveAudioTakeAuditionProject } = auditionModule;
      const { AudioEngine } = engineModule;
      const sampleRate = 44_100;
      const makeTone = (frequency: number): AudioBuffer => {
        const context = new OfflineAudioContext(1, sampleRate * 2, sampleRate);
        const buffer = context.createBuffer(1, sampleRate * 2, sampleRate);
        const samples = buffer.getChannelData(0);
        for (let frame = 0; frame < samples.length; frame++) {
          samples[frame] = 0.2 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
        }
        return buffer;
      };
      const bank = new SampleBank();
      bank.add("take.resume.first", makeTone(220));
      bank.add("take.resume.second", makeTone(547.25));
      const base = createProjectFromTemplate("empty");
      const track = base.tracks[0];
      if (!track) throw new Error("empty-project audio track fixture missing");
      const clean = {
        ...base,
        // Keep the synthetic audition level independent of stateful master
        // dynamics; this test observes source offset and clip fade directly.
        master: { ...base.master, glueEnabled: false, limiterEnabled: false },
        arrangement: { ...base.arrangement, clips: [], audioClips: [] },
      };
      const first = addAudioTakeClip(
        clean,
        "take.resume.group",
        "take.resume.1",
        track.id,
        "take.resume.first",
        0,
        1,
      ).execute(clean);
      const source = addAudioTakeClip(
        first,
        "take.resume.group",
        "take.resume.2",
        track.id,
        "take.resume.second",
        0,
        1,
      ).execute(first);
      const sourceWithFades: ProjectDocument = {
        ...source,
        arrangement: {
          ...source.arrangement,
          audioClips: source.arrangement.audioClips?.map((candidate: AudioClip) =>
            candidate.takeId === "take.resume.2" ? { ...candidate, fadeIn: 1.5, fadeOut: 0 } : candidate,
          ),
        },
      };
      const playheadTick = 720;
      const audition: { project: ProjectDocument; resumedAudioClipOffsets: ReadonlyMap<string, number> } =
        createLiveAudioTakeAuditionProject(sourceWithFades, "take.resume.group", "take.resume.2", playheadTick);
      const clip = audition.project.arrangement.audioClips?.[0];
      if (!clip) throw new Error("live take audition did not retain the selected clip");
      const context = new OfflineAudioContext(2, Math.ceil(sampleRate * 1.35), sampleRate);
      const engine = new AudioEngine();
      engine.attachBank(bank);
      engine.useContext(context);
      engine.setProject(audition.project);

      // Record the actual Web Audio source offset and gain envelope supplied
      // by AudioEngine, while still rendering its real graph below.
      let sourceOffsetAtStart: number | null = null;
      let clipInitialGain: number | null = null;
      const createBufferSource = context.createBufferSource.bind(context);
      context.createBufferSource = (() => {
        const sourceNode = createBufferSource();
        const startSource = sourceNode.start.bind(sourceNode);
        sourceNode.start = ((when?: number, offset?: number, duration?: number) => {
          if (sourceNode.buffer === bank.get("take.resume.second")) sourceOffsetAtStart = offset ?? 0;
          if (when === undefined) startSource();
          else if (offset === undefined) startSource(when);
          else if (duration === undefined) startSource(when, offset);
          else startSource(when, offset, duration);
        }) as typeof sourceNode.start;
        return sourceNode;
      }) as typeof context.createBufferSource;
      const createGain = context.createGain.bind(context);
      context.createGain = (() => {
        const gainNode = createGain();
        const setGainValue = gainNode.gain.setValueAtTime.bind(gainNode.gain);
        gainNode.gain.setValueAtTime = ((value: number, time: number) => {
          if (clipInitialGain === null) clipInitialGain = value;
          return setGainValue(value, time);
        }) as typeof gainNode.gain.setValueAtTime;
        return gainNode;
      }) as typeof context.createGain;
      engine.triggerAudioClip(clip, 0.005, 1.25, audition.resumedAudioClipOffsets.get(clip.id));
      const rendered = await context.startRendering();
      const amplitudeAt = (frequency: number): number => {
        const samples = rendered.getChannelData(0);
        const start = Math.round(sampleRate * 0.05);
        const count = Math.round(sampleRate * 0.1);
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
      engine.panic();
      engine.detachBank();
      return {
        offsetSec: clip.offsetSec,
        resumeOffsetSec: audition.resumedAudioClipOffsets.get(clip.id),
        sourceOffsetAtStart,
        clipInitialGain,
        selectedTone: amplitudeAt(547.25),
        alternateTone: amplitudeAt(220),
      };
    });

    expect(report.offsetSec).toBeCloseTo(0.75, 8);
    expect(report.resumeOffsetSec).toBeCloseTo(0.75, 8);
    expect(report.sourceOffsetAtStart).toBeCloseTo(0.75, 8);
    expect(report.clipInitialGain).toBeCloseTo(0.75, 8);
    expect(report.selectedTone).toBeGreaterThan(0.05);
    expect(report.alternateTone).toBeLessThan(0.005);
  });
});
