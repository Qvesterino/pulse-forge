/**
 * ADR 0056, second cut — the disclosure must happen BEFORE the commitment.
 *
 * The first cut of ADR 0056 wired the grid warning into the transfer dialog, but gated it on
 * `inspection`:
 *
 *     const gridWarning = inspection ? patternGridWarning({ numerator, denominator }) : null;
 *
 * The meter control is live from the moment the dialog opens and is not gated on anything, so the
 * reachable sequence was: open the dialog, set 3/4, and the dialog says NOTHING about the grid it
 * is about to hand over. The warning appeared only once files had been chosen and inspected —
 * that is, only after the user had already committed to the meter. The ADR says the opposite:
 *
 *     "No surface may change the meter silently. While the grid stays 4/4, every surface that
 *      can select a non-4/4 meter must disclose the mismatch before the user commits to it."
 *
 * The mismatch is a property of the live meter state, not of the inspected files. Gating it on
 * the inspection made the disclosure depend on a fact that has nothing to do with it.
 *
 * Stage 2 changed WHICH grid the disclosure is about. The arrangement now follows the meter
 * (ruler, placement, loop regions, metronome, readouts), so the old "the arrangement grid is
 * 4/4" text became false. ADR 0057 then moved the PATTERN grid onto the meter as well: one bar
 * is `ticksPerBar(doc) / STEP_TICKS` steps, and the imported groove is padded UP to a whole
 * number of the document's bars. The disclosure now states what the chosen METER does to the
 * import — before the meter is committed, as before.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CoreServices } from "../src/services";
import { TransferImportDialog } from "../src/ui/TransferImportDialog";

const GRID_WARNING = /reads your project in/i;

function renderDialog(): { container: HTMLElement } {
  const core = { repo: { save: vi.fn() }, bank: { remove: vi.fn() }, engine: {} } as unknown as CoreServices;
  const { container } = render(<TransferImportDialog core={core} onCancel={vi.fn()} onImported={vi.fn()} />);
  return { container };
}

describe("ADR 0056 — the grid is disclosed before the meter is committed", () => {
  it("a non-4/4 meter says what it does to the import, with NO file chosen", async () => {
    // This is the defect. The meter control is live before anything is chosen, so the dialog has
    // to speak at that moment — not once the files land.
    renderDialog();

    fireEvent.change(screen.getByLabelText(/beats per bar/i), { target: { value: "3" } });

    const warning = await screen.findByText(GRID_WARNING);
    // It has to name the metrical bar in BOTH units, or it does not tell the user what the
    // metre means for their project.
    expect(warning.textContent).toContain("3/4");
    expect(warning.textContent).toContain("1440"); // the 3/4 bar, in ticks
    expect(warning.textContent).toContain("12 sixteenth steps"); // the 3/4 bar, in steps
  });

  it("a non-4/4 BEAT UNIT says it too", async () => {
    // The meter has two controls. A disclosure that only watches the numerator would still be
    // silent for 4/2, 2/4 and every other non-matching denominator.
    renderDialog();

    fireEvent.change(screen.getByLabelText(/beat unit/i), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText(/beats per bar/i), { target: { value: "6" } });

    const warning = await screen.findByText(GRID_WARNING);
    expect(warning.textContent).toContain("6/8");
    expect(warning.textContent).toContain("12 sixteenth steps");
  });

  it("NEGATIVE CONTROL: 4/4 with no file chosen says nothing", () => {
    // The 4/4 case is the negative control and it is not optional. A dialog that warned on 4/4
    // would train the user to ignore the box, and the warning would stop meaning anything.
    renderDialog();
    expect(screen.queryByText(GRID_WARNING)).toBeNull();
  });

  it("NEGATIVE CONTROL: 2/2 and 8/8 match the grid and say nothing", () => {
    // A meter matches the pattern grid when its bar is 4/4's bar — sixteen steps.
    // 2/2 and 8/8 are both 1920 ticks, so they are 4/4-length bars.
    for (const [num, den] of [
      [2, 2],
      [8, 8],
    ]) {
      const { unmount } = render(
        <TransferImportDialog
          core={{ repo: { save: vi.fn() }, bank: { remove: vi.fn() }, engine: {} } as unknown as CoreServices}
          onCancel={vi.fn()}
          onImported={vi.fn()}
        />,
      );
      fireEvent.change(screen.getByLabelText(/beats per bar/i), { target: { value: String(num) } });
      fireEvent.change(screen.getByLabelText(/beat unit/i), { target: { value: String(den) } });
      expect(screen.queryByText(GRID_WARNING), `${num}/${den} warned`).toBeNull();
      unmount();
    }
  });

  it("an INVALID meter is a settings error, not a grid mismatch", () => {
    // A half-typed 0 is not a meter. The grid warning would name a 0/4 meter and 0 ticks per bar,
    // which is noise on top of the settings error that already says the value is wrong. The
    // disclosure is about committing to a real meter, and an invalid one cannot be committed.
    renderDialog();

    fireEvent.change(screen.getByLabelText(/beats per bar/i), { target: { value: "0" } });

    expect(screen.queryByText(GRID_WARNING)).toBeNull();
    expect(screen.getByText(/beats per bar must be a whole number from 1 to 32/i)).toBeInTheDocument();
  });

  it("the import still cannot happen before files are chosen", () => {
    // The disclosure is not a licence. Without an inspection there is nothing to import, and the
    // button stays disabled.
    renderDialog();
    fireEvent.change(screen.getByLabelText(/beats per bar/i), { target: { value: "3" } });
    expect(screen.getByRole("button", { name: /IMPORT AS NEW KYX PROJECT/i })).toBeDisabled();
  });
});
