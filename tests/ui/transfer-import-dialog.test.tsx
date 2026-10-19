import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CoreServices } from "../../src/services";
import type { ProjectDocument } from "../../src/project-model/types";
import { writeMidiFile } from "../../src/midi/midiFile";
import { BAR_TICKS } from "../../src/project-model/types";
import { TransferImportDialog } from "../../src/ui/TransferImportDialog";

const importAudioFileMock = vi.hoisted(() => vi.fn());
const removeSampleMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/ui/sample-import", () => ({ importAudioFile: importAudioFileMock }));
vi.mock("../../src/persistence/UserSampleRepository", () => ({
  UserSampleRepository: class {
    remove = removeSampleMock;
  },
}));

function midiWithUnsupportedEvents(): File {
  const track = Uint8Array.from([
    0x00,
    0xc0,
    0x08, // program change
    0x00,
    0xb0,
    0x4a,
    0x64, // control change
    0x00,
    0xe0,
    0x00,
    0x40, // pitch bend
    0x00,
    0xa0,
    0x3c,
    0x20, // polyphonic aftertouch
    0x00,
    0xd0,
    0x30, // channel aftertouch
    0x00,
    0xf0,
    0x02,
    0x7e,
    0x7f, // SysEx
    0x00,
    0x90,
    0x3c,
    0x64, // note on
    0x83,
    0x60,
    0x80,
    0x3c,
    0x60, // note off at tick 480, release velocity 96
    0x00,
    0xff,
    0x2f,
    0x00, // end of track
  ]);
  const midi = new Uint8Array(22 + track.length);
  midi.set([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0]);
  midi.set([0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, track.length], 14);
  midi.set(track, 22);
  return new File([midi.buffer], "Session.mid", { type: "audio/midi" });
}

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

  it("shows exact MIDI loss counts and requires acknowledgement before importing", async () => {
    const save = vi.fn(async (_doc: ProjectDocument) => undefined);
    const core = { repo: { save } } as unknown as CoreServices;
    const onImported = vi.fn();
    const { container } = render(<TransferImportDialog core={core} onCancel={vi.fn()} onImported={onImported} />);
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("transfer file picker was not rendered");

    fireEvent.change(fileInput, { target: { files: [midiWithUnsupportedEvents()] } });
    expect(
      await screen.findByText(
        "MIDI data that will not transfer: 1 unsupported CC message, 1 pitch bend, 1 program change, 2 aftertouch events, 1 SysEx message. KYX imports notes, GM drum hits, CC7/10/11 track automation, and bakes CC64 sustain into note lengths.",
      ),
    ).toBeInTheDocument();

    const importButton = screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i });
    expect(importButton).toBeDisabled();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the transfer limits/i }));
    expect(importButton).toBeEnabled();
    fireEvent.click(importButton);

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(onImported).toHaveBeenCalledOnce();
    const imported = onImported.mock.calls[0]?.[0] as ProjectDocument | undefined;
    const track = imported?.tracks.find((candidate) => candidate.kind === "instrument");
    const pattern = imported?.patterns.find((candidate) => candidate.id === imported.activePatternId);
    expect(pattern?.notes[track?.id ?? ""]?.[0]?.expression?.releaseVelocity).toBe(0.76);
  });

  it("shows supported controller conversions and imports automation plus sustain-adjusted note lengths", async () => {
    const bytes = writeMidiFile({
      bpm: 120,
      tracks: [
        {
          name: "Expressive Lead",
          channel: 0,
          notes: [{ pitch: 60, startTick: 0, endTick: 480, velocity: 0.8 }],
          controllers: [
            { tick: 0, controller: 64, value: 127 },
            { tick: 0, controller: 7, value: 127 },
            { tick: 0, controller: 10, value: 0 },
            { tick: 480, controller: 11, value: 64 },
            { tick: 960, controller: 64, value: 0 },
          ],
        },
      ],
    });
    const midiData = new Uint8Array(bytes.byteLength);
    midiData.set(bytes);
    const midiFile = new File([midiData.buffer], "Controller Map.mid", { type: "audio/midi" });
    const save = vi.fn(async (_doc: ProjectDocument) => undefined);
    const core = { repo: { save } } as unknown as CoreServices;
    const onImported = vi.fn();
    const { container } = render(<TransferImportDialog core={core} onCancel={vi.fn()} onImported={onImported} />);
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("transfer file picker was not rendered");

    fireEvent.change(fileInput, { target: { files: [midiFile] } });
    expect(await screen.findByText(/MIDI controller conversion:/)).toBeInTheDocument();
    expect(
      screen.getByText(/CC7 volume and CC11 expression become combined track-volume automation/),
    ).toBeInTheDocument();
    expect(screen.getByText(/CC10 becomes track-pan automation/)).toBeInTheDocument();
    expect(screen.getByText(/CC64 sustain extends note lengths/)).toBeInTheDocument();
    const importButton = screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i });
    expect(importButton).toBeDisabled();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the transfer limits/i }));
    fireEvent.click(importButton);

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const imported = onImported.mock.calls[0]?.[0] as ProjectDocument | undefined;
    const track = imported?.tracks.find((candidate) => candidate.name === "Expressive Lead");
    const pattern = imported?.patterns.find((candidate) => candidate.id === imported.activePatternId);
    const note = track && pattern?.notes[track.id]?.[0];
    const automation = imported?.arrangement.automationClips?.filter((clip) => clip.target.trackId === track?.id) ?? [];

    expect(note).toMatchObject({ duration: 960 });
    expect(automation.some((clip) => clip.target.kind === "trackGain")).toBe(true);
    expect(automation.some((clip) => clip.target.kind === "trackPan" && clip.points[0]?.value === -1)).toBe(true);
  });

  it("does not save the transfer until the user acknowledges tempo-map flattening, then preserves later MIDI timing", async () => {
    const bytes = writeMidiFile({
      bpm: 120,
      timeSignature: { num: 4, den: 4 },
      tempoChanges: [
        { tick: 0, bpm: 120 },
        { tick: BAR_TICKS * 4, bpm: 100 },
      ],
      tracks: [
        {
          name: "Lead",
          channel: 0,
          notes: [
            {
              pitch: 72,
              startTick: BAR_TICKS * 8,
              endTick: BAR_TICKS * 8 + 480,
              velocity: 0.8,
              releaseVelocity: 0.8,
            },
          ],
        },
      ],
    });
    const midiData = new Uint8Array(bytes.byteLength);
    midiData.set(bytes);
    const midiFile = new File([midiData.buffer], "Tempo Map.mid", { type: "audio/midi" });
    const save = vi.fn(async (_doc: ProjectDocument) => undefined);
    const core = { repo: { save } } as unknown as CoreServices;
    const onImported = vi.fn();
    const { container } = render(<TransferImportDialog core={core} onCancel={vi.fn()} onImported={onImported} />);
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("transfer file picker was not rendered");

    fireEvent.change(fileInput, { target: { files: [midiFile] } });
    expect(
      await screen.findByText(
        /MIDI tempo changes will be flattened into the chosen project tempo while preserving performance timing/,
      ),
    ).toBeInTheDocument();
    const importButton = screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i });
    expect(importButton).toBeDisabled();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the transfer limits/i }));
    fireEvent.click(importButton);

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const imported = onImported.mock.calls[0]?.[0] as ProjectDocument | undefined;
    const track = imported?.tracks.find((candidate) => candidate.name === "Lead");
    const pattern = imported?.patterns.find((candidate) => candidate.id === imported.activePatternId);
    expect(pattern?.notes[track?.id ?? ""]?.[0]).toMatchObject({
      start: 16_896,
      duration: 576,
      expression: { releaseVelocity: 0.8 },
    });
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
