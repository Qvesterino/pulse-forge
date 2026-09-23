import { createServer } from "vite";
const server = await createServer({ root: process.cwd(), logLevel: "error", server: { port: 5242, host: "127.0.0.1", strictPort: true } });
await server.listen();
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:5253/", { waitUntil: "domcontentloaded" });
const state = await page.evaluate(async () => {
  const load = (s) => import(/* @vite-ignore */ s);
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
  const context = new OfflineAudioContext(2, 44100, 44100);
  await loadAllWorklets(context);
  const doc = createProjectFromTemplate("house");
  const groupA = { ...createGroupTrackModel("A"), pan: -1 };
  const groupB = { ...createGroupTrackModel("B"), pan: 1 };
  const drum = doc.tracks.find((t) => t.kind === "drum");
  const mk = (groupId) => ({
    ...doc,
    tracks: [...doc.tracks.map((t) => (t.id === drum.id ? { ...t, groupId, sends: {} } : t)), groupA, groupB],
  });
  const engine = new AudioEngine();
  engine.attachBank(bank);
  engine.useContext(context);
  const snap = (label) => {
    const nodes = engine.trackNodes.get(drum.id);
    const route = nodes?.routeDestination;
    const aInput = engine.groupNodes.get(groupA.id)?.input;
    const bInput = engine.groupNodes.get(groupB.id)?.input;
    console.log(label, "| route=A?", route === aInput, "| route=B?", route === bInput, "| route=master?", route === engine.master, "| A node?", Boolean(aInput), "| B node?", Boolean(bInput));
  };
  const keysAt = (label) => console.log("STEP", label, "groupNodes:", JSON.stringify([...engine.groupNodes.keys()]), "tracks:", JSON.stringify(((engine.doc ?? { tracks: [] }).tracks || []).filter((t) => t.kind === "group").map((t) => t.id)), "docTracks:", JSON.stringify(((engine.doc ?? { tracks: [] }).tracks || []).filter((t) => t.kind === "group").map((t) => t.id)));
  const stepLog = [];
  const keysAt2 = (label) => stepLog.push(label + ": groups=" + JSON.stringify([...engine.groupNodes.keys()]) + " docGroups=" + JSON.stringify(((engine.doc ?? { tracks: [] }).tracks || []).filter((t) => t.kind === "group").map((t) => t.id)));
  engine.setProject(doc);
  keysAt2("after base");
  engine.setProject(mk(groupA.id));
  keysAt2("after A");
  engine.setProject(mk(groupB.id));
  keysAt2("after B");
  const movedTracks = mk(groupB.id).tracks;
  const groupBTrack = movedTracks.find((t) => t.id === groupB.id);
  const nodes = engine.trackNodes.get(drum.id);
  return {
    stepLog,
    groupBKind: groupBTrack?.kind,
    groupAKind: movedTracks.find((t) => t.id === groupA.id)?.kind,
    groupNodesKeys: ["see steps"],
    routeDestinationIdentity: nodes?.routeDestination === engine.master ? "master" : nodes?.routeDestination === engine.groupNodes.get(groupA.id)?.input ? "A" : nodes?.routeDestination === engine.groupNodes.get(groupB.id)?.input ? "B" : "other",
    drumGroupId: groupBTrack?.groupId ? "B-set" : "?",
  };
});
console.log("RESULT:", JSON.stringify(state));
await browser.close();
await server.close();
