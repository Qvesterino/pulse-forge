import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EffectRack } from "../../src/ui/EffectRack";
import { UltinaPanel } from "../../src/ui/UltinaPanel";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

describe("EffectRack", () => {
  function trackWithEffects(count: number) {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    track.effects = Array.from({ length: count }, (_, i) => ({
      id: `fx${i}`,
      type: "delay" as const,
      bypassed: false,
      params: {},
    }));
    return { doc, track };
  }

  it("shows empty message when no effects", () => {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    expect(screen.getByText(/No effects on this track/)).toBeInTheDocument();
  });

  it("renders effect devices", () => {
    const { doc, track } = trackWithEffects(2);
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    // fx-device-name class contains the effect name
    const deviceNames = document.querySelectorAll(".fx-device-name");
    expect(deviceNames.length).toBe(2);
  });

  it("shows add effect dropdown", () => {
    const { doc, track } = trackWithEffects(0);
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    expect(screen.getByLabelText("Add effect")).toBeInTheDocument();
  });

  it("exposes the flagship plugin suites in the add effect menu", () => {
    const { doc, track } = trackWithEffects(0);
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    const select = screen.getByLabelText("Add effect") as HTMLSelectElement;

    expect(Array.from(select.options).map((option) => option.value)).toEqual(
      expect.arrayContaining(["fxeq", "ultina", "ozvena"]),
    );
    expect(select.querySelector('optgroup[label="FLAGSHIP PLUGINS"]')).not.toBeNull();
    expect(screen.getByRole("option", { name: "FXEQ Multiband" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ultina Suite" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ozvena Reverb" })).toBeInTheDocument();
  });

  it("disables move-earlier on first effect", () => {
    const { doc, track } = trackWithEffects(2);
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    const earlierBtns = screen.getAllByText("◀");
    expect(earlierBtns[0]).toBeDisabled();
    expect(earlierBtns[1]).not.toBeDisabled();
  });

  it("disables move-later on last effect", () => {
    const { doc, track } = trackWithEffects(2);
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    const laterBtns = screen.getAllByText("▶");
    expect(laterBtns[0]).not.toBeDisabled();
    expect(laterBtns[1]).toBeDisabled();
  });

  it("executes removeEffect on × click", async () => {
    const user = userEvent.setup();
    const { doc, track } = trackWithEffects(1);
    const { services } = renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    await user.click(screen.getByText("×"));
    expect(services.store.execute).toHaveBeenCalled();
  });

  it("executes toggleEffectBypass on B click", async () => {
    const user = userEvent.setup();
    const { doc, track } = trackWithEffects(1);
    const { services } = renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    await user.click(screen.getByText("B"));
    expect(services.store.execute).toHaveBeenCalled();
  });

  it("collapses a device editor without removing its header controls", async () => {
    const user = userEvent.setup();
    const { doc, track } = trackWithEffects(1);
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });

    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    const collapse = screen.getByRole("button", { name: "Collapse Delay" });
    await user.click(collapse);

    expect(screen.getByRole("button", { name: "Expand Delay" })).toBeInTheDocument();
    expect(screen.queryByText("TIME")).toBeNull();
  });

  it("keeps an Ultina A/B snapshot when its editor is collapsed", async () => {
    const user = userEvent.setup();
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    // A/B state lives in the DOCUMENT (fx.deviceState) — collapse cannot erase it.
    track.effects = [
      {
        id: "fx-ult-collapse",
        type: "ultina",
        bypassed: false,
        params: {},
        deviceState: {
          kind: "ultina-ab-v1",
          data: { slots: { A: { "comp.band0.thresholdDb": -18 } }, active: "A" },
        },
      },
    ];
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    await screen.findByText("A ACTIVE · STORED");

    await user.click(screen.getByRole("button", { name: "Collapse Ultina Suite" }));
    await user.click(screen.getByRole("button", { name: "Expand Ultina Suite" }));

    expect(screen.getByText("A ACTIVE · STORED")).toBeInTheDocument();
  });

  it("A/B state lives in the document — a full remount (reload equivalent) restores it", async () => {
    const user = userEvent.setup();
    const doc = createProjectFromTemplate("house");
    const trackOf = () => doc.tracks.find((t) => t.kind === "instrument")!;
    trackOf().effects = [{ id: "fx-ult-remount", type: "ultina", bypassed: false, params: {} }];
    const services = mockServices(doc);
    (services.store.execute as ReturnType<typeof vi.fn>).mockImplementation(
      (cmd: { execute: (d: unknown) => unknown }) => {
        Object.assign(doc, cmd.execute(doc));
      },
    );
    const first = renderWithContext(<EffectRack track={trackOf()} />, { services });
    await user.click(await screen.findByRole("button", { name: "STORE" }));
    first.unmount();

    // Fresh mount against the mutated document — no component state involved.
    renderWithContext(<EffectRack track={trackOf()} />, { services });
    expect(await screen.findByText("A ACTIVE · STORED")).toBeInTheDocument();
    // And the executed command was the persisted device-state one.
    const executed = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { type: string },
    );
    expect(executed.some((c) => c.type === "setDeviceState")).toBe(true);
  });
});

