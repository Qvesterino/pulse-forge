import { expect, test } from "playwright/test";

test("moving a track between groups removes its old audio route", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const report = await page.evaluate(async () => {
    const load = (specifier: string) => import(/* @vite-ignore */ specifier);
    const [engineModule, sampleModule, templateModule, schemaModule, workletModule] = await Promise.all([
      load("/src/audio-engine/AudioEngine.ts"),
      load("/src/sample-library/factory.ts"),
      load("/src/project-model/templates.ts"),
      load("/src/project-model/schema.ts"),
      load("/src/audio-worklets/loader.ts"),
    ]);
    const { AudioEngine } = engineModule;
    const { generateFactoryBank } = sampleModule;
    const { createProjectFromTemplate } = templateModule;
    const { createGroupTrackModel } = schemaModule;
    const { loadAllWorklets } = workletModule;
    const bank = await generateFactoryBank();
    const context = new OfflineAudioContext(2, 44_100, 44_100);
    await loadAllWorklets(context);

    const doc = createProjectFromTemplate("house");
    const groupA = { ...createGroupTrackModel("A"), pan: -1 };
    const groupB = { ...createGroupTrackModel("B"), pan: 1 };
    const drum = doc.tracks.find((track: { kind: string }) => track.kind === "drum");
    const withGroups = {
      ...doc,
      master: { ...doc.master, limiterEnabled: false, clipperEnabled: false, glueEnabled: false },
      tracks: [...doc.tracks.map((track: { id: string }) => (track.id === drum.id ? { ...track, groupId: groupA.id, sends: {} } : track)), groupA, groupB],
    };
    const moved = {
      ...withGroups,
      tracks: withGroups.tracks.map((track: { id: string }) => (track.id === drum.id ? { ...track, groupId: groupB.id } : track)),
    };
    const engine = new AudioEngine();
    engine.attachBank(bank);
    engine.useContext(context);
    engine.setProject(withGroups);
    engine.setProject(moved);
    // setProject defers the graph rebuild through an internal promise chain
    // (re-entrant calls coalesce into a queue drain). Reading route
    // bookkeeping before the drain settles races the rebuild — the AUDIO
    // settles to group B either way, but the routeDestination field is
    // written only when the queued body runs. Await the chain: deterministic,
    // no arbitrary delay.
    await (engine as unknown as { projectPromise: Promise<void> }).projectPromise;

    const internals = engine as unknown as {
      trackNodes: Map<string, { routeDestination: AudioNode }>;
      groupNodes: Map<string, { input: AudioNode }>;
    };
    const trackRoute = internals.trackNodes.get(drum.id)!.routeDestination;
    const groupAInput = internals.groupNodes.get(groupA.id)!.input;
    const groupBInput = internals.groupNodes.get(groupB.id)!.input;
    engine.trigger(drum.id, drum.pads[0], 0.1, 1);
    const output = await context.startRendering();
    const peak = (samples: Float32Array) => samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);

    // Control: prove the same group panner itself sends a directly-routed
    // child to the right before using its pan as a route-leak detector.
    const controlContext = new OfflineAudioContext(2, 44_100, 44_100);
    await loadAllWorklets(controlContext);
    const controlDoc = createProjectFromTemplate("empty");
    const controlGroup = { ...createGroupTrackModel("B"), pan: 1 };
    const controlProject = {
      ...controlDoc,
      master: { ...controlDoc.master, limiterEnabled: false, clipperEnabled: false, glueEnabled: false },
      tracks: [...controlDoc.tracks, controlGroup],
    };
    const controlEngine = new AudioEngine();
    controlEngine.attachBank(bank);
    controlEngine.useContext(controlContext);
    controlEngine.setProject(controlProject);
    const controlInternals = controlEngine as unknown as {
      master: AudioNode;
      masterTape: { output: AudioNode };
      masterMs: { output: AudioNode };
      masterBassMono: { output: AudioNode };
      masterDc: AudioNode;
      masterGlue: { output: AudioNode };
      masterClipper: AudioNode;
      masterLimiter: AudioNode;
      groupNodes: Map<string, { input: AudioNode; panner: StereoPannerNode; modMacroPan: StereoPannerNode }>;
    };
    const controlGroupNodes = controlInternals.groupNodes.get(controlGroup.id)!;
    const probeStereo = (node: AudioNode) => {
      const splitter = controlContext.createChannelSplitter(2);
      const leftAnalyser = controlContext.createAnalyser();
      const rightAnalyser = controlContext.createAnalyser();
      const silentSink = controlContext.createGain();
      silentSink.gain.value = 0;
      node.connect(splitter);
      splitter.connect(leftAnalyser, 0);
      splitter.connect(rightAnalyser, 1);
      leftAnalyser.connect(silentSink);
      rightAnalyser.connect(silentSink);
      silentSink.connect(controlContext.destination);
      return () => {
        const leftData = new Float32Array(leftAnalyser.fftSize);
        const rightData = new Float32Array(rightAnalyser.fftSize);
        leftAnalyser.getFloatTimeDomainData(leftData);
        rightAnalyser.getFloatTimeDomainData(rightData);
        return { left: peak(leftData), right: peak(rightData) };
      };
    };
    const pannerProbe = probeStereo(controlGroupNodes.panner);
    const groupOutputProbe = probeStereo(controlGroupNodes.modMacroPan);
    const masterStageProbes = Object.fromEntries(
      Object.entries({
        input: controlInternals.master,
        tape: controlInternals.masterTape.output,
        ms: controlInternals.masterMs.output,
        bassMono: controlInternals.masterBassMono.output,
        dc: controlInternals.masterDc,
        glue: controlInternals.masterGlue.output,
        clipper: controlInternals.masterClipper,
        limiter: controlInternals.masterLimiter,
      }).map(([name, node]) => [name, probeStereo(node)]),
    ) as Record<string, () => { left: number; right: number }>;
    const source = controlContext.createOscillator();
    const sourceGain = controlContext.createGain();
    source.frequency.value = 440;
    sourceGain.gain.value = 0.5;
    source.connect(sourceGain).connect(controlGroupNodes.input);
    source.start(0.1);
    source.stop(0.99);
    const controlOutput = await controlContext.startRendering();
    const pannerOutput = pannerProbe();
    const groupOutput = groupOutputProbe();
    const masterStages = Object.fromEntries(
      Object.entries(masterStageProbes).map(([name, read]) => [name, read()]),
    );

    const directContext = new OfflineAudioContext(2, 44_100, 44_100);
    const directSource = directContext.createOscillator();
    const directGain = directContext.createGain();
    const directPanner = directContext.createStereoPanner();
    directSource.frequency.value = 440;
    directGain.gain.value = 0.5;
    directPanner.pan.value = 1;
    directSource.connect(directGain).connect(directPanner).connect(directContext.destination);
    directSource.start(0.1);
    directSource.stop(0.9);
    const directOutput = await directContext.startRendering();
    return {
      routeToB: trackRoute === groupBInput,
      routeToOldA: trackRoute === groupAInput,
      left: peak(output.getChannelData(0)),
      right: peak(output.getChannelData(1)),
      controlLeft: peak(controlOutput.getChannelData(0)),
      controlRight: peak(controlOutput.getChannelData(1)),
      controlPanValue: controlGroupNodes.panner.pan.value,
      pannerOutput,
      groupOutput,
      masterStages,
      directLeft: peak(directOutput.getChannelData(0)),
      directRight: peak(directOutput.getChannelData(1)),
    };
  });

  expect(report.routeToB, JSON.stringify(report)).toBe(true);
  expect(report.routeToOldA, JSON.stringify(report)).toBe(false);
  expect(report.controlLeft, JSON.stringify(report)).toBeLessThan(report.controlRight * 0.15);
  expect(report.left, JSON.stringify(report)).toBeLessThan(report.right * 0.15);
});
