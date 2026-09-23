import { createServer } from "vite";
const server = await createServer({ root: process.cwd(), logLevel: "error", server: { port: 5242, host: "127.0.0.1", strictPort: true } });
await server.listen();
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:5242/", { waitUntil: "domcontentloaded" });
const state = await page.evaluate(async () => {
  const load = (s: string) => import(/* @vite-ignore */ s);
  const [engineModule, sampleModule, templateModule, schemaModule, workletModule] = await Promise.all([
    load("/src/audio-engine/AudioEngine.ts"),
    load("/src/sample-library/factory.ts"),
    load("/src/project-model/templates.ts"),
    load("/src/project-model/schema.ts"),
    load("/src/audio-worklets/loader.ts"),
  ]);
  const { AudioEngine } = engineModule as any;
  const { generateFactoryBank } = sampleModule as any;
  const { createProjectFromTemplate } = templateModule as any;
  const { createGroupTrackModel } = schemaModule as any;
  const { loadAllWorklets } = workletModule as any;
  const bank = await generateFactoryBank();
  const context = new OfflineAudioContext(2, 44100, 44100);
  await loadAllWorklets(context);
  const doc = createProjectFromTemplate("house");
  const groupA = { ...createGroupTrackModel("A"), pan: -1 };
  const groupB = { ...createGroupTrackModel("B"), pan: 1 };
  const drum: any = doc.tracks.find((t: any) => t.kind === "drum");
  const mk = (groupId: string) => ({
    ...doc,
    tracks: [...doc.tracks.map((t: any) => (t.id === drum.id ? { ...t, groupId, sends: {} } : t)), groupA, groupB],
  });
  const engine: any = new AudioEngine();
  engine.attachBank(bank);
  engine.useContext(context);
  const snap = (label: string) => {
    const nodes = engine.trackNodes.get(drum.id);
    const route = nodes?.routeDestination;
    const aInput = engine.groupNodes.get(groupA.id)?.input;
    const bInput = engine.groupNodes.get(groupB.id)?.input;
    console.log(label, "| route=A?", route === aInput, "| route=B?", route === bInput, "| route=master?", route === engine.master, "| A node?", Boolean(aInput), "| B node?", Boolean(bInput));
  };
  engine.setProject(doc);
  snap("after setProject(base)");
  engine.setProject(mk(groupA.id));
  snap("after setProject(A)");
  engine.setProject(mk(groupB.id));
  snap("after setProject(B)");
  const nodes = engine.trackNodes.get(drum.id);
  const connected = context.createGain();
  try { nodes.modMacroPan.connect(connected); } catch {}
  const bInput = engine.groupNodes.get(groupB.id)?.input;
  return {
    routeIsB: nodes.routeDestination === bInput,
    bInputDefined: Boolean(bInput),
    drumGroupId: mk(groupB.id).tracks.find((t: any) => t.id === drum.id).groupId,
  };
});
console.log("RESULT:", JSON.stringify(state));
await browser.close();
await server.close();