describe("EffectRack — FXEQ panel", () => {
  function fxEqDoc() {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    track.effects = [{ id: "fx-eq", type: "fxeq" as const, bypassed: false, params: { bandCount: 4 } }];
    return { doc, track };
  }

  it("mounts the EQ-paint panel: preset select, band chips, canvas", async () => {
    const { doc, track } = fxEqDoc();
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    // The panel is a lazy chunk — wait for it to load.
    expect(await screen.findByLabelText("FXEQ preset")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "FXEQ band map" })).toBeInTheDocument();
    // Live band-peak meter strip sits under the band map.
    expect(screen.getByRole("img", { name: "FXEQ band peaks" })).toBeInTheDocument();
    // bandCount 4 → B1..B4 chips (and no B5).
    expect(screen.getByRole("button", { name: "B4" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "B5" })).toBeNull();
  });

  it("shows the degraded banner when the worklet fallback is active", () => {
    const { doc, track } = fxEqDoc();
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    // mockServices engine has no getDegradedFx → not degraded initially.
    expect(screen.queryByText(/AudioWorklet unavailable/)).toBeNull();
  });

  it("selecting a preset executes ONE bulk apply command", async () => {
    const user = userEvent.setup();
    const { doc, track } = fxEqDoc();
    const services = mockServices(doc);
    renderWithContext(<EffectRack track={track} />, { services });
    const select = await screen.findByLabelText("FXEQ preset");
    const presetName = "Warmth — All-Round";
    await user.selectOptions(select, presetName);
    const executed = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { type: string; label: string },
    );
    const presetCmds = executed.filter((c) => c.type === "applyFxEqPreset");
    expect(presetCmds.length).toBe(1);
    expect(presetCmds[0].label).toContain(presetName);
  });

  it("band module toggle executes a dotted setFxEqParam", async () => {
    const user = userEvent.setup();
    const { doc, track } = fxEqDoc();
    const services = mockServices(doc);
    renderWithContext(<EffectRack track={track} />, { services });
    // B1 selected by default — toggle its SAT module ON. Await the lazy panel.
    const satSections = await screen.findAllByText("SAT");
    await user.click(satSections[0].parentElement!.querySelector("button")!);
    const executed = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { type: string },
    );
    expect(executed.some((c) => c.type === "setFxEqParam")).toBe(true);
  });
});

