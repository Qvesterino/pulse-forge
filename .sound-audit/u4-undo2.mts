import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { normalizeProject } from "../src/project-model/schema";
import { unsunoCommand } from "../src/reference/unsuno";
import { transcribeTrack } from "../src/reference/transcribe";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "../tests/unsuno/golden-synth";

const t = transcribeTrack(renderGoldenTrack(goldenTracks()[0]), GOLDEN_SAMPLE_RATE);
const store = new ProjectStore(createProjectFromTemplate("house"));
const before = normalizeProject(store.doc);
const result = unsunoCommand(before, { transcription: t, sections: [{ role: "intro", startSec: 0, endSec: 8 }] });
console.log("layers", JSON.stringify(result.layers), "patterns", result.patternCount);
if (result.command) {
  store.execute(result.command);
  const after = normalizeProject(store.doc);
  console.log("after ap", after.activePatternId.slice(-6), "key", after.key, "bpm", after.bpm);
  console.log("undoStack", store.undoStackLength);
  store.undo();
  const restored = normalizeProject(store.doc);
  console.log("restored ap", restored.activePatternId.slice(-6), "MATCH", restored.activePatternId === before.activePatternId);
  console.log("patterns count", restored.patterns.length, "vs", before.patterns.length);
  console.log("tracks count", restored.tracks.length, "vs", before.tracks.length);
}
