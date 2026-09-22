import { createProjectFromTemplate } from "../src/project-model/templates";
import { addNote, deleteNotes } from "../src/commands/commands";
const doc0: any = createProjectFromTemplate("house");
const trackId = (doc0.tracks.find((t: any) => t.kind === "instrument")).id;
let working: any = addNote(doc0 as any, trackId, { pitch: 60, start: 0, duration: 4, velocity: 0.8 }).execute(doc0 as any);
working = addNote(working as any, trackId, { pitch: 64, start: 960, duration: 4, velocity: 0.8 }).execute(working as any);
const active = working.patterns.find((p: any) => p.id === working.activePatternId);
const notes = (active.notes ?? {})[trackId] ?? [];
console.log("notes in active pattern for track:", notes.length, "| activePatternId:", working.activePatternId);
const ids = notes.map((n: any) => n.id);
const cmd = deleteNotes(working as any, trackId, ids);
const emptied: any = cmd.execute(working as any);
const activeAfter = emptied.patterns.find((p: any) => p.id === emptied.activePatternId);
console.log("after delete:", ((activeAfter.notes ?? {})[trackId] ?? []).length);
// where do the survivors live?
for (const p of emptied.patterns) {
  const n = (p.notes ?? {})[trackId] ?? [];
  if (n.length > 0) console.log("survivors in pattern", p.id, p.name, n.length);
}
