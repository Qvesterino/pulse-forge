import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { DropZone } from "../../src/ui/DropZone";
import { renderWithContext } from "../helpers";

describe("DropZone", () => {
  function makeFile(name: string, type = "audio/wav", size = 1024): File {
    const bytes = new Uint8Array(size);
    return new File([bytes], name, { type });
  }

  function dropFiles(node: HTMLElement, files: File[]) {
    fireEvent.drop(node, {
      dataTransfer: { files },
    });
  }

  it("renders the drop zone button with the aria-label", () => {
    renderWithContext(<DropZone onImport={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /Drop audio files here or click to browse/i }),
    ).toBeInTheDocument();
  });

  it("shows the active state when dragging files over", () => {
    const { container } = renderWithContext(<DropZone onImport={vi.fn()} />);
    const node = container.querySelector(".drop-zone") as HTMLElement;
    fireEvent.dragOver(node, { dataTransfer: { files: [] } });
    expect(node).toHaveClass("drop-zone-active");
  });

  it("shows 'unsupported format' error when a non-audio file is dropped", async () => {
    const { container } = renderWithContext(<DropZone onImport={vi.fn()} />);
    const node = container.querySelector(".drop-zone") as HTMLElement;
    dropFiles(node, [makeFile("foo.txt", "text/plain")]);
    // Wait for async error path
    await vi.waitFor(() => {
      expect(screen.getByText(/Unsupported format/i)).toBeInTheDocument();
    });
  });

  it("imports a valid audio file and calls onImport with an asset", async () => {
    const onImport = vi.fn();
    const { container } = renderWithContext(<DropZone onImport={onImport} />);
    const node = container.querySelector(".drop-zone") as HTMLElement;
    dropFiles(node, [makeFile("kick.wav")]);
    await vi.waitFor(() => {
      expect(onImport).toHaveBeenCalled();
    });
    const arg = onImport.mock.calls[0][0];
    expect(arg).toMatchObject({
      fileName: "kick.wav",
      name: "kick",
      category: "Custom",
    });
  });
});