import { describe, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createInstrumentTrack } from "../src/commands/tracks";
import { instrumentTrackForRole } from "../src/ai/role-targets";

function threeLaneDoc(): { doc: ReturnType<typeof createProjectFromTemplate>; bass: string; chords: string; lead: string } {
  let doc = createProjectFromTemplate("house");
  doc = { ...doc, tracks: doc.tracks.map((track) => (track.kind === "instrument" && track.name === "808" ? { ...track, name: "Bass" } : track)) };
  doc = createInstrumentTrack(doc, "synth").execute(doc);
  const instruments = doc.tracks.filter((track) => track.kind === "instrument");
  const lead = instruments[instruments.length - 1]!;
  doc = { ...doc, tracks: doc.tracks.map((track) => (track.id === lead.id ? { ...track, name: "Lead" } : track)) };
  const final = doc.tracks.filter((track) => track.kind === "instrument");
  return { doc, bass: final[0].id, chords: final[1].id, lead: final[2].id };
}

describe("debug", () => {
  it("prints instrument lanes", () => {
    const doc = createProjectFromTemplate("house");
    const instruments = doc.tracks.filter((t) => t.kind === "instrument");
    console.log("instrument tracks:", instruments.map((t) => `${t.id}:${t.name}`).join(" | "));
    for (const id of ["house", "trap", "techno", "boombap", "dnb", "amapiano", "jersey"] as const) {
      try {
        const d = createProjectFromTemplate(id);
        const inst = d.tracks.filter((t) => t.kind === "instrument");
        console.log(
          `${id}: ${inst.length} instrument tracks ->`,
          inst.map((t) => t.name).join(" | "),
        );
      } catch {
        console.log(`${id}: (no template)`);
      }
    }
    const lanes = threeLaneDoc();
    console.log("threeLaneDoc ->", lanes.bass, "|", lanes.chords, "|", lanes.lead);
    console.log(
      "tracks:",
      lanes.doc.tracks.map((t) => `${t.kind}:${t.name}`).join(" | "),
    );
    for (const role of ["bass", "chord", "lead"] as const) {
      const t = instrumentTrackForRole(lanes.doc, role, undefined);
      console.log(role, "->", t ? `${t.id}:${t.name}` : null);
    }
  });
});
