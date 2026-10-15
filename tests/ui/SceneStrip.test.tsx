import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { SceneStrip } from "../../src/ui/SceneStrip";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { defaultParamsOf } from "../../src/effects/registry";
import { TWIST_SCENE_PACK } from "../../src/effects/skrutka-scene-pack";
import { KOREN_SCENE_PACK } from "../../src/effects/koren-scene-pack";
import { applyTwistScenePair } from "../../src/commands/twistScene";
import { applyKorenScenePair } from "../../src/commands/korenScene";
import type { Command } from "../../src/commands/types";
import type { EffectInstance, ProjectDocument } from "../../src/project-model/types";

/**
 * SceneStrip — the shared scene-intensity surface: one intensity slider for
 * the active (or selected) scene plus one pair picker per TWIST/GROW device.
 * The tests pin the command wiring (the executed command really writes the
 * scene intensity / the pair), the SCENE chip on bound rows, the CUSTOM
 * fallback and the empty state.
 */

function lastCommand(execute: unknown): Command {
  const calls = (execute as { mock: { calls: [Command][] } }).mock.calls;
  return calls[calls.length - 1]![0];
}

function withSceneFx(): { doc: ProjectDocument; drumId: string; twistId: string; instId: string; growId: string } {
  const doc = createProjectFromTemplate("house");
  const drum = doc.tracks.find((track) => track.kind === "drum")!;
  const twist: EffectInstance = {
    id: "fx-twist",
    type: "skrutka",
    bypassed: false,
    params: defaultParamsOf("skrutka"),
  };
  drum.effects = [twist];
  const inst = doc.tracks.find((track) => track.kind === "instrument")!;
  const grow: EffectInstance = {
    id: "fx-grow",
    type: "bassHarmonic",
    bypassed: false,
    params: defaultParamsOf("bassHarmonic"),
  };
  inst.effects = [grow];
  const twistPair = TWIST_SCENE_PACK.find((pair) => pair.id === "house-tight-liquid")!;
  const growPair = KOREN_SCENE_PACK.find((pair) => pair.id === "drill-phone-growl")!;
  const withTwist = applyTwistScenePair(doc, drum.id, twist.id, twistPair).execute(doc);
  const withBoth = applyKorenScenePair(withTwist, inst.id, grow.id, growPair).execute(withTwist);
  return { doc: withBoth, drumId: drum.id, twistId: twist.id, instId: inst.id, growId: grow.id };
}

