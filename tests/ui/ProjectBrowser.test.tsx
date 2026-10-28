import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectBrowser } from "../../src/ui/ProjectBrowser";
import type { CoreServices } from "../../src/services";
import type { IncompatibleProjectMeta, SavedProjectMeta } from "../../src/persistence/ProjectRepository";
import { CrashJournalRepository } from "../../src/persistence/crashJournal";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { ProjectDocument } from "../../src/project-model/types";
import { INTENT_PREFILL_KEY, peekSongStarter, takeIntentPrefill } from "../../src/landing/handoff";
import { readFailedStatuses, writeStatus } from "../../src/persistence/recoveryBuffer";
import { publishUserSampleRestoreStatus } from "../../src/persistence/userSampleRestoreStatus";

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
    // The import path installs portable assets before it saves, and that step
    // reads the sample bank (entries/has). A bare `{}` bank made the import
    // throw, so the save never happened and the test measured the MOCK, not
    // the contract it claims to pin.
    bank: {
      entries: () => [],
      has: () => false,
      add: () => {},
      remove: () => {},
    } as unknown as CoreServices["bank"],
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
      direction: "newer",
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

    fireEvent.click(await screen.findByText("ALREADY HAVE A PROJECT? IMPORT OR TRANSFER IT"));
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

/**
 * "RECOVER" MUST NOT BECOME "REPLACE WITH SOMETHING UNREADABLE".
 *
 * The recovery buffer is untrusted input (a synchronous localStorage write),
 * `repo.save()` writes the document raw, and `repo.load()` refuses what it
 * cannot validate. So a buffer we cannot vouch for used to overwrite the one
 * copy of the user's saved project with something the loader then rejected —
 * the project was gone, and the crash journal keeps events, not bodies.
 */
describe("ProjectBrowser — recovery never destroys the saved project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    window.localStorage.clear();
  });

  function seedBuffer(doc: unknown): void {
    window.localStorage.setItem(
      "kyx:recovery-buffer:v1:p1",
      JSON.stringify({ v: 1, projectId: "p1", savedAt: new Date().toISOString(), doc }),
    );
  }

  it("refuses a malformed buffer: the project is NOT saved and NOT opened", async () => {
    // The reader accepts it (it is a slot with a project id), but the document
    // inside is not a project — `repo.save()` would have taken it raw.
    seedBuffer({ id: "p1", tracks: "not-an-array" });
    const saved: ProjectDocument[] = [];
    const onOpen = vi.fn();
    const core = makeCore(saved);

    render(<ProjectBrowser core={core} onOpen={onOpen} />);

    fireEvent.click(await screen.findByRole("button", { name: "Recover" }));

    await waitFor(() => expect(screen.getByText(/nothing was overwritten/)).toBeTruthy());
    expect(core.repo.save, "an unreadable buffer must never reach the repository").not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("refuses a buffer that belongs to a different project", async () => {
    const other = { ...createProjectFromTemplate("house"), id: "somebody-else" };
    seedBuffer(other);
    const onOpen = vi.fn();
    const core = makeCore([]);

    render(<ProjectBrowser core={core} onOpen={onOpen} />);

    fireEvent.click(await screen.findByRole("button", { name: "Recover" }));

    await waitFor(() => expect(screen.getByText(/different project/)).toBeTruthy());
    expect(core.repo.save).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("recovers a valid buffer: one save, and the project opens", async () => {
    const doc = { ...createProjectFromTemplate("house"), id: "p1", name: "Recovered Beat" };
    seedBuffer(doc);
    const saved: ProjectDocument[] = [];
    const onOpen = vi.fn();
    const core = makeCore(saved);

    render(<ProjectBrowser core={core} onOpen={onOpen} />);

    fireEvent.click(await screen.findByRole("button", { name: "Recover" }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].id).toBe("p1");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

/**
 * A TAKE THAT CAME BACK SILENT MUST SAY SO (audit S-3).
 *
 * The boot restore skipped a sample it could not decode IN SILENCE — the
 * recorded take that used it was permanently silent and the user was never
 * told. The browser is the first screen, so it is where the news belongs.
 */
describe("ProjectBrowser — saved audio that did not come back is announced", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    window.localStorage.clear();
    publishUserSampleRestoreStatus({ state: "ready", restored: [], failed: [] });
  });

  it("names the samples and says the takes are silent", async () => {
    publishUserSampleRestoreStatus({
      state: "ready",
      restored: [],
      failed: [
        { id: "user.take-3", name: "Take 3", reason: "the decoder said no", partial: false },
        { id: "user.take-4", name: "Take 4", reason: "the saved recording is incomplete", partial: true },
      ],
    });
    render(<ProjectBrowser core={makeCore([])} onOpen={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/saved samples could not be restored/)).toBeTruthy());
    expect(screen.getByText(/are silent/)).toBeTruthy();
    expect(screen.getByText(/Take 3, Take 4/)).toBeTruthy();
  });

  it("offers a retry — the bytes are still in the store", async () => {
    publishUserSampleRestoreStatus({
      state: "ready",
      restored: [],
      failed: [{ id: "user.take-3", name: "Take 3", reason: "the decoder said no", partial: false }],
    });
    render(<ProjectBrowser core={makeCore([])} onOpen={vi.fn()} />);

    const retry = await screen.findByRole("button", { name: "Retry restoring saved audio" });
    expect(retry).toBeTruthy();
    fireEvent.click(retry);
    await waitFor(() => expect(retry).not.toBeDisabled());
  });

  it("says nothing when everything came back", async () => {
    publishUserSampleRestoreStatus({ state: "ready", restored: ["user.take-3"], failed: [] });
    render(<ProjectBrowser core={makeCore([])} onOpen={vi.fn()} />);

    await waitFor(() => expect(screen.queryByText(/could not be restored/)).toBeNull());
  });
});

/**
 * A SESSION THAT COULD NOT BE PROTECTED MUST SAY SO (audit S-4).
 *
 * When the crash buffer could not hold the work, the session that died left
 * nothing behind — and the user was never told, because the failure was
 * discarded. The record survives the tab close, so the NEXT session can
 * explain the loss instead of letting the work vanish without a word.
 */
describe("ProjectBrowser — a session that could not be protected is announced", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    window.localStorage.clear();
  });

  function seedFailure(): void {
    writeStatus("p1", {
      state: "unprotected",
      checkedAt: new Date().toISOString(),
      bytes: 4_000_000,
      reason: "too-large",
      lastFailureAt: new Date().toISOString(),
    });
  }

  it("announces it, and says WHY", async () => {
    seedFailure();
    render(<ProjectBrowser core={makeCore([])} onOpen={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/could not be protected/)).toBeTruthy());
    expect(screen.getByText(/too large for the browser/)).toBeTruthy();
  });

  it("the user can be told once and then let go of it", async () => {
    seedFailure();
    render(<ProjectBrowser core={makeCore([])} onOpen={vi.fn()} />);

    const dismiss = await screen.findByRole("button", { name: "Dismiss unprotected notice" });
    fireEvent.click(dismiss);

    await waitFor(() => expect(screen.queryByText(/could not be protected/)).toBeNull());
    expect(readFailedStatuses()).toHaveLength(0);
  });

  it("says nothing when there is no failure", async () => {
    render(<ProjectBrowser core={makeCore([])} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText(/could not be protected/)).toBeNull());
  });
});
