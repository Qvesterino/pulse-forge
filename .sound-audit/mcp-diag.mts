import { executeMcpTool } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

const SR = GOLDEN_SAMPLE_RATE;
let current = createProjectFromTemplate("house");
const ctx: any = {
  getDoc: () => current,
  execute: (cmd: any) => { current = cmd.execute(current); },
  undo: () => {}, redo: () => {}, undoStackLength: () => 1, historyLabels: () => [],
  isMicRecordingActive: () => false,
  transport: { play(){}, stop(){}, pause(){}, setLoop(){}, setMetronome(){} },
  loadSampleMono: async (id: string) => (id.startsWith("user.") ? { mono: renderGoldenTrack(goldenTracks()[0]), sampleRate: SR } : null),
};
const restyle = await executeMcpTool(ctx, "kyx_unsuno", { action: "restyle", artist: "travis scott" });
console.log("restyle text:", restyle.text, "mutated:", restyle.mutated);
const regen = await executeMcpTool(ctx, "kyx_unsuno", { action: "regen", artist: "fisher" });
console.log("regen text:", regen.text, "mutated:", regen.mutated);
const unknown = await executeMcpTool(ctx, "kyx_unsuno", { action: "regen", artist: "nikto taky 999" });
console.log("unknown text:", unknown.text, "mutated:", unknown.mutated);
