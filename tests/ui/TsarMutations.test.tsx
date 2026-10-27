import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TsarPanel } from "../../src/ui/TsarPanel";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { createInstrumentTrackModel } from "../../src/project-model/schema";
import type { InstrumentTrack, ProjectDocument } from "../../src/project-model/types";
import { MUTATION_GROUP_PARAMS } from "../../src/tsar/mutations";

/**
 * WAVE 4 — CONTROLLED MUTATIONS IN THE PANEL.
 *
 * The panel contract:
 *  - the producer sees the RANGE stops and the LOCK groups;
 *  - the seed is visible and can be typed back in;
 *  - the tournament stays BLIND and touches NOTHING until the winner is kept;
 *  - keeping the winner is ONE command whose label carries the run key, so
 *    the same variations can be invoked again later.
 */

function tsarDoc(): ProjectDocument {
  const base = createProjectFromTemplate("empty");
  const track = createInstrumentTrackModel("tsar", 1);
  track.id = "tsar-ui-track";
  track.name = "TSAR Lead";
  return { ...base, tracks: [track] };
}

function trackOf(doc: ProjectDocument): InstrumentTrack {
  return doc.tracks.find((t): t is InstrumentTrack => t.id === "tsar-ui-track")!;
}

/** Run the blind ladder to its end, always picking A. */
async function runLadderToTheEnd(user: ReturnType<typeof userEvent.setup>) {
  for (let round = 0; round < 12; round += 1) {
    const wins = screen.queryByRole("button", { name: "A WINS" });
    if (!wins) break;
    await user.click(wins);
  }
}

describe("TsarPanel — controlled mutations", () => {
  it("offers the range stops and the lock groups", () => {
    renderWithContext(<TsarPanel />, { services: mockServices(tsarDoc()) });

    const range = screen.getByRole("group", { name: "Mutation range" });
    for (const label of ["SUBTLE", "MEDIUM", "BOLD", "FULL"]) {
      expect(within(range).getByRole("button", { name: label })).toBeInTheDocument();
    }
    const locks = screen.getByRole("group", { name: "Locked parameter groups" });
    for (const label of ["SOURCE", "TUNING", "ENV", "FILTER", "MOD", "CHAR"]) {
      expect(within(locks).getByRole("button", { name: label })).toBeInTheDocument();
    }
    // The seed is VISIBLE and editable — a seed you cannot read back is not
    // a seed you can re-invoke.
    expect(screen.getByLabelText("Mutation seed")).toBeInTheDocument();
    expect(screen.getByText(/seed 1234567/)).toBeInTheDocument();
  });

  it("a mutation run touches the project nothing — the ladder is blind", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    await user.click(screen.getByRole("button", { name: "MUTATE PATCH" }));
    expect(screen.getByText(/BLIND A\/B — round 1\//)).toBeInTheDocument();
    // Nothing was committed: the comparison must not change the patch.
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("keeping the winner is ONE command, and its label carries the run key", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    await user.click(screen.getByRole("button", { name: "MUTATE PATCH" }));
    await runLadderToTheEnd(user);
    expect(screen.getByText(/WINNER:/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "KEEP WINNER" }));
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const command = executeSpy.mock.calls[0]![0] as { type: string; label: string };
    expect(command.type).toBe("applyInstrumentPatch");
    // The run key travels with the patch, so the variations can be invoked
    // again later.
    expect(command.label).toContain("seed 1234567");
    expect(command.label).toContain("FULL");
  });

  it("a locked group stays bit-identical in the applied patch", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    const before = { ...trackOf(services.store.doc).params };
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    const locks = screen.getByRole("group", { name: "Locked parameter groups" });
    await user.click(within(locks).getByRole("button", { name: "TUNING" }));
    await user.click(screen.getByRole("button", { name: "MUTATE PATCH" }));
    await runLadderToTheEnd(user);
    await user.click(screen.getByRole("button", { name: "KEEP WINNER" }));

    const command = executeSpy.mock.calls[0]![0] as { execute: (doc: ProjectDocument) => ProjectDocument };
    const after = trackOf(command.execute(services.store.doc)).params;
    for (const id of MUTATION_GROUP_PARAMS.tuning) {
      if (!(id in before)) continue;
      expect(after[id], `${id} is locked and must not move`).toBe(before[id]);
    }
  });

  it("the seed can be typed back in, and the same seed gives the same variations", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    renderWithContext(<TsarPanel />, { services });

    const seedInput = screen.getByLabelText("Mutation seed");
    await user.type(seedInput, "4242");
    await user.click(screen.getByRole("button", { name: "SET" }));
    expect(screen.getByText(/seed 4242/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "MUTATE PATCH" }));
    const firstRound = screen.getByText(/BLIND A\/B — round 1\//).textContent;

    // The run is recorded, so the same variations can come back later.
    const recent = screen.getByRole("group", { name: "Recent mutation runs" });
    expect(within(recent).getByRole("button", { name: /seed 4242/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "DISCARD" }));
    await user.click(screen.getByRole("button", { name: "MUTATE PATCH" }));
    expect(screen.getByText(/BLIND A\/B — round 1\//).textContent).toBe(firstRound);
  });

  it("locking every group says so instead of silently doing nothing", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    renderWithContext(<TsarPanel />, { services });

    const locks = screen.getByRole("group", { name: "Locked parameter groups" });
    for (const label of ["SOURCE", "TUNING", "ENV", "FILTER", "MOD", "CHAR"]) {
      await user.click(within(locks).getByRole("button", { name: label }));
    }
    await user.click(screen.getByRole("button", { name: "MUTATE PATCH" }));
    expect(screen.getByText(/every live group is locked/i)).toBeInTheDocument();
    expect(screen.queryByText(/BLIND A\/B/)).not.toBeInTheDocument();
  });
});
