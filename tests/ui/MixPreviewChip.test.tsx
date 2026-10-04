/**
 * MixPreviewChip — the studio half of kyx_mix_idea preview mode.
 *
 * The card exists only while a lane is armed; APPLY executes the stored
 * command through the store (ONE undo step) and dismisses; DISMISS throws
 * the lane away without touching the project.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ServicesContext } from "../../src/ui/context";
import { MixPreviewChipLazy as MixPreviewChip } from "../../src/ui/MixPreviewChipLazy";
import { armMixPreviewLane, clearMixPreviewLane, type MixPreviewLane } from "../../src/mcp/mix-preview";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { Services } from "../../src/services";

function fakeLane(): MixPreviewLane {
  const doc = createProjectFromTemplate("house");
  return {
    id: "mp-test",
    idea: "warmer and glue the drums",
    label: "warmth + glue (production)",
    targets: ["drums"],
    goals: ["warmer", "glue"],
    interpreter: "production",
    beforeDoc: doc,
    afterDoc: doc,
    command: { execute: (input: unknown) => input, label: "test" } as never,
    stats: { beforeLufs: -14.2, afterLufs: -13.1, matchGainDb: -1.1, seconds: 12.4 },
    createdAt: new Date().toISOString(),
  };
}

function mountedServices() {
  return {
    store: { execute: vi.fn() },
    bank: {},
  } as unknown as Services;
}

describe("MixPreviewChip", () => {
  it("renders nothing without a lane", () => {
    clearMixPreviewLane();
    const { container } = render(
      <ServicesContext.Provider value={mountedServices()}>
        <MixPreviewChip />
      </ServicesContext.Provider>,
    );
    expect(container.querySelector(".mix-preview-card")).toBeNull();
  });

  it("appears when a lane is armed and APPLY executes the command through the store", () => {
    clearMixPreviewLane();
    const services = mountedServices();
    render(
      <ServicesContext.Provider value={services}>
        <MixPreviewChip />
      </ServicesContext.Provider>,
    );

    const lane = fakeLane();
    act(() => armMixPreviewLane(lane));
    expect(screen.getByText("MIX PREVIEW")).toBeTruthy();
    expect(screen.getByText(lane.label)).toBeTruthy();
    expect(screen.getByText(/before -14.2/)).toBeTruthy();
    expect(screen.getByText(/level-matched -1.1 dB/)).toBeTruthy();

    fireEvent.click(screen.getByText("APPLY"));
    expect(services.store.execute).toHaveBeenCalledTimes(1);
    expect(services.store.execute).toHaveBeenCalledWith(lane.command);
    // The lane is consumed — the card leaves.
    expect(screen.queryByText("MIX PREVIEW")).toBeNull();
  });

  it("dismisses without touching the project", () => {
    clearMixPreviewLane();
    const services = mountedServices();
    render(
      <ServicesContext.Provider value={services}>
        <MixPreviewChip />
      </ServicesContext.Provider>,
    );

    act(() => armMixPreviewLane(fakeLane()));
    expect(screen.getByText("MIX PREVIEW")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss preview" }));
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(screen.queryByText("MIX PREVIEW")).toBeNull();
  });
});
