import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThemePanel } from "../../src/ui/ThemePanel";
import { encodeThemeCode } from "../../src/export/themeCode";
import { getThemeSnapshot, resetTheme } from "../../src/ui/theme";

/**
 * The install path moved from `window.prompt` to the shared
 * `TextPromptDialog` (native prompts block the main thread, render as browser
 * chrome and can be suppressed entirely). These tests drive the REAL dialog:
 * open it from the button, type the code, submit — so they would fail if the
 * button ever regressed to a native prompt that a test cannot reach.
 */
async function installCode(code: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "INSTALL FROM CODE…" }));
  const field = screen.getByLabelText("Paste a theme code (PFTHM1:…)");
  fireEvent.change(field, { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "INSTALL" }));
}

describe("ThemePanel install-from-code", () => {
  beforeEach(() => {
    resetTheme();
  });

  it("rejects a malformed code and leaves the theme unchanged", () => {
    render(<ThemePanel />);
    void installCode("PFTHM1: definitely not a code");
    expect(screen.getByText("Invalid theme code")).toBeInTheDocument();
    expect(getThemeSnapshot().preset).toBe("molten");
    expect(getThemeSnapshot().hue).toBeNull();
    expect(getThemeSnapshot().scale).toBe(1);
    // The dialog stays open so the user can fix the paste without reopening.
    expect(screen.getByRole("dialog", { name: "INSTALL THEME" })).toBeInTheDocument();
  });

  it("installs a valid code and closes the dialog", () => {
    render(<ThemePanel />);
    void installCode(encodeThemeCode({ preset: "matrix", hue: null, scale: 1.15, compact: true, reduceMotion: true }));
    expect(screen.getByText("Theme installed")).toBeInTheDocument();
    expect(getThemeSnapshot()).toEqual({
      preset: "matrix",
      hue: null,
      scale: 1.15,
      compact: true,
      reduceMotion: true,
    });
    expect(screen.queryByRole("dialog", { name: "INSTALL THEME" })).not.toBeInTheDocument();
  });

  it("cancelling the dialog installs nothing", () => {
    render(<ThemePanel />);
    fireEvent.click(screen.getByRole("button", { name: "INSTALL FROM CODE…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Theme installed")).not.toBeInTheDocument();
    expect(screen.queryByText("Invalid theme code")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "INSTALL THEME" })).not.toBeInTheDocument();
  });
});
