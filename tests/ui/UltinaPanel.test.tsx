import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UltinaPanel } from "../../src/ui/UltinaPanel";
import { DEFAULT_MODULE_ORDER } from "../../src/effects/ultina-core/contracts/state";
import { createEmptyProposal } from "../../src/effects/ultina-core/analysis/assistant";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices, renderWithContext } from "../helpers";

const ultinaPanelMocks = vi.hoisted(() => ({
  renderTrack: vi.fn(),
  startUltinaAnalysis: vi.fn(),
  startLoudnessMeasurement: vi.fn(),
  playAuditionBuffer: vi.fn(),
  stopAudition: vi.fn(),
}));

vi.mock("../../src/rendering/track-renderer", () => ({ renderTrack: ultinaPanelMocks.renderTrack }));
vi.mock("../../src/analysis/ultinaAnalysisClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/analysis/ultinaAnalysisClient")>();
  return {
    ...actual,
    startUltinaAnalysis: ultinaPanelMocks.startUltinaAnalysis,
    startUltinaLoudnessMeasurement: ultinaPanelMocks.startLoudnessMeasurement,
  };
});
vi.mock("../../src/intent/audition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/intent/audition")>();
  return {
    ...actual,
    playAuditionBuffer: ultinaPanelMocks.playAuditionBuffer,
    stopAudition: ultinaPanelMocks.stopAudition,
  };
});

const baseProps = {
  trackId: "track-1",
  fxId: "fx-1",
  params: { "comp.enabled": 1 },
  onParam: vi.fn(),
  onApplyPreset: vi.fn(),
  onApplyProposal: vi.fn(),
};

