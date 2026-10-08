import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportPanel } from "../../src/ui/ExportPanel";
import { MasterProfileFileCheck } from "../../src/ui/MasterProfileFileGuidance";
import { awaitMasteringSampleBankReady } from "../../src/mastering/readiness";
import { createProjectFromTemplate } from "../../src/project-model/templates";
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

vi.mock("../../src/mastering/analysisClient", async (importOriginal) => {
  const [mod, analysis] = await Promise.all([
    importOriginal<typeof import("../../src/mastering/analysisClient")>(),
    import("../../src/mastering/analysis"),
  ]);
  return {
    ...mod,
    analyzeMasterBufferAsync: vi.fn(
      async (
        buffer: AudioBuffer,
        profile: Parameters<typeof analysis.analyzeMasterBuffer>[1],
        options?: Parameters<typeof mod.analyzeMasterBufferAsync>[2],
      ) => analysis.analyzeMasterBuffer(buffer, profile, options?.onProgress),
    ),
  };
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
  it("allows cancelling while boot-time sample hydration is still pending", async () => {
    let resolveHydration: (() => void) | undefined;
    const hydration = new Promise<void>((resolve) => {
      resolveHydration = resolve;
    });
    const controller = new AbortController();
    const waiting = awaitMasteringSampleBankReady(hydration, controller.signal);

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    resolveHydration?.();
  });

  it("renders the export region with the default FORMAT select", () => {
    renderWithContext(<ExportPanel />, { services: mockServices() });
    expect(screen.getByRole("region", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByLabelText("FORMAT")).toBeInTheDocument();
    expect(screen.getByLabelText("RATE")).toBeInTheDocument();
    expect(screen.getByLabelText("DEPTH")).toBeInTheDocument();
  });

  it("applies the typed streaming file suggestion only after explicit selection", async () => {
    const user = userEvent.setup();
    const project = createProjectFromTemplate("house");
    project.master.deliveryProfileId = "streaming";
    renderWithContext(<ExportPanel masteringMode />, { services: mockServices(project) });

    expect(screen.getByLabelText("FORMAT")).toHaveValue("wav");
    await user.click(screen.getByRole("button", { name: "USE PROFILE FILE SETTINGS" }));
    expect(screen.getByLabelText("FORMAT")).toHaveValue("flac");
    expect(screen.getByLabelText("DEPTH")).toHaveValue("24");
  });

  it("presents source-backed file checks separately from the loudness verdict", () => {
    render(
      <MasterProfileFileCheck
        verdict={{
          profileId: "streaming",
          status: "warn",
          checks: [
            { status: "pass", line: "FLAC is the preferred delivery format in the checked source." },
            { status: "warn", line: "The native source depth could not be confirmed." },
          ],
        }}
      />,
    );

    const fileCheck = screen.getByRole("group", { name: "Profile file delivery check" });
    expect(fileCheck).toHaveAttribute("data-state", "warn");
    expect(fileCheck).toHaveTextContent("PROFILE FILE DELIVERY CHECK · WARN");
    expect(fileCheck).toHaveTextContent("FLAC is the preferred delivery format");
    expect(fileCheck).not.toHaveTextContent("LUFS");
  });

  it("does not present an unverifiable delivery verdict as verified", () => {
    render(
      <MasterProfileFileCheck
        verdict={{
          profileId: "apple",
          status: "not-measured",
          checks: [
            { status: "pass", line: "16-bit is accepted by the checked source profile." },
            { status: "not-measured", line: "Apple-qualified encoder could not be verified from metadata." },
          ],
        }}
      />,
    );

    const fileCheck = screen.getByRole("group", { name: "Profile file delivery check" });
    expect(fileCheck).toHaveAttribute("data-state", "not-measured");
    expect(fileCheck).toHaveTextContent("PROFILE FILE DELIVERY CHECK · NOT-MEASURED");
    expect(fileCheck).not.toHaveTextContent("VERIFIED");
    expect(fileCheck).toHaveTextContent("Apple-qualified encoder could not be verified");
  });

  it("announces mastering progress in a polite atomic live region", async () => {
    const user = userEvent.setup();
    const { container } = renderWithContext(<ExportPanel />, { services: mockServices() });
    const announcement = container.querySelector<HTMLElement>(".sr-only");
    if (!announcement) throw new Error("The screen-reader export status is missing.");
    expect(announcement).toHaveAttribute("role", "status");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveAttribute("aria-atomic", "true");

    const analysisClient = await import("../../src/mastering/analysisClient");
    const originalAnalysis = vi.mocked(analysisClient.analyzeMasterBufferAsync).getMockImplementation();
    if (!originalAnalysis) throw new Error("The mastering analysis test implementation is missing.");
    let releaseAnalysis: (() => void) | undefined;
    vi.mocked(analysisClient.analyzeMasterBufferAsync).mockImplementationOnce(async (buffer, profile, options) => {
      const report = await originalAnalysis(buffer, profile);
      options?.onProgress?.({ progress: 0.47, stage: "Checking loudness" });
      return new Promise((resolve) => {
        releaseAnalysis = () => resolve(report);
      });
    });

    await user.click(screen.getByRole("button", { name: /^EXPORT MASTER/ }));
    await waitFor(() => expect(announcement).toHaveTextContent("Analyzing master… 40% · Checking loudness"));
    await user.click(screen.getByRole("button", { name: "Cancel export" }));
    releaseAnalysis?.();
    await waitFor(() => expect(announcement).toHaveTextContent(/Master export cancelled/));
  });

  it("announces a mastering export failure as an assertive alert", async () => {
    const user = userEvent.setup();
    const renderer = await import("../../src/rendering/renderer");
    vi.mocked(renderer.renderProject).mockRejectedValueOnce(new Error("simulated render failure"));
    const { container } = renderWithContext(<ExportPanel />, { services: mockServices() });

    await user.click(screen.getByRole("button", { name: /^EXPORT MASTER/ }));
    const announcement = await screen.findByRole("alert");
    expect(announcement).toHaveAttribute("aria-live", "assertive");
    expect(announcement).toHaveAttribute("aria-atomic", "true");
    expect(announcement).toHaveTextContent("simulated render failure");
    expect(container.querySelector(".sr-only")).toBe(announcement);
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

  it("blocks MP3 delivery before render when the estimated working set exceeds 512 MiB", async () => {
    const user = userEvent.setup();
    const project = createProjectFromTemplate("house");
    const longProject = {
      ...project,
      arrangement: {
        ...project.arrangement,
        clips: project.arrangement.clips.map((clip) => ({ ...clip, startBar: 0, lengthBars: 450 })),
      },
    };
    renderWithContext(<ExportPanel masteringMode />, { services: mockServices(longProject) });

    await user.selectOptions(screen.getByLabelText("FORMAT"), "mp3-320");

    expect(screen.getByRole("button", { name: /^EXPORT MASTER.*MP3/ })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/MP3 DELIVERY EXCEEDS KYX'S 512 MiB WORKING-SET LIMIT/);
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

  it("re-enables AUTO STAGE when a re-export delivers a new verdict", async () => {
    // The staged button instructs the user to "re-export to verify", so the
    // re-export is a documented step, not an edge case. A new render is a new
    // verdict: if the mix changed (a track was added, a fader moved, the user
    // undid the staged gain), the advice differs and has to be applicable
    // again. A latch that is never reset leaves it permanently unreachable for
    // the rest of the panel's life.
    const user = userEvent.setup();
    const services = mockServices();
    renderWithContext(<ExportPanel />, { services });

    await user.click(screen.getByRole("button", { name: /^EXPORT MASTER/ }));
    await user.click(await screen.findByRole("button", { name: /^AUTO STAGE/ }));
    expect(await screen.findByRole("button", { name: /^STAGED/ })).toBeDisabled();

    // Re-export, exactly as the button's own label tells the user to.
    await user.click(screen.getByRole("button", { name: /^EXPORT MASTER/ }));
    const afterReexport = await screen.findByRole("button", { name: /^(AUTO STAGE|STAGED)/ });
    expect(afterReexport).toBeEnabled();
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
