import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { McpConsentToggle, McpDestructiveToggle } from "../../src/ui/McpAuthorityToggles";
import { mcpAllowDestructive, mcpAllowMutations } from "../../src/mcp/flags";

beforeEach(() => {
  localStorage.removeItem("pf:mcp-allow-destructive");
  localStorage.removeItem("pf:mcp-allow-mutations");
});

afterEach(() => {
  localStorage.removeItem("pf:mcp-allow-destructive");
  localStorage.removeItem("pf:mcp-allow-mutations");
});

describe("MCP destructive authority", () => {
  it("does not enable delete authority before confirmation", () => {
    render(<McpDestructiveToggle />);
    fireEvent.click(screen.getByRole("button", { name: "🔒 MAZANIE" }));

    expect(screen.getByRole("group", { name: "Confirm MCP delete authority" })).toBeInTheDocument();
    expect(mcpAllowDestructive()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "ZRUŠIŤ" }));
    expect(mcpAllowDestructive()).toBe(false);
    expect(screen.getByRole("button", { name: "🔒 MAZANIE" })).toHaveAttribute("aria-pressed", "false");
  });

  it("enables only after the explicit allow click, and disables immediately", () => {
    render(<McpDestructiveToggle />);
    fireEvent.click(screen.getByRole("button", { name: "🔒 MAZANIE" }));
    fireEvent.click(screen.getByRole("button", { name: "POVOLIŤ MAZANIE" }));

    expect(mcpAllowDestructive()).toBe(true);
    const toggle = screen.getByRole("button", { name: "🔓 MAZANIE" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    // Turning authority OFF is immediate — the safety direction needs no dialog.
    fireEvent.click(toggle);
    expect(mcpAllowDestructive()).toBe(false);
  });
});

describe("MCP edit consent", () => {
  it("shares the same store as the delete toggle (no local drift)", () => {
    render(
      <>
        <McpConsentToggle />
        <McpDestructiveToggle />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "🔒 ZMENY" }));
    expect(mcpAllowMutations()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "🔓 ZMENY" }));
    expect(mcpAllowMutations()).toBe(false);
  });
});
