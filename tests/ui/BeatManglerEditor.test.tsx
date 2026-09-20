import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ServicesContext } from "../../src/ui/context";
import { BeatManglerEditor } from "../../src/ui/BeatManglerEditor";
import { mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ProjectStore } from "../../src/store/ProjectStore";
import { addEffect } from "../../src/commands/commands";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * Beat Mangler editor — preset shelf and envelope tools.
 *
 * The editor commits through `setBeatManglerSteps`; these tests run it against
 * a REAL ProjectStore (not a mocked execute) so the document round-trip and
 * undo behaviour are pinned, while the rest of Services stays mocked.
 */

function setup() {
  let doc: ProjectDocument = createProjectFromTemplate("empty");
  const track = doc.tracks.find((t) => t.kind === "drum" || t.kind === "instrument")!;
  doc = addEffect(doc, track.id, "beatMangler").execute(doc);
  const fxId = doc.tracks.find((t) => t.id === track.id)!.effects.find((e) => e.type === "beatMangler")!.id;
  const store = new ProjectStore(doc);
  const services = mockServices(doc);
  // Swap in the real store so execute/undo actually mutate a document.
  (services as { store: ProjectStore }).store = store;
  return { services, store, trackId: track.id, fxId };
}

function effectsOf(store: ProjectStore, trackId: string, fxId: string) {
  const doc = store.getDoc();
  return doc.tracks.find((t) => t.id === trackId)!.effects.find((e) => e.id === fxId)!;
}

function renderEditor(services: ReturnType<typeof mockServices>, trackId: string, fxId: string) {
  return render(
    <ServicesContext.Provider value={services}>
      <BeatManglerEditor trackId={trackId} fxId={fxId} />
    </ServicesContext.Provider>,
  );
}

describe("BeatManglerEditor", () => {
  it("renders the preset shelf and both envelope lanes", () => {
    const { services, trackId, fxId } = setup();
    renderEditor(services, trackId, fxId);
    expect(screen.getByText("HALFTIME")).toBeInTheDocument();
    expect(screen.getByText("SCRATCH IN")).toBeInTheDocument();
    expect(screen.getByText("FILL 1/4")).toBeInTheDocument();
    expect(screen.getByText("VOL")).toBeInTheDocument();
    expect(screen.getByText("PITCH")).toBeInTheDocument();
  });

  it("HALFTIME applies a gated volume envelope to the document", () => {
    const { services, store, trackId, fxId } = setup();
    renderEditor(services, trackId, fxId);
    fireEvent.click(screen.getByText("HALFTIME"));
    const volume = effectsOf(store, trackId, fxId).volumeSteps!;
    expect(volume.length).toBe(16);
    expect(volume[0]).toBe(1);
    expect(volume[2]).toBe(0);
  });

  it("SCRATCH IN writes a pitch ramp and leaves pitch presets' volume at full gain", () => {
    const { services, store, trackId, fxId } = setup();
    renderEditor(services, trackId, fxId);
    fireEvent.click(screen.getByText("SCRATCH IN"));
    const fx = effectsOf(store, trackId, fxId);
    expect(fx.pitchSteps![0]).toBeCloseTo(-12, 1);
    expect(fx.pitchSteps![fx.pitchSteps!.length - 1]).toBeCloseTo(0, 1);
    expect(fx.volumeSteps!.every((v) => v === 1)).toBe(true);
  });

  it("FILL 1/4 silences everything except the last quarter", () => {
    const { services, store, trackId, fxId } = setup();
    renderEditor(services, trackId, fxId);
    fireEvent.click(screen.getByText("FILL 1/4"));
    const volume = effectsOf(store, trackId, fxId).volumeSteps!;
    expect(volume.slice(0, 12).every((v) => v === 0)).toBe(true);
    expect(volume.slice(12).every((v) => v === 1)).toBe(true);
  });

  it("is undoable like every other command", () => {
    const { services, store, trackId, fxId } = setup();
    renderEditor(services, trackId, fxId);
    fireEvent.click(screen.getByText("WOBBLE 8TH"));
    expect(effectsOf(store, trackId, fxId).volumeSteps).toBeDefined();
    store.undo();
    expect(effectsOf(store, trackId, fxId).volumeSteps).toBeUndefined();
  });

  it("INVERT flips the volume envelope", () => {
    const { services, store, trackId, fxId } = setup();
    renderEditor(services, trackId, fxId);
    fireEvent.click(screen.getByText("HALFTIME"));
    fireEvent.click(screen.getByText("INVERT"));
    const volume = effectsOf(store, trackId, fxId).volumeSteps!;
    expect(volume[0]).toBe(0);
    expect(volume[2]).toBe(1);
  });

  it("VOL→PITCH maps gain 0..1 onto −24..24 st", () => {
    const { services, store, trackId, fxId } = setup();
    renderEditor(services, trackId, fxId);
    fireEvent.click(screen.getByText("HALFTIME"));
    fireEvent.click(screen.getByText("VOL→PITCH"));
    const pitch = effectsOf(store, trackId, fxId).pitchSteps!;
    expect(pitch[0]).toBeCloseTo(24, 1); // gain 1 → +24 st
    expect(pitch[2]).toBeCloseTo(-24, 1); // gain 0 → −24 st
  });

  it("RESET clears both envelopes to neutral", () => {
    const { services, store, trackId, fxId } = setup();
    renderEditor(services, trackId, fxId);
    fireEvent.click(screen.getByText("HALFTIME"));
    fireEvent.click(screen.getByText("RESET"));
    const fx = effectsOf(store, trackId, fxId);
    expect(fx.volumeSteps!.every((v) => v === 1)).toBe(true);
    expect(fx.pitchSteps!.every((v) => v === 0)).toBe(true);
  });

  it("32-step resize tiles the existing shape", () => {
    const { services, store, trackId, fxId } = setup();
    renderEditor(services, trackId, fxId);
    fireEvent.click(screen.getByText("HALFTIME"));
    // The tools row owns the resize buttons; the grids also render "32" in
    // their own step-count controls, so scope by the actions group.
    const actions = screen.getByRole("group", { name: "Beat mangler envelope tools" });
    fireEvent.click(within(actions).getByText("32"));
    const volume = effectsOf(store, trackId, fxId).volumeSteps!;
    expect(volume.length).toBe(32);
    expect(volume[0]).toBe(1);
    expect(volume[2]).toBe(0);
    expect(volume[16]).toBe(1);
    expect(volume[18]).toBe(0);
  });
});
