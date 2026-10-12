import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { buildDefaultParams, REZ_PARAM, voiceParamId } from "../../src/effects/rezonans-core/contracts/parameters";
import { RezonansPanel } from "../../src/ui/RezonansPanel";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices, renderWithContext } from "../helpers";

function stub2dContext() {
  return new Proxy(
    {},
    {
      get() {
        return () => undefined;
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

describe("RezonansPanel manual note targets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(stub2dContext());
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows named absolute-note choices and commits the selected MIDI target", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    const params = buildDefaultParams();
    params[REZ_PARAM.harmonyMode] = 4;
    const onParam = vi.fn();

    const { container } = renderWithContext(
      <RezonansPanel trackId="t1" fxId="fx1" params={params} degraded={false} onParam={onParam} />,
      { services },
    );

    expect(container.querySelector(".rezonans-readout")).toHaveTextContent("MANUAL NOTES");
    const note = screen.getByRole("combobox", { name: "V1 target note" });
    expect(note).toHaveValue("60");
    expect(note.querySelectorAll("option")).toHaveLength(61);
    fireEvent.change(note, { target: { value: "64" } });
    expect(onParam).toHaveBeenCalledWith("voice0.note", 64);
  });

  it("keeps note selectors hidden in the existing degree mode", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    const params = buildDefaultParams();
    params[REZ_PARAM.harmonyMode] = 2;

    renderWithContext(<RezonansPanel trackId="t1" fxId="fx1" params={params} degraded={false} />, { services });

    expect(screen.queryByRole("combobox", { name: "V1 target note" })).not.toBeInTheDocument();
  });

  it("shows the applied note when the pitch-shift range limits the requested target", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    const engine = services.engine as unknown as {
      getFxMeters?: (trackId: string, fxId: string) => unknown;
      setFxMetersEnabled?: (trackId: string, fxId: string, enabled: boolean) => void;
    };
    let meters: unknown = null;
    engine.getFxMeters = () => meters;
    engine.setFxMetersEnabled = vi.fn();

    const params = buildDefaultParams();
    params[REZ_PARAM.harmonyMode] = 4;
    params[voiceParamId(0, "enabled")] = 1;
    params[voiceParamId(0, "note")] = 36; // C2, more than an octave below A4.

    renderWithContext(<RezonansPanel trackId="t1" fxId="fx1" params={params} degraded={false} />, { services });
    meters = {
      f0: 440,
      clarity: 0.99,
      chordPc: -1,
      latencySamples: 1536,
      sampleRate: 48000,
      voiceMidi: [57, -1, -1, -1], // Solver's applied target: A3 (−12 semitones).
      envelopeDb: new Float32Array(48),
      formants: new Float32Array([-1, -1, -1]),
    };

    act(() => vi.advanceTimersByTime(66));

    expect(screen.getByLabelText("V1 applied note range status")).toHaveTextContent("LIMIT A3");
    expect(screen.getByLabelText("V1 applied note range status")).toHaveAttribute(
      "title",
      "Requested C2 is limited to A3 by the ±12-semitone pitch range.",
    );
  });
});
