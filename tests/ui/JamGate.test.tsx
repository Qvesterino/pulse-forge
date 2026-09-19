import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { JamGate } from "../../src/ui/JamGate";
import { renderWithContext, mockServices } from "../helpers";

describe("JamGate", () => {
  function servicesWith(state: AudioContextState | "no-context" = "suspended") {
    const services = mockServices();
    const audioCtx =
      state === "no-context"
        ? null
        : ({
            state,
            resume: vi.fn(async () => {}),
          } as unknown as AudioContext);
    Object.defineProperty(services.engine, "context", {
      value: audioCtx,
      configurable: true,
      writable: true,
    });
    return services;
  }

  it("does not render when jamActive is false", () => {
    const services = servicesWith("suspended");
    renderWithContext(<JamGate services={services} jamActive={false} />);
    expect(screen.queryByLabelText(/Tap to join the live jam/i)).toBeNull();
  });

  it("renders the TAP TO JAM gate when jamActive is true and audio context is suspended", () => {
    const services = servicesWith("suspended");
    renderWithContext(<JamGate services={services} jamActive={true} />);
    expect(screen.getByText(/TAP TO JAM/i)).toBeInTheDocument();
  });

  it("does not render when audio context is already running", () => {
    const services = servicesWith("running");
    renderWithContext(<JamGate services={services} jamActive={true} />);
    expect(screen.queryByText(/TAP TO JAM/i)).toBeNull();
  });

  it("tapping the gate calls ensureContext and resume", () => {
    const services = servicesWith("suspended");
    renderWithContext(<JamGate services={services} jamActive={true} />);
    const gate = screen.getByLabelText(/Tap to join the live jam/i);
    fireEvent.pointerDown(gate);
    expect(services.engine.ensureContext).toHaveBeenCalled();
  });
});
