/**
 * ADR 0056 → 0057 — the meter is musical, and the grid speaks it too.
 *
 * Stage 2 moved the arrangement onto the document's meter. ADR 0057 moved the
 * PATTERN grid after it: one bar is `ticksPerBar(doc) / STEP_TICKS` steps, and
 * the imported groove is padded UP to a whole number of the document's bars, so
 * it lands on the downbeat in every meter.
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
import { ticksPerBar, ticksPerBarFor } from "../src/project-model/schema";
import { isWholeBarPatternFor } from "../src/project-model/grid";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { PATTERN_TICKS, STEPS_PER_PATTERN } from "../src/project-model/types";
import { patternGridWarning } from "../src/export/transfer-import";
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

const GRID_WARNING = /reads your project in/i;

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

describe("ADR 0056/0057 — the meter is musical, and the grid speaks it", () => {
  beforeEach(() => {
    importAudioFileMock.mockReset();
    removeSampleMock.mockClear();
  });

  it("a 16-step pattern is a whole number of bars exactly when the metrical bar divides it", () => {
    for (const sig of [
      { numerator: 4, denominator: 4 },
      { numerator: 2, denominator: 2 },
      { numerator: 8, denominator: 8 },
      // 2/4 moved to this side when ADR 0057 asked the RIGHT question. The old
      // predicate asked "is the bar four quarter notes"; this one asks "does a
      // 16-step pattern land on the bar line", and in 2/4 the bar is eight
      // steps, so a 16-step pattern is exactly two whole bars.
      { numerator: 2, denominator: 4 },
    ]) {
      expect(isWholeBarPatternFor(sig, STEPS_PER_PATTERN)).toBe(true);
    }
    for (const sig of [
      { numerator: 3, denominator: 4 },
      { numerator: 6, denominator: 8 },
      { numerator: 4, denominator: 2 },
      { numerator: 12, denominator: 8 },
    ]) {
      expect(isWholeBarPatternFor(sig, STEPS_PER_PATTERN)).toBe(false);
    }
  });

  it("ticksPerBar and ticksPerBarFor are one formula, not two copies", () => {
    const doc = { ...createProjectFromTemplate("house"), timeSignature: { numerator: 6, denominator: 8 } };
    expect(ticksPerBar(doc)).toBe(ticksPerBarFor(doc.timeSignature));
    expect(ticksPerBar(doc)).toBe(1440);
    expect(ticksPerBarFor({ numerator: 4, denominator: 4 })).toBe(PATTERN_TICKS);
  });

  it("the warning names the metrical bar and its step count, and stays silent on 4/4", () => {
    expect(patternGridWarning({ numerator: 4, denominator: 4 })).toBeNull();

    const warning = patternGridWarning({ numerator: 6, denominator: 8 });
    expect(warning).not.toBeNull();
    expect(warning).toContain("6/8");
    expect(warning).toContain("1440"); // the 6/8 bar, in ticks
    expect(warning).toContain("12"); // the 6/8 bar, in sixteenth steps
    // The arrangement part of the sentence must say the arrangement FOLLOWS
    // the meter — the old text claimed the opposite and became false.
    expect(warning).toContain("loop region is 1440 ticks");
    expect(warning).not.toContain("arrangement grid is 4/4");
  });

  it("states the padding, and does NOT claim a drift the import no longer has", () => {
    const warning = patternGridWarning({ numerator: 6, denominator: 8 })!;
    // The import rounds UP to a whole number of the document's bars, so the
    // groove lands on the downbeat. The old wording ("1.33 bars", "every 4
    // bars") described a drift that the import no longer produces — a
    // disclosure that says something untrue is worse than no disclosure.
    expect(warning).toContain("padded to a whole number");
    expect(warning).toContain("lands on the downbeat");
    expect(warning).not.toMatch(/drift/i);
    expect(warning).not.toContain("1.33 bars");
    expect(warning).not.toContain("every 4 bars");
  });

  it("a 6/8 MIDI pre-fills the meter, raises the grid warning and holds the import until it is acknowledged", async () => {
    const { container } = renderDialog();
    const fileInput = container.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("transfer file picker was not rendered");

    fireEvent.change(fileInput, { target: { files: [midiFile({ num: 6, den: 8 })] } });

    const warning = await screen.findByText(GRID_WARNING);
    expect(warning.textContent).toContain("6/8");
    expect(warning.textContent).toContain("1440");
    // The 6/8 bar in STEPS — the grid's bar is metrical, so the dialog quotes
    // the metrical length, not 4/4's 1920 ticks.
    expect(warning.textContent).toContain("12 sixteenth steps");

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
