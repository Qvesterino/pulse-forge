import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DockChrome, DOCK_TABS } from "../../src/ui/DockChrome";
import { PANEL_KEYS, type DockState } from "../../src/ui/dockLayout";

const state = (overrides: Partial<DockState> = {}): DockState => ({
  height: 300,
  slotA: "mixer",
  slotB: null,
  ...overrides,
});

const noop = () => {};

function renderChrome(dock: DockState, handlers: Partial<Parameters<typeof DockChrome>[0]> = {}) {
  const props = {
    dock,
    onToggle: vi.fn(),
    onCloseAll: vi.fn(),
    onResizeStart: vi.fn(),
    onResizeReset: vi.fn(),
    onResizeStep: vi.fn(),
    ...handlers,
  };
  render(<DockChrome {...props} />);
  return props;
}

describe("DockChrome", () => {
  it("renders exactly one tab per registered panel — a new panel can never ship without a tab", () => {
    expect(DOCK_TABS.map((t) => t.id).sort()).toEqual([...PANEL_KEYS].sort());
    renderChrome(state());
    for (const tab of DOCK_TABS) {
      expect(screen.getByRole("tab", { name: tab.ariaLabel })).toBeInTheDocument();
    }
  });

  it("marks the open panel selected and reflects the split slot", () => {
    renderChrome(state({ slotA: "mixer", slotB: "intent" }));
    expect(screen.getByRole("tab", { name: "Toggle mixer panel" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Toggle intent panel" })).toHaveAttribute("aria-selected", "true");
    // The split-slot tab carries the dimmer-LED class for at-a-glance reads.
    expect(screen.getByRole("tab", { name: "Toggle intent panel" }).className).toContain("in-split");
    expect(screen.getByRole("tab", { name: "Toggle arrangement and scenes" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("plain click toggles, Ctrl+click asks for the split slot", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderChrome(state({ slotA: "mixer", slotB: null }), { onToggle });

    await user.click(screen.getByRole("tab", { name: "Toggle dice panel" }));
    expect(onToggle).toHaveBeenLastCalledWith("dice", false);

    await user.keyboard("[ControlLeft>]");
    await user.click(screen.getByRole("tab", { name: "Toggle dice panel" }));
    await user.keyboard("[/ControlLeft]");
    expect(onToggle).toHaveBeenLastCalledWith("dice", true);
  });

  it("close-all is disabled when nothing is open, enabled otherwise", () => {
    const { rerender } = render(
      <DockChrome
        dock={state({ slotA: null, slotB: null })}
        onToggle={noop}
        onCloseAll={noop}
        onResizeStart={noop}
        onResizeReset={noop}
        onResizeStep={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Close all dock panels" })).toBeDisabled();

    rerender(
      <DockChrome
        dock={state({ slotA: "mixer", slotB: null })}
        onToggle={noop}
        onCloseAll={noop}
        onResizeStart={noop}
        onResizeReset={noop}
        onResizeStep={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Close all dock panels" })).toBeEnabled();
  });

  it("grip is keyboard-operable: arrows step the height, Enter resets", async () => {
    const user = userEvent.setup();
    const onResizeStep = vi.fn();
    const onResizeReset = vi.fn();
    renderChrome(state(), { onResizeStep, onResizeReset });

    const grip = screen.getByRole("button", { name: "Resize bottom panel dock" });
    grip.focus();
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{ArrowDown}");
    expect(onResizeStep).toHaveBeenNthCalledWith(1, 16);
    expect(onResizeStep).toHaveBeenNthCalledWith(2, -16);

    await user.keyboard("{Enter}");
    expect(onResizeReset).toHaveBeenCalledOnce();
  });
});
