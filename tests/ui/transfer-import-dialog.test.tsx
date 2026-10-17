import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CoreServices } from "../../src/services";
import type { ProjectDocument } from "../../src/project-model/types";
import { TransferImportDialog } from "../../src/ui/TransferImportDialog";

const importAudioFileMock = vi.hoisted(() => vi.fn());
const removeSampleMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/ui/sample-import", () => ({ importAudioFile: importAudioFileMock }));
vi.mock("../../src/persistence/UserSampleRepository", () => ({
  UserSampleRepository: class {
    remove = removeSampleMock;
  },
}));

describe("TransferImportDialog", () => {
  beforeEach(() => {
    importAudioFileMock.mockReset();
    removeSampleMock.mockClear();
  });

  it("does not start a batch import before the user confirms common audio alignment", async () => {
    const save = vi.fn();
    const core = { repo: { save } } as unknown as CoreServices;
    const onImported = vi.fn();
    const { container } = render(<TransferImportDialog core={core} onCancel={vi.fn()} onImported={onImported} />);
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("transfer file picker was not rendered");
    const stem = new File([new Uint8Array([1]).buffer], "Stem.wav", { type: "audio/wav" });

    fireEvent.change(fileInput, { target: { files: [stem] } });
    await waitFor(() => expect(screen.getByText(/Audio files are placed at bar 1/)).toBeInTheDocument());
    expect(screen.getByText(/source mixer fader\/pan controls/)).toBeInTheDocument();

    const importButton = screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i });
    expect(importButton).toBeDisabled();
    fireEvent.click(importButton);

    expect(save).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("creates and saves a new project with named audio lanes and a muted reference mix", async () => {
    importAudioFileMock.mockImplementation(async (_services, file: File, options: { id: string }) => ({
      id: options.id,
      name: file.name,
      fileName: file.name,
      category: "Custom",
      duration: 2,
      sampleRate: 48_000,
      channels: 2,
      createdAt: new Date().toISOString(),
    }));
    const save = vi.fn(async (_doc: ProjectDocument) => undefined);
    const core = { repo: { save }, bank: { remove: vi.fn() }, engine: {} } as unknown as CoreServices;
    const onImported = vi.fn();
    const { container } = render(<TransferImportDialog core={core} onCancel={vi.fn()} onImported={onImported} />);
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("transfer file picker was not rendered");
    const files = [
      new File([new Uint8Array([1]).buffer], "Drums.wav", { type: "audio/wav" }),
      new File([new Uint8Array([2]).buffer], "Reference Mix.wav", { type: "audio/wav" }),
    ];

    fireEvent.change(fileInput, { target: { files } });
    await waitFor(() => expect(screen.getByText(/Audio files are placed at bar 1/)).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox", { name: /SOURCE DAW/i }), { target: { value: "cubase" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Track name for Drums.wav" }), {
      target: { value: "Drum Bus" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /All audio exports start at the same song origin/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the transfer limits/i }));
    fireEvent.click(screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(importAudioFileMock).toHaveBeenCalledTimes(2);
    expect(onImported).toHaveBeenCalledOnce();
    const imported = onImported.mock.calls[0]?.[0] as ProjectDocument | undefined;
    expect(imported?.arrangement.audioClips).toHaveLength(2);
    expect(imported?.tracks.find((track) => track.name === "Reference Mix")?.mute).toBe(true);
    expect(imported?.tracks.some((track) => track.name === "Drum Bus")).toBe(true);
    expect(imported?.transferOrigin).toEqual({ version: 1, kind: "aligned-audio-midi", sourceDaw: "cubase" });
  });

  it("requires an output track name before creating the project", async () => {
    const save = vi.fn();
    const core = { repo: { save }, bank: { remove: vi.fn() }, engine: {} } as unknown as CoreServices;
    const onImported = vi.fn();
    const { container } = render(<TransferImportDialog core={core} onCancel={vi.fn()} onImported={onImported} />);
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("transfer file picker was not rendered");
    const stem = new File([new Uint8Array([1]).buffer], "Stem.wav", { type: "audio/wav" });

    fireEvent.change(fileInput, { target: { files: [stem] } });
    await waitFor(() => expect(screen.getByText(/Audio files are placed at bar 1/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: /All audio exports start at the same song origin/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the transfer limits/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Track name for Stem.wav" }), { target: { value: "   " } });

    expect(screen.getByRole("alert").textContent).toContain("Name every audio track");
    expect(screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("summarizes batch size and requires review of the decoded-memory warning", async () => {
    const save = vi.fn();
    const core = { repo: { save }, bank: { remove: vi.fn() }, engine: {} } as unknown as CoreServices;
    const { container } = render(<TransferImportDialog core={core} onCancel={vi.fn()} onImported={vi.fn()} />);
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("transfer file picker was not rendered");
    const files = Array.from({ length: 5 }, (_, index) => {
      const file = new File([new Uint8Array([index])], `Stem ${index + 1}.wav`, { type: "audio/wav" });
      Object.defineProperty(file, "size", { configurable: true, value: 20 * 1024 * 1024 + 1 });
      return file;
    });

    fireEvent.change(fileInput, { target: { files } });
    expect(await screen.findByText(/more than 100 MB of audio files/)).toBeInTheDocument();
    expect(screen.getByLabelText("Total selected audio size").textContent).toContain("100.0 MB");
    fireEvent.click(screen.getByRole("checkbox", { name: /All audio exports start at the same song origin/i }));

    expect(screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the transfer limits/i }));
    expect(screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i })).toBeEnabled();
    expect(save).not.toHaveBeenCalled();
  });

  it("rolls back every staged sample when a later track fails to decode", async () => {
    importAudioFileMock
      .mockImplementationOnce(async (_services, file: File, options: { id: string }) => ({
        id: options.id,
        name: file.name,
        fileName: file.name,
        category: "Custom",
        duration: 2,
        sampleRate: 48_000,
        channels: 2,
        createdAt: new Date().toISOString(),
      }))
      .mockRejectedValueOnce(new Error("Second stem could not be decoded."));
    const save = vi.fn();
    const remove = vi.fn();
    const core = { repo: { save }, bank: { remove }, engine: {} } as unknown as CoreServices;
    const onImported = vi.fn();
    const { container } = render(<TransferImportDialog core={core} onCancel={vi.fn()} onImported={onImported} />);
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("transfer file picker was not rendered");
    const files = [
      new File([new Uint8Array([1]).buffer], "Drums.wav", { type: "audio/wav" }),
      new File([new Uint8Array([2]).buffer], "Bass.wav", { type: "audio/wav" }),
    ];

    fireEvent.change(fileInput, { target: { files } });
    await waitFor(() => expect(screen.getByText(/Audio files are placed at bar 1/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: /All audio exports start at the same song origin/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the transfer limits/i }));
    fireEvent.click(screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i }));

    expect(await screen.findByText("Second stem could not be decoded.")).toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(removeSampleMock).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
  });
});
