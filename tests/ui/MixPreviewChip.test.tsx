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
import {
  armMixPreviewLane,
  clearMixPreviewLane,
  currentMixPreviewLane,
  type MixPreviewLane,
} from "../../src/mcp/mix-preview";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";

function fakeLane(doc: ProjectDocument): MixPreviewLane {
  return {
    id: "mp-test",
    idea: "warmer and glue the drums",
    label: "warmth + glue (production)",
    targets: ["drums"],
    goals: ["warmer", "glue"],
    interpreter: "production",
    steps: [],
    warnings: [],
    beforeDoc: doc,
    afterDoc: doc,
    command: { execute: (input: unknown) => input, label: "test" } as never,
    stats: { beforeLufs: -14.2, afterLufs: -13.1, matchGainDb: -1.1, seconds: 12.4 },
    createdAt: new Date().toISOString(),
  };
}

/**
 * The store must expose the document: APPLY first checks that the project has
 * not moved under the preview (mixPreviewMatchesProject compares the lane's
 * beforeDoc with the live one), and a store that cannot say what it holds
 * cannot be applied to.
 */
function mountedServices(doc: ProjectDocument) {
  return {
    store: { execute: vi.fn(), getDoc: () => doc },
    bank: {},
  } as unknown as Services;
}

describe("MixPreviewChip", () => {
  it("renders nothing without a lane", () => {
    clearMixPreviewLane();
    const { container } = render(
      <ServicesContext.Provider value={mountedServices(createProjectFromTemplate("house"))}>
        <MixPreviewChip />
      </ServicesContext.Provider>,
    );
    expect(container.querySelector(".mix-preview-card")).toBeNull();
  });

  it("appears when a lane is armed and APPLY executes the command through the store", async () => {
    clearMixPreviewLane();
    const doc = createProjectFromTemplate("house");
    const services = mountedServices(doc);
    render(
      <ServicesContext.Provider value={services}>
        <MixPreviewChip />
      </ServicesContext.Provider>,
    );

    const lane = fakeLane(doc);
    act(() => armMixPreviewLane(lane));
    expect(screen.getByText("MIX PREVIEW")).toBeTruthy();
    expect(screen.getByText(lane.label)).toBeTruthy();
    expect(screen.getByText(/before -14.2/)).toBeTruthy();
    expect(screen.getByText(/level-matched -1.1 dB/)).toBeTruthy();

    // APPLY is asynchronous: it applies, then re-renders to verify the
    // result, so the card's final shape is only known once that settles.
    await act(async () => {
      fireEvent.click(screen.getByText("APPLY"));
    });
    expect(services.store.execute).toHaveBeenCalledTimes(1);
    expect(services.store.execute).toHaveBeenCalledWith(lane.command);
    // The lane is consumed — and the card turns into the post-apply check
    // (it does not simply vanish: the check is what the human reads next).
    expect(currentMixPreviewLane()).toBeNull();
    expect(await screen.findByText("POST-APPLY CHECK")).toBeTruthy();
    expect(screen.queryByText("MIX PREVIEW")).toBeNull();
  });

  it("dismisses without touching the project", () => {
    clearMixPreviewLane();
    const doc = createProjectFromTemplate("house");
    const services = mountedServices(doc);
    render(
      <ServicesContext.Provider value={services}>
        <MixPreviewChip />
      </ServicesContext.Provider>,
    );

    act(() => armMixPreviewLane(fakeLane(doc)));
    expect(screen.getByText("MIX PREVIEW")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss preview" }));
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(screen.queryByText("MIX PREVIEW")).toBeNull();
  });
});

describe("MixPreviewChip — staleness guard (CF-19)", () => {
  it("NEGATIVE: APPLY after the project moved under the preview refuses and runs nothing", async () => {
    clearMixPreviewLane();
    const doc = createProjectFromTemplate("house");
    const services = mountedServices(doc);
    render(
      <ServicesContext.Provider value={services}>
        <MixPreviewChip />
      </ServicesContext.Provider>,
    );

    // The lane froze the doc the user auditioned…
    const lane = fakeLane(doc);
    act(() => armMixPreviewLane(lane));
    expect(screen.getByText("MIX PREVIEW")).toBeTruthy();

    // …and the project moved since: a different document is live now.
    const moved = { ...doc, bpm: 172 };
    (services.store as { getDoc: () => ProjectDocument }).getDoc = () => moved;

    await act(async () => {
      fireEvent.click(screen.getByText("APPLY"));
    });

    // What was heard must not land: the command never runs and the chip says
    // how to get a fresh preview instead of applying a stale one.
    expect(services.store.execute).not.toHaveBeenCalled();
    expect(await screen.findByText(/Project changed after this preview/)).toBeTruthy();
    expect(currentMixPreviewLane()).not.toBeNull();
  });
});
