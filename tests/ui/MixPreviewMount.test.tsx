import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { MixPreviewMount } from "../../src/ui/MixPreviewChip";
import { ServicesContext } from "../../src/ui/context";
import { armMixPreviewLane, clearMixPreviewLane, type MixPreviewLane } from "../../src/mcp/mix-preview";
import type { Services } from "../../src/services";

afterEach(() => act(() => clearMixPreviewLane()));

it("keeps the post-apply result visible after the armed lane is cleared", async () => {
  const doc = createProjectFromTemplate("house");
  const store = { getDoc: () => doc, execute: vi.fn() };
  const services = { store, bank: {} } as unknown as Services;
  render(
    <ServicesContext.Provider value={services}>
      <MixPreviewMount />
    </ServicesContext.Provider>,
  );
  const lane = {
    id: "preview",
    idea: "warmer bass",
    label: "warm bass",
    targets: ["bass"],
    goals: ["warmer"],
    interpreter: "production",
    steps: [],
    warnings: [],
    beforeDoc: doc,
    afterDoc: doc,
    command: { type: "test", label: "test", execute: (input: typeof doc) => input, undo: (input: typeof doc) => input },
    stats: { beforeLufs: -14, afterLufs: -14, matchGainDb: 0, seconds: 1 },
    createdAt: new Date().toISOString(),
  } satisfies MixPreviewLane;
  act(() => armMixPreviewLane(lane));
  const apply = await screen.findByRole("button", { name: "APPLY" });
  await act(async () => {
    fireEvent.click(apply);
  });
  expect(await screen.findByText("POST-APPLY CHECK", {}, { timeout: 15000 })).toBeTruthy();
  expect(store.execute).toHaveBeenCalledTimes(1);
});
