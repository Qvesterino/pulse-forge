import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GenerateDialog } from "../../src/ui/GenerateDialog";
import { mockServices, renderWithContext } from "../helpers";

describe("GenerateDialog", () => {
  it("renders nothing when open=false", () => {
    renderWithContext(<GenerateDialog open={false} onClose={() => {}} />, { services: mockServices() });
    expect(screen.queryByRole("dialog", { name: "Generate pattern" })).not.toBeInTheDocument();
  });

  it("renders the dialog with MODE/GENRE/STYLE/SEED controls when open", () => {
    renderWithContext(<GenerateDialog open onClose={() => {}} />, { services: mockServices() });
    expect(screen.getByRole("dialog", { name: "Generate pattern" })).toBeInTheDocument();
    expect(screen.getByText("MODE")).toBeInTheDocument();
    expect(screen.getByText("GENRE")).toBeInTheDocument();
    expect(screen.getByText("STYLE")).toBeInTheDocument();
    expect(screen.getByText("SEED")).toBeInTheDocument();
  });

  it("clicking the ✕ button closes the dialog via onClose", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithContext(<GenerateDialog open onClose={onClose} />, { services: mockServices() });
    await user.click(screen.getByRole("button", { name: "✕" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("toggling mode to REPLACE activates the REPLACE button", async () => {
    const user = userEvent.setup();
    renderWithContext(<GenerateDialog open onClose={() => {}} />, { services: mockServices() });
    await user.click(screen.getByRole("button", { name: "REPLACE" }));
    expect(screen.getByRole("button", { name: "REPLACE" })).toHaveClass("active-solo");
  });

  it("clicking the random seed 🎲 button changes the seed input value", async () => {
    renderWithContext(<GenerateDialog open onClose={() => {}} />, { services: mockServices() });
    const seed = document.querySelector<HTMLInputElement>(".generate-seed-input");
    expect(seed).not.toBeNull();
    const before = seed!.value;
    fireEvent.click(screen.getByRole("button", { name: "🎲" }));
    await waitFor(() =>
      expect(document.querySelector<HTMLInputElement>(".generate-seed-input")!.value).not.toBe(before),
    );
  });
});
