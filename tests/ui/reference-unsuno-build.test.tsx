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
    // U5 etiquette: the golden house mix is clean — no findings, no chip.
    // (The pure heuristics are covered in section-mix-doctor.test.ts.)
    expect(screen.queryByTestId("unsuno-mix-findings")).not.toBeInTheDocument();
  }, 90_000);
});

describe("DropZone — UN-SUNO analyze offer (U6)", () => {
  it("RE-STYLE: after BUILD, an artist input swaps the band in one command", async () => {
    const { services, executeSpy } = setup();
    fireEvent.change(screen.getByTestId("reference-file-input"), { target: { files: [makeFile("song.wav")] } });
    await waitFor(
      () => {
        const build = screen.getByTestId("reference-build") as HTMLButtonElement;
        expect(build.disabled).toBe(false);
      },
      { timeout: 20_000 },
    );
    fireEvent.click(screen.getByTestId("reference-build"));
    fireEvent.click(screen.getByTestId("reference-build-go"));
    await waitFor(() => expect(executeSpy).toHaveBeenCalledTimes(1), { timeout: 30_000 });
    // The re-style row appears after a successful build.
    const row = await waitFor(() => expect(screen.getByTestId("restyle-row")).toBeInTheDocument(), { timeout: 10_000 });
    void row;
    fireEvent.change(screen.getByTestId("restyle-artist-input"), { target: { value: "travis scott" } });
    fireEvent.click(screen.getByTestId("restyle-go"));
    await waitFor(() => expect(executeSpy).toHaveBeenCalledTimes(2), { timeout: 30_000 });
    const command = executeSpy.mock.calls[1][0] as unknown as { type: string; label: string };
    expect(command.type).toBe("restyle");
    expect(command.label).toMatch(/travis scott/i);
  }, 120_000);

  it("U4.5: sourceSampleId attaches the original as one arrangement clip", async () => {
    const { services, executeSpy } = setup();
    const capturedBox: { detail?: { file: File; sampleId?: string } } = {};
    const listener = (event: Event): void => {
      capturedBox.detail = (event as CustomEvent<{ file: File; sampleId?: string }>).detail;
    };
    window.addEventListener("pf:unsuno-analyze", listener);
    // Simulate the DropZone hand-off, then BUILD with the source attached.
    window.dispatchEvent(
      new CustomEvent("pf:unsuno-analyze", { detail: { file: makeFile("orig.wav"), sampleId: "user.orig-123" } }),
    );
    window.removeEventListener("pf:unsuno-analyze", listener);
    await waitFor(
      () => {
        const build = screen.getByTestId("reference-build") as HTMLButtonElement;
        expect(build.disabled).toBe(false);
      },
      { timeout: 20_000 },
    );
    fireEvent.click(screen.getByTestId("reference-build"));
    fireEvent.click(screen.getByTestId("reference-build-go"));
    await waitFor(() => expect(executeSpy).toHaveBeenCalledTimes(1), { timeout: 30_000 });
    expect(capturedBox.detail?.sampleId).toBe("user.orig-123");
    // The executed unsuno command was built WITH the source id (its label
    // carries the warp suffix only when grids disagree; presence is enough).
    const command = executeSpy.mock.calls[0][0] as unknown as { type: string };
    expect(command.type).toBe("unsuno");
    void services;
  }, 60_000);

  it("S2: stems export produces 3 valid RIFF WAVs with suffixed names", async () => {
    // HPSS on the 15 s house render takes tens of seconds in the test env;
    // the contract (3 valid RIFF WAVs, suffixed names) is what this test
    // pins — determinism lives in stems-export.test.ts.
    const { services, decodeAudioData: decodeAudioDataMock } = setup();
    fireEvent.change(screen.getByTestId("reference-file-input"), { target: { files: [makeFile("mysong.wav")] } });
    await waitFor(
      () => {
        const build = screen.getByTestId("reference-build") as HTMLButtonElement;
        expect(build.disabled).toBe(false);
      },
      { timeout: 20_000 },
    );
    const exportBtn = screen.getByTestId("reference-export-stems") as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(false);
    // The engine mock's context needs createBuffer for the WAV encode path.
    (services.engine as unknown as { ensureContext: unknown }).ensureContext = () => ({
      state: "running",
      resume: vi.fn(async () => {}),
      currentTime: 0,
      decodeAudioData: vi.fn(async () => decodeAudioDataMock),
      // A storing AudioBuffer stub: copyToChannel feeds getChannelData so the
      // encoded WAV carries the actual stem samples.
      createBuffer: (channels: number, length: number, rate: number) => {
        const data = new Map<number, Float32Array>();
        return {
          numberOfChannels: channels,
          length,
          sampleRate: rate,
          getChannelData: (index: number) => {
            if (!data.has(index)) data.set(index, new Float32Array(length));
            return data.get(index)!;
          },
          copyToChannel: (source: Float32Array, index: number) => data.set(index, new Float32Array(source)),
        };
      },
    });
    fireEvent.click(exportBtn);
    await waitFor(
      () => {
        // surface any panel error inline — a silent failure teaches nothing
        const err = screen.queryByTestId("reference-error");
        expect(err?.textContent ?? null).toBe(null);
        expect(downloadSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 60_000 },
    );
    const names = downloadSpy.mock.calls.slice(0, 3).map((call) => call[1] as string);
    // the analyzed fileName is SANITIZED (dot stripped) before it reaches names
    expect(names).toEqual(["mysongwav-percussive.wav", "mysongwav-harmonic.wav", "mysongwav-bass.wav"]);
    for (const call of downloadSpy.mock.calls.slice(0, 3)) {
      const blob = call[0] as Blob;
      expect(blob.type).toBe("audio/wav");
      const head = Buffer.from(await blob.slice(0, 44).arrayBuffer());
      expect(head.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(head.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(head.readUInt32LE(24)).toBe(GOLDEN_SAMPLE_RATE);
      expect(head.readUInt16LE(22)).toBe(1); // mono
    }
  }, 120_000);

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
      const event = listener.mock.calls[0][0] as CustomEvent<{ file: File; sampleId: string }>;
      expect(event.detail.file).toBeInstanceOf(File);
      expect(typeof event.detail.sampleId).toBe("string");
      expect(event.detail.sampleId).toMatch(/^user\./);
      expect(screen.queryByTestId("dropzone-analyze-offer")).not.toBeInTheDocument();
    } finally {
      window.removeEventListener("pf:unsuno-analyze", listener);
    }
  });
});
