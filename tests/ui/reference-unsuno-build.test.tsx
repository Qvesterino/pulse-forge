import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ServicesContext } from "../../src/ui/context";
import { ReferenceMapPanel } from "../../src/ui/ReferenceMapPanel";
import { DropZone } from "../../src/ui/DropZone";
import { mockServices } from "../helpers";
import { renderGoldenTrack, goldenTracks, GOLDEN_SAMPLE_RATE } from "../unsuno/golden-synth";

/**
 * U6 — the BUILD PROJECT surface: analyze a real file through the panel's
 * real pipeline (only the AudioContext decoder is faked), then confirm that
 * 🎛 BUILD PROJECT executes exactly ONE unsuno command on the store — and
 * that the confirm step sits between the click and the mutation.
 */

const { downloadSpy, renderProjectSpy } = vi.hoisted(() => ({
  downloadSpy: vi.fn(),
  renderProjectSpy: vi.fn(),
}));
vi.mock("../../src/export/download", () => ({ downloadBlob: downloadSpy }));
vi.mock("../../src/rendering/renderer", () => ({ renderProject: renderProjectSpy }));

const housePcm = renderGoldenTrack(goldenTracks()[0]);
const seconds = housePcm.length / GOLDEN_SAMPLE_RATE;

function decodedHouse() {
  return {
    duration: seconds,
    sampleRate: GOLDEN_SAMPLE_RATE,
    numberOfChannels: 1,
    length: housePcm.length,
    getChannelData: () => housePcm,
  };
}

function makeFile(name: string, bytes = 2048): File {
  return new File([new Uint8Array(bytes)], name, { type: "audio/wav" });
}

function setup() {
  const decodeAudioData = vi.fn(async () => decodedHouse());
  const services = mockServices();
  const executeSpy = vi.fn((command: { type: string; label?: string }) => {
    // Mimic the real store just enough: the toast reads the label.
    (services as { lastCommandLabel?: string | null }).lastCommandLabel = command.label ?? null;
    return undefined;
  });
  (services.store as { execute: unknown }).execute = executeSpy;
  (services.engine as unknown as { ensureContext: unknown }).ensureContext = () => ({
    state: "running",
    resume: vi.fn(async () => {}),
    currentTime: 0,
    decodeAudioData,
  });
  render(
    <ServicesContext.Provider value={services}>
      <ReferenceMapPanel />
    </ServicesContext.Provider>,
  );
  return { decodeAudioData, services, executeSpy };
}

describe("ReferenceMapPanel — BUILD PROJECT (U6)", () => {
  beforeEach(() => {
    downloadSpy.mockClear();
    renderProjectSpy.mockClear();
  });

  it("no build button before anything is analyzed", () => {
    setup();
    // The controls block (and the build button with it) only exists once an
    // analysis does — there is nothing to build from.
    expect(screen.queryByTestId("reference-build")).not.toBeInTheDocument();
  });

  it("analyzes a real file, confirms, then executes ONE unsuno command", async () => {
    const { executeSpy } = setup();
    fireEvent.change(screen.getByTestId("reference-file-input"), { target: { files: [makeFile("track.wav")] } });
    // Analysis done → the button appears and demands confirmation first.
    const build = await waitFor(
      () => {
        const element = screen.getByTestId("reference-build") as HTMLButtonElement;
        expect(element.disabled).toBe(false);
        return element;
      },
      { timeout: 20_000 },
    );
    void build;
    expect(screen.queryByTestId("reference-build-go")).not.toBeInTheDocument();
    fireEvent.click(build);
    expect(screen.getByTestId("reference-build-confirm")).toBeInTheDocument();
    expect(executeSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("reference-build-go"));
    await waitFor(() => expect(executeSpy).toHaveBeenCalledTimes(1), { timeout: 30_000 });
    const command = executeSpy.mock.calls[0][0] as unknown as { type: string; label: string };
    expect(command.type).toBe("unsuno");
    expect(command.label).toMatch(/UN-SUNO reconstruct/);
    // The applied status carries the honest layer summary.
    await waitFor(() => expect(screen.getByTestId("reference-applied").textContent).toMatch(/UN-SUNO:/));
  }, 90_000);
});

describe("DropZone — UN-SUNO analyze offer (U6)", () => {
  it("offers analysis after a single import and dispatches the panel event", async () => {
    const services = mockServices();
    (services.engine as unknown as { ensureContext: unknown }).ensureContext = () => ({
      state: "running",
      resume: vi.fn(async () => {}),
      currentTime: 0,
      // A minimal decodable buffer — DropZone only needs importAudioFile to pass.
      decodeAudioData: vi.fn(async () => ({
        duration: 2,
        sampleRate: GOLDEN_SAMPLE_RATE,
        numberOfChannels: 1,
        length: GOLDEN_SAMPLE_RATE * 2,
        getChannelData: () => new Float32Array(GOLDEN_SAMPLE_RATE * 2),
      })),
    });
    render(
      <ServicesContext.Provider value={services}>
        <DropZone onImport={() => {}} />
      </ServicesContext.Provider>,
    );
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const listener = vi.fn();
    window.addEventListener("pf:unsuno-analyze", listener);
    try {
      fireEvent.change(input!, { target: { files: [makeFile("loop.wav")] } });
      await waitFor(() => expect(screen.getByTestId("dropzone-analyze-offer")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("dropzone-analyze-go"));
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent<File>;
      expect(event.detail).toBeInstanceOf(File);
      expect(screen.queryByTestId("dropzone-analyze-offer")).not.toBeInTheDocument();
    } finally {
      window.removeEventListener("pf:unsuno-analyze", listener);
    }
  });
});
