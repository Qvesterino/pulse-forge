import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { SessionStateIndicator } from "../../src/ui/SessionStateIndicator";
import {
  getSessionRecordingState,
  IDLE_SESSION_STATE,
  publishSessionRecordingState,
  subscribeSessionRecordingState,
} from "../../src/ui/sessionStateSurface";
import { ServicesContext } from "../../src/ui/context";
import { mockServices } from "../helpers";

function renderIndicator() {
  const onOpenArrangement = vi.fn();
  const services = mockServices();
  const { container } = render(
    <ServicesContext.Provider value={services}>
      <SessionStateIndicator onOpenArrangement={onOpenArrangement} />
    </ServicesContext.Provider>,
  );
  return { container, onOpenArrangement, services };
}

afterEach(() => {
  publishSessionRecordingState(IDLE_SESSION_STATE);
});

describe("sessionStateSurface store", () => {
  it("publish merges patches and skips no-op notifications", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionRecordingState(listener);
    publishSessionRecordingState({ armedTrackNames: ["Lead Vocal"], recState: "recording" });
    expect(listener).toHaveBeenCalledTimes(1);
    // Same values again — no notification.
    publishSessionRecordingState({ armedTrackNames: ["Lead Vocal"], recState: "recording" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSessionRecordingState().armedTrackNames).toEqual(["Lead Vocal"]);
    unsubscribe();
  });
});

describe("SessionStateIndicator", () => {
  it("renders nothing when every axis is idle", () => {
    const { container } = renderIndicator();
    expect(container.querySelector(".session-state")).toBeNull();
  });

  it("shows armed track, REC state and punch range when published", () => {
    publishSessionRecordingState({
      armedTrackNames: ["Lead Vocal", "Guitar"],
      recState: "recording",
      punchRange: "9.1 → 13.0",
      loopTakes: false,
      takeModeLabel: null,
    });
    const { container } = renderIndicator();
    expect(container.textContent).toContain("● REC");
    expect(container.textContent).toContain("ARMED: Lead Vocal +1");
    expect(container.textContent).toContain("PUNCH 9.1 → 13.0");
    expect(container.textContent).not.toContain("LOOP TAKES");
  });

  it("shows loop takes, metronome and count-in chips", () => {
    vi.useFakeTimers();
    publishSessionRecordingState({ loopTakes: true, takeModeLabel: "NEW TAKE GROUP" });
    const services = mockServices();
    // mockServices exposes transport through getters — replace the property
    // with the flagged transport for the poll to read.
    const flaggedTransport = {
      ...(services.transport as unknown as object),
      metronome: true,
      countInBars: 1,
    };
    Object.defineProperty(services, "transport", { get: () => flaggedTransport, configurable: true });
    const { container } = render(
      <ServicesContext.Provider value={services}>
        <SessionStateIndicator onOpenArrangement={() => {}} />
      </ServicesContext.Provider>,
    );
    act(() => {
      vi.advanceTimersByTime(300); // first poll tick
    });
    expect(container.textContent).toContain("LOOP TAKES");
    expect(container.textContent).toContain("NEW TAKE GROUP");
    expect(container.textContent).toContain("METRO");
    expect(container.textContent).toContain("COUNT-IN 1");
    vi.useRealTimers();
  });

  it("clicking the group opens the arrangement REC strip", () => {
    publishSessionRecordingState({ armedTrackNames: ["Bass"] });
    const { container, onOpenArrangement } = renderIndicator();
    const group = container.querySelector(".session-state-group") as HTMLElement;
    group.click();
    expect(onOpenArrangement).toHaveBeenCalledTimes(1);
  });

  it("starts the REC chip in its starting state before capture arms", () => {
    publishSessionRecordingState({ armedTrackNames: ["Bass"], recState: "starting" });
    const { container } = renderIndicator();
    expect(container.textContent).toContain("◌ REC");
  });
});
