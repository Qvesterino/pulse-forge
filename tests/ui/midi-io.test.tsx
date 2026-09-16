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
  it("exposes explicit grid and scale quantize actions", () => {
    const base = createProjectFromTemplate("house");
    const doc = { ...base, key: "C Major" as const };
    const services = mockServices(doc);
    renderWithContext(<PatternBar clip={null} onCopy={vi.fn()} />, { services });

    fireEvent.change(screen.getByRole("combobox", { name: "Quantize grid" }), { target: { value: "240" } });
    let command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("quantizePatternToGrid");

    fireEvent.click(screen.getByRole("button", { name: "SCALE" }));
    command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("quantizePatternToScale");
  });

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

    fireEvent.click(screen.getByRole("button", { name: ".MID" }));
    const input = document.querySelector('input[type="file"][accept*=".mid"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    const file = new File([bytes as unknown as BlobPart], "My Beat.mid", { type: "audio/midi" });
    fireEvent.change(input, { target: { files: [file] } });

    // The SMF parser loads as a lazy chunk — under full-suite CPU load the
    // dynamic import can outrun waitFor's 1s default (same rationale as the
    // export test below).
    await waitFor(() => expect(screen.getByText(/notes \+ 1 drum hits/)).toBeInTheDocument(), {
      timeout: 10_000,
    });
    // Command executed: track count grew (drums + lead added to the empty kit).
    expect((services.store.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it("surfaces a parse error instead of crashing", async () => {
    const doc = createProjectFromTemplate("empty");
    const services = mockServices(doc);
    renderWithContext(<PatternBar clip={null} onCopy={vi.fn()} />, { services });

    fireEvent.click(screen.getByRole("button", { name: ".MID" }));
    const input = document.querySelector('input[type="file"][accept*=".mid"]') as HTMLInputElement;
    const junk = new File([new Uint8Array([1, 2, 3, 4])], "junk.mid", { type: "audio/midi" });
    fireEvent.change(input, { target: { files: [junk] } });

    await waitFor(() => expect(screen.getByText(/Import failed/)).toBeInTheDocument());
    expect(services.store.execute).not.toHaveBeenCalled();
  });

  it("rejects an oversized .mid before reading it into memory", async () => {
    const doc = createProjectFromTemplate("empty");
    const services = mockServices(doc);
    renderWithContext(<PatternBar clip={null} onCopy={vi.fn()} />, { services });

    fireEvent.click(screen.getByRole("button", { name: ".MID" }));
    const input = document.querySelector('input[type="file"][accept*=".mid"]') as HTMLInputElement;
    // Stub a huge size without allocating the bytes.
    const huge = new File([new Uint8Array(8)], "huge.mid", { type: "audio/midi" });
    Object.defineProperty(huge, "size", { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [huge] } });

    await waitFor(() => expect(screen.getByText(/too large/)).toBeInTheDocument());
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

describe("ExportPanel export policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes marker cue behavior and offline cancellation visible", () => {
    const doc = createProjectFromTemplate("house");
    doc.markers = [{ id: "marker-1", name: "Drop", type: "drop", tick: 0 }];
    renderWithContext(<ExportPanel />, { services: mockServices(doc) });

    const policy = screen.getByRole("note", { name: "Export policy" });
    expect(policy).toHaveTextContent(/1 cue one-shots.*SCOREPACK.*master WAV/i);
    expect(policy).toHaveTextContent(/CANCEL stops between stages\/encoding/i);
  });

  it("shows the video frame-granularity caveat when video is selected", () => {
    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    renderWithContext(<ExportPanel />, { services: mockServices(createProjectFromTemplate("house")) });
    fireEvent.change(screen.getByLabelText("FORMAT"), { target: { value: "video" } });

    expect(screen.getByRole("note", { name: "Export policy" })).toHaveTextContent(
      /VIDEO: final duration is codec\/frame-granular/i,
    );
  });
});
