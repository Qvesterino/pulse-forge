import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
const doc = createProjectFromTemplate("house");
const ctx: McpToolContext = {
  getDoc: () => doc,
  execute: (c) => { /* inspect */ const next = c.execute(doc); console.log("command label:", c.label); },
  undo: () => undefined, redo: () => undefined, undoStackLength: () => 0, historyLabels: () => [],
  isMicRecordingActive: () => false,
  transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
};
const r = executeMcpTool(ctx, "kyx_tracks", { op: "loadPreset", presetName: "Warm Sub", family: "bass" });
console.log("result:", r.text.slice(0, 160), "| isError:", r.isError);
