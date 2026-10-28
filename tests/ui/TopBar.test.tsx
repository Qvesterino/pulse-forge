import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mockServices, mockTopBarWidth } from "../helpers";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopBar } from "../../src/ui/TopBar";
import { renderWithContext } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { BAR_TICKS, type ProjectDocument } from "../../src/project-model/types";
import { addMidiClip } from "../../src/commands/commands";
import { setMcpAllowDestructive, setMcpAllowMutations } from "../../src/mcp/flags";
import { IDLE_SESSION_STATE, publishSessionRecordingState } from "../../src/ui/sessionStateSurface";

function topBarProps(overrides?: Partial<React.ComponentProps<typeof TopBar>>) {
  return {
    onToggleDiagnostics: vi.fn(),
    diagnosticsOpen: false,
    ioOpen: false,
    onToggleIo: vi.fn(),
    onToggleHelp: vi.fn(),
    playMode: "pattern" as const,
    onSetPlayMode: vi.fn(),
    onOpenBrowser: vi.fn(),
    onReplaceServices: vi.fn(),
    scaleSnap: false,
    onToggleScaleSnap: vi.fn(),
    historyOpen: false,
    onToggleHistory: vi.fn(),
    ...overrides,
  };
}

describe("TopBar", () => {
  it("renders brand name", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.getByText("KYX")).toBeInTheDocument();
  });

  it("retries a failed project save with keyboard activation", async () => {
    const user = userEvent.setup();
    const services = mockServices();
    vi.spyOn(services.store, "getSaveStatus").mockReturnValue("error");
    renderWithContext(<TopBar {...topBarProps()} />, { services });

    const retry = screen.getByRole("button", { name: "Save failed. Retry saving project." });
    expect(retry).toHaveAttribute("tabindex", "0");
    expect(retry).toHaveAttribute("aria-keyshortcuts", "Enter Space");
    retry.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(services.flushSave).toHaveBeenCalledTimes(2);
  });

  it("does not expose a retry button for a successfully saved project", () => {
    const { container } = renderWithContext(<TopBar {...topBarProps()} />);
    const saveStatus = container.querySelector(".save-status");
    expect(saveStatus).toHaveAttribute("role", "status");
    expect(saveStatus).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("button", { name: /save failed/i })).not.toBeInTheDocument();
  });

  it("shows an armed MIDI recorder as waiting, not recording, while the transport is stopped", () => {
    const services = mockServices();
    vi.spyOn(services.patternRecorder, "getSnapshot").mockReturnValue({
      armed: true,
      mode: "overdub",
      quantize: "off",
      strength: 1,
    });
    const { container } = renderWithContext(<TopBar {...topBarProps()} />, { services });

    const record = screen.getByRole("button", { name: "MIDI recording armed; waiting for playback" });
    expect(record).toHaveAttribute("aria-pressed", "false");
    expect(record).toHaveClass("armed");
    expect(record).not.toHaveClass("recording");
    expect(screen.getByRole("combobox", { name: "Record mode" })).toBeInTheDocument();
    expect(container.querySelector('[role="status"]')).toHaveTextContent("armed and waiting");
  });

  it("turns the REC lamp on only after count-in reaches the content start", async () => {
    const services = mockServices();
    vi.spyOn(services.patternRecorder, "getSnapshot").mockReturnValue({
      armed: true,
      mode: "overdub",
      quantize: "off",
      strength: 1,
    });
    const transport = services.transport as unknown as {
      playing: boolean;
      position: number;
      anchorTickBeforePreRoll: () => number;
    };
    transport.playing = true;
    transport.position = 0;
    transport.anchorTickBeforePreRoll = () => 960;

    renderWithContext(<TopBar {...topBarProps()} />, { services });
    const waiting = screen.getByRole("button", { name: "MIDI recording armed; waiting for playback" });
    expect(waiting).toHaveAttribute("aria-pressed", "false");
    expect(waiting).not.toHaveClass("recording");

    transport.position = 960;
    await waitFor(() => {
      const recording = screen.getByRole("button", { name: "MIDI recording active" });
      expect(recording).toHaveAttribute("aria-pressed", "true");
      expect(recording).toHaveClass("recording");
    });
  });

  /**
   * Audit S-4: the crash buffer is the only copy of the work that was
   * uncommitted when the tab dies. When it cannot hold the project, the user
   * has to know WHILE they can still save — the chip sits next to the save
   * status because that is where "is my work safe" is already answered.
   */
  it("warns that the project is not crash-protected", () => {
    const services = mockServices();
    vi.spyOn(services.store, "getRecoveryStatus").mockReturnValue("unprotected");
    renderWithContext(<TopBar {...topBarProps()} />, { services });

    expect(screen.getByText("NOT CRASH-PROTECTED")).toBeInTheDocument();
  });

  it("says nothing when the project IS crash-protected", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.queryByText("NOT CRASH-PROTECTED")).not.toBeInTheDocument();
  });

  it("renders PROJECTS button", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.getByText("PROJECTS")).toBeInTheDocument();
  });

  it("calls onOpenBrowser when PROJECTS clicked", async () => {
    const user = userEvent.setup();
    const onOpenBrowser = vi.fn();
    renderWithContext(<TopBar {...topBarProps({ onOpenBrowser })} />);
    await user.click(screen.getByText("PROJECTS"));
    expect(onOpenBrowser).toHaveBeenCalled();
  });

  it("shows PATTERN mode by default", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.getByText("PATTERN")).toBeInTheDocument();
  });

  it("shows SONG mode when playMode is song", () => {
    renderWithContext(<TopBar {...topBarProps({ playMode: "song" })} />);
    expect(screen.getByText("SONG")).toBeInTheDocument();
  });

  it("calls onSetPlayMode when mode button clicked", async () => {
    const user = userEvent.setup();
    const onSetPlayMode = vi.fn();
    renderWithContext(<TopBar {...topBarProps({ onSetPlayMode })} />);
    await user.click(screen.getByText("PATTERN"));
    expect(onSetPlayMode).toHaveBeenCalledWith("song");
  });

  it("warns when switching to SONG with the playhead past the last clip", async () => {
    const user = userEvent.setup();
    const onSetPlayMode = vi.fn();
    const services = mockServices();
    (services.transport as unknown as { position: number }).position = 9 * BAR_TICKS;
    renderWithContext(<TopBar {...topBarProps({ onSetPlayMode })} />, { services });
    await user.click(screen.getByText("PATTERN"));
    // The switch still happens — the guard warns, it does not block.
    expect(onSetPlayMode).toHaveBeenCalledWith("song");
    expect(screen.getByText(/NO CLIP AT BAR 10/)).toBeInTheDocument();
  });

  it("offers REWIND from the guard and seeks the transport to bar 1", async () => {
    const user = userEvent.setup();
    const services = mockServices();
    (services.transport as unknown as { position: number }).position = 9 * BAR_TICKS;
    renderWithContext(<TopBar {...topBarProps()} />, { services });
    await user.click(screen.getByText("PATTERN"));
    await user.click(screen.getByText("REWIND"));
    expect(services.transport.seek).toHaveBeenCalledWith(0);
    expect(screen.queryByText(/NO CLIP AT BAR/)).not.toBeInTheDocument();
  });

  it("shows no guard when a clip sits under the playhead", async () => {
    const user = userEvent.setup();
    const services = mockServices();
    (services.transport as unknown as { position: number }).position = 2 * BAR_TICKS;
    renderWithContext(<TopBar {...topBarProps()} />, { services });
    await user.click(screen.getByText("PATTERN"));
    expect(screen.queryByText(/NO CLIP AT BAR/)).not.toBeInTheDocument();
  });

  it("warns about an empty arrangement when switching to SONG", async () => {
    const user = userEvent.setup();
    const doc = { ...createProjectFromTemplate("house"), arrangement: { clips: [] } };
    const services = mockServices(doc);
    renderWithContext(<TopBar {...topBarProps()} />, { services });
    await user.click(screen.getByText("PATTERN"));
    expect(screen.getByText(/ARRANGEMENT EMPTY/)).toBeInTheDocument();
  });

  it("recognizes a MIDI-only arrangement when switching to SONG", async () => {
    const user = userEvent.setup();
    const source = createProjectFromTemplate("house");
    const instrument = source.tracks.find((track) => track.kind === "instrument");
    if (!instrument || instrument.kind !== "instrument") throw new Error("house template needs an instrument track");
    const sourcePattern = source.patterns.find((pattern) => pattern.id === source.activePatternId);
    if (!sourcePattern) throw new Error("house template needs an active pattern");
    const base: ProjectDocument = { ...source, arrangement: { ...source.arrangement, clips: [], midiClips: [] } };
    const services = mockServices(base);
    let currentDoc: ProjectDocument = base;
    services.store.getDoc = () => currentDoc;
    (services.transport as unknown as { position: number }).position = BAR_TICKS * 8;
    renderWithContext(<TopBar {...topBarProps()} />, { services });
    currentDoc = addMidiClip(base, instrument.id, sourcePattern.id, BAR_TICKS * 8, BAR_TICKS * 4).execute(base);

    await user.click(screen.getByText("PATTERN"));

    expect(screen.queryByText(/ARRANGEMENT EMPTY|NO CLIP AT BAR/)).not.toBeInTheDocument();
  });

  it("shows no guard when leaving SONG mode", async () => {
    const user = userEvent.setup();
    const services = mockServices();
    (services.transport as unknown as { position: number }).position = 9 * BAR_TICKS;
    renderWithContext(<TopBar {...topBarProps({ playMode: "song" })} />, { services });
    await user.click(screen.getByText("SONG"));
    expect(screen.queryByText(/NO CLIP AT BAR/)).not.toBeInTheDocument();
  });

  it("calls playback.playPause when play button clicked", async () => {
    const user = userEvent.setup();
    const { services } = renderWithContext(<TopBar {...topBarProps()} />);
    await user.click(screen.getByText("▶"));
    expect(services.playback.playPause).toHaveBeenCalled();
  });

  it("calls playback.stop when stop button clicked", async () => {
    const user = userEvent.setup();
    const { services } = renderWithContext(<TopBar {...topBarProps()} />);
    await user.click(screen.getByText("■"));
    expect(services.playback.stop).toHaveBeenCalled();
  });

  it("cycles count-in, toggles pre-roll and toggles the content metronome", async () => {
    // Count-in / pre-roll / metronome are direct only on a desktop-width bar
    // (they overflow below 1200 px); this spec describes the desktop shell.
    const restore = mockTopBarWidth();
    try {
      const user = userEvent.setup();
      const { services } = renderWithContext(<TopBar {...topBarProps()} />);

      const countIn = screen.getByRole("button", { name: "Count-in off" });
      await user.click(countIn);
      expect(services.transport.setCountIn).toHaveBeenCalledWith(1);
      expect(screen.getByRole("button", { name: "Count-in 1 bar" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Count-in 1 bar" }));
      expect(services.transport.setCountIn).toHaveBeenCalledWith(2);
      await user.click(screen.getByRole("button", { name: "Count-in 2 bars" }));
      expect(services.transport.setCountIn).toHaveBeenCalledWith(0);

      const preRoll = screen.getByRole("button", { name: "Pre-roll off" });
      await user.click(preRoll);
      expect(services.transport.setPreRoll).toHaveBeenCalledWith(1);
      expect(screen.getByRole("button", { name: "Pre-roll on" })).toHaveAttribute("aria-pressed", "true");

      const metronome = screen.getByRole("button", { name: "Metronome off" });
      await user.click(metronome);
      expect(services.transport.setMetronome).toHaveBeenCalledWith(true);
      expect(screen.getByRole("button", { name: "Metronome on" })).toHaveAttribute("aria-pressed", "true");
    } finally {
      restore();
    }
  });

  it("sets BPM from two taps without changing the project until the second tap", async () => {
    const restore = mockTopBarWidth();
    try {
      const user = userEvent.setup();
      const { services } = renderWithContext(<TopBar {...topBarProps()} />);
      let now = 1_000;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

      try {
        const tap = screen.getByRole("button", { name: "Tap tempo" });
        await user.click(tap);
        expect(services.store.execute).not.toHaveBeenCalled();

        now = 1_500;
        await user.click(tap);
        expect(services.store.execute).toHaveBeenCalledTimes(1);
        const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
          type: string;
          execute: (doc: { bpm: number }) => { bpm: number };
        };
        expect(command.type).toBe("setBpm");
        expect(command.execute(services.store.doc).bpm).toBe(120);
      } finally {
        nowSpy.mockRestore();
      }
    } finally {
      restore();
    }
  });

  it("shows project name", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.getByLabelText("Project name")).toBeInTheDocument();
  });

  it("no longer carries panel toggles — the dock tab row owns them (ROADMAP-UI-2027 V1)", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.queryByLabelText("Toggle mixer panel")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Toggle export panel")).not.toBeInTheDocument();
    expect(screen.queryByText("MIX")).not.toBeInTheDocument();
  });

  it("moves lower-priority tools into an accessible overflow menu", async () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = originalGetBoundingClientRect.call(this);
      if (this.classList.contains("topbar")) return { ...rect, width: 1280, left: 0, right: 1280 } as DOMRect;
      return rect;
    });
    const user = userEvent.setup();

    try {
      renderWithContext(<TopBar {...topBarProps({ onOpenPalette: vi.fn() })} />);
      await waitFor(() => expect(screen.getByRole("button", { name: /More topbar controls/ })).toBeInTheDocument());

      // Tools only: ⌘K/?/HIST stay direct at 1280; ASSIST onwards overflow.
      expect(screen.getByLabelText("Open command palette")).toBeInTheDocument();
      expect(screen.getByLabelText("Show keyboard shortcuts")).toBeInTheDocument();
      expect(screen.getByLabelText("Toggle undo history")).toBeInTheDocument();
      expect(screen.queryByLabelText("Toggle pattern assist panel")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /More topbar controls/ }));
      expect(screen.getByRole("menu", { name: "More topbar controls" })).toBeInTheDocument();

      // Tool overflow order follows priority: ASSIST first, then JAM.
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Toggle pattern assist panel" }));
      await user.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Toggle collaboration panel" }));
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu", { name: "More topbar controls" })).not.toBeInTheDocument();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("keeps the core transport visible and moves secondary controls into overflow on a narrow screen", async () => {
    const originalWidth = window.innerWidth;
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = originalGetBoundingClientRect.call(this);
      if (this.classList.contains("topbar")) return { ...rect, width: 400, left: 0, right: 400 } as DOMRect;
      return rect;
    });
    const user = userEvent.setup();

    try {
      const { services } = renderWithContext(<TopBar {...topBarProps({ onOpenPalette: vi.fn() })} />);

      expect(screen.getByLabelText("Record MIDI to pattern")).toBeInTheDocument();
      expect(screen.getByTitle("Play / Pause (Space)")).toBeInTheDocument();
      expect(screen.getByTitle("Stop")).toBeInTheDocument();
      expect(screen.getByLabelText("BPM")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Count-in off" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /More topbar controls/ }));
      await user.click(screen.getByRole("menuitem", { name: "Cycle count-in (off)" }));
      expect(services.transport.setCountIn).toHaveBeenCalledWith(1);
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });

  it("calls onToggleHelp when ? clicked", async () => {
    // ? is a direct tool on the desktop bar; below 1200 px it lives in ⋯.
    const restore = mockTopBarWidth();
    try {
      const user = userEvent.setup();
      const onToggleHelp = vi.fn();
      renderWithContext(<TopBar {...topBarProps({ onToggleHelp })} />);
      await user.click(screen.getByLabelText("Show keyboard shortcuts"));
      expect(onToggleHelp).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("opens DIAG from the overflow menu", async () => {
    const user = userEvent.setup();
    const onToggleDiagnostics = vi.fn();
    renderWithContext(<TopBar {...topBarProps({ onToggleDiagnostics })} />);
    // Rarely-used tools live behind ⋯ — the topbar keeps only ⌘K/?/HIST.
    await user.click(screen.getByRole("button", { name: /More topbar controls/ }));
    await user.click(screen.getByRole("menuitem", { name: "Toggle diagnostics panel" }));
    expect(onToggleDiagnostics).toHaveBeenCalled();
  });

  it("undo button calls store.undo", async () => {
    const restore = mockTopBarWidth();
    try {
      const { services } = renderWithContext(<TopBar {...topBarProps()} />);
      const undoBtn = screen.getByLabelText("Undo");
      expect(undoBtn).toBeDisabled(); // nothing to undo
      // Manually enable undo
      (services.store as any).canUndo = true;
    } finally {
      restore();
    }
  });
});

describe("TopBar — play button freshness", () => {
  it("updates the play button when playback is toggled from elsewhere (Space / Esc paths)", async () => {
    const services = mockServices();
    let notify: () => void = () => {};
    (services as unknown as { playback: unknown }).playback = {
      ...(services as unknown as { playback: Record<string, unknown> }).playback,
      subscribe: (cb: () => void) => {
        notify = cb;
        return () => {};
      },
    };
    renderWithContext(<TopBar {...topBarProps()} />, { services });

    // Stopped — button offers play.
    expect(screen.getByTitle("Play / Pause (Space)").textContent).toBe("▶");

    // Playback started elsewhere (keyboard shortcut, not this button) —
    // the button must flip without any doc mutation forcing a re-render.
    (services.transport as { playing: boolean }).playing = true;
    act(() => notify());
    expect(screen.getByTitle("Play / Pause (Space)").textContent).toBe("❚❚");

    (services.transport as { playing: boolean }).playing = false;
    act(() => notify());
    expect(screen.getByTitle("Play / Pause (Space)").textContent).toBe("▶");
  });
});

describe("TopBar — save a copy", () => {
  function saveCopyServices() {
    const services = mockServices();
    const doc = services.store.getDoc();
    const copy = { ...doc, id: "project-copy-id", name: `${doc.name} (copy)` };
    (services.repo as any).duplicate = vi.fn(async () => copy);
    (services.repo as any).rename = vi.fn(async (_id: string, name: string) => ({ ...copy, name }));
    services.flushSave = vi.fn(async () => {});
    return { services, doc, copy };
  }

  async function openSaveCopy(user: ReturnType<typeof userEvent.setup>) {
    const restore = mockTopBarWidth();
    try {
      await user.click(screen.getByRole("button", { name: /More topbar controls/ }));
      await user.click(screen.getByRole("menuitem", { name: "Save a copy of this project" }));
    } finally {
      restore();
    }
  }

  it("saves a durable copy and keeps the current project open", async () => {
    const user = userEvent.setup();
    const { services, doc, copy } = saveCopyServices();
    renderWithContext(<TopBar {...topBarProps()} />, { services });

    await openSaveCopy(user);
    const dialog = screen.getByRole("dialog", { name: "Save a copy of this project" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText("SAVE A COPY")).toHaveValue(`${doc.name} (copy)`);

    await user.click(screen.getByRole("button", { name: "SAVE COPY" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Save a copy of this project" })).not.toBeInTheDocument(),
    );
    expect(services.flushSave).toHaveBeenCalled();
    expect(services.repo.duplicate).toHaveBeenCalledWith(doc.id);
    expect(services.repo.rename).toHaveBeenCalledWith(copy.id, `${doc.name} (copy)`);
    expect(await screen.findByText(/Copy saved as/)).toBeInTheDocument();
  });

  it("shows the repository error inside the dialog and keeps it open", async () => {
    const user = userEvent.setup();
    const { services } = saveCopyServices();
    (services.repo as any).duplicate = vi.fn(async () => null);
    renderWithContext(<TopBar {...topBarProps()} />, { services });

    await openSaveCopy(user);
    await user.click(screen.getByRole("button", { name: "SAVE COPY" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be duplicated/i);
    expect(screen.getByRole("dialog", { name: "Save a copy of this project" })).toBeInTheDocument();
  });

  it("closes without writing anything on cancel", async () => {
    const user = userEvent.setup();
    const { services } = saveCopyServices();
    renderWithContext(<TopBar {...topBarProps()} />, { services });

    await openSaveCopy(user);
    await user.click(screen.getByRole("button", { name: "CANCEL" }));

    expect(screen.queryByRole("dialog", { name: "Save a copy of this project" })).not.toBeInTheDocument();
    expect(services.repo.duplicate).not.toHaveBeenCalled();
    expect(services.repo.rename).not.toHaveBeenCalled();
  });
});

describe("TopBar — explicit record target + agent authority badge", () => {
  afterEach(() => {
    setMcpAllowDestructive(false);
    setMcpAllowMutations(false);
    publishSessionRecordingState(IDLE_SESSION_STATE);
  });

  it("labels the transport record button as MIDI", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    const record = screen.getByRole("button", { name: "Record MIDI to pattern" });
    expect(record).toHaveTextContent("MIDI");
    expect(screen.queryByText("AUDIO ARMED")).not.toBeInTheDocument();
  });

  it("shows AUDIO ARMED globally while an audio track is armed", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    act(() => {
      publishSessionRecordingState({
        armedTrackNames: ["Vocal"],
        recState: "idle",
        punchRange: null,
        loopTakes: false,
        takeModeLabel: null,
      });
    });
    expect(screen.getByText("AUDIO ARMED")).toHaveAttribute("role", "status");

    act(() => {
      publishSessionRecordingState({ ...IDLE_SESSION_STATE, armedTrackNames: ["Vocal"], recState: "recording" });
    });
    expect(screen.getByText("AUDIO REC")).toBeInTheDocument();
  });

  it("keeps MCP authority visible from the studio shell", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.queryByText(/AGENT .* ON/)).not.toBeInTheDocument();

    act(() => setMcpAllowMutations(true));
    expect(screen.getByText("AGENT EDIT ON")).toBeInTheDocument();

    act(() => setMcpAllowDestructive(true));
    expect(screen.getByText("AGENT DELETE ON")).toBeInTheDocument();

    act(() => {
      setMcpAllowDestructive(false);
      setMcpAllowMutations(false);
    });
    expect(screen.queryByText(/AGENT .* ON/)).not.toBeInTheDocument();
  });
});
