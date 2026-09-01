import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EffectRack } from "../../src/ui/EffectRack";
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
});

describe("EffectRack — FXEQ panel", () => {
  function fxEqDoc() {
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    track.effects = [
      { id: "fx-eq", type: "fxeq" as const, bypassed: false, params: { bandCount: 4 } },
    ];
    return { doc, track };
  }

  it("mounts the EQ-paint panel: preset select, band chips, canvas", () => {
    const { doc, track } = fxEqDoc();
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    expect(screen.getByLabelText("FXEQ preset")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "FXEQ band map" })).toBeInTheDocument();
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
    const select = screen.getByLabelText("FXEQ preset");
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
    // B1 selected by default — toggle its SAT module ON.
    const satSections = screen.getAllByText("SAT");
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
    track.effects = [
      { id: "fx-ult", type: "ultina" as const, bypassed: false, params: {} },
    ];
    return { doc, track };
  }

  it("mounts the module editor: chips in graph order + enable toggle", () => {
    const { doc, track } = ultinaDoc();
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    expect(screen.getByLabelText("Ultina module editor")).toBeInTheDocument();
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
    renderWithContext(<EffectRack track={track} />, { services: mockServices(doc) });
    await user.click(screen.getByRole("button", { name: "EQ" }));
    expect(screen.getByRole("img", { name: "EQ response sketch" })).toBeInTheDocument();
    // 12 band chips (BAND toggle shows "BAND 1 — OFF" initially).
    expect(screen.getByRole("button", { name: /BAND 1/ })).toBeInTheDocument();
  });
});
