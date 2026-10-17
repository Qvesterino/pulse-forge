import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { IntentPanel } from "../../src/ui/IntentPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { renderWithContext, mockServices } from "../helpers";
import { resetTapeForTests, tapeSteps } from "../../src/intent/session-tape";
import { buildSessionStory } from "../../src/services/sessionStory";
import type { Services } from "../../src/services";

/**
 * SESSION TAPE, THROUGH THE REAL PANEL.
 *
 * The journal must be filled by the gestures themselves (DO IT, USE, a route
 * action), and REWIND must go through the store's own history jump — including
 * the refusal, where a step that applied nothing reports why instead of
 * silently landing somewhere else.
 *
 * `rerankTopBySound` is the identity (the established jsdom pattern); the tape
 * does not care which order the bank is in, only which steps happened.
 */

vi.mock("../../src/intent/ranking-v3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intent/ranking-v3")>();
  return { ...actual, rerankTopBySound: vi.fn(async (_doc, bank) => [...bank]) };
});

function setup() {
  localStorage.clear();
  resetTapeForTests();
  const doc = createProjectFromTemplate("house");
  const project = new ProjectStore(doc);
  const jumpTo = vi.spyOn(project, "jumpTo");
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  renderWithContext(<IntentPanel />, { services });
  return { project, jumpTo };
}

function askAndDo(prompt: string): void {
  fireEvent.change(screen.getByLabelText(/Intent description/i), { target: { value: prompt } });
  fireEvent.click(screen.getByRole("button", { name: /DO IT/i }));
}

beforeEach(() => {
  localStorage.clear();
  resetTapeForTests();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetTapeForTests();
});

describe("session tape in the panel", () => {
  it("journals generation, application and a later route action — then rewinds and detaches", async () => {
    const { jumpTo } = setup();

    // 1) GENERATE
    askAndDo("dark trap at 142");
    const useButtons = await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });
    const tape = screen.getByLabelText("Session tape");
    expect(within(tape).getByTitle(/^generated · generation/)).toBeTruthy();

    // 2) APPLY a candidate
    fireEvent.click(useButtons[0]!);
    await waitFor(() => expect(within(tape).getByTitle(/^applied-candidate · candidateUse/)).toBeTruthy());

    // 3) a plain route action afterwards
    askAndDo("Turn the drums up a bit");
    await waitFor(() => expect(within(tape).getByTitle(/^applied · fader/)).toBeTruthy());

    // 4) REWIND to the applied candidate → the fader step ran on a branch that
    //    is no longer current, so it detaches.
    fireEvent.click(within(tape).getByTitle(/^applied-candidate · candidateUse/));
    await waitFor(() => expect(jumpTo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(tape).getByTitle(/^applied · fader/).style.textDecoration).toBe("line-through"));
    expect(screen.getByText(/rewound to/i)).toBeTruthy();
    // The same session, told as a story (Session Story end-to-end): the REAL
    // tape read into the REAL builder, no synthetic fixtures — the measured
    // reason survives, and the rewind left a visible branch.
    const story = buildSessionStory({
      docName: "House Beat",
      docId: "doc-1",
      generatedAt: new Date("2026-10-17T15:00:00.000Z"),
      contentHash: null,
      steps: tapeSteps(),
      reactionEntries: [],
      reactions: null,
      ai: null,
      exportStamp: null,
    });
    expect(story.markdown).toContain("# Session Story");
    expect(story.markdown).toContain("dark trap at 142");
    expect(story.markdown.split("\n").some((line) => line.startsWith("   Why:"))).toBe(true);
    expect(story.markdown).toContain("detached — a rewind left this branch");
    expect(story.markdown).toContain("1 detached by a rewind");
  }, 40000);

  it("NEGATIVE: a step that applied nothing refuses with the reason, and never jumps", async () => {
    const { jumpTo } = setup();

    askAndDo("dark trap at 142");
    await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });
    const tape = screen.getByLabelText("Session tape");

    fireEvent.click(within(tape).getByTitle(/^generated · generation/));

    await waitFor(() => expect(screen.getByText(/applied nothing/i)).toBeTruthy());
    expect(jumpTo).not.toHaveBeenCalled();
  }, 40000);

  it("clears the journal on request", async () => {
    setup();
    askAndDo("dark trap at 142");
    await screen.findAllByRole("button", { name: /^USE$/ }, { timeout: 20000 });
    expect(screen.getByLabelText("Session tape")).toBeTruthy();

    fireEvent.click(within(screen.getByLabelText("Session tape")).getByTitle("Clear the session journal"));

    await waitFor(() => expect(screen.queryByLabelText("Session tape")).toBeNull());
  }, 40000);
});
