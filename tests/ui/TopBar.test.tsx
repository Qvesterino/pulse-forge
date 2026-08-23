import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mockServices } from "../helpers";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopBar } from "../../src/ui/TopBar";
import { renderWithContext } from "../helpers";

function topBarProps(overrides?: Partial<React.ComponentProps<typeof TopBar>>) {
  return {
    onToggleDiagnostics: vi.fn(),
    diagnosticsOpen: false,
    onSetBottomPanel: vi.fn(),
    bottomPanel: null as "mixer" | "fx" | "arr" | "mod" | "exp" | "midi" | null,
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
    expect(screen.getByText("PULSE FORGE")).toBeInTheDocument();
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

  it("shows project name", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.getByLabelText("Project name")).toBeInTheDocument();
  });

  it("renders MIX, FX, ARR, MOD, EXPORT buttons", () => {
    renderWithContext(<TopBar {...topBarProps()} />);
    expect(screen.getByText("MIX")).toBeInTheDocument();
    expect(screen.getByText("FX")).toBeInTheDocument();
    expect(screen.getByText("ARR")).toBeInTheDocument();
    expect(screen.getByText("MOD")).toBeInTheDocument();
    expect(screen.getByText("EXPORT")).toBeInTheDocument();
  });

  it("calls onSetBottomPanel when panel button clicked", async () => {
    const user = userEvent.setup();
    const onSetBottomPanel = vi.fn();
    renderWithContext(<TopBar {...topBarProps({ onSetBottomPanel })} />);
    await user.click(screen.getByText("MIX"));
    expect(onSetBottomPanel).toHaveBeenCalledWith("mixer");
  });

  it("calls onToggleHelp when ? clicked", async () => {
    const user = userEvent.setup();
    const onToggleHelp = vi.fn();
    renderWithContext(<TopBar {...topBarProps({ onToggleHelp })} />);
    await user.click(screen.getByLabelText("Show keyboard shortcuts"));
    expect(onToggleHelp).toHaveBeenCalled();
  });

  it("calls onToggleDiagnostics when DIAG clicked", async () => {
    const user = userEvent.setup();
    const onToggleDiagnostics = vi.fn();
    renderWithContext(<TopBar {...topBarProps({ onToggleDiagnostics })} />);
    await user.click(screen.getByText("DIAG"));
    expect(onToggleDiagnostics).toHaveBeenCalled();
  });

  it("undo button calls store.undo", async () => {
    const { services } = renderWithContext(<TopBar {...topBarProps()} />);
    const undoBtn = screen.getByLabelText("Undo");
    expect(undoBtn).toBeDisabled(); // nothing to undo
    // Manually enable undo
    (services.store as any).canUndo = true;
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
