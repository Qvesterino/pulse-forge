/**
 * ADR 0056 — the arrangement grid is 4/4 whatever meter the document declares,
 * so every surface that can pick a non-4/4 meter has to DISCLOSE the mismatch
 * before the user commits to it.
 *
 * These specs are the gate for that disclosure. The 4/4 case is the negative
 * control and it is not optional: a dialog that warned on 4/4 too would train
 * the user to ignore the box, and the warning would stop meaning anything.
 *
 * The dialog specs drive the real entry point (the transfer import dialog) and
 * the real user flow (a 6/8 MIDI pre-fills the meter, the warning appears,
 * the import waits for the acknowledgement).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CoreServices } from "../src/services";
import { arrangementGridMatchesMeter, ticksPerBar, ticksPerBarFor } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { BAR_TICKS } from "../src/project-model/types";
import { arrangementGridWarning } from "../src/export/transfer-import";
import { writeMidiFile } from "../src/midi/midiFile";
import { TransferImportDialog } from "../src/ui/TransferImportDialog";

const importAudioFileMock = vi.hoisted(() => vi.fn());
const removeSampleMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/ui/sample-import", () => ({ importAudioFile: importAudioFileMock }));
vi.mock("../src/persistence/UserSampleRepository", () => ({
  UserSampleRepository: class {
    remove = removeSampleMock;
  },
}));

const GRID_WARNING = /arrangement grid is 4\/4/i;

function midiFile(sig?: { num: number; den: number }): File {
  const bytes = writeMidiFile({
    bpm: 120,
    ...(sig ? { timeSignature: sig } : {}),
    tracks: [
      {
        name: "Lead",
        channel: 0,
        notes: [{ pitch: 60, startTick: 0, endTick: 480, velocity: 0.8 }],
      },
    ],
  });
  const data = new Uint8Array(bytes.byteLength);
  data.set(bytes);
  return new File([data.buffer], "Song.mid", { type: "audio/midi" });
}

function renderDialog(): { container: HTMLElement } {
  const core = { repo: { save: vi.fn() }, bank: { remove: vi.fn() }, engine: {} } as unknown as CoreServices;
  const { container } = render(<TransferImportDialog core={core} onCancel={vi.fn()} onImported={vi.fn()} />);
  const fileInput = container.querySelector('input[type="file"]');
  if (!fileInput) throw new Error("transfer file picker was not rendered");
  return { container };
}

describe("ADR 0056 — bar length: the meter is musical, the arrangement grid is 4/4", () => {
  beforeEach(() => {
    importAudioFileMock.mockReset();
    removeSampleMock.mockClear();
  });

  it("a meter matches the 4/4 grid exactly when one bar spans four quarter notes", () => {
    for (const sig of [
      { numerator: 4, denominator: 4 },
      { numerator: 2, denominator: 2 },
      { numerator: 8, denominator: 8 },
    ]) {
      expect(arrangementGridMatchesMeter(sig)).toBe(true);
    }
    for (const sig of [
      { numerator: 3, denominator: 4 },
      { numerator: 6, denominator: 8 },
      { numerator: 4, denominator: 2 },
      { numerator: 12, denominator: 8 },
      { numerator: 2, denominator: 4 },
    ]) {
      expect(arrangementGridMatchesMeter(sig)).toBe(false);
    }
  });

  it("ticksPerBar and ticksPerBarFor are one formula, not two copies", () => {
    const doc = { ...createProjectFromTemplate("house"), timeSignature: { numerator: 6, denominator: 8 } };
    expect(ticksPerBar(doc)).toBe(ticksPerBarFor(doc.timeSignature));
    expect(ticksPerBar(doc)).toBe(1440);
    expect(ticksPerBarFor({ numerator: 4, denominator: 4 })).toBe(BAR_TICKS);
  });

  it("the warning names BOTH tick lengths and stays silent on 4/4", () => {
    expect(arrangementGridWarning({ numerator: 4, denominator: 4 })).toBeNull();

    const warning = arrangementGridWarning({ numerator: 6, denominator: 8 });
    expect(warning).not.toBeNull();
    expect(warning).toContain("6/8");
    expect(warning).toContain(String(BAR_TICKS)); // 1920 — the arrangement grid
    expect(warning).toContain("1440"); // the 6/8 bar
  });

  it("a 6/8 MIDI pre-fills the meter, raises the grid warning and holds the import until it is acknowledged", async () => {
    const { container } = renderDialog();
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("transfer file picker was not rendered");

    fireEvent.change(fileInput, { target: { files: [midiFile({ num: 6, den: 8 })] } });

    const warning = await screen.findByText(GRID_WARNING);
    expect(warning.textContent).toContain("6/8");
    expect(warning.textContent).toContain("1440");
    expect(warning.textContent).toContain("1920");

    const importButton = screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i });
    expect(importButton).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the transfer limits/i }));
    expect(importButton).toBeEnabled();
  });

  it("NEGATIVE CONTROL: a 4/4 import raises no grid warning and needs no acknowledgement", async () => {
    const { container } = renderDialog();
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("transfer file picker was not rendered");

    fireEvent.change(fileInput, { target: { files: [midiFile({ num: 4, den: 4 })] } });

    await waitFor(() => expect(screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i })).toBeInTheDocument());
    expect(screen.queryByText(GRID_WARNING)).toBeNull();
    expect(screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i })).toBeEnabled();
  });

  it("the warning follows the meter the user picks, not the meter's origin", async () => {
    const { container } = renderDialog();
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("transfer file picker was not rendered");

    fireEvent.change(fileInput, { target: { files: [midiFile({ num: 4, den: 4 })] } });
    await waitFor(() => expect(screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i })).toBeInTheDocument());
    expect(screen.queryByText(GRID_WARNING)).toBeNull();

    fireEvent.change(screen.getByLabelText(/beats per bar/i), { target: { value: "3" } });

    const warning = await screen.findByText(GRID_WARNING);
    expect(warning.textContent).toContain("3/4");
    expect(warning.textContent).toContain("1440");
  });
});
