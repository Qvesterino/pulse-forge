import { afterEach, describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices } from "../helpers";
import type { ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";

describe("instrument MIDI arrangement lanes", () => {
  afterEach(() => cleanup());

  it("adds the active pattern to an instrument lane as a resizable MIDI clip", () => {
    const source = createProjectFromTemplate("house");
    const track = source.tracks.find((candidate) => candidate.kind === "instrument");
    const pattern = source.patterns.find((candidate) => candidate.id === source.activePatternId);
    if (!track || track.kind !== "instrument" || !pattern) throw new Error("house template fixture is incomplete");
    const doc: ProjectDocument = { ...source, arrangement: { ...source.arrangement, midiClips: [] } };
    const project = new ProjectStore(doc);
    const selectionStore = new SelectionStore();
    const services = { ...mockServices(doc), store: project } as unknown as Services;
    render(
      createElement(
        ServicesContext.Provider,
        { value: services },
        createElement(
          SelectionContext.Provider,
          { value: selectionStore },
          createElement(ArrangementPanel) as ReactElement,
        ),
      ),
    );

    act(() => fireEvent.click(screen.getByRole("button", { name: `Add MIDI clip to ${track.name}` })));

    expect(project.getDoc().arrangement.midiClips).toMatchObject([
      {
        trackId: track.id,
        patternId: pattern.id,
        startTick: 0,
        lengthTicks: pattern.stepCount * 120,
      },
    ]);
    expect(screen.getByLabelText(`${track.name} MIDI lane`)).toBeTruthy();
  });
});
