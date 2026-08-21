import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Diagnostics } from "../../src/ui/Diagnostics";
import { renderWithContext } from "../helpers";

describe("Diagnostics", () => {
  it("renders ENGINE tab by default", () => {
    renderWithContext(<Diagnostics />);
    expect(screen.getByText("ENGINE")).toBeInTheDocument();
    expect(screen.getByText("MEMORY")).toBeInTheDocument();
    expect(screen.getByText("PERFORMANCE")).toBeInTheDocument();
  });

  it("shows engine diagnostics rows", () => {
    renderWithContext(<Diagnostics />);
    expect(screen.getByText("bpm")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
  });

  it("switches to MEMORY tab", async () => {
    const user = userEvent.setup();
    renderWithContext(<Diagnostics />);
    await user.click(screen.getByText("MEMORY"));
    expect(screen.getByText("Load metrics")).toBeInTheDocument();
  });

  it("switches to PERFORMANCE tab and shows measure buttons", async () => {
    const user = userEvent.setup();
    renderWithContext(<Diagnostics />);
    await user.click(screen.getByText("PERFORMANCE"));
    expect(screen.getByText("MEASURE PATTERN")).toBeInTheDocument();
    expect(screen.getByText("MEASURE SONG")).toBeInTheDocument();
  });

  it("has correct aria-label", () => {
    renderWithContext(<Diagnostics />);
    expect(screen.getByRole("region", { name: /Engine diagnostics/ })).toBeInTheDocument();
  });
});
