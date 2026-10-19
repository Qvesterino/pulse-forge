import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectBrowser } from "../../src/ui/ProjectBrowser";
import type { CoreServices } from "../../src/services";
import type { IncompatibleProjectMeta, SavedProjectMeta } from "../../src/persistence/ProjectRepository";
import { CrashJournalRepository } from "../../src/persistence/crashJournal";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { ProjectDocument } from "../../src/project-model/types";
import { INTENT_PREFILL_KEY, peekSongStarter, takeIntentPrefill } from "../../src/landing/handoff";

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
    morphPresets: {} as CoreServices["morphPresets"],
    ultinaPresets: {} as CoreServices["ultinaPresets"],
    latency: {} as CoreServices["latency"],
    crashJournal: new CrashJournalRepository(),
  };
}

describe("ProjectBrowser — import does not overwrite by embedded id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
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

  it("creates a saved song starter and hands its intent and loop filters into the studio", async () => {
    const saved: ProjectDocument[] = [];
    const onOpen = vi.fn();
    render(<ProjectBrowser core={makeCore(saved)} onOpen={onOpen} />);

    await screen.findByRole("button", { name: "CREATE SONG STARTER" });
    fireEvent.change(screen.getByLabelText("Song starter genre"), { target: { value: "techno" } });
    fireEvent.change(screen.getByLabelText("Song starter mood"), { target: { value: "dark" } });
    fireEvent.change(screen.getByLabelText("Song starter tempo BPM"), { target: { value: "145" } });
    fireEvent.click(screen.getByRole("button", { name: "CREATE SONG STARTER" }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ name: "Techno Song Starter", bpm: 145 });
    expect(onOpen).toHaveBeenCalledWith(saved[0]);
    expect(peekSongStarter()).toEqual({ genre: "Techno", mood: "dark", bpm: 145 });
    expect(sessionStorage.getItem(INTENT_PREFILL_KEY)).toContain("full Techno song with a dark mood at 145 BPM");
    expect(takeIntentPrefill()).toContain("Include an intro, build, drop, break, final drop, and outro.");
  });

  it("does not save or open the project when tempo exceeds 240 BPM", async () => {
    const saved: ProjectDocument[] = [];
    const onOpen = vi.fn();
    const core = makeCore(saved);
    render(<ProjectBrowser core={core} onOpen={onOpen} />);

    await screen.findByRole("button", { name: "CREATE SONG STARTER" });
    fireEvent.change(screen.getByLabelText("Song starter tempo BPM"), { target: { value: "241" } });
    const createButton = screen.getByRole("button", { name: "CREATE SONG STARTER" });
    expect(createButton).toBeDisabled();
    fireEvent.click(createButton);

    expect(core.repo.save).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(peekSongStarter()).toBeNull();
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
    expect(screen.queryByRole("heading", { name: "Continue your song in KYX" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^OPEN$/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^DEL$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^DELETE\?$/ }));
    await waitFor(() => expect(core.repo.delete).toHaveBeenCalledWith(incompatible.id));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows truthful first-run transfer boundaries and opens the transfer wizard", async () => {
    render(<ProjectBrowser core={makeCore([])} onOpen={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Continue your song in KYX" })).toBeTruthy();
    expect(screen.getByText(/KYX projects and supported project JSON import/)).toBeTruthy();
    expect(screen.getByText(/native low-latency Windows audio backend is not shipped/)).toBeTruthy();
    expect(screen.getByText(/CLAP scanning reads metadata only/)).toBeTruthy();
    expect(screen.getByText(/does not recreate source fader, pan or automation controls/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /PREPARE WAV \+ MIDI TRANSFER/ }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("does not present storage failure as first-run onboarding", async () => {
    const core = makeCore([]);
    vi.mocked(core.repo.listAll).mockRejectedValueOnce(new Error("database unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<ProjectBrowser core={core} onOpen={vi.fn()} />);

      expect(await screen.findByRole("alert")).toHaveTextContent("Saved projects could not be read");
      expect(screen.queryByRole("heading", { name: "Continue your song in KYX" })).toBeNull();
      expect(screen.queryByText("Pick a template — you will hear your first sound in under a minute.")).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("shows the source DAW on projects created through audio and MIDI transfer", async () => {
    const core = makeCore([]);
    const meta: SavedProjectMeta = {
      id: "cubase-transfer",
      name: "Transferred Song",
      bpm: 124,
      trackCount: 9,
      createdAt: "2026-10-17T10:00:00.000Z",
      updatedAt: "2026-10-17T10:00:00.000Z",
      transferOrigin: { version: 1, kind: "aligned-audio-midi", sourceDaw: "cubase" },
    };
    vi.mocked(core.repo.listAll).mockResolvedValueOnce([meta]);

    render(<ProjectBrowser core={core} onOpen={vi.fn()} />);

    expect(await screen.findAllByText(/imported from Cubase/)).toHaveLength(2);
  });
});
