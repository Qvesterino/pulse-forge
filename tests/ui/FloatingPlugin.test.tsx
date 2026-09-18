import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FloatingPlugin } from "../../src/ui/FloatingPlugin";
import { mockServices, renderWithContext } from "../helpers";

describe("FloatingPlugin", () => {
  it("renders the plugin header for a drums track, with mode buttons and Close", () => {
    const services = mockServices();
    const doc = services.store.doc as { tracks: { id: string; kind?: string }[] };
    const drums = doc.tracks.find((t) => t.kind === "drum")!;
    renderWithContext(
      <FloatingPlugin trackId={drums.id} selectedPadId={drums.id} onClose={() => {}} />,
      { services },
    );
    // Header shows "DRUMS — PAD" (no pad resolution since mockServices pads array is empty).
    expect(screen.getByText(/DRUMS/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Plugin mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close plugin" })).toBeInTheDocument();
  });

  it("renders nothing when the trackId is not in the doc", () => {
    const services = mockServices();
    const { container } = renderWithContext(
      <FloatingPlugin trackId="nonexistent" selectedPadId="x" onClose={() => {}} />,
      { services },
    );
    // The component returns null when no track is found.
    expect(container.firstChild).toBeNull();
  });

  it("clicking the Close button invokes onClose", async () => {
    const onClose = vi.fn();
    const services = mockServices();
    const doc = services.store.doc as { tracks: { id: string; kind?: string }[] };
    const drums = doc.tracks.find((t) => t.kind === "drum")!;
    const user = userEvent.setup();
    renderWithContext(
      <FloatingPlugin trackId={drums.id} selectedPadId={drums.id} onClose={onClose} />,
      { services },
    );
    await user.click(screen.getByRole("button", { name: "Close plugin" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("default mode is Hobby (the localStorage-toggled HOBBY button is active by default)", () => {
    const services = mockServices();
    const doc = services.store.doc as { tracks: { id: string; kind?: string }[] };
    const drums = doc.tracks.find((t) => t.kind === "drum")!;
    renderWithContext(
      <FloatingPlugin trackId={drums.id} selectedPadId={drums.id} onClose={() => {}} />,
      { services },
    );
    const hobby = screen.getByRole("button", { name: "HOBBY" });
    const profi = screen.getByRole("button", { name: "PROFI" });
    expect(hobby).toHaveAttribute("aria-pressed", "true");
    expect(profi).toHaveAttribute("aria-pressed", "false");
  });
});
