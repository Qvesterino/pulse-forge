import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectBrowser } from "../../src/ui/ProjectBrowser";
import type { CoreServices } from "../../src/services";
import type { IncompatibleProjectMeta } from "../../src/persistence/ProjectRepository";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * Import/export robustness audit regression: importing a project file used
 * to `repo.save()` the document under its EMBEDDED id — re-importing a file
 * (or importing any file whose id matches a library project) silently
 * overwrote that saved project. Imports must land under a fresh id.
 */

vi.mock("../../src/export/project-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/export/project-io")>();
  return {
    ...actual,
    importProject: vi.fn(async () => {
      // A "file" whose embedded id collides with an existing library row.
      const doc = createProjectFromTemplate("house");
      return { ...doc, id: "project-victim", name: "Imported Copy" };
    }),
  };
});

function makeCore(saved: ProjectDocument[]): CoreServices {
  return {
    engine: {} as CoreServices["engine"],
    bank: {} as CoreServices["bank"],
    repo: {
      listAll: vi.fn(async () => []),
      listIncompatible: vi.fn(async () => []),
      load: vi.fn(async () => null),
      loadMostRecent: vi.fn(async () => null),
      save: vi.fn(async (doc: ProjectDocument) => {
        saved.push(doc);
      }),
      duplicate: vi.fn(async () => null),
      rename: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
    } as unknown as CoreServices["repo"],
    snapshots: {} as CoreServices["snapshots"],
    presets: {} as CoreServices["presets"],
    library: {} as CoreServices["library"],
    userKits: {} as CoreServices["userKits"],
    groovePool: {} as CoreServices["groovePool"],
    latency: {} as CoreServices["latency"],
  };
}

describe("ProjectBrowser — import does not overwrite by embedded id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves an imported file under a FRESH id and opens the fresh copy", async () => {
    const saved: ProjectDocument[] = [];
    const onOpen = vi.fn();
    render(<ProjectBrowser core={makeCore(saved)} onOpen={onOpen} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const file = new File(["{}"], "beat.pulseforge.json", { type: "application/json" });
    await waitFor(() => expect(screen.getByText("IMPORT FROM FILE")).toBeTruthy());
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(saved.length).toBe(1));
    expect(saved[0].id).not.toBe("project-victim");
    expect(saved[0].name).toBe("Imported Copy");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect((onOpen.mock.calls[0][0] as ProjectDocument).id).toBe(saved[0].id);
  });

  it("shows newer-version projects without offering open, and still allows explicit deletion", async () => {
    const saved: ProjectDocument[] = [];
    const onOpen = vi.fn();
    const core = makeCore(saved);
    const incompatible: IncompatibleProjectMeta = {
      id: "future-project",
      name: "Future Project",
      updatedAt: new Date().toISOString(),
      schemaVersion: 999,
    };
    vi.mocked(core.repo.listIncompatible).mockResolvedValueOnce([incompatible]);

    render(<ProjectBrowser core={core} onOpen={onOpen} />);

    expect(await screen.findByText("Future Project")).toBeTruthy();
    expect(screen.getByText("NEWER VERSION")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^OPEN$/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^DEL$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^DELETE\?$/ }));
    await waitFor(() => expect(core.repo.delete).toHaveBeenCalledWith(incompatible.id));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
