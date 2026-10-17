import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { ActivityCenter } from "../../src/ui/ActivityCenter";
import { mockServices, renderWithContext } from "../helpers";
import { createDefaultProject } from "../../src/project-model/schema";
import { jobSnapshot, resetJobCenterForTests, startJob } from "../../src/services/jobCenter";
import {
  completeAgentCall,
  currentAgentSession,
  markSessionCheckpointSaved,
  prepareAgentCall,
  resetAgentTrustForTests,
} from "../../src/mcp/agentTrust";
import { restoreIntentCheckpoint } from "../../src/intent/checkpoints";

// The revert path restores through the shared checkpoint database — mocked so
// the assertion is about the COMMAND the panel commits, not IndexedDB.
vi.mock("../../src/intent/checkpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intent/checkpoints")>();
  return { ...actual, restoreIntentCheckpoint: vi.fn(async () => null) };
});

/**
 * ACTIVITY CENTER (Wave 1 A+B) — the visible half of the trust layer: running
 * jobs with cancel, the agent audit trail, and one-click session revert.
 */

beforeEach(() => {
  localStorage.clear();
  resetJobCenterForTests();
  resetAgentTrustForTests();
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("ActivityCenter", () => {
  it("renders nothing while idle (zero cost when healthy)", () => {
    const { container } = renderWithContext(<ActivityCenter />);
    expect(container.textContent).toBe("");
  });

  it("shows a running job, opens the panel and cancels it", async () => {
    renderWithContext(<ActivityCenter />);
    act(() => {
      startJob({ kind: "agent", label: "web-relay · kyx_export", timeoutMs: 60_000 });
    });
    const chip = await screen.findByRole("button", { name: /JOBS 1/ });
    fireEvent.click(chip);
    expect(screen.getByRole("dialog", { name: "Activity center" })).toBeInTheDocument();
    expect(screen.getByText(/web-relay · kyx_export/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "CANCEL" }));
    expect(jobSnapshot().jobs[0]!.status).toBe("cancelled");
    await waitFor(() => expect(screen.queryByRole("button", { name: "CANCEL" })).toBeNull());
  });

  it("lists the agent audit trail and reverts a session as one undoable command", async () => {
    const project = createDefaultProject();
    const services = mockServices(project);
    vi.mocked(restoreIntentCheckpoint).mockResolvedValueOnce({
      name: "agent-session-x",
      summary: "3 tracks",
      doc: project,
    });

    // Simulate a completed agent session with a DURABLE checkpoint.
    prepareAgentCall({
      agent: "web-relay",
      tool: "kyx_markers",
      risk: "mutate",
      docId: project.id,
      docName: project.name,
    });
    markSessionCheckpointSaved(currentAgentSession()!.id);
    const checkpointName = currentAgentSession()!.checkpointName;
    completeAgentCall({
      agent: "web-relay",
      tool: "kyx_markers",
      risk: "mutate",
      depth: 0,
      mutated: true,
      isError: false,
      durationMs: 12,
      docId: project.id,
      docName: project.name,
      summary: 'op="add"',
    });

    renderWithContext(<ActivityCenter />, { services });
    fireEvent.click(screen.getByRole("button", { name: /AGENT/ }));
    expect(screen.getByText(/kyx_markers/)).toBeInTheDocument();

    const revert = screen.getByRole("button", { name: "REVERT SESSION" });
    expect(revert).toBeEnabled();
    fireEvent.click(revert);

    await waitFor(() => expect(services.store.execute).toHaveBeenCalledTimes(1));
    const command = vi.mocked(services.store.execute).mock.calls[0]![0] as { type: string; label: string };
    expect(command.type).toBe("restoreSnapshot");
    expect(command.label).toContain("Revert agent session");
    expect(restoreIntentCheckpoint).toHaveBeenCalledWith(project.id, checkpointName);
    // The session is closed after a revert — the panel returns to plain history.
    await waitFor(() => expect(currentAgentSession()).toBeNull());
  });

  it("keeps the revert disabled while the session checkpoint is not durable", async () => {
    const project = createDefaultProject();
    prepareAgentCall({
      agent: "web-relay",
      tool: "kyx_markers",
      risk: "mutate",
      docId: project.id,
      docName: project.name,
    });
    completeAgentCall({
      agent: "web-relay",
      tool: "kyx_markers",
      risk: "mutate",
      depth: 0,
      mutated: true,
      isError: false,
      durationMs: 5,
      docId: project.id,
    });

    renderWithContext(<ActivityCenter />, { services: mockServices(project) });
    fireEvent.click(screen.getByRole("button", { name: /AGENT/ }));
    expect(screen.getByRole("button", { name: "REVERT SESSION" })).toBeDisabled();
    expect(screen.getByText(/checkpoint not durable/)).toBeInTheDocument();
  });
});
