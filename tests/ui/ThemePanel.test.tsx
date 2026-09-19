import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThemePanel } from "../../src/ui/ThemePanel";
import { encodeThemeCode } from "../../src/export/themeCode";
import { getThemeSnapshot, resetTheme } from "../../src/ui/theme";

describe("ThemePanel install-from-code", () => {
  beforeEach(() => {
    resetTheme();
    vi.restoreAllMocks();
  });

  it("rejects a malformed code and leaves the theme unchanged", () => {
    vi.spyOn(window, "prompt").mockReturnValue("PFTHM1: definitely not a code");
    render(<ThemePanel />);
    fireEvent.click(screen.getByRole("button", { name: "INSTALL FROM CODE…" }));
    expect(screen.getByText("Invalid theme code")).toBeInTheDocument();
    expect(getThemeSnapshot().preset).toBe("molten");
    expect(getThemeSnapshot().hue).toBeNull();
    expect(getThemeSnapshot().scale).toBe(1);
  });

  it("installs a valid code", () => {
    vi.spyOn(window, "prompt").mockReturnValue(
      encodeThemeCode({ preset: "matrix", hue: null, scale: 1.15, compact: true, reduceMotion: true }),
    );
    render(<ThemePanel />);
    fireEvent.click(screen.getByRole("button", { name: "INSTALL FROM CODE…" }));
    expect(screen.getByText("Theme installed")).toBeInTheDocument();
    expect(getThemeSnapshot()).toEqual({
      preset: "matrix",
      hue: null,
      scale: 1.15,
      compact: true,
      reduceMotion: true,
    });
  });

  it("a cancelled prompt does nothing", () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<ThemePanel />);
    fireEvent.click(screen.getByRole("button", { name: "INSTALL FROM CODE…" }));
    expect(screen.queryByText("Theme installed")).not.toBeInTheDocument();
    expect(screen.queryByText("Invalid theme code")).not.toBeInTheDocument();
  });
});