describe("UltinaPanel", () => {
  it("renders the module selector with one chip per module in DEFAULT_MODULE_ORDER", () => {
    renderWithContext(<UltinaPanel {...baseProps} />, { services: mockServices() });
    const chips = screen.getByRole("group", { name: "Select module" });
    expect(chips).toBeInTheDocument();
    expect(chips.querySelectorAll("button")).toHaveLength(DEFAULT_MODULE_ORDER.length);
  });

  it("defaults the selected module to the third row 'COMP' (the compander)", () => {
    renderWithContext(<UltinaPanel {...baseProps} />, { services: mockServices() });
    // selectedModule starts at "comp", so the COMP button is pressed.
    expect(screen.getByRole("button", { name: "COMP" })).toHaveAttribute("aria-pressed", "true");
  });

  it("clicking EQ switches the selected module (EQ is in DEFAULT_MODULE_ORDER)", async () => {
    const user = userEvent.setup();
    renderWithContext(<UltinaPanel {...baseProps} params={{ "eq.enabled": 1 }} />, {
      services: mockServices(),
    });
    await user.click(screen.getByRole("button", { name: "EQ" }));
    expect(screen.getByRole("button", { name: "EQ" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "COMP" })).toHaveAttribute("aria-pressed", "false");
  });

  it("the ON/OFF toggle invokes onParam with `<module>.enabled` 0/1", async () => {
    const onParam = vi.fn();
    const user = userEvent.setup();
    // Start with comp turned OFF.
    renderWithContext(<UltinaPanel {...baseProps} params={{ "comp.enabled": 0 }} onParam={onParam} />, {
      services: mockServices(),
    });
    await user.click(screen.getByRole("button", { name: "OFF" }));
    expect(onParam).toHaveBeenCalledWith("comp.enabled", 1);
  });

  it("renders the degraded banner when the worklet is unavailable", () => {
    renderWithContext(<UltinaPanel {...baseProps} degraded={true} />, { services: mockServices() });
    expect(screen.getByText(/worklet|1:1/i)).toBeInTheDocument();
  });

  it("renders Mix Assist A/B before accepting the exact offline proposal", async () => {
    ultinaPanelMocks.renderTrack.mockReset();
    ultinaPanelMocks.startUltinaAnalysis.mockReset();
    ultinaPanelMocks.startLoudnessMeasurement.mockReset();
    ultinaPanelMocks.playAuditionBuffer.mockReset();
    ultinaPanelMocks.stopAudition.mockReset();

    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((candidate) => candidate.kind === "instrument");
    expect(track?.kind).toBe("instrument");
    if (!track || track.kind !== "instrument") throw new Error("House fixture has no instrument track");
    track.effects = [{ id: "fx-1", type: "ultina", bypassed: false, params: {} }];
    const createBuffer = (tag: string) =>
      ({
        tag,
        sampleRate: 44100,
        numberOfChannels: 2,
        getChannelData: () => new Float32Array(44100),
      }) as unknown as AudioBuffer & { tag: string };
    const before = createBuffer("before");
    const after = createBuffer("after");
    ultinaPanelMocks.renderTrack.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const proposal = {
      ...createEmptyProposal(),
      instrument: "bass" as const,
      analyzedDuration: 4,
      features: {
        ...createEmptyProposal().features,
        valid: true,
        analyzedDuration: 4,
        lufsIntegrated: -15.2,
        crestFactorDb: 8.1,
        dynamicRangeDb: 11.4,
      },
      classification: { instrument: "bass" as const, confidence: 0.92, scores: { bass: 0.92 }, explanation: "bass" },
      moduleToggles: [
        {
          moduleType: "eq",
          enabled: true,
          confidence: 0.8,
          reasonCode: "MUD_FREQUENCY_BUILDUP" as const,
          explanation: "reduce low-mid mud",
        },
      ],
      changes: [
        {
          parameterId: "eq.band0.gainDb",
          value: -2,
          confidence: 0.8,
          reasonCode: "MUD_FREQUENCY_BUILDUP" as const,
          explanation: "reduce low-mid mud",
        },
      ],
    };
    ultinaPanelMocks.startUltinaAnalysis.mockReturnValue({
      promise: Promise.resolve({ kind: "success", proposal }),
      cancel: vi.fn(),
    });
    ultinaPanelMocks.startLoudnessMeasurement
      .mockReturnValueOnce({ promise: Promise.resolve({ integratedLufs: -16 }), cancel: vi.fn() })
      .mockReturnValueOnce({ promise: Promise.resolve({ integratedLufs: -12 }), cancel: vi.fn() });

    const onApplyProposal = vi.fn(
      (
        _label: string,
        _toggles: { moduleType: string; enabled: boolean }[],
        _changes: { parameterId: string; value: number }[],
      ) => undefined,
    );
    const services = mockServices(doc);
    const user = userEvent.setup();
    renderWithContext(
      <UltinaPanel {...baseProps} trackId={track.id} fxId="fx-1" params={{}} onApplyProposal={onApplyProposal} />,
      { services },
    );

    await user.click(screen.getByRole("button", { name: /MIX ASSIST/ }));
    const review = await screen.findByRole("region", { name: "Mix assist proposal" });
    expect(review).toHaveTextContent("punchy character · balanced intensity");
    expect(review).toHaveTextContent("-15.2 LUFS");
    expect(review).toHaveTextContent("AFFECTED — track");
    expect(review).toHaveTextContent("BS.1770 integrated -16.0 → -12.0 LUFS");
    expect(ultinaPanelMocks.renderTrack).toHaveBeenCalledTimes(2);
    expect(services.store.getDoc()).toBe(doc);
    expect(onApplyProposal).not.toHaveBeenCalled();
    const previewDoc = ultinaPanelMocks.renderTrack.mock.calls[1][0] as typeof doc;
    const previewTrack = previewDoc.tracks.find((candidate) => candidate.id === track.id);
    expect(previewTrack?.kind).toBe("instrument");
    if (!previewTrack || previewTrack.kind !== "instrument") throw new Error("Preview lost the target track");
    expect(previewTrack.effects[0]?.params["eq.band0.gainDb"]).toBe(-2);
    expect(track.effects[0]?.params["eq.band0.gainDb"]).toBeUndefined();

    await user.click(screen.getByRole("button", { name: /PLAY BEFORE/ }));
    expect(ultinaPanelMocks.playAuditionBuffer).toHaveBeenLastCalledWith(before, expect.any(Function), 1);
    await user.click(screen.getByRole("button", { name: /PLAY PROPOSAL/ }));
    expect(ultinaPanelMocks.playAuditionBuffer).toHaveBeenLastCalledWith(
      after,
      expect.any(Function),
      expect.closeTo(Math.pow(10, -4 / 20), 5),
    );
    expect(onApplyProposal).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /APPLY PROPOSAL/ }));
    expect(onApplyProposal).toHaveBeenCalledTimes(1);
    expect(onApplyProposal).toHaveBeenCalledWith(
      "Mix assist (Bass)",
      [{ moduleType: "eq", enabled: true }],
      [{ parameterId: "eq.band0.gainDb", value: -2 }],
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: "Mix assist proposal" })).toBeNull());
  });

  it("invalidates a pending Mix Assist proposal if the project changes before acceptance", async () => {
    ultinaPanelMocks.renderTrack.mockReset();
    ultinaPanelMocks.startUltinaAnalysis.mockReset();
    ultinaPanelMocks.startLoudnessMeasurement.mockReset();
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((candidate) => candidate.kind === "instrument");
    expect(track?.kind).toBe("instrument");
    if (!track || track.kind !== "instrument") throw new Error("House fixture has no instrument track");
    track.effects = [{ id: "fx-1", type: "ultina", bypassed: false, params: {} }];
    const buffer = {
      sampleRate: 44100,
      numberOfChannels: 2,
      getChannelData: () => new Float32Array(44100),
    } as unknown as AudioBuffer;
    ultinaPanelMocks.renderTrack.mockResolvedValueOnce(buffer).mockResolvedValueOnce(buffer);
    const proposal = {
      ...createEmptyProposal(),
      analyzedDuration: 4,
      moduleToggles: [],
      changes: [
        {
          parameterId: "eq.band0.gainDb",
          value: -2,
          confidence: 0.8,
          reasonCode: "MUD_FREQUENCY_BUILDUP" as const,
          explanation: "reduce low-mid mud",
        },
      ],
    };
    ultinaPanelMocks.startUltinaAnalysis.mockReturnValue({
      promise: Promise.resolve({ kind: "success", proposal }),
      cancel: vi.fn(),
    });
    ultinaPanelMocks.startLoudnessMeasurement.mockReturnValue({
      promise: Promise.resolve({ integratedLufs: -18 }),
      cancel: vi.fn(),
    });
    const services = mockServices(doc);
    const onApplyProposal = vi.fn(
      (
        _label: string,
        _toggles: { moduleType: string; enabled: boolean }[],
        _changes: { parameterId: string; value: number }[],
      ) => undefined,
    );
    const user = userEvent.setup();
    renderWithContext(
      <UltinaPanel {...baseProps} trackId={track.id} fxId="fx-1" params={{}} onApplyProposal={onApplyProposal} />,
      { services },
    );
    await user.click(screen.getByRole("button", { name: /MIX ASSIST/ }));
    expect(await screen.findByRole("region", { name: "Mix assist proposal" })).toBeInTheDocument();

    const replacementDoc = { ...doc };
    services.store.getDoc = () => replacementDoc;
    (services.store as unknown as { _emit: () => void })._emit();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Mix assist proposal" })).toBeNull());
    expect(screen.getByText(/Projekt sa počas audície zmenil/)).toBeInTheDocument();
    expect(onApplyProposal).not.toHaveBeenCalled();
  });

  it("keeps Reference Match as an offline proposal until explicit acceptance", async () => {
    ultinaPanelMocks.renderTrack.mockReset();
    ultinaPanelMocks.startUltinaAnalysis.mockReset();
    ultinaPanelMocks.startLoudnessMeasurement.mockReset();
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((candidate) => candidate.kind === "instrument");
    expect(track?.kind).toBe("instrument");
    if (!track || track.kind !== "instrument") throw new Error("House fixture has no instrument track");
    track.effects = [{ id: "fx-1", type: "ultina", bypassed: false, params: {} }];
    const buffer = {
      sampleRate: 44100,
      numberOfChannels: 2,
      getChannelData: () => new Float32Array(44100),
    } as unknown as AudioBuffer;
    ultinaPanelMocks.renderTrack.mockResolvedValueOnce(buffer).mockResolvedValueOnce(buffer);
    const proposal = {
      ...createEmptyProposal(),
      analyzedDuration: 4,
      moduleToggles: [],
      changes: [
        {
          parameterId: "eq.band0.gainDb",
          value: 1.5,
          confidence: 0.7,
          reasonCode: "INSTRUMENT_PROFILE_MISMATCH" as const,
          explanation: "move toward the target curve",
        },
      ],
    };
    ultinaPanelMocks.startUltinaAnalysis.mockReturnValue({
      promise: Promise.resolve({ kind: "success", proposal }),
      cancel: vi.fn(),
    });
    ultinaPanelMocks.startLoudnessMeasurement
      .mockReturnValueOnce({ promise: Promise.resolve({ integratedLufs: -21 }), cancel: vi.fn() })
      .mockReturnValueOnce({ promise: Promise.resolve({ integratedLufs: -18 }), cancel: vi.fn() });
    const services = mockServices(doc);
    const onApplyProposal = vi.fn(
      (
        _label: string,
        _toggles: { moduleType: string; enabled: boolean }[],
        _changes: { parameterId: string; value: number }[],
      ) => undefined,
    );
    const user = userEvent.setup();
    renderWithContext(
      <UltinaPanel {...baseProps} trackId={track.id} fxId="fx-1" params={{}} onApplyProposal={onApplyProposal} />,
      { services },
    );

    await user.click(screen.getByRole("button", { name: "🎯 MATCH" }));
    expect(await screen.findByRole("region", { name: "Reference match proposal" })).toBeInTheDocument();
    expect(ultinaPanelMocks.renderTrack).toHaveBeenCalledTimes(2);
    expect(services.store.getDoc()).toBe(doc);
    expect(onApplyProposal).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /APPLY PROPOSAL/ }));
    expect(onApplyProposal).toHaveBeenCalledTimes(1);
    expect(onApplyProposal.mock.calls[0][0]).toMatch(/^Reference match \(/);
    expect(onApplyProposal.mock.calls[0][2]).toEqual([{ parameterId: "eq.band0.gainDb", value: 1.5 }]);
  });
});
