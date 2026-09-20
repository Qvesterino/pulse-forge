import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportPanel } from "../../src/ui/ExportPanel";
import { mockServices, renderWithContext } from "../helpers";

vi.mock("../../src/rendering/renderer", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/rendering/renderer")>();
  return {
    ...mod,
    renderProject: vi.fn(async () => {
      const data = new Float32Array(44100).fill(0.95);
      return {
        numberOfChannels: 2,
        length: data.length,
        sampleRate: 44100,
        duration: 1,
        getChannelData: (ch: number) => (ch === 0 ? data : data.slice()),
      };
    }),
  };
});

vi.mock("../../src/rendering/wav", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/rendering/wav")>();
  return { ...mod, downloadWav: vi.fn() };
});

// Rhythmic take: four decaying 60 Hz bursts (detector-grade attacks).
function impulseTake(): { buffer: AudioBuffer; blob: Blob } {
  const sr = 44100;
  const data = new Float32Array(sr);
  for (const t of [0, 0.25, 0.5, 0.75]) {
    const start = Math.floor(t * sr);
    for (let i = 0; i < 0.05 * sr; i++) {
      const idx = start + i;
      if (idx >= data.length) break;
      data[idx] += 0.9 * Math.exp(-i / (0.004 * sr)) * Math.sin((2 * Math.PI * 60 * i) / sr);
    }
  }
  return {
    buffer: {
      duration: 1,
      sampleRate: sr,
      numberOfChannels: 1,
      length: data.length,
      getChannelData: () => data,
    } as unknown as AudioBuffer,
    blob: { type: "audio/webm", arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob,
  };
}

vi.mock("../../src/audio-engine/recorder", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/audio-engine/recorder")>();
  return {
    ...mod,
    LiveRecorder: vi.fn().mockImplementation(() => ({
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => impulseTake()),
      cancel: vi.fn(async () => {}),
      get elapsedSeconds() {
        return 1;
      },
    })),
  };
});

describe("ExportPanel", () => {
  it("renders the export region with the default FORMAT select", () => {
    renderWithContext(<ExportPanel />, { services: mockServices() });
    expect(screen.getByRole("region", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByLabelText("FORMAT")).toBeInTheDocument();
    expect(screen.getByLabelText("RATE")).toBeInTheDocument();
    expect(screen.getByLabelText("DEPTH")).toBeInTheDocument();
  });

  it("default export button is labelled EXPORT MASTER (WAV)", () => {
    renderWithContext(<ExportPanel />, { services: mockServices() });
    expect(screen.getByRole("button", { name: /^EXPORT MASTER/ })).toBeInTheDocument();
    // WAV doesn't get a suffix — only MP3 gets "(MP3)" appended for clarity.
    expect(screen.getByRole("button", { name: /^EXPORT MASTER/ })).toHaveTextContent("EXPORT MASTER");
  });

  it("switching FORMAT to MP3 192 updates the button label", async () => {
    const user = userEvent.setup();
    renderWithContext(<ExportPanel />, { services: mockServices() });
    await user.selectOptions(screen.getByLabelText("FORMAT"), "mp3-192");
    expect(screen.getByRole("button", { name: /^EXPORT MASTER.*MP3/ })).toBeInTheDocument();
  });

  it("switching RATE to 48 kHz records 48000 as selected value", async () => {
    const user = userEvent.setup();
    renderWithContext(<ExportPanel />, { services: mockServices() });
    await user.selectOptions(screen.getByLabelText("RATE"), "48000");
    expect(screen.getByLabelText("RATE")).toHaveValue("48000");
  });

  it("export-policy note is rendered so users can see CANCEL guidance", () => {
    renderWithContext(<ExportPanel />, { services: mockServices() });
    expect(screen.getByRole("note", { name: "Export policy" })).toBeInTheDocument();
  });

  it("no AUTO STAGE button before any export", () => {
    renderWithContext(<ExportPanel />, { services: mockServices() });
    expect(screen.queryByRole("button", { name: /^AUTO STAGE/ })).toBeNull();
  });

  it("hot export offers AUTO STAGE and applies one master-gain command", async () => {
    const user = userEvent.setup();
    const services = mockServices();
    renderWithContext(<ExportPanel />, { services });
    await user.click(screen.getByRole("button", { name: /^EXPORT MASTER/ }));
    // Hot constant-scale render: TP over ceiling and way too loud.
    const stage = await screen.findByRole("button", { name: /^AUTO STAGE/ });
    expect(stage).toHaveTextContent("-");
    await user.click(stage);
    const executed = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { type: string; execute: (d: unknown) => { master: { masterGain: number } } },
    );
    const staging = executed.filter((c) => c.type === "setMasterConfig");
    expect(staging).toHaveLength(1);
    expect(staging[0].execute({ master: { masterGain: 1 } }).master.masterGain).toBeLessThan(1);
    // Button confirms and disables after staging.
    expect(await screen.findByRole("button", { name: /^STAGED/ })).toBeDisabled();
  });

  it("global quality switch defaults to Studio HQ", () => {
    renderWithContext(<ExportPanel />, { services: mockServices() });
    const quality = screen.getByLabelText("QUALITY") as HTMLSelectElement;
    expect(quality.value).toBe("studio");
  });

  it("switching QUALITY to Live records live as selected value", async () => {
    const user = userEvent.setup();
    renderWithContext(<ExportPanel />, { services: mockServices() });
    await user.selectOptions(screen.getByLabelText("QUALITY"), "live");
    expect(screen.getByLabelText("QUALITY")).toHaveValue("live");
  });

  it("no AUTO-CHOP button before any take", () => {
    renderWithContext(<ExportPanel />, { services: mockServices() });
    expect(screen.queryByRole("button", { name: /^AUTO-CHOP/ })).toBeNull();
  });

  it("recorded take offers AUTO-CHOP that maps onsets to drum pads + pattern", async () => {
    const user = userEvent.setup();
    const services = mockServices();
    (services.engine as unknown as { getLiveAudioContext?: () => unknown }).getLiveAudioContext = vi.fn(() => ({}));
    renderWithContext(<ExportPanel />, { services });
    await user.click(screen.getByRole("button", { name: /● REC/ }));
    await user.click(await screen.findByRole("button", { name: /■ STOP/ }));

    const chop = await screen.findByRole("button", { name: /^AUTO-CHOP/ });
    await user.click(chop);
    const executed = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { type: string },
    );
    expect(executed.some((c) => c.type === "chopSampleToPads")).toBe(true);
    expect(await screen.findByText(/slices → .* \+ pattern/)).toBeInTheDocument();
  });
});
