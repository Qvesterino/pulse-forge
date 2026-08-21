import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { renderWithContext } from "../helpers";

describe("ArrangementPanel", () => {
  it("renders SCENES heading", () => {
    renderWithContext(<ArrangementPanel />);
    expect(screen.getByText("SCENES")).toBeInTheDocument();
  });

  it("shows + SCENE button", () => {
    renderWithContext(<ArrangementPanel />);
    expect(screen.getByText("+ SCENE")).toBeInTheDocument();
  });

  it("calls createScene when + SCENE clicked", async () => {
    const { services } = renderWithContext(<ArrangementPanel />);
    const btn = screen.getByText("+ SCENE");
    const { click } = await import("@testing-library/user-event").then((m) => m.default.setup());
    await click(btn);
    expect(services.store.execute).toHaveBeenCalled();
  });

  it("has correct aria label", () => {
    renderWithContext(<ArrangementPanel />);
    expect(screen.getByRole("region", { name: /Arrangement and scenes/ })).toBeInTheDocument();
  });

  it("ruler mode toggle exists", () => {
    renderWithContext(<ArrangementPanel />);
    expect(screen.getByText("ARRANGEMENT")).toBeInTheDocument();
  });
});
