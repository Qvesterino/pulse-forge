import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { createPattern, setPatternLength } from "../src/commands/patterns";
import { normalizeProject } from "../src/project-model/schema";

const store = new ProjectStore(createProjectFromTemplate("house"));
const before = normalizeProject(store.doc).activePatternId;
store.execute(createPattern(store.doc, "X"));
store.execute(setPatternLength(store.doc, store.doc.activePatternId, 64));
const after = normalizeProject(store.doc).activePatternId;
store.undo();
const restored = normalizeProject(store.doc).activePatternId;
console.log("before", before.slice(-6), "after", after.slice(-6), "restored", restored.slice(-6), "MATCH", restored === before);