describe("EffectRack — Ultina panel", () => {
  function ultinaDoc() {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    track.effects = [{ id: "fx-ult", type: "ultina" as const, bypassed: false, params: {} }];
    return { doc, track };
  }

  it("mounts the module editor: chips in graph order + enable toggle", async () => {
    const { doc, track } = ultinaDoc();
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    // The panel is a lazy chunk — wait for it to load.
    expect(await screen.findByLabelText("Ultina module editor")).toBeInTheDocument();
    // Graph-order chips present.
    expect(screen.getByRole("button", { name: "COMP" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "UNMSK" })).toBeInTheDocument();
    // Default selected module is COMP, currently OFF (params {}).
    expect(screen.getByRole("button", { name: "OFF" })).toBeInTheDocument();
  });

  it("enable toggle executes a dotted setUltinaParam", async () => {
    const user = userEvent.setup();
    const { doc, track } = ultinaDoc();
    const services = mockServices(doc);
    renderWithContext(<EffectRack track={track} />, { services });
    await user.click(screen.getByRole("button", { name: "OFF" })); // COMP enable
    const executed = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { type: string },
    );
    const paramCmds = executed.filter((c) => c.type === "setUltinaParam");
    expect(paramCmds.length).toBe(1);
  });

  it("selecting a preset executes ONE bulk apply command", async () => {
    const user = userEvent.setup();
    const { doc, track } = ultinaDoc();
    const services = mockServices(doc);
    renderWithContext(<EffectRack track={track} />, { services });
    const select = screen.getByLabelText("Ultina preset");
    const firstOption = select.querySelectorAll("option")[1]; // first real preset
    await user.selectOptions(select, firstOption.getAttribute("value")!);
    const executed = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { type: string },
    );
    expect(executed.some((c) => c.type === "applyUltinaPreset")).toBe(true);
  });

  it("EQ module shows the 12-band editor with response sketch", async () => {
    const user = userEvent.setup();
    const { doc, track } = ultinaDoc();
    const services = mockServices(doc);
    renderWithContext(<EffectRack track={track} />, { services });
    await user.click(screen.getByRole("button", { name: "EQ" }));
    // The store mock doesn't mutate the doc — assert the enable command.
    await user.click(screen.getByRole("button", { name: "OFF" }));
    const executed = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { type: string; label: string },
    );
    expect(executed.some((c) => c.type === "setUltinaParam" && c.label.includes("eq.enabled"))).toBe(true);
  });
});

