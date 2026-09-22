import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { createGenerativeTrack } from "../src/commands/commands";
import type { Command } from "../src/commands/types";
import { yDocToProject, projectToYDoc } from "../src/collab/YDocAdapter";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import type { GenerativeTrack, ProjectDocument } from "../src/project-model/types";

function generatedTrack(doc: ProjectDocument): GenerativeTrack {
  const track = doc.tracks.find((candidate): candidate is GenerativeTrack => candidate.kind === "generative");
  if (!track) throw new Error("Generative track missing");
  return track;
}

describe("GenerativeTrack project contract", () => {
  it("creates a provider-backed track through one undoable command", () => {
    const doc = createDefaultProject();
    const command: Command = createGenerativeTrack(doc);
    const next = command.execute(doc);
    const track = generatedTrack(next);

    expect(track.generative.providerId).toBe("mrt2");
    expect(track.generative.modelId).toBe("mrt2_small");
    expect(track.generative.style).toEqual({ kind: "text", text: "dark atmospheric accompaniment" });
    expect(track.generative.macros).toEqual({ energy: 0.5, density: 0.35, variation: 0.25, texture: 0.5 });
    expect(command.undo(next)).toEqual(doc);
  });

  it("heals malformed provider config and source references during normalization", () => {
    const doc = createDefaultProject();
    const malformed: GenerativeTrack = {
      id: "gen-malformed",
      kind: "generative",
      name: "AI",
      gain: 0.8,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
      sends: {},
      generative: {
        providerId: "",
        modelId: "",
        style: { kind: "text", text: "x".repeat(1000) },
        noteSourceTrackId: "gen-malformed",
        chordSourceTrackId: "missing",
        drumsMode: "invalid" as "off",
        macros: { energy: 4, density: -1, variation: Number.NaN, texture: 0.25 },
        automation: [
          {
            id: "energy-lane",
            macro: "energy",
            points: [
              { tick: 20.4, value: 2 },
              { tick: -4, value: -1 },
            ],
          },
          { id: "bad-lane", macro: "unsupported", points: [{ tick: 0, value: 1 }] },
        ] as unknown as GenerativeTrack["generative"]["automation"],
        latencyMode: "invalid" as "live",
      },
    };
    const normalized = normalizeProject({ ...doc, tracks: [...doc.tracks, malformed] });
    const track = generatedTrack(normalized);

    expect(track.generative.providerId).toBe("mrt2");
    expect(track.generative.modelId).toBe("mrt2_small");
    expect(track.generative.style).toEqual({ kind: "text", text: "dark atmospheric accompaniment" });
    expect(track.generative.noteSourceTrackId).toBeUndefined();
    expect(track.generative.chordSourceTrackId).toBeUndefined();
    expect(track.generative.drumsMode).toBe("off");
    expect(track.generative.latencyMode).toBe("live");
    expect(track.generative.macros).toEqual({ energy: 1, density: 0, variation: 0.25, texture: 0.25 });
    expect(track.generative.automation).toEqual([
      {
        id: "energy-lane",
        macro: "energy",
        points: [
          { tick: 0, value: 0 },
          { tick: 20, value: 1 },
        ],
      },
    ]);
  });

  it("round-trips generative config through the Yjs adapter", () => {
    const base = createDefaultProject();
    const doc = createGenerativeTrack(base).execute(base);
    const yDoc = new Y.Doc();
    projectToYDoc(doc, yDoc.getMap("project"));
    const restored = yDocToProject(yDoc.getMap("project"));

    const originalTrack = generatedTrack(doc);
    const restoredTrack = generatedTrack(restored);
    expect(restoredTrack.kind).toBe("generative");
    expect(restoredTrack.id).toBe(originalTrack.id);
    expect(restoredTrack.generative).toEqual(originalTrack.generative);
  });

  it("keeps host-local connection details out of the persisted project shape", () => {
    const base = createDefaultProject();
    const doc = createGenerativeTrack(base).execute(base);
    const raw = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    const tracks = raw.tracks as Array<Record<string, unknown>>;
    const generative = tracks.find((track) => track.kind === "generative");
    if (!generative) throw new Error("Generative track missing");
    const config = generative.generative as Record<string, unknown>;
    config.endpoint = "ws://127.0.0.1:8765";
    config.authToken = "must-not-persist";
    config.modelPath = "C:/models/mrt2";

    const normalized = normalizeProject(raw as never);
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain("must-not-persist");
    expect(serialized).not.toContain("C:/models/mrt2");
    expect(serialized).not.toContain("127.0.0.1:8765");
  });
});
