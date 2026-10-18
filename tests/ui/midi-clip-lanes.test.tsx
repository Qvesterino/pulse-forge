import { afterEach, describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices } from "../helpers";
import { BAR_TICKS, type ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";
import { addMidiClip } from "../../src/commands/midiClips";
import {
  MIDI_CLIP_EDITOR_NAVIGATION_EVENT,
  type MidiClipEditorNavigationRequest,
} from "../../src/ui/arrangement/midiClipEditorNavigation";
import { MidiClipLanes } from "../../src/ui/arrangement/MidiClipLanes";

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

  it("double-click selects the source pattern and navigates to the MIDI clip start", () => {
    const source = createProjectFromTemplate("house");
    const track = source.tracks.find((candidate) => candidate.kind === "instrument");
    const sourcePattern = source.patterns.find((candidate) => candidate.id === source.activePatternId);
    if (!track || track.kind !== "instrument" || !sourcePattern)
      throw new Error("house template needs an instrument and an active pattern");
    const targetPatternId = "midi-clip-navigation-target";
    const targetPattern = { ...sourcePattern, id: targetPatternId, name: "Navigation Target" };
    const base: ProjectDocument = {
      ...source,
      patterns: [...source.patterns, targetPattern],
      arrangement: { ...source.arrangement, midiClips: [] },
    };
    const withClip = addMidiClip(base, track.id, targetPatternId, BAR_TICKS * 6, BAR_TICKS * 2).execute(base);
    const clip = withClip.arrangement.midiClips![0]!;
    const project = new ProjectStore(withClip);
    const selectionStore = new SelectionStore();
    const services = { ...mockServices(withClip), store: project } as unknown as Services;
    const navigation: MidiClipEditorNavigationRequest[] = [];
    const captureNavigation = (event: Event) => {
      navigation.push((event as CustomEvent<MidiClipEditorNavigationRequest>).detail);
    };
    window.addEventListener(MIDI_CLIP_EDITOR_NAVIGATION_EVENT, captureNavigation);
    try {
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

      act(() => fireEvent.doubleClick(screen.getByRole("button", { name: /Navigation Target MIDI clip/ })));

      expect(project.getDoc().activePatternId).toBe(targetPatternId);
      expect(services.playback.seek).toHaveBeenCalledWith(BAR_TICKS * 6);
      expect(navigation).toEqual([
        {
          clipId: clip.id,
          trackId: track.id,
          patternId: targetPatternId,
          startTick: BAR_TICKS * 6,
          phaseOffsetTicks: 0,
        },
      ]);
    } finally {
      window.removeEventListener(MIDI_CLIP_EDITOR_NAVIGATION_EVENT, captureNavigation);
    }
  });

  it("marks shared MIDI sources and Make unique & edit isolates one placement", () => {
    const source = createProjectFromTemplate("house");
    const track = source.tracks.find((candidate) => candidate.kind === "instrument");
    const pattern = source.patterns.find((candidate) => candidate.id === source.activePatternId);
    if (!track || track.kind !== "instrument" || !pattern) throw new Error("house template fixture is incomplete");
    const base: ProjectDocument = { ...source, arrangement: { ...source.arrangement, midiClips: [] } };
    const first = addMidiClip(base, track.id, pattern.id, 0, BAR_TICKS * 2).execute(base);
    const firstClip = first.arrangement.midiClips![0]!;
    const withSecond = addMidiClip(first, track.id, pattern.id, BAR_TICKS * 4, BAR_TICKS * 2).execute(first);
    const secondClip = withSecond.arrangement.midiClips!.find((clip) => clip.id !== firstClip.id)!;
    const project = new ProjectStore(withSecond);
    const selectionStore = new SelectionStore();
    const services = { ...mockServices(withSecond), store: project } as unknown as Services;
    const view = render(
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

    const linkedClips = view.container.querySelectorAll(".arr-midi-clip.shared-source");
    expect(linkedClips).toHaveLength(2);
    const firstLinkedClip = linkedClips[0] as HTMLButtonElement;
    expect(firstLinkedClip.getAttribute("aria-label")).toContain("shared source pattern used by 3 placements");
    expect(firstLinkedClip.title).toContain("editing it changes all 3 arrangement placements");

    const clipButton = view.container.querySelectorAll(".arr-midi-clip")[1] as HTMLButtonElement;
    act(() => fireEvent.contextMenu(clipButton, { clientX: 120, clientY: 80 }));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "Make unique & edit" })));

    const nextClips = project.getDoc().arrangement.midiClips!;
    const unchangedClip = nextClips.find((clip) => clip.id === firstClip.id)!;
    const uniqueClip = nextClips.find((clip) => clip.id === secondClip.id)!;
    expect(unchangedClip.patternId).toBe(pattern.id);
    expect(uniqueClip.patternId).not.toBe(pattern.id);
    expect(project.getDoc().activePatternId).toBe(uniqueClip.patternId);
    expect(services.playback.seek).toHaveBeenCalledWith(BAR_TICKS * 4);
    expect(view.container.querySelectorAll(".arr-midi-clip.shared-source")).toHaveLength(1);
    expect((view.container.querySelectorAll(".arr-midi-clip")[1] as HTMLButtonElement).title).toContain(
      "Source pattern: edits apply to this pattern.",
    );
  });

  it("does not show the batch note editor for a single MIDI clip, then edits a multi-selection", () => {
    const source = createProjectFromTemplate("house");
    const track = source.tracks.find((candidate) => candidate.kind === "instrument");
    const pattern = source.patterns.find((candidate) => candidate.id === source.activePatternId);
    if (!track || track.kind !== "instrument" || !pattern) throw new Error("house template fixture is incomplete");
    const notes = [
      { id: "multi-edit-note-a", pitch: 48, start: 0, duration: 240, velocity: 0.8 },
      { id: "multi-edit-note-b", pitch: 55, start: 240, duration: 120, velocity: 0.6 },
    ];
    const base: ProjectDocument = {
      ...source,
      patterns: source.patterns.map((candidate) =>
        candidate.id === pattern.id ? { ...candidate, notes: { ...candidate.notes, [track.id]: notes } } : candidate,
      ),
      arrangement: { ...source.arrangement, midiClips: [] },
    };
    const first = addMidiClip(base, track.id, pattern.id, 0, BAR_TICKS * 2).execute(base);
    const firstClip = first.arrangement.midiClips![0]!;
    const second = addMidiClip(first, track.id, pattern.id, BAR_TICKS * 4, BAR_TICKS * 2).execute(first);
    const secondClip = second.arrangement.midiClips!.find((clip) => clip.id !== firstClip.id)!;
    const third = addMidiClip(second, track.id, pattern.id, BAR_TICKS * 8, BAR_TICKS * 2).execute(second);
    const thirdClip = third.arrangement.midiClips!.find(
      (clip) => clip.id !== firstClip.id && clip.id !== secondClip.id,
    )!;
    const project = new ProjectStore(third);
    const selectionStore = new SelectionStore();
    const services = { ...mockServices(third), store: project } as unknown as Services;
    const view = render(
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

    const clipButtons = [...view.container.querySelectorAll(".arr-midi-clip")] as HTMLButtonElement[];
    expect(clipButtons).toHaveLength(3);
    act(() => fireEvent.contextMenu(clipButtons[0]!, { clientX: 120, clientY: 80 }));
    expect(screen.queryByRole("menuitem", { name: /Edit note properties/ })).toBeNull();
    act(() => fireEvent.mouseDown(view.container.querySelector(".arr-midi-lanes-heading")!));
    act(() => {
      fireEvent.pointerDown(clipButtons[0]!, { button: 0, clientX: 20, pointerId: 1 });
      fireEvent.pointerUp(clipButtons[0]!, { pointerId: 1 });
      fireEvent.pointerDown(clipButtons[1]!, { button: 0, clientX: 180, ctrlKey: true, pointerId: 2 });
    });
    expect(selectionStore.getState().clipIds).toEqual([firstClip.id, secondClip.id]);
    act(() => fireEvent.contextMenu(clipButtons[1]!, { clientX: 120, clientY: 80 }));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "Edit note properties in 2 objects…" })));

    expect(screen.getByRole("dialog", { name: "Edit notes in 2 MIDI objects" })).toBeTruthy();
    expect(screen.getByText(/2 source notes across 2 objects/)).toBeTruthy();
    act(() => fireEvent.change(screen.getByRole("spinbutton", { name: "Transpose" }), { target: { value: "2" } }));
    const historyBefore = project.undoStackLength;
    act(() => fireEvent.click(screen.getByRole("button", { name: "Apply as one edit" })));

    const editedClips = project.getDoc().arrangement.midiClips!;
    const editedFirst = editedClips.find((clip) => clip.id === firstClip.id)!;
    const editedSecond = editedClips.find((clip) => clip.id === secondClip.id)!;
    const unselectedThird = editedClips.find((clip) => clip.id === thirdClip.id)!;
    expect(editedFirst.patternId).not.toBe(pattern.id);
    expect(editedSecond.patternId).toBe(editedFirst.patternId);
    expect(unselectedThird.patternId).toBe(pattern.id);
    const editedNotes = project.getDoc().patterns.find((candidate) => candidate.id === editedFirst.patternId)!.notes[
      track.id
    ];
    expect(editedNotes.map(({ pitch, start, duration, velocity }) => ({ pitch, start, duration, velocity }))).toEqual(
      notes.map(({ pitch, start, duration, velocity }) => ({ pitch: pitch + 2, start, duration, velocity })),
    );
    expect(project.getDoc().patterns.find((candidate) => candidate.id === pattern.id)!.notes[track.id]).toEqual(notes);
    expect(project.undoStackLength).toBe(historyBefore + 1);
    act(() => project.undo());
    expect(project.getDoc().arrangement.midiClips?.map((clip) => clip.patternId)).toEqual([
      pattern.id,
      pattern.id,
      pattern.id,
    ]);
    act(() => project.redo());
    expect(project.getDoc().arrangement.midiClips?.find((clip) => clip.id === firstClip.id)?.patternId).toBe(
      editedFirst.patternId,
    );
  });

  it("duplicates a MIDI clip as one undoable edit", () => {
    const source = createProjectFromTemplate("house");
    const track = source.tracks.find((candidate) => candidate.kind === "instrument");
    const pattern = source.patterns.find((candidate) => candidate.id === source.activePatternId);
    if (!track || track.kind !== "instrument" || !pattern) throw new Error("house template fixture is incomplete");
    const base: ProjectDocument = { ...source, arrangement: { ...source.arrangement, midiClips: [] } };
    const withClip = addMidiClip(base, track.id, pattern.id, BAR_TICKS * 2, BAR_TICKS * 2).execute(base);
    const project = new ProjectStore(withClip);
    const selectionStore = new SelectionStore();
    const services = { ...mockServices(withClip), store: project } as unknown as Services;
    const undoLength = project.undoStackLength;
    const view = render(
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

    act(() => fireEvent.contextMenu(view.container.querySelector(".arr-midi-clip") as HTMLButtonElement));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" })));

    expect(project.getDoc().arrangement.midiClips?.map((clip) => clip.startTick)).toEqual([
      BAR_TICKS * 2,
      BAR_TICKS * 4,
    ]);
    expect(project.undoStackLength).toBe(undoLength + 1);
    act(() => project.undo());
    expect(project.getDoc().arrangement.midiClips).toHaveLength(1);
  });

  it("counts shared placements outside the viewport-filtered clip list", () => {
    const source = createProjectFromTemplate("house");
    const track = source.tracks.find((candidate) => candidate.kind === "instrument");
    const pattern = source.patterns.find((candidate) => candidate.id === source.activePatternId);
    const scene = source.scenes[0];
    if (!track || track.kind !== "instrument" || !pattern || !scene)
      throw new Error("house template fixture is incomplete");
    const base: ProjectDocument = {
      ...source,
      scenes: source.scenes.map((candidate) =>
        candidate.id === scene.id ? { ...candidate, patternId: pattern.id } : candidate,
      ),
      arrangement: {
        ...source.arrangement,
        clips: [{ id: "shared-scene-placement", sceneId: scene.id, startBar: 0, lengthBars: 4 }],
        midiClips: [],
      },
    };
    const first = addMidiClip(base, track.id, pattern.id, 0, BAR_TICKS * 2).execute(base);
    const second = addMidiClip(first, track.id, pattern.id, BAR_TICKS * 4, BAR_TICKS * 2).execute(first);
    const third = addMidiClip(second, track.id, pattern.id, BAR_TICKS * 50, BAR_TICKS * 2).execute(second);
    const allClips = third.arrangement.midiClips!;
    const view = render(
      createElement(MidiClipLanes, {
        doc: third,
        tracks: third.tracks,
        midiClips: allClips.slice(0, 2),
        selectedClipIds: [],
        totalBars: 60,
        barWidth: 30,
        snapGrid: "1",
        playheadTick: 0,
        onExecute: () => true,
        onSelect: () => {},
        onEditSource: () => {},
        onMakeUniqueAndEdit: () => {},
      }),
    );

    const renderedClips = view.container.querySelectorAll(".arr-midi-clip");
    expect(renderedClips).toHaveLength(2);
    expect((renderedClips[0] as HTMLButtonElement).getAttribute("aria-label")).toContain(
      "shared source pattern used by 4 placements",
    );
    expect((renderedClips[0] as HTMLButtonElement).title).toContain("all 4 arrangement placements");
  });
});
