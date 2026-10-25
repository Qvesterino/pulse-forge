import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createDefaultProject } from "../../src/project-model/schema";
import { defaultInstrumentParams } from "../../src/instruments/definitions";
import type { InstrumentTrack, ProjectDocument } from "../../src/project-model/types";
import { KopaEditor } from "../../src/ui/KopaEditor";

/**
 * THE KOPA EDITOR — the graphic as a control.
 *
 * Three promises, all checked here:
 *
 *  - the graphic shows the values STORED IN THE PROJECT (not a guess);
 *  - a drag writes the document ONCE, as one command, and only the
 *    parameters the drag touched;
 *  - the audition NEVER touches the document — a comparison is not an edit.
 */

function setup() {
  const doc = createDefaultProject();
  const base = doc.tracks.find((track) => track.kind === "instrument")!;
  const track = {
    ...(base as InstrumentTrack),
    id: "kopa-track",
    instrument: "kopa",
    name: "KOPA",
    params: { ...defaultInstrumentParams("kopa") },
  } as InstrumentTrack;
  const project = { ...doc, tracks: [track] } as unknown as ProjectDocument;
  const execute = vi.fn();
  const previewInstrumentWithParams = vi.fn();
  const services = {
    store: { execute },
    engine: { previewInstrumentWithParams },
  };
  render(<KopaEditor track={track} doc={project} services={services} />);
  return { execute, previewInstrumentWithParams, track, project };
}

/** The instrument track's parameters (the Track union needs narrowing). */
function paramsOf(doc: ProjectDocument): Record<string, number> {
  const track = doc.tracks.find((candidate): candidate is InstrumentTrack => candidate.kind === "instrument");
  if (!track) throw new Error("no instrument track");
  return track.params;
}

const handle = (id: string) => document.querySelector(`[data-handle="${id}"]`) as SVGGElement;

describe("the KOPA editor", () => {
  it("shows the values STORED in the project", () => {
    setup();
    expect(handle("bodyDecay").getAttribute("aria-valuenow")).toBe("0.35");
    expect(handle("clickLevel").getAttribute("aria-valuenow")).toBe("0.35");
    expect(handle("tailLevel").getAttribute("aria-valuenow")).toBe("0.25");
    expect(handle("pitchAmount").getAttribute("aria-valuenow")).toBe("24");
    // Every handle is a real slider: focusable and announced.
    expect(handle("bodyDecay").getAttribute("role")).toBe("slider");
    expect(handle("bodyDecay").getAttribute("tabindex")).toBe("0");
    expect(handle("bodyDecay").getAttribute("aria-valuetext")).toContain("s");
  });

  it("a drag writes the document ONCE, as one command", () => {
    const { execute, project } = setup();
    const svg = document.querySelector(".kopa-editor-svg") as SVGSVGElement;
    const body = handle("bodyDecay");

    fireEvent.pointerDown(body, { clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 260, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 300, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 300, clientY: 100, pointerId: 1 });

    // ONE command for the whole drag — not one per pointer move.
    expect(execute).toHaveBeenCalledTimes(1);
    const command = execute.mock.calls[0]![0] as { type: string; execute: (d: ProjectDocument) => ProjectDocument };
    expect(command.type).toBe("setInstrumentParams");
    const next = command.execute(project);
    expect(paramsOf(next).bodyDecay).not.toBe(paramsOf(project).bodyDecay);
  });

  it("the drag changes only the parameter it touched", () => {
    const { execute, project } = setup();
    const svg = document.querySelector(".kopa-editor-svg") as SVGSVGElement;
    fireEvent.pointerDown(handle("tailLevel"), { clientX: 100, clientY: 120, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 100, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 100, clientY: 60, pointerId: 1 });

    expect(execute).toHaveBeenCalledTimes(1);
    const command = execute.mock.calls[0]![0] as { execute: (d: ProjectDocument) => ProjectDocument };
    const next = command.execute(project);
    const params = paramsOf(next);
    expect(params.tailLevel).not.toBe(paramsOf(project).tailLevel);
    // Everything else is untouched.
    expect(params.bodyDecay).toBe(paramsOf(project).bodyDecay);
    expect(params.clickLevel).toBe(paramsOf(project).clickLevel);
  });

  it("the audition never touches the document", () => {
    const { execute, previewInstrumentWithParams, track } = setup();
    fireEvent.click(screen.getByRole("button", { name: /A · SAVED/ }));
    expect(previewInstrumentWithParams).toHaveBeenCalledTimes(1);
    expect(previewInstrumentWithParams.mock.calls[0]![0]).toBe(track.id);
    // The saved side previews the document's own values — no overrides.
    expect(previewInstrumentWithParams.mock.calls[0]![2]).toEqual({});
    expect(execute).not.toHaveBeenCalled();
  });

  it("the keyboard writes one command per key press", () => {
    const { execute, project } = setup();
    const tail = handle("tailLevel");
    fireEvent.keyDown(tail, { key: "ArrowUp" });
    expect(execute).toHaveBeenCalledTimes(1);
    const command = execute.mock.calls[0]![0] as { execute: (d: ProjectDocument) => ProjectDocument };
    const next = command.execute(project);
    expect(paramsOf(next).tailLevel).toBeGreaterThan(paramsOf(project).tailLevel!);
    // And the value stays inside the parameter's range.
    expect(paramsOf(next).tailLevel).toBeLessThanOrEqual(1);
  });

  it("offers a handle only where the DSP has a parameter", () => {
    setup();
    // The body has no level parameter and the sub no decay of its own — the
    // graphic must not offer handles for them.
    expect(handle("bodyDecay")).toBeTruthy();
    expect(document.querySelector('[data-handle="bodyLevel"]')).toBeNull();
    expect(document.querySelector('[data-handle="subDecay"]')).toBeNull();
    // The lanes the graphic draws are the DSP's layers.
    expect(document.querySelector(".kopa-body")).toBeTruthy();
    expect(document.querySelector(".kopa-sub")).toBeTruthy();
    expect(document.querySelector(".kopa-harm")).toBeTruthy();
  });
});
