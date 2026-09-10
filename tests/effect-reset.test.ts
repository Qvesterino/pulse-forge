import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { resetEffect } from "../src/commands/commands";

describe("resetEffect", () => {
  it("resets a flagship plugin to its complete schema defaults and undoes exactly", () => {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
    track.effects = [
      {
        id: "fx-reset-vlyx",
        type: "ultina",
        bypassed: false,
        params: {
          "comp.enabled": 1,
          "comp.thresholdDb": -3,
          "eq.band11.gainDb": 14,
          "stale.unknown": 99,
        },
      },
    ];
    const before = structuredClone(doc);

    const command = resetEffect(doc, track.id, "fx-reset-vlyx");
    const reset = command.execute(doc);
    const resetFx = reset.tracks.find((candidate) => candidate.id === track.id)!.effects[0];
    expect(resetFx.params["comp.enabled"]).toBe(0);
    expect(resetFx.params["comp.thresholdDb"]).toBe(-20);
    expect(resetFx.params["eq.band11.gainDb"]).toBe(0);
    expect(resetFx.params["stale.unknown"]).toBeUndefined();

    const undone = command.undo(reset);
    expect(undone).toEqual(before);
  });

  it("does not clear a gate pattern while resetting effect parameters", () => {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
    track.effects = [
      {
        id: "fx-reset-delay",
        type: "delay",
        bypassed: false,
        params: { time: 800 },
        steps: [1, 0, 1, 1],
      },
    ];

    const reset = resetEffect(doc, track.id, "fx-reset-delay").execute(doc);
    const resetFx = reset.tracks.find((candidate) => candidate.id === track.id)!.effects[0];
    expect(resetFx.params.time).toBe(375);
    expect(resetFx.steps).toEqual([1, 0, 1, 1]);
  });
});
