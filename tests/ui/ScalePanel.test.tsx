import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScalePanel } from "../../src/ui/ScalePanel";
import { renderWithContext } from "../helpers";

describe("ScalePanel", () => {
  it("renders root and scale selects", () => {
    renderWithContext(<ScalePanel scaleSnap={false} onToggleSnap={vi.fn()} />);
    expect(screen.getByLabelText("Scale root")).toBeInTheDocument();
    expect(screen.getByLabelText("Scale type")).toBeInTheDocument();
  });

  it("shows SNAP OFF when scaleSnap is false", () => {
    renderWithContext(<ScalePanel scaleSnap={false} onToggleSnap={vi.fn()} />);
    expect(screen.getByRole("button", { name: /SNAP OFF/ })).toBeInTheDocument();
  });

  it("shows SNAP ON when scaleSnap is true", () => {
    renderWithContext(<ScalePanel scaleSnap={true} onToggleSnap={vi.fn()} />);
    expect(screen.getByRole("button", { name: /SNAP ON/ })).toBeInTheDocument();
  });

  it("calls onToggleSnap when SNAP button clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithContext(<ScalePanel scaleSnap={false} onToggleSnap={onToggle} />);
    await user.click(screen.getByRole("button", { name: /SNAP OFF/ }));
    expect(onToggle).toHaveBeenCalled();
  });

  it("executes setProjectKey when root changes", async () => {
    const user = userEvent.setup();
    const { services } = renderWithContext(<ScalePanel scaleSnap={false} onToggleSnap={vi.fn()} />);
    const select = screen.getByLabelText("Scale root");
    await user.selectOptions(select, "D");
    expect(services.store.execute).toHaveBeenCalled();
  });

  it("shows CLEAR button only when key is set", () => {
    renderWithContext(<ScalePanel scaleSnap={false} onToggleSnap={vi.fn()} />);
    // Default house template has no key set
    expect(screen.queryByRole("button", { name: /CLEAR/ })).not.toBeInTheDocument();
  });

  it("renders all root options", () => {
    renderWithContext(<ScalePanel scaleSnap={false} onToggleSnap={vi.fn()} />);
    const select = screen.getByLabelText("Scale root") as HTMLSelectElement;
    expect(select.options.length).toBe(12);
  });
});
