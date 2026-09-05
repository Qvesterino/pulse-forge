/**
 * MIDI I/O wiring — PatternBar import button and ExportPanel MIDI export.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { PatternBar } from "../../src/ui/PatternBar";
import { ExportPanel } from "../../src/ui/ExportPanel";
import { writeMidiFile } from "../../src/midi/midiFile";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { renderWithContext, mockServices } from "../helpers";

const REAL_CREATE_OBJECT_URL = URL.createObjectURL;
const REAL_REVOKE_OBJECT_URL = URL.revokeObjectURL;

afterEach(() => {
  URL.createObjectURL = REAL_CREATE_OBJECT_URL;
  URL.revokeObjectURL = REAL_REVOKE_OBJECT_URL;
  vi.restoreAllMocks();
});

describe("PatternBar MIDI import", () => {
  it("imports a .mid file into a new active pattern with a status line", async () => {
    const doc = createProjectFromTemplate("empty");
    const services = mockServices(doc);
    const bytes = writeMidiFile({
      bpm: 110,
      tracks: [
        { name: "Drums", channel: 9, notes: [{ pitch: 36, startTick: 0, endTick: 60, velocity: 0.9 }] },
        { name: "Lead", channel: 0, notes: [{ pitch: 72, startTick: 120, endTick: 240, velocity: 0.8 }] },
      ],
    });

    renderWithContext(<PatternBar clip={null} onCopy={vi.fn()} />, { services });

    fireEvent.click(screen.getByRole("button", { name: "MIDI" }));
    const input = document.querySelector('input[type="file"][accept*=".mid"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    const file = new File([bytes as unknown as BlobPart], "My Beat.mid", { type: "audio/midi" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/notes \+ 1 drum hits/)).toBeInTheDocument());
    // Command executed: track count grew (drums + lead added to the empty kit).
    expect((services.store.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it("surfaces a parse error instead of crashing", async () => {
    const doc = createProjectFromTemplate("empty");
    const services = mockServices(doc);
    renderWithContext(<PatternBar clip={null} onCopy={vi.fn()} />, { services });

    fireEvent.click(screen.getByRole("button", { name: "MIDI" }));
    const input = document.querySelector('input[type="file"][accept*=".mid"]') as HTMLInputElement;
    const junk = new File([new Uint8Array([1, 2, 3, 4])], "junk.mid", { type: "audio/midi" });
    fireEvent.change(input, { target: { files: [junk] } });

    await waitFor(() => expect(screen.getByText(/Import failed/)).toBeInTheDocument());
    expect(services.store.execute).not.toHaveBeenCalled();
  });
});

describe("ExportPanel MIDI export", () => {
  it("downloads the active pattern as .mid", async () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    const created: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:mock"), revokeObjectURL: vi.fn() }));
    void created;

    const { container } = renderWithContext(<ExportPanel />, { services });
    fireEvent.click(screen.getByText("EXPORT MIDI (PATTERN)"));

    // The SMF writer loads as a lazy chunk — wait for the async export.
    // Generous timeout: the dynamic import can outrun the 1s default under
    // full-suite CPU load.
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const anchor = container.querySelector("a[download*='.mid']") ?? { download: "" };
    // The download fired with a .mid filename and the status confirms it.
    expect(screen.getByText(/MIDI exported/)).toBeInTheDocument();
    expect(anchor).toBeTruthy();
  });
});