describe("SceneStrip", () => {
  afterEach(cleanup);

  it("edits the active scene's static intensity through the command", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    const scene = doc.scenes.find((candidate) => candidate.patternId === doc.activePatternId) ?? doc.scenes[0]!;
    renderWithContext(<SceneStrip />, { services });

    expect(screen.getAllByText(scene.name).length).toBeGreaterThan(0);
    expect(screen.getByText("STATIC")).toBeInTheDocument();

    const slider = screen.getByRole("slider", { name: "Scene intensity" });
    // jsdom rects are zero — give the rail a real width so the click-to-set
    // commit resolves a position instead of NaN.
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 200,
    } as DOMRect);
    fireEvent.pointerDown(slider, { button: 0, clientX: 0, clientY: 0, pointerType: "mouse" });
    fireEvent.pointerUp(slider, { clientX: 0, clientY: 0 });

    expect(services.store.execute).toHaveBeenCalledTimes(1);
    const after = lastCommand(services.store.execute).execute(doc);
    expect(after.scenes.find((candidate) => candidate.id === scene.id)!.intensity).toBe(0);
  });

  it("shows the active pair per device and applies a new one from the strip", () => {
    const { doc, drumId, twistId, instId, growId } = withSceneFx();
    const services = mockServices(doc);
    const drumName = doc.tracks.find((track) => track.id === drumId)!.name;
    const instName = doc.tracks.find((track) => track.id === instId)!.name;
    renderWithContext(<SceneStrip />, { services });

    expect(screen.getByText("TWIST", { selector: ".scene-strip-kind" })).toBeInTheDocument();
    expect(screen.getByText("GROW", { selector: ".scene-strip-kind" })).toBeInTheDocument();
    expect(screen.getAllByText("SCENE", { selector: ".scene-strip-chip" })).toHaveLength(2);

    const twistSelect = screen.getByLabelText(`TWIST scene pair on ${drumName}`) as HTMLSelectElement;
    expect(twistSelect.value).toBe("house-tight-liquid");
    fireEvent.change(twistSelect, { target: { value: "trap-center-shimmer" } });
    const twistAfter = lastCommand(services.store.execute).execute(doc);
    const twistFx = twistAfter.tracks
      .find((track) => track.id === drumId)!
      .effects.find((effect) => effect.id === twistId)!;
    const twistSlots = twistFx.deviceState!.data.slots as Record<string, Record<string, number>>;
    expect(twistSlots.A?.field).toBe(-0.5);

    const growSelect = screen.getByLabelText(`GROW scene pair on ${instName}`) as HTMLSelectElement;
    expect(growSelect.value).toBe("drill-phone-growl");
    fireEvent.change(growSelect, { target: { value: "dnb-sub-reese" } });
    const growAfter = lastCommand(services.store.execute).execute(doc);
    const growFx = growAfter.tracks
      .find((track) => track.id === instId)!
      .effects.find((effect) => effect.id === growId)!;
    const growSlots = growFx.deviceState!.data.slots as Record<string, Record<string, number>>;
    expect(growSlots.B?.width).toBe(0.5);
  });

  it("falls back to CUSTOM for a device without a stored pair", () => {
    const doc = createProjectFromTemplate("house");
    const drum = doc.tracks.find((track) => track.kind === "drum")!;
    const paired: EffectInstance = {
      id: "fx-twist-paired",
      type: "skrutka",
      bypassed: false,
      params: defaultParamsOf("skrutka"),
    };
    const fresh: EffectInstance = {
      id: "fx-twist-fresh",
      type: "skrutka",
      bypassed: false,
      params: defaultParamsOf("skrutka"),
    };
    drum.effects = [paired, fresh];
    const withPair = applyTwistScenePair(
      doc,
      drum.id,
      paired.id,
      TWIST_SCENE_PACK.find((pair) => pair.id === "house-tight-liquid")!,
    ).execute(doc);
    const services = mockServices(withPair);
    renderWithContext(<SceneStrip />, { services });

    const selects = screen.getAllByLabelText(`TWIST scene pair on ${drum.name}`) as HTMLSelectElement[];
    expect(selects).toHaveLength(2);
    const custom = selects.find((select) => select.value === "")!;
    expect(custom).toBeDefined();
    expect(within(custom).getByText("CUSTOM")).toBeInTheDocument();
  });

  it("shows the empty state when the project has no scene devices", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    renderWithContext(<SceneStrip />, { services });
    expect(screen.getByText("No TWIST or GROW devices in the project")).toBeInTheDocument();
  });

  it("writes the per-scene pair override and renders a stored one", () => {
    const { doc, drumId, twistId } = withSceneFx();
    const drumName = doc.tracks.find((track) => track.id === drumId)!.name;
    const scene = doc.scenes.find((candidate) => candidate.patternId === doc.activePatternId) ?? doc.scenes[0]!;
    const services = mockServices(doc);
    const { unmount } = renderWithContext(<SceneStrip />, { services });

    const select = screen.getByLabelText(`Scene pair for TWIST on ${drumName}`) as HTMLSelectElement;
    expect(select.value).toBe("");
    fireEvent.change(select, { target: { value: "trap-center-shimmer" } });
    const after = lastCommand(services.store.execute).execute(doc);
    expect(after.scenes.find((candidate) => candidate.id === scene.id)!.packs?.[twistId]).toBe("trap-center-shimmer");
    unmount();

    // A stored scene selection renders as the scene picker's value.
    const withScenePack = lastCommand(services.store.execute).execute(doc);
    const services2 = mockServices(withScenePack);
    renderWithContext(<SceneStrip />, { services: services2 });
    expect((screen.getByLabelText(`Scene pair for TWIST on ${drumName}`) as HTMLSelectElement).value).toBe(
      "trap-center-shimmer",
    );
  });

  it("pins a macro to the scene from the strip and clears it", () => {
    const { doc } = withSceneFx();
    const scene = doc.scenes.find((candidate) => candidate.patternId === doc.activePatternId) ?? doc.scenes[0]!;
    const macro = doc.macros[0]!;
    const services = mockServices(doc);
    const { unmount } = renderWithContext(<SceneStrip />, { services });

    const slider = screen.getByRole("slider", { name: `Scene macro ${macro.name}` });
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 200 } as DOMRect);
    fireEvent.pointerDown(slider, { button: 0, clientX: 200, clientY: 0, pointerType: "mouse" });
    fireEvent.pointerUp(slider, { clientX: 200, clientY: 0 });
    const after = lastCommand(services.store.execute).execute(doc);
    expect(after.scenes.find((candidate) => candidate.id === scene.id)!.macros?.[macro.id]).toBeCloseTo(1, 9);
    unmount();

    // A pinned scene shows the clear control; clearing restores the live macro.
    const services2 = mockServices(after);
    renderWithContext(<SceneStrip />, { services: services2 });
    const clear = screen.getByTitle(`Clear the ${macro.name} pin — the macro returns to its live value`);
    fireEvent.click(clear);
    const cleared = lastCommand(services2.store.execute).execute(after);
    expect(cleared.scenes.find((candidate) => candidate.id === scene.id)!.macros).toBeUndefined();
  });

  it("arms and disarms CC remaps per scene", () => {
    // Command outputs are frozen — rebuild a mutable copy before pushing the
    // CC mapping into the macro.
    const doc = JSON.parse(JSON.stringify(withSceneFx().doc)) as ProjectDocument;
    const trackId = doc.tracks.find((track) => track.kind === "drum")!.id;
    const macro = doc.macros[0]!;
    macro.mappings.push({
      id: "cc-ui",
      trackId,
      param: "gain",
      amount: 0.5,
      source: "midiCC",
      ccNumber: 74,
    });
    const scene = doc.scenes.find((candidate) => candidate.patternId === doc.activePatternId) ?? doc.scenes[0]!;
    const services = mockServices(doc);
    const { unmount } = renderWithContext(<SceneStrip />, { services });

    const box = screen.getByLabelText(`${macro.name} ← CC74 armed in this scene`) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    const after = lastCommand(services.store.execute).execute(doc);
    // The only CC mapping was disarmed → the empty allow-list = none armed.
    expect(after.scenes.find((candidate) => candidate.id === scene.id)!.ccRemaps).toEqual([]);
    unmount();

    const services2 = mockServices(after);
    renderWithContext(<SceneStrip />, { services: services2 });
    expect((screen.getByLabelText(`${macro.name} ← CC74 armed in this scene`) as HTMLInputElement).checked).toBe(false);
  });

  it("re-points CC number and channel per scene", () => {
    const doc = JSON.parse(JSON.stringify(withSceneFx().doc)) as ProjectDocument;
    const trackId = doc.tracks.find((track) => track.kind === "drum")!.id;
    const macro = doc.macros[0]!;
    macro.mappings.push({
      id: "cc-repoint-ui",
      trackId,
      param: "gain",
      amount: 0.5,
      source: "midiCC",
      ccNumber: 74,
      channel: 1,
    });
    const scene = doc.scenes.find((candidate) => candidate.patternId === doc.activePatternId) ?? doc.scenes[0]!;
    const label = `${macro.name} ← CC74 ch1`;
    const services = mockServices(doc);
    const { unmount } = renderWithContext(<SceneStrip />, { services });

    const ccField = screen.getByLabelText(`CC number for ${label} in this scene`) as HTMLInputElement;
    expect(ccField.value).toBe("74");
    fireEvent.change(ccField, { target: { value: "20" } });
    fireEvent.blur(ccField);
    const after = lastCommand(services.store.execute).execute(doc);
    expect(after.scenes.find((candidate) => candidate.id === scene.id)!.ccOverrides).toEqual({
      "cc-repoint-ui": { ccNumber: 20 },
    });
    unmount();

    const services2 = mockServices(after);
    renderWithContext(<SceneStrip />, { services: services2 });
    const chField = screen.getByLabelText(`Channel for ${label} in this scene`) as HTMLInputElement;
    expect(chField.value).toBe("1");
    fireEvent.change(chField, { target: { value: "5" } });
    fireEvent.blur(chField);
    const after2 = lastCommand(services2.store.execute).execute(after);
    expect(after2.scenes.find((candidate) => candidate.id === scene.id)!.ccOverrides).toEqual({
      "cc-repoint-ui": { ccNumber: 20, channel: 5 },
    });
  });

  it("pins a modulator pattern to the scene and clears it", () => {
    const doc = JSON.parse(JSON.stringify(withSceneFx().doc)) as ProjectDocument;
    const trackId = doc.tracks.find((track) => track.kind === "drum")!.id;
    doc.lfos.push({
      id: "lfo-ui",
      trackId,
      param: "gain",
      amount: 0.5,
      kind: "step",
      division: 2,
      steps: [0.5, -0.5],
    });
    const scene = doc.scenes.find((candidate) => candidate.patternId === doc.activePatternId) ?? doc.scenes[0]!;
    const services = mockServices(doc);
    const { unmount } = renderWithContext(<SceneStrip />, { services });

    fireEvent.click(screen.getByRole("button", { name: "PIN" }));
    const after = lastCommand(services.store.execute).execute(doc);
    expect(after.scenes.find((candidate) => candidate.id === scene.id)!.modulators).toEqual({
      "lfo-ui": { steps: [0.5, -0.5] },
    });
    unmount();

    const services2 = mockServices(after);
    renderWithContext(<SceneStrip />, { services: services2 });
    expect(screen.getByText("STEPS ×2")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Clear the scene pin — the modulator returns to its own pattern"));
    const cleared = lastCommand(services2.store.execute).execute(after);
    expect(cleared.scenes.find((candidate) => candidate.id === scene.id)!.modulators).toBeUndefined();
  });
});
