/**
 * Snapshots UI — the SNAPSHOTS section of the history panel: list, manual
 * snapshot, restore command, delete.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { UndoHistoryPanel } from "../../src/ui/UndoHistoryPanel";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { ProjectSnapshot } from "../../src/persistence/SnapshotRepository";
import { renderWithContext, mockServices } from "../helpers";

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  const doc = createProjectFromTemplate("house");
  return {
    id: "snap-1",
    projectId: doc.id,
    label: "Manual — Sep 2, 10:00",
    createdAt: new Date("2026-09-02T10:00:00").toISOString(),
    doc,
    ...overrides,
  };
}

function setup(snapshots: ProjectSnapshot[]) {
  const doc = createProjectFromTemplate("house");
  const services = mockServices(doc);
  const core = services.core as unknown as {
    snapshots: { list: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; prune: ReturnType<typeof vi.fn> };
  };
  core.snapshots.list = vi.fn(async () => snapshots);
  core.snapshots.save = vi.fn(async (_projectId: string, doc_: unknown, label: string) => ({
    id: "snap-new",
    projectId: doc.id,
    label,
    createdAt: new Date().toISOString(),
    doc: doc_,
  }));
  core.snapshots.delete = vi.fn(async () => {});
  core.snapshots.prune = vi.fn(async () => {});
  return { services, core };
}

describe("snapshots section in the history panel", () => {
  it("lists snapshots with label, time and a RESTORE action", async () => {
    const { services } = setup([snapshot()]);
    renderWithContext(<UndoHistoryPanel open />, { services });

    expect(await screen.findByText("SNAPSHOTS")).toBeTruthy();
    expect(screen.getByText("Manual — Sep 2, 10:00")).toBeTruthy();
    expect(screen.getByText("RESTORE")).toBeTruthy();
  });

  it("⊕ NOW saves a manual snapshot and refreshes the list", async () => {
    const { services, core } = setup([]);
    // After the manual save the refresh re-lists — now with one entry.
    core.snapshots.list = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([snapshot()]);
    renderWithContext(<UndoHistoryPanel open />, { services });

    await screen.findByText(/No snapshots yet/);
    fireEvent.click(screen.getByText("⊕ NOW"));

    await waitFor(() => expect(core.snapshots.save).toHaveBeenCalledTimes(1));
    const [projectId, , label] = core.snapshots.save.mock.calls[0] as [string, unknown, string];
    expect(projectId).toBe(services.store.doc.id);
    expect(label).toContain("Manual —");
    expect(core.snapshots.prune).toHaveBeenCalled();
    // Empty-state hint disappears once a snapshot lands.
    await waitFor(() => expect(screen.queryByText(/No snapshots yet/)).toBeNull());
  });

  it("RESTORE executes one undoable restoreSnapshot command", async () => {
    const snap = snapshot();
    const { services } = setup([snap]);
    renderWithContext(<UndoHistoryPanel open />, { services });

    fireEvent.click(await screen.findByText("RESTORE"));
    const execute = services.store.execute as ReturnType<typeof vi.fn>;
    expect(execute).toHaveBeenCalledTimes(1);
    const command = execute.mock.calls[0][0] as { type: string; label: string };
    expect(command.type).toBe("restoreSnapshot");
    expect(command.label).toContain(snap.label);
  });

  it("✕ deletes the snapshot and drops it from the list", async () => {
    const snap = snapshot();
    const { services, core } = setup([snap]);
    renderWithContext(<UndoHistoryPanel open />, { services });

    fireEvent.click(await screen.findByRole("button", { name: "Delete snapshot Manual — Sep 2, 10:00" }));
    await waitFor(() => expect(core.snapshots.delete).toHaveBeenCalledWith("snap-1"));
    await waitFor(() => expect(screen.queryByText("Manual — Sep 2, 10:00")).toBeNull());
  });
});
