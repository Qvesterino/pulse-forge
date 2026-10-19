import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { addEffect } from "../../src/commands/commands";
import { MASTER_EFFECT_OWNER_ID } from "../../src/project-model/types";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { eqBands, eqHzToX } from "../../src/effects/eqCurve";
import { MasterSpectrumEq } from "../../src/ui/MasterSpectrumEq";
import { mockServices, renderWithContext } from "../helpers";

const WIDTH = 300;
const HEIGHT = 100;

function stubCanvas(canvas: HTMLCanvasElement): void {
  Object.defineProperty(canvas, "clientWidth", { value: WIDTH, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: HEIGHT, configurable: true });
  canvas.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      width: WIDTH,
      height: HEIGHT,
      top: 0,
      left: 0,
      right: WIDTH,
      bottom: HEIGHT,
      toJSON: () => ({}),
    }) as DOMRect;
  canvas.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  canvas.hasPointerCapture = () => true;
}

function projectWithMasterEq() {
  const doc = createProjectFromTemplate("house");
  const command = addEffect(doc, MASTER_EFFECT_OWNER_ID, "eq");
  return command.execute(doc);
}

afterEach(() => cleanup());

describe("MasterSpectrumEq", () => {
  it("does not add EQ before user asks for it", () => {
    const services = mockServices();
    renderWithContext(<MasterSpectrumEq analyser={null} id="test" />, { services });

    expect(screen.getByRole("group", { name: "Master spectrum and EQ" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add master EQ" })).toBeInTheDocument();
    expect(screen.queryByRole("application", { name: /EQ response curve/ })).not.toBeInTheDocument();
    expect(services.store.execute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Add master EQ" }));
    expect(services.store.execute).toHaveBeenCalledTimes(1);
    const command = vi.mocked(services.store.execute).mock.calls[0]?.[0];
    expect(command?.type).toBe("addEffect");
    expect(command?.execute(services.store.getDoc()).master.effects?.[0]?.type).toBe("eq");
  });

  it("commits curve drags and bypass through the master effect command path", () => {
    const doc = projectWithMasterEq();
    const services = mockServices(doc);
    const { container } = renderWithContext(<MasterSpectrumEq analyser={null} id="test" />, { services });
    const eq = doc.master.effects?.[0];
    expect(eq?.type).toBe("eq");

    const canvas = container.querySelector<HTMLCanvasElement>("canvas.master-spectrum-eq-curve");
    expect(canvas).not.toBeNull();
    stubCanvas(canvas!);
    const band = eqBands(eq!.params).find((candidate) => candidate.paramId === "highMidGain")!;
    const x = eqHzToX(band.freqHz, WIDTH);
    const y = HEIGHT / 2;
    fireEvent.pointerDown(canvas!, { clientX: x, clientY: y, pointerId: 1, bubbles: true });
    fireEvent.pointerMove(canvas!, { clientX: x, clientY: y - 8, pointerId: 1, bubbles: true });
    fireEvent.pointerUp(canvas!, { clientX: x, clientY: y - 8, pointerId: 1, bubbles: true });

    expect(services.store.execute).toHaveBeenCalledTimes(1);
    const edit = vi.mocked(services.store.execute).mock.calls[0]?.[0];
    expect(edit?.type).toBe("setEffectParam");
    expect(edit?.execute(doc).master.effects?.[0]?.params.highMidGain).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Bypass master EQ" }));
    expect(services.store.execute).toHaveBeenCalledTimes(2);
    const bypass = vi.mocked(services.store.execute).mock.calls[1]?.[0];
    expect(bypass?.execute(doc).master.effects?.[0]?.bypassed).toBe(true);
  });
});
