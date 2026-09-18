import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { UndoHistoryPanel } from "../../src/ui/UndoHistoryPanel";
import { renderWithContext } from "../helpers";

describe("UndoHistoryPanel", () => {
  it("renders the undo history region when open", () => {
    renderWithContext(<UndoHistoryPanel open={true} />);
    expect(screen.getByRole("region", { name: /Undo history/i })).toBeInTheDocument();
  });

  it("does not render anything when closed", () => {
    renderWithContext(<UndoHistoryPanel open={false} />);
    expect(screen.queryByRole("region", { name: /Undo history/i })).toBeNull();
  });

  it("renders the snapshots section", () => {
    renderWithContext(<UndoHistoryPanel open={true} />);
    expect(screen.getByLabelText(/Project snapshots/i)).toBeInTheDocument();
  });
});