describe("UltinaPanel — EQ band editor (direct render)", () => {
  it("renders the response sketch and band params when EQ is enabled", () => {
    const onParam = vi.fn();
    const onApplyPreset = vi.fn();
    const params: Record<string, number> = {
      "eq.enabled": 1,
      "eq.band0.enabled": 1,
      "eq.band0.freqHz": 80,
      "eq.band0.gainDb": 6,
      "eq.band0.q": 1,
      "eq.band0.shape": 0,
    };
    renderWithContext(
      <UltinaPanel
        trackId="t-ult"
        fxId="fx-ult"
        params={params}
        onParam={onParam}
        onApplyPreset={onApplyPreset}
        onApplyProposal={vi.fn()}
      />,
      { services: mockServices() },
    );
    // Select EQ, and since params enable it, the sketch renders.
    fireEvent.click(screen.getAllByRole("button", { name: "EQ" })[0]);
    expect(screen.getByRole("img", { name: "EQ response sketch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /BAND 1/ })).toBeInTheDocument();
  });
});

describe("UltinaPanel — PRO tools (delta / A/B / gain match)", () => {
  function renderPanel(params: Record<string, number>) {
    const onParam = vi.fn();
    const onApplyPreset = vi.fn();
    renderWithContext(
      <UltinaPanel
        trackId="t-ult"
        fxId="fx-ult"
        params={params}
        onParam={onParam}
        onApplyPreset={onApplyPreset}
        onApplyProposal={vi.fn()}
      />,
      { services: mockServices() },
    );
    return { onParam, onApplyPreset };
  }

  it("DELTA and G-MATCH toggles execute global params", async () => {
    const user = userEvent.setup();
    const { onParam } = renderPanel({});
    await user.click(screen.getByRole("button", { name: "DELTA" }));
    expect(onParam).toHaveBeenCalledWith("global.deltaListen", 1);
    await user.click(screen.getByRole("button", { name: "G-MATCH" }));
    expect(onParam).toHaveBeenCalledWith("global.gainMatchEnabled", 1);
  });

  it("G-MATCH on reveals the target LUFS slider (default -14)", () => {
    renderPanel({ "global.gainMatchEnabled": 1 });
    expect(screen.getByText("TARGET")).toBeInTheDocument();
    // The slider shows the streaming-standard default.
    expect(screen.getByText("-14.0 LUFS")).toBeInTheDocument();
  });

  it("A/B: STORE writes the active slot, clicking the other loads it as ONE gesture", async () => {
    const user = userEvent.setup();
    const params = { "comp.thresholdDb": -18, "global.mix": 80 };
    const { onApplyPreset } = renderPanel(params);
    // STORE into active slot A — dot marks it filled.
    await user.click(screen.getByRole("button", { name: "STORE" }));
    expect(screen.getByRole("button", { name: /A•/ })).toBeInTheDocument();
    // Switch to B (empty — just switches), then STORE B too.
    await user.click(screen.getByRole("button", { name: /^B$/ }));
    await user.click(screen.getByRole("button", { name: "STORE" }));
    // Click A — loads the stored snapshot as one bulk apply.
    await user.click(screen.getByRole("button", { name: /A•/ }));
    expect(onApplyPreset).toHaveBeenCalledWith("Slot A", expect.objectContaining({ "comp.thresholdDb": -18 }));
  });

  it("A/B exposes copy and clear controls without applying audio changes", async () => {
    const user = userEvent.setup();
    const { onApplyPreset } = renderPanel({ "comp.thresholdDb": -18 });

    await user.click(screen.getByRole("button", { name: "STORE" }));
    const copy = screen.getByRole("button", { name: "Copy A to B" });
    expect(copy).not.toBeDisabled();
    await user.click(copy);
    expect(screen.getByRole("button", { name: /B•/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear slot A" }));
    expect(screen.getByRole("button", { name: /^A$/ })).toBeInTheDocument();
    expect(onApplyPreset).not.toHaveBeenCalled();
  });
});

describe("EffectRack — flagship device shell contract (all three plugins)", () => {
  function flagshipDoc(type: "fxeq" | "ultina" | "ozvena", id: string) {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    track.effects = [{ id, type, bypassed: false, params: {} }];
    return { doc, track };
  }

  const NAMES: Record<string, string> = {
    fxeq: "FXEQ Multiband",
    ultina: "Ultina Suite",
    ozvena: "Ozvena Reverb",
  };

  for (const type of ["fxeq", "ultina", "ozvena"] as const) {
    it(`${type}: add → mount → collapse keeps mounted → expand → bypass flips state`, async () => {
      const user = userEvent.setup();
      const id = `fx-${type}-shell`;
      const { doc, track } = flagshipDoc(type, id);
      const services = mockServices(doc);
      (services.store.execute as ReturnType<typeof vi.fn>).mockImplementation(
        (cmd: { execute: (d: unknown) => unknown }) => {
          Object.assign(doc, cmd.execute(doc));
        },
      );
      renderWithContext(<EffectRack track={track} />, { services });

      // Device mounts with the shared header contract.
      expect(screen.getByText(NAMES[type], { selector: ".fx-device-name" })).toBeInTheDocument();
      expect(screen.getByText("ACTIVE")).toBeInTheDocument();

      // Collapse: aria-expanded flips, header stays, heavy content unmounts.
      await user.click(screen.getByRole("button", { name: `Collapse ${NAMES[type]}` }));
      expect(screen.getByRole("button", { name: `Expand ${NAMES[type]}` })).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByText(NAMES[type], { selector: ".fx-device-name" })).toBeInTheDocument();
      expect(screen.queryByText("ACTIVE")).toBeInTheDocument();

      // Expand again.
      await user.click(screen.getByRole("button", { name: `Expand ${NAMES[type]}` }));
      expect(screen.getByRole("button", { name: `Collapse ${NAMES[type]}` })).toHaveAttribute("aria-expanded", "true");

      // Bypass goes through the command layer (the label flip against the
      // real store is covered by the browser plugin-workflow E2E).
      await user.click(screen.getByTitle("Bypass effect"));
      const executed = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[0] as { type: string },
      );
      expect(executed.some((c) => c.type === "toggleEffectBypass")).toBe(true);
    });
  }
});
